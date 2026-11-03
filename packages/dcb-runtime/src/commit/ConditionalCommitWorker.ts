/**
 * Dormant conditional-commit write executor. The V1 serialized handler is
 * delegated here so provider capability is a composition fact. No public
 * route calls the conditional method.
 */
import {
  ConditionalCommitProtocolError,
  canonicalizeConditionalCommitPayload,
  computeConditionalCommitFingerprint,
  parseCanonicalEventKey,
  parseSerializedConditionalCommitRequestBody,
  type ConditionalCommitInDoubtReason,
  type ConditionalCommitValidationCode,
} from "@sekiban/dcb-core";
import { canonicalEventType } from "../eventIdentity";
import { createUuidV7, serializedEventMetadata, writeTimestampUtc } from "../eventRecord";
import { scopeIdentityMissingResponse } from "../scope/ControlRouteScope";
import { scopeIdFor } from "../scope/ScopeName";
import {
  envServiceIdentity,
  requestServiceIdentity,
  type ServiceIdentityProvider,
} from "../service/ServiceIdentityProvider";
import type { StoreProvider } from "../store/provider";
import {
  handleSerializedCommit as handleV1SerializedCommit,
  type CommitWorkerEnv,
  type CommitWorkerHooks,
} from "./CommitWorker";

const CONDITIONAL_TAG_AUTHORITY = Symbol("conditional-tag-authority");
const INITIAL_OWNER_EPOCH = 0;

type ConditionalTagAuthorityCapability = {
  readonly [CONDITIONAL_TAG_AUTHORITY]: true;
};

export interface ConditionalCommitHooks {
  readonly registeredEventParsers?: Readonly<Record<string, (payload: unknown) => unknown>>;
  readonly serviceIdentityProvider?: ServiceIdentityProvider;
  readonly loseAppendResponse?: boolean;
  readonly failRecoveryResolve?: boolean;
}

interface PreparedOperation {
  readonly serviceId: string;
  readonly normalizedKey: string;
  readonly tag: string;
  readonly eventPayloadName: string;
  readonly payloadBase64: string;
  readonly payloadText: string;
  readonly canonicalPayload: Uint8Array;
  readonly operationFingerprint: string;
  readonly parsers: Readonly<Record<string, (payload: unknown) => unknown>>;
}

interface WinnerFacts {
  readonly serviceId: string;
  readonly tag: string;
  readonly normalizedKey: string;
  readonly operationFingerprint: string;
  readonly eventId: string;
  readonly suid: string;
  readonly payload: string;
  readonly eventType: string;
  readonly attemptId: string;
  readonly timestamp: string;
  readonly provenance: "g32";
  readonly allocatorLineageId: string;
  readonly eventDigest: string;
}

const UNSUPPORTED_BODY = Object.freeze({
  version: 1,
  outcome: "Unsupported",
  code: "conditional_commit_unsupported",
  error: "Conditional commit is not supported by this deployment.",
  retryable: false,
});

const CONFLICT_BODY = Object.freeze({
  version: 1,
  outcome: "KeyReuseConflict",
  code: "conditional_commit_key_reuse_conflict",
  error: "The idempotency key is already bound to a different operation.",
  retryable: false,
});

const CORRUPT_BODY = Object.freeze({
  version: 1,
  code: "conditional_commit_committed_state_corrupt",
  error: "The durable conditional commit state could not be verified.",
  retryable: false,
});

const IN_DOUBT_ERROR = "The conditional commit outcome is not yet verified; resend the same prepared request.";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function unsupportedResponse(): Response {
  return json(UNSUPPORTED_BODY, 501);
}

function conflictResponse(): Response {
  return json(CONFLICT_BODY, 409);
}

function corruptResponse(): Response {
  return json(CORRUPT_BODY, 500);
}

function inDoubtResponse(reason: ConditionalCommitInDoubtReason): Response {
  return json({
    version: 1,
    code: "conditional_commit_in_doubt",
    error: IN_DOUBT_ERROR,
    retryable: true,
    reason,
  }, 503);
}

function validationResponse(code: ConditionalCommitValidationCode): Response {
  return json({
    version: 1,
    code,
    error: new ConditionalCommitProtocolError(code).message,
    retryable: false,
  }, 400);
}

function isInDoubtReason(value: unknown): value is ConditionalCommitInDoubtReason {
  return value === "winner_unreadable"
    || value === "ambiguous_after_append"
    || value === "committed_state_unverified"
    || value === "live_precondition_blocked"
    || value === "bootstrap_epoch_changed";
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function conditionalPermitDigest(input: {
  readonly serviceId: string;
  readonly tag: string;
  readonly fingerprint: string;
  readonly eventId: string;
}): string {
  const normalized = JSON.stringify({
    version: 1,
    serviceId: input.serviceId,
    tag: input.tag,
    fingerprint: input.fingerprint,
    eventId: input.eventId,
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, "0")}`;
}

function mintCapability(): ConditionalTagAuthorityCapability {
  return Object.freeze({ [CONDITIONAL_TAG_AUTHORITY]: true });
}

function readFacts(value: unknown): WinnerFacts | undefined {
  if (!isRecord(value)) return undefined;
  const facts = value;
  if (
    typeof facts.serviceId !== "string"
    || typeof facts.tag !== "string"
    || typeof facts.normalizedKey !== "string"
    || typeof facts.operationFingerprint !== "string"
    || typeof facts.eventId !== "string"
    || typeof facts.suid !== "string"
    || typeof facts.payload !== "string"
    || typeof facts.eventType !== "string"
    || typeof facts.attemptId !== "string"
    || typeof facts.timestamp !== "string"
    || facts.provenance !== "g32"
    || typeof facts.allocatorLineageId !== "string"
    || typeof facts.eventDigest !== "string"
  ) {
    return undefined;
  }
  return {
    serviceId: facts.serviceId,
    tag: facts.tag,
    normalizedKey: facts.normalizedKey,
    operationFingerprint: facts.operationFingerprint,
    eventId: facts.eventId,
    suid: facts.suid,
    payload: facts.payload,
    eventType: facts.eventType,
    attemptId: facts.attemptId,
    timestamp: facts.timestamp,
    provenance: "g32",
    allocatorLineageId: facts.allocatorLineageId,
    eventDigest: facts.eventDigest,
  };
}

export function createOrdinaryConditionalExecutor(input: { readonly storeProvider?: StoreProvider } = {}): ConditionalWriteExecutor {
  const capability = input.storeProvider === undefined ? mintCapability() : undefined;
  return new ConditionalWriteExecutor(capability);
}

export function createFixedD1ConditionalExecutor(): ConditionalWriteExecutor {
  return new ConditionalWriteExecutor(mintCapability());
}

export class ConditionalWriteExecutor {
  constructor(private readonly capability: ConditionalTagAuthorityCapability | undefined) {}

  handleSerializedCommit(request: Request, env: CommitWorkerEnv, hooks: CommitWorkerHooks = {}): Promise<Response> {
    return handleV1SerializedCommit(request, env, hooks);
  }

  async handleConditionalCommit(
    request: Request,
    env: CommitWorkerEnv,
    hooks: ConditionalCommitHooks = {},
  ): Promise<Response> {
    if (request.method !== "POST") return validationResponse("conditional_commit_invalid_envelope");
    let raw: string;
    try {
      raw = await request.text();
    } catch {
      return validationResponse("conditional_commit_invalid_json");
    }
    let parsed: ReturnType<typeof parseSerializedConditionalCommitRequestBody>;
    try {
      parsed = parseSerializedConditionalCommitRequestBody(raw);
    } catch (error) {
      if (error instanceof ConditionalCommitProtocolError) return validationResponse(error.code);
      return validationResponse("conditional_commit_invalid_json");
    }
    let serviceId: string;
    try {
      serviceId = requestServiceIdentity(request, hooks.serviceIdentityProvider ?? envServiceIdentity(env), {
        allowG11Verification: env.G11_VERIFICATION_ENABLED === "true",
      });
    } catch {
      return scopeIdentityMissingResponse();
    }
    const drafted = this.prepareOperation(parsed, serviceId, hooks.registeredEventParsers ?? {});
    if (drafted instanceof Response) return drafted;
    const prepared: PreparedOperation = {
      ...drafted,
      operationFingerprint: await this.fingerprint(drafted),
      parsers: hooks.registeredEventParsers ?? {},
    };
    if (!this.capabilityAuthorizes()) return unsupportedResponse();
    const resolved = await this.resolveConditionalTag(env, prepared, hooks);
    if (resolved instanceof Response) return resolved;

    const bootstrap = await this.readBootstrapState(env, prepared.serviceId);
    if (bootstrap.kind === "unsupported") return unsupportedResponse();
    if (bootstrap.kind === "retry") return inDoubtResponse(bootstrap.reason);

    const startedAt = Date.now();
    const attemptId = crypto.randomUUID();
    const eventId = createUuidV7(startedAt);
    const timestamp = writeTimestampUtc(startedAt);
    const admitted = await this.bootstrapCommand(env, prepared.serviceId, "admit", { commandId: attemptId });
    if (admitted === undefined) return inDoubtResponse("bootstrap_epoch_changed");
    if (await this.bootstrapCommand(env, prepared.serviceId, "release", { commandId: attemptId, leaseEpoch: admitted }) === undefined) {
      return inDoubtResponse("bootstrap_epoch_changed");
    }
    const permitDigest = conditionalPermitDigest({
      serviceId: prepared.serviceId,
      tag: prepared.tag,
      fingerprint: prepared.operationFingerprint,
      eventId,
    });
    let permitHeld = false;
    const releasePermit = async (): Promise<void> => {
      if (!permitHeld) return;
      permitHeld = false;
      await this.bootstrapPermit(env, prepared.serviceId, "permit-release", attemptId, permitDigest);
    };
    if (!await this.bootstrapPermit(env, prepared.serviceId, "permit", attemptId, permitDigest)) {
      return inDoubtResponse("bootstrap_epoch_changed");
    }
    permitHeld = env.BOOTSTRAP !== undefined;
    const allocated = await this.allocateConditional(env, prepared, attemptId, eventId, admitted);
    if (allocated === undefined) {
      await releasePermit();
      return inDoubtResponse("live_precondition_blocked");
    }
    if (await this.bootstrapCommand(env, prepared.serviceId, "finalize", { commandId: attemptId, leaseEpoch: admitted }) === undefined) {
      await releasePermit();
      return inDoubtResponse("bootstrap_epoch_changed");
    }
    const appended = await this.appendConditionalTag(env, prepared, hooks, {
      attemptId,
      eventId,
      timestamp,
      suid: allocated.suid,
      allocatorLineageId: allocated.allocatorLineageId,
    });
    if (appended.release) await releasePermit();
    return appended.response;
  }

  private capabilityAuthorizes(): boolean {
    return this.capability?.[CONDITIONAL_TAG_AUTHORITY] === true;
  }

  private prepareOperation(
    parsed: ReturnType<typeof parseSerializedConditionalCommitRequestBody>,
    serviceId: string,
    parsers: Readonly<Record<string, (payload: unknown) => unknown>>,
  ): Omit<PreparedOperation, "operationFingerprint" | "parsers"> | Response {
    const eventPayloadName = parsed.eventCandidate.eventPayloadName;
    const parser = parsers[eventPayloadName];
    if (parser === undefined) return validationResponse("conditional_commit_event_not_registered");
    let payloadText: string;
    try {
      payloadText = new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64(parsed.eventCandidate.payload));
    } catch {
      return validationResponse("conditional_commit_invalid_utf8");
    }
    let payloadJson: unknown;
    try {
      payloadJson = JSON.parse(payloadText);
    } catch {
      return validationResponse("conditional_commit_invalid_payload_json");
    }
    let domain: unknown;
    try {
      domain = parser(payloadJson);
    } catch (error) {
      if (error instanceof ConditionalCommitProtocolError) return validationResponse(error.code);
      return validationResponse("conditional_commit_invalid_candidate");
    }
    let canonicalPayload: Uint8Array;
    try {
      canonicalPayload = canonicalizeConditionalCommitPayload(domain);
    } catch (error) {
      if (error instanceof ConditionalCommitProtocolError) return validationResponse(error.code);
      return validationResponse("conditional_commit_payload_not_canonicalizable");
    }
    return {
      serviceId,
      normalizedKey: parsed.idempotencyKey,
      tag: parsed.eventCandidate.tags[0],
      eventPayloadName,
      payloadBase64: parsed.eventCandidate.payload,
      payloadText,
      canonicalPayload,
    };
  }

  private async fingerprint(prepared: Omit<PreparedOperation, "operationFingerprint" | "parsers">): Promise<string> {
    return computeConditionalCommitFingerprint({
      serviceId: prepared.serviceId,
      idempotencyKey: prepared.normalizedKey,
      eventPayloadName: prepared.eventPayloadName,
      canonicalPayload: prepared.canonicalPayload,
      tag: prepared.tag,
    });
  }

  private tagStub(env: CommitWorkerEnv, serviceId: string, tag: string): DurableObjectStub {
    return env.TAG.get(scopeIdFor(env.TAG, { serviceId, doClass: "tag", identity: tag }));
  }

  private async resolveConditionalTag(
    env: CommitWorkerEnv,
    prepared: PreparedOperation,
    hooks: ConditionalCommitHooks,
  ): Promise<Response | PreparedOperation> {
    let response: Response;
    try {
      response = await this.postTag(env, prepared, "/__internal/conditional/resolve", {
        serviceId: prepared.serviceId,
        tag: prepared.tag,
        normalizedKey: prepared.normalizedKey,
        operationFingerprint: prepared.operationFingerprint,
      });
    } catch {
      return inDoubtResponse("winner_unreadable");
    }
    if (response.status === 204) return prepared;
    const mapped = await this.mapTerminalResponse(response, prepared, false);
    if (mapped === undefined) return inDoubtResponse("winner_unreadable");
    if (hooks.failRecoveryResolve && response.status === 503) return inDoubtResponse("winner_unreadable");
    return mapped;
  }

  private async postTag(
    env: CommitWorkerEnv,
    prepared: PreparedOperation,
    path: "/__internal/conditional/resolve" | "/__internal/conditional/append",
    body: unknown,
  ): Promise<Response> {
    const url = new URL(`https://conditional.internal${path}`);
    url.searchParams.set("__tag", prepared.tag);
    url.searchParams.set("__serviceId", prepared.serviceId);
    return this.tagStub(env, prepared.serviceId, prepared.tag).fetch(new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
  }

  private async readBootstrapState(
    env: CommitWorkerEnv,
    serviceId: string,
  ): Promise<{ readonly kind: "empty" } | { readonly kind: "unsupported" } | { readonly kind: "retry"; readonly reason: "bootstrap_epoch_changed" | "committed_state_unverified" }> {
    if (env.BOOTSTRAP === undefined) return { kind: "unsupported" };
    let response: Response;
    try {
      const url = new URL("https://conditional.internal/state");
      url.searchParams.set("__serviceId", serviceId);
      response = await env.BOOTSTRAP.get(scopeIdFor(env.BOOTSTRAP, {
        serviceId,
        doClass: "bootstrap",
        identity: "coordinator",
      })).fetch(new Request(url));
    } catch {
      return { kind: "retry", reason: "committed_state_unverified" };
    }
    if (!response.ok) {
      return response.status >= 500
        ? { kind: "retry", reason: "committed_state_unverified" }
        : { kind: "unsupported" };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: "unsupported" };
    }
    const coordinator = parseCoordinatorState(body, serviceId);
    if (coordinator === undefined) return { kind: "unsupported" };
    if (coordinator.status === "EMPTY") return { kind: "empty" };
    if (coordinator.status === "PLANNED" || coordinator.status === "IMPORTING" || coordinator.status === "VERIFYING") {
      return { kind: "retry", reason: "bootstrap_epoch_changed" };
    }
    return { kind: "unsupported" };
  }

  private bootstrapStub(env: CommitWorkerEnv, serviceId: string): DurableObjectStub | undefined {
    if (env.BOOTSTRAP === undefined) return undefined;
    return env.BOOTSTRAP.get(scopeIdFor(env.BOOTSTRAP, { serviceId, doClass: "bootstrap", identity: "coordinator" }));
  }

  private async bootstrapCommand(
    env: CommitWorkerEnv,
    serviceId: string,
    action: "admit" | "release" | "finalize",
    body: { readonly commandId: string; readonly leaseEpoch?: number },
  ): Promise<number | undefined> {
    const stub = this.bootstrapStub(env, serviceId);
    if (stub === undefined) return 0;
    try {
      const url = new URL(`https://conditional.internal/command/${action}`);
      url.searchParams.set("__serviceId", serviceId);
      const response = await stub.fetch(new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
      if (!response.ok) return undefined;
      const parsed = await response.clone().json().catch(() => undefined) as { leaseEpoch?: unknown } | undefined;
      return typeof parsed?.leaseEpoch === "number" ? parsed.leaseEpoch : undefined;
    } catch {
      return undefined;
    }
  }

  private async bootstrapPermit(
    env: CommitWorkerEnv,
    serviceId: string,
    action: "permit" | "permit-release",
    commandId: string,
    digest: string,
  ): Promise<boolean> {
    const stub = this.bootstrapStub(env, serviceId);
    if (stub === undefined) return true;
    try {
      const url = new URL(`https://conditional.internal/command/${action}`);
      url.searchParams.set("__serviceId", serviceId);
      const response = await stub.fetch(new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId, digest }),
      }));
      return response.ok;
    } catch {
      return action === "permit-release";
    }
  }

  private async allocateConditional(
    env: CommitWorkerEnv,
    prepared: PreparedOperation,
    attemptId: string,
    eventId: string,
    bootstrapEpoch: number,
  ): Promise<{ readonly suid: string; readonly allocatorLineageId: string } | undefined> {
    try {
      const allocator = env.ALLOCATOR.get(scopeIdFor(env.ALLOCATOR, {
        serviceId: prepared.serviceId,
        doClass: "allocator",
        identity: "allocator",
      }));
      const response = await allocator.fetch(new Request("https://conditional.internal/allocate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attemptId,
          serviceId: prepared.serviceId,
          bootstrapCommandId: attemptId,
          bootstrapEpoch,
          candidates: [{
            candidateIndex: 0,
            eventId,
            targetTags: [prepared.tag],
            pinnedWriterEpoch: INITIAL_OWNER_EPOCH,
          }],
        }),
      }));
      if (!response.ok) return undefined;
      const body = await response.json() as {
        allocatorLineageId?: unknown;
        candidates?: ReadonlyArray<{ readonly eventId?: unknown; readonly suid?: unknown }>;
      };
      const candidate = body.candidates?.find((item) => item.eventId === eventId);
      if (typeof body.allocatorLineageId !== "string" || typeof candidate?.suid !== "string") return undefined;
      return { suid: candidate.suid, allocatorLineageId: body.allocatorLineageId };
    } catch {
      return undefined;
    }
  }

  private async appendConditionalTag(
    env: CommitWorkerEnv,
    prepared: PreparedOperation,
    hooks: ConditionalCommitHooks,
    candidate: {
      readonly attemptId: string;
      readonly eventId: string;
      readonly timestamp: string;
      readonly suid: string;
      readonly allocatorLineageId: string;
    },
  ): Promise<{ readonly response: Response; readonly release: boolean }> {
    const body = {
      serviceId: prepared.serviceId,
      tag: prepared.tag,
      normalizedKey: prepared.normalizedKey,
      operationFingerprint: prepared.operationFingerprint,
      candidate: {
        attemptId: candidate.attemptId,
        epoch: INITIAL_OWNER_EPOCH,
        eventId: candidate.eventId,
        suid: candidate.suid,
        payload: prepared.payloadText,
        eventTags: [prepared.tag],
        allocatorLineageId: candidate.allocatorLineageId,
        eventType: canonicalEventType(prepared.eventPayloadName),
        provenance: "g32",
        timestamp: candidate.timestamp,
      },
    };
    let response: Response | undefined;
    try {
      response = await this.postTag(env, prepared, "/__internal/conditional/append", body);
    } catch {
      response = undefined;
    }
    if (response === undefined || hooks.loseAppendResponse === true) {
      const recovered = await this.recoverAppend(env, prepared, hooks);
      return recovered;
    }
    if (response.status === 503) {
      const reason = await this.readInDoubtReason(response);
      if (reason === "live_precondition_blocked") {
        const recovered = await this.recoverAppend(env, prepared, hooks);
        if (recovered.response.status === 503) {
          return { response: inDoubtResponse("live_precondition_blocked"), release: true };
        }
        return recovered;
      }
      if (reason === "ambiguous_after_append" || reason === "winner_unreadable") {
        return { response: inDoubtResponse(reason), release: false };
      }
      const recovered = await this.recoverAppend(env, prepared, hooks);
      return recovered.response.status === 503
        ? { response: inDoubtResponse("ambiguous_after_append"), release: false }
        : recovered;
    }
    const mapped = await this.mapTerminalResponse(response, prepared, true);
    if (mapped === undefined) {
      const recovered = await this.recoverAppend(env, prepared, hooks);
      return recovered;
    }
    return { response: mapped, release: true };
  }

  private async recoverAppend(
    env: CommitWorkerEnv,
    prepared: PreparedOperation,
    hooks: ConditionalCommitHooks,
  ): Promise<{ readonly response: Response; readonly release: boolean }> {
    if (hooks.failRecoveryResolve === true) return { response: inDoubtResponse("ambiguous_after_append"), release: false };
    let response: Response;
    try {
      response = await this.postTag(env, prepared, "/__internal/conditional/resolve", {
        serviceId: prepared.serviceId,
        tag: prepared.tag,
        normalizedKey: prepared.normalizedKey,
        operationFingerprint: prepared.operationFingerprint,
      });
    } catch {
      return { response: inDoubtResponse("ambiguous_after_append"), release: false };
    }
    if (response.status === 204) return { response: inDoubtResponse("ambiguous_after_append"), release: false };
    const mapped = await this.mapTerminalResponse(response, prepared, false);
    if (mapped === undefined) return { response: inDoubtResponse("ambiguous_after_append"), release: false };
    return { response: mapped, release: true };
  }

  private async readInDoubtReason(response: Response): Promise<ConditionalCommitInDoubtReason | undefined> {
    try {
      const body = await response.clone().json() as { reason?: unknown };
      return isInDoubtReason(body.reason) ? body.reason : undefined;
    } catch {
      return undefined;
    }
  }

  private async mapTerminalResponse(
    response: Response,
    prepared: PreparedOperation,
    appended: boolean,
  ): Promise<Response | undefined> {
    if (response.status === 404) return unsupportedResponse();
    if (response.status === 501) return unsupportedResponse();
    if (response.status === 500) return corruptResponse();
    if (response.status !== 200 && response.status !== 201 && response.status !== 409) return undefined;
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return undefined;
    }
    if (!isRecord(body)) return undefined;
    const facts = readFacts(body.facts);
    if (facts === undefined) return corruptResponse();
    const verified = await this.revalidateFacts(prepared, facts);
    if (verified === "corrupt") return corruptResponse();
    if (response.status === 409 || verified === "conflict") return conflictResponse();
    if (response.status === 201 || (appended && body.status === "appended")) {
      return json({
        version: 1,
        outcome: "Appended",
        receipt: {
          winnerEventId: facts.eventId,
          winnerSortableUniqueId: facts.suid,
          operationFingerprint: facts.operationFingerprint,
        },
        writtenEvents: [{
          payload: prepared.payloadBase64,
          sortableUniqueIdValue: facts.suid,
          id: facts.eventId,
          eventMetadata: serializedEventMetadata(facts.eventId),
          tags: [prepared.tag],
          eventPayloadName: prepared.eventPayloadName,
        }],
      }, 201);
    }
    return json({
      version: 1,
      outcome: "AlreadyCommittedSameOperation",
      receipt: {
        winnerEventId: facts.eventId,
        winnerSortableUniqueId: facts.suid,
        operationFingerprint: facts.operationFingerprint,
      },
      writtenEvents: [],
    }, 200);
  }

  private async revalidateFacts(prepared: PreparedOperation, facts: WinnerFacts): Promise<"same" | "conflict" | "corrupt"> {
    if (facts.serviceId !== prepared.serviceId || facts.tag !== prepared.tag || facts.normalizedKey !== prepared.normalizedKey) {
      return "corrupt";
    }
    try {
      const storedName = parseCanonicalEventKey(facts.eventType).eventPayloadName;
      const storedParser = prepared.parsers[storedName];
      if (storedParser === undefined) return "corrupt";
      const domain = storedParser(JSON.parse(facts.payload));
      const canonical = canonicalizeConditionalCommitPayload(domain);
      const fingerprint = await computeConditionalCommitFingerprint({
        serviceId: facts.serviceId,
        idempotencyKey: facts.normalizedKey,
        eventPayloadName: storedName,
        canonicalPayload: canonical,
        tag: facts.tag,
      });
      if (fingerprint !== facts.operationFingerprint) return "corrupt";
      return fingerprint === prepared.operationFingerprint ? "same" : "conflict";
    } catch {
      return "corrupt";
    }
  }
}

const COORDINATOR_KEYS = [
  "schemaVersion",
  "status",
  "importId",
  "targetServiceId",
  "allocatorLineageId",
  "source",
  "digest",
  "manifest",
  "progress",
  "leaseEpoch",
  "leaseUntil",
  "failure",
  "readyAt",
  "normalInFlight",
  "normalCommands",
  "releasedCommands",
  "writePermits",
  "verifiedImportId",
  "verifiedLeaseEpoch",
  "storeCompletion",
] as const;

const COORDINATOR_STATUSES = ["EMPTY", "PLANNED", "IMPORTING", "VERIFYING", "READY", "FAILED"] as const;

function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nullableText(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function closedCoordinator(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || Object.keys(value).length !== COORDINATOR_KEYS.length) return undefined;
  if (COORDINATOR_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) return undefined;
  return value;
}

function stringMap(value: unknown, values: (item: unknown) => boolean): boolean {
  return isRecord(value) && Object.values(value).every(values);
}

function manifestRecord(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  const keys = ["format", "version", "source", "target", "highWatermark", "eventCount", "tagCounts", "contentDigest", "canonicalization"];
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) return false;
  const target = value.target;
  return value.format === "sekiban-dcb-bootstrap"
    && value.version === 1
    && value.canonicalization === "utf8-json-sorted-keys-v1"
    && sourceRecord(value.source)
    && value.source !== null
    && isRecord(target)
    && Object.keys(target).length === 2
    && typeof target.serviceId === "string"
    && typeof target.allocatorLineageId === "string"
    && nullableText(value.highWatermark)
    && nonNegative(value.eventCount)
    && stringMap(value.tagCounts, nonNegative)
    && typeof value.contentDigest === "string";
}

function sourceRecord(value: unknown): boolean {
  if (value === null) return true;
  return isRecord(value)
    && Object.keys(value).length === 2
    && typeof value.serviceId === "string"
    && typeof value.lineageId === "string";
}

function emptyFacts(record: Record<string, unknown>): boolean {
  return record.importId === null
    && record.allocatorLineageId === null
    && record.source === null
    && record.digest === null
    && record.manifest === null
    && record.failure === null
    && record.readyAt === null
    && record.verifiedImportId === null
    && record.verifiedLeaseEpoch === null
    && record.storeCompletion === null
    && isRecord(record.progress)
    && Object.keys(record.progress).length === 0;
}

function parseCoordinatorState(value: unknown, serviceId: string): { readonly status: typeof COORDINATOR_STATUSES[number] } | undefined {
  const record = closedCoordinator(value);
  if (record === undefined) return undefined;
  if (record.schemaVersion !== 1 || record.targetServiceId !== serviceId) return undefined;
  if (typeof record.status !== "string" || !(COORDINATOR_STATUSES as readonly string[]).includes(record.status)) return undefined;
  if (!nullableText(record.importId) || !nullableText(record.allocatorLineageId) || !nullableText(record.digest)) return undefined;
  if (!nullableText(record.failure) || !nullableText(record.readyAt) || !nullableText(record.verifiedImportId)) return undefined;
  if (!sourceRecord(record.source) || !manifestRecord(record.manifest) || !stringMap(record.progress, nullableText)) return undefined;
  if (!nonNegative(record.leaseEpoch) || !nonNegative(record.normalInFlight)) return undefined;
  if (!(record.leaseUntil === null || nonNegative(record.leaseUntil))) return undefined;
  if (!(record.verifiedLeaseEpoch === null || nonNegative(record.verifiedLeaseEpoch))) return undefined;
  if (!stringMap(record.normalCommands, nonNegative) || !stringMap(record.releasedCommands, nonNegative)) return undefined;
  if (!stringMap(record.writePermits, (item) => typeof item === "string")) return undefined;
  if (!(record.storeCompletion === null || record.storeCompletion === "prepopulated-manifest")) return undefined;
  if (record.status === "EMPTY" && !emptyFacts(record)) return undefined;
  return { status: record.status as typeof COORDINATOR_STATUSES[number] };
}
