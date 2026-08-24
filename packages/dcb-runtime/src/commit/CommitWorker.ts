import { allocatorNameForService, type AllocationVector } from "../allocator/types";
import type { ConsistencyTag, JournalRecord, ReconciliationFailureCause } from "../journal/types";
import {
  durationSince,
  mapTerminalCommitOutcome,
  type CompleteCommitResponse,
  type TagWriteResultResponse,
} from "../http/commitResponse";
import {
  COMMIT_TEST_FAULTS,
  type AllocatedCommitCandidate,
  type CommitTestFault,
  type ValidatedCommitEnvelope,
} from "./types";
import { serviceIdForRequest } from "../http/testServiceId";
import type { DeliveryClass } from "../downstream/Doorbell";
import { canonicalEventType } from "../eventIdentity";
import { createUuidV7, serializedEventMetadata, writeTimestampUtc } from "../eventRecord";
import { assertSortableUniqueId } from "../allocator/SortableUniqueId";
import {
  beginWorkerInvocationObservation,
  CommitTrace,
  type CommitTraceClock,
  type CommitTraceProviderAdapter,
  type CommitTraceScope,
  type CommitTraceSink,
  createTraceCorrelationId,
  type NativeTracing,
} from "../trace/CommitTrace";
import { observeWorkerInvocation } from "../trace/ObservationStream";
import { verifyCommitTrace } from "../trace/CommitTraceVerifier";

const INITIAL_OWNER_EPOCH = 0;
const MAX_WRITE_ATTEMPTS = 2;
const OUTCOME_UNDETERMINED_ERROR =
  "Commit outcome is undetermined; reread tag heads and event/query state before retrying because blind retry may create duplicate events.";
const JOURNAL_TRANSITION_TRACE: Readonly<Partial<Record<JournalRecord["state"], { readonly rowId: "S05a" | "S05b" | "S05c" | "S05d" | "S05e"; readonly phaseOrdinal: number }>>> = {
  RESERVED: { rowId: "S05a", phaseOrdinal: 0 },
  ALLOCATED: { rowId: "S05b", phaseOrdinal: 1 },
  WRITING: { rowId: "S05c", phaseOrdinal: 2 },
  COMPLETE: { rowId: "S05d", phaseOrdinal: 3 },
  REFUSED: { rowId: "S05e", phaseOrdinal: 4 },
  FAILED: { rowId: "S05e", phaseOrdinal: 4 },
};

type JsonObject = Record<string, unknown>;

export interface CommitWorkerEnv {
  ALLOCATOR: DurableObjectNamespace;
  JOURNAL: DurableObjectNamespace;
  TAG: DurableObjectNamespace;
  /** Service-scoped bootstrap authority. Optional keeps pre-G21 unit harnesses compatible. */
  BOOTSTRAP?: DurableObjectNamespace;
  /** Set only by an authenticated deployment-verification lane. */
  G11_VERIFICATION_ENABLED?: string;
  /** Non-secret service identity configured per deployment. */
  SDT_SERVICE_ID?: string;
}

/** Test seam for the admitted-then-stalled bootstrap race; production has no hook. */
export interface CommitWorkerHooks {
  /** Test-only barrier after entry admission is released and before /allocate. */
  beforeBootstrapAllocation?(): Promise<void> | void;
  beforeBootstrapFinalization?(): Promise<void> | void;
  /** Test-only allocator namespace; production uses the service-scoped allocator. */
  allocatorName?: string;
  /** Runtime composition value; never sourced from a caller-controlled V1 body. */
  domainDeliveryClass?: DeliveryClass;
  /** Registered schema/parser authority for exact-case payload admission. */
  registeredEventParsers?: Readonly<Record<string, (payload: unknown) => unknown>>;
  /** Test/evidence observer. It is not a public response or protocol field. */
  commitTraceSink?: CommitTraceSink;
  /** Deterministic test clock for trace containment and ratio fixtures. */
  commitTraceClock?: CommitTraceClock;
  /** Provider automatic attributes are optional adapter input only. */
  commitTraceProvider?: CommitTraceProviderAdapter;
  /** Cloudflare active-context span API supplied by the Worker entrypoint. */
  nativeTracing?: NativeTracing;
}

interface ReservationSuccess {
  tag: string;
  reservationToken: string;
}

interface ReservationFailure {
  outcome: "REFUSED" | "FAILED";
  failureCause: ReconciliationFailureCause;
  reason: string;
}

interface ReservationAttempt {
  successes: Map<string, ReservationSuccess>;
  failure?: ReservationFailure;
}

interface TagStateResponse {
  version: number;
  updatedAt: string;
}

interface CommitTraceRequestState {
  readonly trace: CommitTrace;
  scope: CommitTraceScope;
  emitWorkerObservation?: () => void;
}

/**
 * The static authority checker proves the manifest bytes; this is the
 * separate runtime structural/attribution verifier. Its outcome is retained
 * only in the in-process trace snapshot and is fail-open by design: G30 must
 * not change the protocol when an observation adapter is unavailable.
 */
const runtimeCommitTraceVerifier = {
  verify(snapshot: Parameters<typeof verifyCommitTrace>[0]): void {
    const accepted = snapshot.spans.some((span) => span.face === "accepted" && typeof span.attributes["attempt.id"] === "string");
    verifyCommitTrace(snapshot, { accepted });
  },
} as const;

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

function error(status: number, code: string, message: string): Response {
  return json({ error: message, code }, status);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isStandardBase64(value: string): boolean {
  if (value.length === 0) {
    return true;
  }
  return (
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  );
}

class CommitPayloadAdmissionError extends Error {
  constructor(readonly code: "invalid_payload_utf8" | "invalid_payload_json" | "payload_case_mismatch" | "payload_type_discriminator", message: string) {
    super(message);
    this.name = "CommitPayloadAdmissionError";
  }
}

function decodeBase64Utf8Json(value: string): { readonly text: string; readonly parsed: unknown } {
  let bytes: Uint8Array;
  try {
    const binary = atob(value);
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new CommitPayloadAdmissionError("invalid_payload_utf8", "Payload base64 could not be decoded");
  }
  let text: string;
  try {
    // The fatal decoder is deliberate: replacement characters would destroy
    // the payload-byte equality contract before storage is even attempted.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CommitPayloadAdmissionError("invalid_payload_utf8", "Payload must be valid UTF-8 JSON text");
  }
  try {
    return Object.freeze({ text, parsed: JSON.parse(text) });
  } catch {
    throw new CommitPayloadAdmissionError("invalid_payload_json", "Payload must be syntactically valid JSON");
  }
}

function assertNoPayloadDiscriminator(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPayloadDiscriminator(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "eventType" || key === "eventName" || key === "eventPayloadName") {
      throw new CommitPayloadAdmissionError("payload_type_discriminator", `Payload discriminator ${path}.${key} is forbidden`);
    }
    assertNoPayloadDiscriminator(child, `${path}.${key}`);
  }
}

/**
 * A parser may coerce values, but it may not silently accept a member missing
 * from its returned schema value. This catches additional members and
 * case-only spelling drift without reserializing the admitted bytes.
 */
function assertExactMemberPaths(actual: unknown, registered: unknown, path = "$"): void {
  if (Array.isArray(actual)) {
    if (!Array.isArray(registered)) {
      throw new CommitPayloadAdmissionError("payload_case_mismatch", `Registered schema shape differs at ${path}`);
    }
    actual.forEach((entry, index) => assertExactMemberPaths(entry, registered[index], `${path}[${index}]`));
    return;
  }
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return;
  if (typeof registered !== "object" || registered === null || Array.isArray(registered)) {
    throw new CommitPayloadAdmissionError("payload_case_mismatch", `Registered schema shape differs at ${path}`);
  }
  const registeredRecord = registered as Record<string, unknown>;
  for (const [key, value] of Object.entries(actual as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(registeredRecord, key)) {
      const caseOnly = Object.keys(registeredRecord).find((registeredKey) => registeredKey.toLocaleLowerCase("en-US") === key.toLocaleLowerCase("en-US"));
      const suffix = caseOnly === undefined ? "is not registered" : `must use exact case ${caseOnly}`;
      throw new CommitPayloadAdmissionError("payload_case_mismatch", `Payload member ${path}.${key} ${suffix}`);
    }
    assertExactMemberPaths(value, registeredRecord[key], `${path}.${key}`);
  }
}

function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function faultFromRequest(request: Request): CommitTestFault | undefined {
  // The test pool calls the Worker through this synthetic host. Production
  // V1 traffic cannot enable fault injection through a wire/header extension.
  if (new URL(request.url).hostname !== "commit.test") {
    return undefined;
  }
  const candidate = request.headers.get("x-sdt-g4-test-fault");
  return candidate !== null && COMMIT_TEST_FAULTS.includes(candidate as CommitTestFault)
    ? candidate as CommitTestFault
    : undefined;
}

function testAttemptIdFromRequest(request: Request): string | undefined {
  if (new URL(request.url).hostname !== "commit.test") {
    return undefined;
  }
  const candidate = request.headers.get("x-sdt-g4-test-attempt-id");
  return candidate !== null && isNonEmptyString(candidate) ? candidate : undefined;
}

function responseWithAttempt(response: Response, attemptId: string, expose: boolean): Response {
  if (!expose) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("x-sdt-g4-attempt-id", attemptId);
  return new Response(response.body, { status: response.status, headers });
}

/** Parse the complete V1 envelope before any Durable Object is contacted. */
export function validateCommitEnvelope(
  value: unknown,
  registeredEventParsers: Readonly<Record<string, (payload: unknown) => unknown>> = {},
):
  | { value: ValidatedCommitEnvelope }
  | { error: Response } {
  if (!isObject(value) || typeof value.version !== "number") {
    return { error: error(400, "malformed_commit_envelope", "Commit envelope must contain numeric version 1") };
  }
  if (value.version !== 1) {
    return {
      error: error(400, "unsupported_commit_envelope_version", "Only serialized commit envelope version 1 is supported"),
    };
  }

  const rawCandidates = value.eventCandidates ?? [];
  const rawConsistencyTags = value.consistencyTags ?? [];
  if (!Array.isArray(rawCandidates) || !Array.isArray(rawConsistencyTags)) {
    return { error: error(400, "malformed_commit_envelope", "eventCandidates and consistencyTags must be arrays") };
  }

  const eventCandidates: ValidatedCommitEnvelope["eventCandidates"] = [];
  for (const rawCandidate of rawCandidates) {
    if (!isObject(rawCandidate)) {
      return { error: error(400, "malformed_commit_envelope", "Each event candidate must be an object") };
    }
    if (
      typeof rawCandidate.payload !== "string" ||
      !isStandardBase64(rawCandidate.payload) ||
      !isNonEmptyString(rawCandidate.eventPayloadName) ||
      !Array.isArray(rawCandidate.tags)
    ) {
      return {
        error: error(
          400,
          "malformed_commit_envelope",
          "Each event candidate needs base64 payload, eventPayloadName, and tags",
        ),
      };
    }
    if (
      rawCandidate.tags.length === 0 ||
      !rawCandidate.tags.every(isNonEmptyString) ||
      new Set(rawCandidate.tags).size !== rawCandidate.tags.length
    ) {
      return { error: error(400, "validation_error", "Candidate tags must be unique non-empty strings") };
    }
    let eventType: string;
    let payload: string;
    try {
      if (Object.prototype.hasOwnProperty.call(rawCandidate, "eventPayloadVersion")) {
        throw new Error("V1 commit candidates must not contain eventPayloadVersion; the registered event definition is authoritative");
      }
      eventType = canonicalEventType(rawCandidate.eventPayloadName);
      const decoded = decodeBase64Utf8Json(rawCandidate.payload);
      assertNoPayloadDiscriminator(decoded.parsed);
      const parser = registeredEventParsers[rawCandidate.eventPayloadName];
      if (parser !== undefined) {
        let registered: unknown;
        try {
          registered = parser(decoded.parsed);
        } catch {
          throw new CommitPayloadAdmissionError("payload_case_mismatch", `Payload was rejected by registered ${rawCandidate.eventPayloadName} schema`);
        }
        assertExactMemberPaths(decoded.parsed, registered);
      }
      payload = decoded.text;
    } catch (identityError) {
      if (identityError instanceof CommitPayloadAdmissionError) {
        return { error: error(400, identityError.code, identityError.message) };
      }
      return { error: error(400, "invalid_event_identity", identityError instanceof Error ? identityError.message : "Event identity is invalid") };
    }
    eventCandidates.push({
      payload,
      eventPayloadName: rawCandidate.eventPayloadName,
      eventType,
      tags: [...rawCandidate.tags],
    });
  }

  const allTags = unique(eventCandidates.flatMap((candidate) => candidate.tags));
  const consistencyTags: ConsistencyTag[] = [];
  for (const rawTag of rawConsistencyTags) {
    if (!isObject(rawTag) || !isNonEmptyString(rawTag.tag) || !("lastSortableUniqueId" in rawTag)) {
      return { error: error(400, "malformed_commit_envelope", "Each consistency tag has a required V1 shape") };
    }
    if (rawTag.lastSortableUniqueId === null || typeof rawTag.lastSortableUniqueId !== "string") {
      return {
        error: error(
          400,
          "malformed_commit_envelope",
          "lastSortableUniqueId must be a non-null string; omit the entry for an unobserved tag",
        ),
      };
    }
    try {
      assertSortableUniqueId(rawTag.lastSortableUniqueId);
    } catch {
      return { error: error(400, "invalid_sortable_unique_id", "lastSortableUniqueId must be a 30-digit SortableUniqueId") };
    }
    if (!allTags.includes(rawTag.tag)) {
      return { error: error(400, "validation_error", "Each consistency tag must occur in an event candidate") };
    }
    consistencyTags.push({ tag: rawTag.tag, lastSortableUniqueId: rawTag.lastSortableUniqueId });
  }
  if (new Set(consistencyTags.map((entry) => entry.tag)).size !== consistencyTags.length) {
    return { error: error(400, "validation_error", "Consistency tags must be unique") };
  }

  return { value: { eventCandidates, consistencyTags, allTags } };
}

/**
 * Stateless request orchestrator. Every mutation is delegated to the durable
 * actor that owns it; this class retains only one request's generated IDs.
 */
export class CommitWorker {
  constructor(
    private readonly env: CommitWorkerEnv,
    private readonly serviceId: string,
    private readonly hooks: CommitWorkerHooks = {},
  ) {}

  async handle(request: Request): Promise<Response> {
    const workerObservation = beginWorkerInvocationObservation();
    // CF-Ray is provider-owned ingress identity. It is retained exclusively
    // in sdt.observe/v1 after admission; neither V1 JSON nor durable/internal
    // request shapes gain a diagnostic field.
    const requestId = request.headers.get("cf-ray")?.trim();
    const trace = new CommitTrace({
      schema: "sdt.commit/v1",
      correlationId: createTraceCorrelationId(),
      serviceId: this.serviceId,
      nativeTracing: this.hooks.nativeTracing,
      sink: this.hooks.commitTraceSink,
      clock: this.hooks.commitTraceClock,
      provider: this.hooks.commitTraceProvider,
      runtimeVerifier: runtimeCommitTraceVerifier,
      diagnostics: {
        "worker.isolate.id": workerObservation.isolateInstanceId,
        "worker.isolate.first": workerObservation.firstInvocation,
      },
    });
    return trace.root("S00", {
      actorKey: `root:${this.serviceId}`,
      // This is a trace-only observation generated at the handler boundary.
      // It is intentionally not persisted, used for control, or returned on
      // the V1 response.
      attributes: { "activation.first": workerObservation.firstInvocation },
    }, async (root) => {
      let workerObservationEmitted = false;
      const state: CommitTraceRequestState = {
        trace,
        scope: root,
        emitWorkerObservation: () => {
          if (workerObservationEmitted || requestId === undefined || requestId.length === 0) return;
          workerObservationEmitted = true;
          // This is deliberately a separate structured Workers Logs event.
          // It uses existing accepted identity without adding a span row,
          // storage write, control input, or V1 response field.
          observeWorkerInvocation({
            ...workerObservation,
            requestId,
            correlationId: trace.observationCorrelationId(),
            scriptVersion: this.hooks.commitTraceProvider?.scriptVersion,
            colo: this.hooks.commitTraceProvider?.colo,
          });
        },
      };
      const response = await this.handleUntraced(request, state);
      return state.scope.span("S15", { httpStatus: response.status }, async () => response);
    });
  }

  private async handleUntraced(
    request: Request,
    traceState?: CommitTraceRequestState,
  ): Promise<Response> {
    if (request.method !== "POST") {
      return error(404, "commit_route_not_found", "Commit route requires POST");
    }

    const decodeAndValidate = async (): Promise<ReturnType<typeof validateCommitEnvelope>> => {
      let body: unknown;
      try {
        body = await request.json<unknown>();
      } catch {
        return { error: error(400, "malformed_commit_envelope", "Commit envelope must be JSON") };
      }
      return validateCommitEnvelope(body, this.hooks.registeredEventParsers);
    };
    const validated = traceState === undefined
      ? await decodeAndValidate()
      : await traceState.scope.span("S01", {}, async () => decodeAndValidate());
    if ("error" in validated) {
      return validated.error;
    }

    const startedAt = Date.now();
    const input = validated.value;
    if (input.eventCandidates.length === 0) {
      return json({ writtenEvents: [], tagWriteResults: [], duration: durationSince(startedAt) });
    }

    const fault = faultFromRequest(request);
    const attemptId = fault === undefined
      ? crypto.randomUUID()
      : testAttemptIdFromRequest(request) ?? crypto.randomUUID();
    if (traceState !== undefined) {
      traceState.trace.markAccepted(attemptId);
      traceState.scope = traceState.scope.accepted(attemptId);
      traceState.emitWorkerObservation?.();
    }
    const writeTimestamp = writeTimestampUtc(startedAt);
    const candidates = input.eventCandidates.map((candidate) => ({
      ...candidate,
      eventId: createUuidV7(startedAt),
      timestamp: writeTimestamp,
    }));
    const bootstrapEpoch = await this.bootstrapCommand("admit", attemptId, undefined, traceState?.scope, "S02");
    if (bootstrapEpoch === undefined) {
      return responseWithAttempt(error(409, "bootstrap_command_rejected", "Bootstrap is importing; commit is unavailable"), attemptId, fault !== undefined);
    }
    // Admission only linearizes the entry check.  Do not retain it through
    // remote work: PLANNED may start after in-flight work reaches zero, and
    // the epoch check at the authoritative write is what fences that race.
    if ((await this.bootstrapCommand("release", attemptId, bootstrapEpoch, traceState?.scope, "S03")) === undefined) {
      return responseWithAttempt(error(409, "bootstrap_command_rejected", "Bootstrap admission could not be released"), attemptId, fault !== undefined);
    }
    try {
    const journal = this.journalFor(attemptId);
    const admitted = await this.postJson<JournalRecord>(journal, "/admit", {
      candidates: candidates.map(({ eventId, payload, eventType, tags, timestamp }) => ({ eventId, payload, eventType, tags, timestamp })),
      consistencyTags: input.consistencyTags,
      commitContext: {
        attemptId,
        serviceId: this.serviceId,
        ...(fault === "fence-not-durable" ? { testFenceNotDurable: true } : {}),
        ...(fault === "fence-install-partial" ? { testFenceInstallFaultOnce: true } : {}),
      },
    }, traceState?.scope, "S04");
    if (admitted.response.status !== 201 || admitted.body === undefined) {
      return responseWithAttempt(error(500, "internal_error", "Commit Journal admission failed"), attemptId, fault !== undefined);
    }

    // RESERVED means that the reservation phase is now durable. It permits a
    // pre-allocation REFUSED/FAILED only after the cancel barrier completes.
    const reserved = await this.transition(journal, admitted.body, "RESERVED", undefined, undefined, traceState?.scope);
    if (reserved === undefined) {
      return this.noApplicationOutcome(attemptId, fault !== undefined);
    }

    const reservations = await this.acquireReservations(input, attemptId, fault, traceState?.scope);
    if (reservations.failure !== undefined) {
      return this.finishReservationFailure(
        journal,
        reserved,
        input.consistencyTags,
        attemptId,
        reservations.failure,
        fault,
        traceState?.scope,
      );
    }

    await this.hooks.beforeBootstrapAllocation?.();
    const allocation = await this.allocate(candidates, attemptId, fault, bootstrapEpoch, traceState?.scope);
    if (allocation === undefined) {
      return this.finishReservationFailure(
        journal,
        reserved,
        input.consistencyTags,
        attemptId,
        {
          outcome: "FAILED",
          failureCause: "allocator-failure",
          reason: "allocator could not durably allocate the complete vector",
        },
        fault,
        traceState?.scope,
      );
    }
    const allocatedCandidates = this.withAllocatedSuids(candidates, allocation);
    if (allocatedCandidates === undefined) {
      return this.noApplicationOutcome(attemptId, fault !== undefined);
    }
    if (fault === "journal-cas-after-allocator") {
      return this.noApplicationOutcome(attemptId, true);
    }

    const allocated = await this.transition(journal, reserved, "ALLOCATED", undefined, allocation.allocatorLineageId, traceState?.scope);
    if (allocated === undefined) {
      return this.noApplicationOutcome(attemptId, fault !== undefined);
    }
    const writing = await this.transition(journal, allocated, "WRITING", undefined, undefined, traceState?.scope);
    if (writing === undefined) {
      return this.noApplicationOutcome(attemptId, fault !== undefined);
    }

    await this.hooks.beforeBootstrapFinalization?.();

    // This is immediately before the first final authoritative tag mutation.
    // The same service epoch obtained at admission must still be current.
    if ((await this.bootstrapCommand("finalize", attemptId, bootstrapEpoch, traceState?.scope, "S10")) === undefined) {
      return responseWithAttempt(error(409, "bootstrap_command_rejected", "Bootstrap fencing epoch changed before commit write"), attemptId, fault !== undefined);
    }

    const writesSucceeded = await this.appendAllTags(
      input,
      allocatedCandidates,
      attemptId,
      allocation.allocatorLineageId,
      reservations.successes,
      fault,
      traceState?.scope,
    );
    if (!writesSucceeded) {
      return this.handoffToAlarm(journal, writing, allocation, attemptId, fault, traceState?.scope);
    }

    const complete = await this.transition(journal, writing, "COMPLETE", undefined, undefined, traceState?.scope);
    if (complete === undefined) {
      return this.noApplicationOutcome(attemptId, fault !== undefined);
    }
    try {
      const success = await this.successResponse(input, allocatedCandidates, attemptId, startedAt, fault, traceState?.scope);
      return responseWithAttempt(json(success, 200), attemptId, fault !== undefined);
    } catch {
      return responseWithAttempt(
        error(500, "internal_error", "Committed records could not be read while preparing the response"),
        attemptId,
        fault !== undefined,
      );
    }
    } finally { /* the entry admission was deliberately released above */ }
  }

  private journalFor(attemptId: string): DurableObjectStub {
    return this.env.JOURNAL.get(this.env.JOURNAL.idFromName(attemptId));
  }

  private tagFor(tag: string): DurableObjectStub {
    return this.env.TAG.get(this.env.TAG.idFromName(`${this.serviceId}|${tag}`));
  }

  private async bootstrapCommand(
    action: "admit" | "finalize" | "release",
    commandId: string,
    leaseEpoch?: number,
    traceScope?: CommitTraceScope,
    rowId?: "S02" | "S03" | "S10",
  ): Promise<number | undefined> {
    if (this.env.BOOTSTRAP === undefined) return 0;
    const invoke = async (): Promise<{ readonly response: Response; readonly leaseEpoch: number | undefined }> => {
      const url = new URL(`https://commit-worker.internal/command/${action}`);
      url.searchParams.set("__serviceId", this.serviceId);
      const response = await this.env.BOOTSTRAP!.get(this.env.BOOTSTRAP!.idFromName(this.serviceId)).fetch(new Request(url, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commandId, ...(leaseEpoch === undefined ? {} : { leaseEpoch }) }),
      }));
      if (!response.ok) return { response, leaseEpoch: undefined };
      const body = await response.clone().json().catch(() => undefined) as { leaseEpoch?: unknown } | undefined;
      return { response, leaseEpoch: typeof body?.leaseEpoch === "number" ? body.leaseEpoch : undefined };
    };
    const result = traceScope === undefined || rowId === undefined
      ? await invoke()
      : await traceScope.span(rowId, {}, invoke);
    return result.leaseEpoch;
  }

  private async postJson<T>(
    stub: DurableObjectStub,
    path: string,
    body: unknown,
    traceScope?: CommitTraceScope,
    rowId?: string,
    traceOptions: Parameters<CommitTraceScope["span"]>[1] = {},
  ): Promise<{ response: Response; body?: T }> {
    const invoke = async (): Promise<{ response: Response; body?: T }> => {
      const response = await stub.fetch(
        new Request(`https://commit-worker.internal${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      let parsed: T | undefined;
      try {
        parsed = (await response.clone().json()) as T;
      } catch {
        // Callers use the status first; malformed internal bodies are failures.
      }
      return { response, body: parsed };
    };
    return traceScope === undefined || rowId === undefined
      ? invoke()
      : traceScope.span(rowId, traceOptions, invoke);
  }

  private async tagRequest(
    tag: string,
    path: string,
    body?: unknown,
    traceScope?: CommitTraceScope,
    rowId?: string,
    traceOptions: { readonly memberIndex?: number; readonly retryIndex?: number; readonly attemptId?: string } = {},
  ): Promise<Response> {
    const invoke = async (): Promise<Response> => {
      const url = new URL(`https://commit-worker.internal${path}`);
      url.searchParams.set("__tag", tag);
      url.searchParams.set("__serviceId", this.serviceId);
      if (path === "/append" && this.hooks.domainDeliveryClass !== undefined) {
        url.searchParams.set("__domainDeliveryClass", this.hooks.domainDeliveryClass);
      }
      return this.tagFor(tag).fetch(new Request(url.toString(), {
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" } }),
      }));
    };
    return traceScope === undefined || rowId === undefined
      ? invoke()
      : traceScope.span(rowId, { tag, ...traceOptions }, invoke);
  }

  private async transition(
    journal: DurableObjectStub,
    record: JournalRecord,
    nextState: JournalRecord["state"],
    terminalReason?: string,
    allocatorLineageId?: string,
    traceScope?: CommitTraceScope,
  ): Promise<JournalRecord | undefined> {
    const trace = JOURNAL_TRANSITION_TRACE[nextState];
    const result = await this.postJson<JournalRecord>(journal, "/transition", {
      expectedState: record.state,
      expectedVersion: record.version,
      expectedOwnerEpoch: record.ownerEpoch,
      nextState,
      terminalReason,
      ...(allocatorLineageId === undefined ? {} : { allocatorLineageId }),
    }, traceScope, trace?.rowId, trace === undefined ? {} : { phaseOrdinal: trace.phaseOrdinal });
    return result.response.status === 200 ? result.body : undefined;
  }

  private async acquireReservations(
    input: ValidatedCommitEnvelope,
    attemptId: string,
    fault: CommitTestFault | undefined,
    traceScope?: CommitTraceScope,
  ): Promise<ReservationAttempt> {
    const acquire = (stageScope?: CommitTraceScope) => Promise.allSettled(
      input.consistencyTags.map(async (entry) => ({
        tag: entry.tag,
        response: await this.tagRequest(entry.tag, "/acquire", {
          attemptId,
          epoch: INITIAL_OWNER_EPOCH,
          eventTags: input.allTags,
          consistencyTags: input.consistencyTags,
        }, stageScope?.fork(), stageScope === undefined ? undefined : "S07", {
          memberIndex: input.consistencyTags.findIndex((candidate) => candidate.tag === entry.tag),
          attemptId,
        }),
      })),
    );
    const responses = traceScope === undefined
      ? await acquire()
      : await traceScope.span("S06", {}, async (stage) => acquire(stage));
    const successes = new Map<string, ReservationSuccess>();
    let failure: ReservationFailure | undefined;
    for (const result of responses) {
      if (result.status === "rejected") {
        failure ??= {
          outcome: "FAILED",
          failureCause: "reservation-timeout",
          reason: "a consistency reservation provider did not settle successfully",
        };
        continue;
      }
      const { tag, response } = result.value;
      const body = await response.clone().json().catch(() => undefined) as JsonObject | undefined;
      const reservation = isObject(body) && isObject(body.reservation) ? body.reservation : undefined;
      if (
        response.status >= 200 &&
        response.status < 300 &&
        reservation !== undefined &&
        isNonEmptyString(reservation.token)
      ) {
        successes.set(tag, { tag, reservationToken: reservation.token });
        continue;
      }
      const code = isObject(body) && typeof body.code === "string" ? body.code : undefined;
      if (response.status === 500 && code === "internal_error") {
        failure ??= {
          outcome: "FAILED",
          failureCause: "guard-rejection",
          reason: "a consistency tag is fenced while its durable state is reconciled",
        };
        continue;
      }
      const reason = isObject(body) && typeof body.reason === "string" ? body.reason : "reservation provider rejected the attempt";
      const logical = reason === "consistency_head_mismatch" || reason === "active_reservation_conflict";
      failure ??= logical
        ? { outcome: "REFUSED", failureCause: "reservation-conflict", reason }
        : { outcome: "FAILED", failureCause: "reservation-timeout", reason };
    }
    if (fault === "reservation-delayed-success" && successes.size > 0) {
      failure = {
        outcome: "FAILED",
        failureCause: "reservation-timeout",
        reason: "simulated delayed reservation success after an unavailable response",
      };
    }
    return { successes, failure };
  }

  private async allocate(
    candidates: Array<{ eventId: string }>,
    attemptId: string,
    fault: CommitTestFault | undefined,
    bootstrapEpoch: number,
    traceScope?: CommitTraceScope,
  ): Promise<AllocationVector | undefined> {
    const allocator = this.env.ALLOCATOR.get(this.env.ALLOCATOR.idFromName(this.hooks.allocatorName ?? allocatorNameForService(this.serviceId)));
    try {
      const result = await this.postJson<AllocationVector>(allocator, "/allocate", {
        attemptId,
        serviceId: this.serviceId,
        bootstrapCommandId: attemptId,
        bootstrapEpoch,
        candidates: candidates.map((candidate, candidateIndex) => ({ candidateIndex, eventId: candidate.eventId })),
        faultInjection: fault === "allocator-commit" ? "between-vector-and-watermark" : undefined,
      }, traceScope, "S08");
      if (result.response.status >= 200 && result.response.status < 300 && result.body !== undefined) {
        return result.body;
      }
    } catch {
      // A lost response is not evidence that allocation did not commit.
    }
    return this.readAllocation(allocator, attemptId);
  }

  private async readAllocation(
    allocator: DurableObjectStub,
    attemptId: string,
  ): Promise<AllocationVector | undefined> {
    try {
      const response = await allocator.fetch(
        new Request(`https://commit-worker.internal/attempts/${encodeURIComponent(attemptId)}`),
      );
      if (response.status !== 200) {
        return undefined;
      }
      const vector = (await response.json()) as AllocationVector;
      return Array.isArray(vector.candidates) ? vector : undefined;
    } catch {
      return undefined;
    }
  }

  private withAllocatedSuids(
    candidates: Array<{ eventId: string; payload: string; eventPayloadName: string; eventType: string; tags: string[]; timestamp: string }>,
    vector: AllocationVector,
  ): AllocatedCommitCandidate[] | undefined {
    if (vector.candidates.length !== candidates.length) {
      return undefined;
    }
    const suids = new Map(vector.candidates.map((candidate) => [candidate.eventId, candidate.suid]));
    const allocated = candidates.map((candidate) => {
      const suid = suids.get(candidate.eventId);
      return suid === undefined ? undefined : { ...candidate, suid };
    });
    return allocated.every((candidate): candidate is AllocatedCommitCandidate => candidate !== undefined)
      ? allocated
      : undefined;
  }

  private async appendAllTags(
    input: ValidatedCommitEnvelope,
    candidates: AllocatedCommitCandidate[],
    attemptId: string,
    allocatorLineageId: string,
    reservations: Map<string, ReservationSuccess>,
    fault: CommitTestFault | undefined,
    traceScope?: CommitTraceScope,
  ): Promise<boolean> {
    let pending = [...input.allTags];
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS && pending.length > 0; attempt += 1) {
      const append = (stageScope?: CommitTraceScope) => Promise.allSettled(
        pending.map(async (tag) => {
          const injectFault =
            fault === "tag-append-always" ||
            ((fault === "tag-append-last" ||
              fault === "fence-not-durable" ||
              fault === "fence-install-partial") &&
              tag === input.allTags[input.allTags.length - 1]);
          const response = await this.tagRequest(tag, "/append", {
            attemptId,
            epoch: INITIAL_OWNER_EPOCH,
            allocatorLineageId,
            reservationToken: reservations.get(tag)?.reservationToken,
            candidates: candidates
              .filter((candidate) => candidate.tags.includes(tag))
              .map(({ eventId, suid, payload, eventType, tags, timestamp }) => ({
                eventId,
                suid,
                payload,
                eventType,
                provenance: "g32" as const,
                eventTags: tags,
                allocatorLineageId,
                timestamp,
            })),
            faultInjection: injectFault ? "after-append-before-confirm" : undefined,
          }, stageScope?.fork(), stageScope === undefined ? undefined : "S12", {
            memberIndex: input.allTags.findIndex((candidate) => candidate === tag),
            retryIndex: attempt,
            attemptId,
          });
          return { tag, success: response.status >= 200 && response.status < 300 };
        }),
      );
      const results = traceScope === undefined
        ? await append()
        : await traceScope.span("S11", { retryIndex: attempt }, async (stage) => append(stage));
      pending = results.flatMap((result, index) =>
        result.status === "fulfilled" && result.value.success ? [] : [pending[index]!],
      );
    }
    return pending.length === 0;
  }

  private async handoffToAlarm(
    journal: DurableObjectStub,
    writing: JournalRecord,
    allocation: AllocationVector,
    attemptId: string,
    fault: CommitTestFault | undefined,
    traceScope?: CommitTraceScope,
  ): Promise<Response> {
    const sealing = await this.postJson<JournalRecord>(journal, "/reconcile", {
      expectedState: writing.state,
      expectedVersion: writing.version,
      expectedOwnerEpoch: writing.ownerEpoch,
      reconciliation: {
        allocatorVector: allocation.candidates.map((candidate) => candidate.suid),
        records: [],
        failureCause: "write-failure",
      },
    }, traceScope, "S20");
    if (sealing.response.status !== 200 || sealing.body?.state !== "SEALING") {
      return this.noApplicationOutcome(attemptId, fault !== undefined);
    }
    if (fault === "sealing-after-cas") {
      return this.noApplicationOutcome(attemptId, true);
    }

    // The state transition itself sets an immediate durable alarm. Triggering
    // the same handler here only allows a still-live HTTP request to return a
    // terminal §7 report; it never lets the worker choose that outcome.
    for (let wake = 0; wake < 3; wake += 1) {
      const recovered = await this.postJson<JournalRecord>(journal, "/debug/alarm", {});
      if (recovered.response.status === 200 && recovered.body !== undefined) {
        const mapped = mapTerminalCommitOutcome(recovered.body);
        if (mapped !== undefined) {
          return responseWithAttempt(json(mapped.body, mapped.status), attemptId, fault !== undefined);
        }
      }
    }
    return this.noApplicationOutcome(attemptId, fault !== undefined);
  }

  private async finishReservationFailure(
    journal: DurableObjectStub,
    reserved: JournalRecord,
    consistencyTags: ConsistencyTag[],
    attemptId: string,
    failure: ReservationFailure,
    fault: CommitTestFault | undefined,
    traceScope?: CommitTraceScope,
  ): Promise<Response> {
    const classified = await this.postJson<JournalRecord>(journal, "/reservation-failure", {
      expectedState: reserved.state,
      expectedVersion: reserved.version,
      expectedOwnerEpoch: reserved.ownerEpoch,
      outcome: failure.outcome,
      failureCause: failure.failureCause,
      reason: failure.reason,
    }, traceScope, "S17");
    if (classified.response.status !== 200 || classified.body === undefined) {
      return this.noApplicationOutcome(attemptId, fault !== undefined);
    }
    const cancel = (stageScope?: CommitTraceScope) => Promise.allSettled(
      consistencyTags.map(async ({ tag }, memberIndex) => {
        const response = await this.tagRequest(tag, "/cancel", {
          attemptId,
          epoch: INITIAL_OWNER_EPOCH,
          forceTombstone: true,
        }, stageScope?.fork(), stageScope === undefined ? undefined : "S19", { memberIndex, attemptId });
        return response.status >= 200 && response.status < 300;
      }),
    );
    const cancelled = traceScope === undefined
      ? await cancel()
      : await traceScope.span("S18", {}, async (stage) => cancel(stage));
    if (!cancelled.every((result) => result.status === "fulfilled" && result.value)) {
      return this.noApplicationOutcome(attemptId, fault !== undefined);
    }
    if (fault === "tombstone-after-durable") {
      return this.noApplicationOutcome(attemptId, true);
    }
    const terminal = await this.transition(journal, classified.body, failure.outcome, failure.reason, undefined, traceScope);
    if (terminal === undefined) {
      return this.noApplicationOutcome(attemptId, fault !== undefined);
    }
    const mapped = mapTerminalCommitOutcome(terminal);
    return mapped === undefined
      ? this.noApplicationOutcome(attemptId, fault !== undefined)
      : responseWithAttempt(json(mapped.body, mapped.status), attemptId, fault !== undefined);
  }

  private async successResponse(
    input: ValidatedCommitEnvelope,
    candidates: AllocatedCommitCandidate[],
    attemptId: string,
    startedAt: number,
    fault: CommitTestFault | undefined,
    traceScope?: CommitTraceScope,
  ): Promise<CompleteCommitResponse> {
    const readStates = (stageScope?: CommitTraceScope) => Promise.all(input.allTags.map(async (tag, memberIndex): Promise<TagWriteResultResponse> => {
      if (fault === "tag-state-unavailable") {
        throw new Error("Test fault made the committed tag state unavailable");
      }
      const response = await this.tagRequest(tag, "/state", undefined, stageScope?.fork(), stageScope === undefined ? undefined : "S14", { memberIndex, attemptId });
      if (response.status !== 200) {
        throw new Error("Committed tag state was unavailable while preparing the response");
      }
      const body = (await response.json()) as Partial<TagStateResponse>;
      if (typeof body.version !== "number" || typeof body.updatedAt !== "string") {
        throw new Error("Committed tag state was malformed while preparing the response");
      }
      return { tag, version: body.version, writtenAt: body.updatedAt };
    }));
    const tagWriteResults = traceScope === undefined
      ? await readStates()
      : await traceScope.span("S13", {}, async (stage) => readStates(stage));
    return {
      writtenEvents: candidates.map((candidate) => ({
        payload: encodeBase64Utf8(candidate.payload),
        sortableUniqueIdValue: candidate.suid,
        id: candidate.eventId,
        eventMetadata: serializedEventMetadata(candidate.eventId),
        tags: candidate.tags,
        eventPayloadName: candidate.eventPayloadName,
      })),
      tagWriteResults,
      duration: durationSince(startedAt),
    };
  }

  /** The request lifetime ended before the Journal made an authoritative outcome durable. */
  private noApplicationOutcome(attemptId: string, exposeAttempt: boolean): Response {
    return responseWithAttempt(error(504, "timeout", OUTCOME_UNDETERMINED_ERROR), attemptId, exposeAttempt);
  }
}

export async function handleSerializedCommit(request: Request, env: CommitWorkerEnv, hooks: CommitWorkerHooks = {}): Promise<Response> {
  return new CommitWorker(env, serviceIdForRequest(request, {
    allowG11Verification: env.G11_VERIFICATION_ENABLED === "true",
    configuredServiceId: env.SDT_SERVICE_ID,
  }), hooks).handle(request);
}
