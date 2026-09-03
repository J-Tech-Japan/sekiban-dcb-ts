import type { AllocationVector } from "../allocator/types";
import type { ConsistencyTag, ReconciliationFailureCause } from "../journal/types";
import {
  durationSince,
  type CompleteCommitResponse,
  type TagWriteResultResponse,
} from "../http/commitResponse";
import {
  COMMIT_TEST_FAULTS,
  type AllocatedCommitCandidate,
  type CommitTestFault,
  type ValidatedCommitEnvelope,
} from "./types";
import type { DeliveryClass } from "../downstream/Doorbell";
import { canonicalEventType } from "../eventIdentity";
import { createUuidV7, serializedEventMetadata, writeTimestampUtc } from "../eventRecord";
import { assertSortableUniqueId } from "../allocator/SortableUniqueId";
import { PARTIAL_WRITE_FENCE_REASON, type TagHeadFacts } from "../tag/types";
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
import { observeWorkerInvocation, type ObservationLogSink } from "../trace/ObservationStream";
import { verifyCommitTrace } from "../trace/CommitTraceVerifier";
import { scopeIdFor } from "../scope/ScopeName";
import {
  envServiceIdentity,
  requestServiceIdentity,
  type ServiceIdentityProvider,
} from "../service/ServiceIdentityProvider";
import type { G60DurableHopObserver } from "../diagnostics/G60DurableHop";

const INITIAL_OWNER_EPOCH = 0;
const MAX_WRITE_ATTEMPTS = 2;
const OUTCOME_UNDETERMINED_ERROR =
  "Commit outcome is undetermined; reread tag heads and event/query state before retrying because blind retry may create duplicate events.";
type JsonObject = Record<string, unknown>;

export interface CommitWorkerEnv {
  ALLOCATOR: DurableObjectNamespace;
  /**
   * Retained for the G42 probe and RepairWorker routes.  CommitWorker must
   * never resolve this namespace after G41: tags own prepare/commit facts.
   */
  JOURNAL?: DurableObjectNamespace;
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
  /** Test-only allocator identity; production uses the canonical allocator identity. */
  allocatorScopeIdentity?: string;
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
  /** Test-only sink injection; production emits the structured log normally. */
  workerObservationSink?: ObservationLogSink;
  /** G60 internal durable hop observation; never changes the V1 wire. */
  durableHopObserver?: G60DurableHopObserver;
  /** Host/deployment identity seam; absent callers receive the env-backed default. */
  serviceIdentityProvider?: ServiceIdentityProvider;
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

interface AppendAttempt {
  readonly committedTags: ReadonlySet<string>;
  readonly pendingTags: readonly string[];
}

interface CommitTraceRequestState {
  readonly trace: CommitTrace;
  scope: CommitTraceScope;
  enableWorkerObservation?: () => void;
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
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new CommitPayloadAdmissionError("invalid_payload_utf8", "Payload must not start with a UTF-8 BOM");
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
  if (!isObject(value)) {
    return { error: error(400, "malformed_commit_envelope", "Commit envelope must contain numeric version 1") };
  }
  const clientModelAliasMembers = ["candidates", "consistency"].filter(
    (member) => Object.prototype.hasOwnProperty.call(value, member),
  );
  if (typeof value.version !== "number") {
    if (clientModelAliasMembers.length > 0) {
      return {
        error: error(
          400,
          "malformed_commit_envelope",
          `Client-model member(s) ${clientModelAliasMembers.join(", ")} require the transport adapter; use version 1 with eventCandidates and consistencyTags on the V1 wire.`,
        ),
      };
    }
    return { error: error(400, "malformed_commit_envelope", "Commit envelope must contain numeric version 1") };
  }
  if (value.version !== 1) {
    return {
      error: error(400, "unsupported_commit_envelope_version", "Only serialized commit envelope version 1 is supported"),
    };
  }

  const missingV1ArrayMembers = ["eventCandidates", "consistencyTags"].filter(
    (member) => !Object.prototype.hasOwnProperty.call(value, member),
  );
  if (missingV1ArrayMembers.length > 0 || clientModelAliasMembers.length > 0) {
    const missing = missingV1ArrayMembers.length === 0
      ? ""
      : `Missing required V1 member(s): ${missingV1ArrayMembers.join(", ")}. `;
    const aliases = clientModelAliasMembers.length === 0
      ? ""
      : `Client-model member(s) ${clientModelAliasMembers.join(", ")} require the transport adapter; use eventCandidates and consistencyTags on the V1 wire. `;
    return { error: error(400, "malformed_commit_envelope", `${missing}${aliases}`.trim()) };
  }

  if (value.eventCandidates === undefined) {
    return { error: error(400, "malformed_commit_envelope", "eventCandidates must be an array") };
  }
  if (value.consistencyTags === undefined) {
    return { error: error(400, "malformed_commit_envelope", "consistencyTags must be an array") };
  }

  // The explicit required-member check above intentionally stays separate
  // from these historical defaults. Its omission mutant restores the former
  // fail-open behavior, while the shipped path still permits explicit []
  // members exactly as the V1 contract does.
  const rawCandidates = value.eventCandidates ?? [];
  const rawConsistencyTags = value.consistencyTags ?? [];
  if (!Array.isArray(rawCandidates)) {
    return { error: error(400, "malformed_commit_envelope", "eventCandidates must be an array") };
  }
  if (!Array.isArray(rawConsistencyTags)) {
    return { error: error(400, "malformed_commit_envelope", "consistencyTags must be an array") };
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
      let workerObservationEligible = false;
      const state: CommitTraceRequestState = {
        trace,
        scope: root,
        enableWorkerObservation: () => {
          workerObservationEligible = true;
        },
        emitWorkerObservation: () => {
          if (!workerObservationEligible || workerObservationEmitted || requestId === undefined || requestId.length === 0) return;
          workerObservationEmitted = true;
          // This is deliberately a separate structured Workers Logs event.
          // It uses existing accepted identity without adding a span row,
          // storage write, control input, or V1 response field.
          observeWorkerInvocation({
            ...workerObservation,
            requestId,
            correlationId: trace.observationCorrelationId(),
            emittedWorkerRowIds: trace.emittedWorkerRowIds(),
            scriptVersion: this.hooks.commitTraceProvider?.scriptVersion,
            colo: this.hooks.commitTraceProvider?.colo,
          }, this.hooks.workerObservationSink);
        },
      };
      try {
        const response = await this.handleUntraced(request, state);
        // The one Worker observation is emitted only after S15 has settled,
        // so its inventory covers every native Worker span entered by this
        // request. Its console transport remains observation-only and is not
        // awaited as part of the V1 response.
        return await state.scope.span("S15", { httpStatus: response.status }, async () => response);
      } finally {
        state.emitWorkerObservation?.();
      }
    });
  }

  private async handleUntraced(
    request: Request,
    traceState?: CommitTraceRequestState,
  ): Promise<Response> {
    if (request.method !== "POST") {
      return error(404, "commit_route_not_found", "Commit route requires POST");
    }
    const commandReceivedAt = Date.now();

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
      traceState.enableWorkerObservation?.();
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
    // G41: there is no attempt-level Journal admission or state machine on
    // this path.  A tag reservation is the durable prepare fact and every
    // tag's local append transaction is the commit fact.  The retained S04 /
    // S05 trace identities are compatibility observations only; they cannot
    // resolve JOURNAL and are removed from the actual dependency path.
    await this.retiredJournalMilestone("S04", traceState?.scope);
    const reservations = await this.acquireReservations(input, attemptId, fault, traceState?.scope);
    await this.retiredJournalMilestone("S05a", traceState?.scope, 0);
    if (reservations.failure !== undefined) {
      return this.finishReservationFailure(
        [...reservations.successes.keys()],
        attemptId,
        reservations.failure,
        fault,
        traceState?.scope,
      );
    }

    if (fault === "after-reservations-before-allocation") {
      // Boundary 1: every durable prepare fact is force-tombstoned before
      // returning the intentionally undetermined outcome.  There is no
      // attempt-level Journal recovery record to make this safe later.
      await this.cancelReservations([...reservations.successes.keys()], attemptId, fault, traceState?.scope);
      return this.noApplicationOutcome(attemptId, true);
    }

    await this.hooks.beforeBootstrapAllocation?.();
    const allocation = await this.allocate(candidates, attemptId, fault, bootstrapEpoch, traceState?.scope);
    if (allocation === undefined) {
      return this.finishReservationFailure(
        [...reservations.successes.keys()],
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
      await this.cancelReservations([...reservations.successes.keys()], attemptId, fault, traceState?.scope);
      return this.noApplicationOutcome(attemptId, fault !== undefined);
    }
    // Allocation supplies the exact EventId/SUID pair needed by the durable
    // operational ledger. The timestamp is captured at the request boundary;
    // the observer writes after the response path through waitUntil and never
    // becomes an admission, ordering, or response dependency.
    for (const candidate of allocatedCandidates) {
      this.hooks.durableHopObserver?.observe({
        stage: "command-receipt",
        serviceId: this.serviceId,
        eventId: candidate.eventId,
        suid: candidate.suid,
        attemptId,
        observedAt: commandReceivedAt,
      });
    }
    await this.retiredJournalMilestone("S05b", traceState?.scope, 1);
    if (fault === "journal-cas-after-allocator") {
      // This retained fault marks the allocation-to-first-append crash
      // boundary.  With no Journal alarm, tags receive the same best-effort
      // tombstone barrier immediately and retain their own expiry alarm.
      await this.cancelReservations(input.allTags, attemptId, fault, traceState?.scope);
      return this.noApplicationOutcome(attemptId, true);
    }

    await this.retiredJournalMilestone("S05c", traceState?.scope, 2);
    await this.hooks.beforeBootstrapFinalization?.();

    // This is immediately before the first final authoritative tag mutation.
    // The same service epoch obtained at admission must still be current.
    if ((await this.bootstrapCommand("finalize", attemptId, bootstrapEpoch, traceState?.scope, "S10")) === undefined) {
      await this.cancelReservations(input.allTags, attemptId, fault, traceState?.scope);
      return responseWithAttempt(error(409, "bootstrap_command_rejected", "Bootstrap fencing epoch changed before commit write"), attemptId, fault !== undefined);
    }

    const writes = await this.appendAllTags(
      input,
      allocatedCandidates,
      attemptId,
      allocation.allocatorLineageId,
      reservations.successes,
      fault,
      traceState?.scope,
    );
    if (writes.pendingTags.length > 0) {
      // Cancel is deliberately best effort: a cancellation error cannot
      // replace the primary partial-write outcome or delete a committed row.
      await this.cancelReservations(input.allTags, attemptId, fault, traceState?.scope);
      // A missing participant must retain a tag-local, durable partial fact.
      // This is the direct replacement for Journal reconciliation's
      // /fence/install loop: G44 can discover the incomplete source universe
      // without a delivery, and G45/G46 retain a readable fenced frontier.
      if (!await this.installPartialWriteFences(writes.pendingTags, attemptId, traceState?.scope)) {
        return this.noApplicationOutcome(attemptId, true);
      }
      return this.partialWriteOutcome(input, allocatedCandidates, writes, attemptId, fault !== undefined);
    }
    await this.retiredJournalMilestone("S05d", traceState?.scope, 3);
    if (fault === "sealing-after-cas") {
      // The all-tags-written/response-lost boundary has no single terminal
      // Journal response.  Durable tag receipts and G44 reconciliation are
      // now the detection authority.
      return this.noApplicationOutcome(attemptId, true);
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
  }

  private tagFor(tag: string): DurableObjectStub {
    return this.env.TAG.get(scopeIdFor(this.env.TAG, {
      serviceId: this.serviceId,
      doClass: "tag",
      identity: tag,
    }));
  }

  /**
   * `sdt.commit/v1` still has the historical S04/S05 row identities in its
   * separately-owned G30 manifest.  G41 keeps those observations zero-work
   * until that trace schema is revised by its owner, while proving that they
   * cannot perform a JOURNAL namespace operation.  These spans are not a
   * substitute for a Journal record or terminal-outcome authority.
   */
  private async retiredJournalMilestone(
    rowId: "S04" | "S05a" | "S05b" | "S05c" | "S05d" | "S05e",
    traceScope?: CommitTraceScope,
    phaseOrdinal?: number,
  ): Promise<void> {
    if (traceScope === undefined) return;
    await traceScope.span(rowId, phaseOrdinal === undefined ? {} : { phaseOrdinal }, async () => undefined);
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
      const response = await this.env.BOOTSTRAP!.get(scopeIdFor(this.env.BOOTSTRAP!, {
        serviceId: this.serviceId,
        doClass: "bootstrap",
        identity: "coordinator",
      })).fetch(new Request(url, {
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
    const allocator = this.env.ALLOCATOR.get(scopeIdFor(this.env.ALLOCATOR, {
      serviceId: this.serviceId,
      doClass: "allocator",
      identity: this.hooks.allocatorScopeIdentity ?? "allocator",
    }));
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
  ): Promise<AppendAttempt> {
    let pending = [...input.allTags];
    const committedTags = new Set<string>();
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
      const nextPending: string[] = [];
      for (const [index, result] of results.entries()) {
        const tag = pending[index]!;
        if (result.status === "fulfilled" && result.value.success) {
          committedTags.add(tag);
        } else {
          nextPending.push(tag);
        }
      }
      pending = nextPending;
    }
    return { committedTags, pendingTags: pending };
  }

  /**
   * Settle the same force-tombstone barrier used by the durable reservation
   * failure path.  A concurrently-started admission can reject after one or
   * more acquire calls have succeeded; in that branch there is no terminal
   * Journal record to perform this cleanup on the caller's behalf.
   */
  private async cancelReservations(
    tags: readonly string[],
    attemptId: string,
    fault: CommitTestFault | undefined,
    traceScope?: CommitTraceScope,
  ): Promise<Readonly<{ readonly attemptedTags: readonly string[]; readonly failedTags: readonly string[] }>> {
    const cancel = (stageScope?: CommitTraceScope) => Promise.allSettled(
      tags.map(async (tag, memberIndex) => {
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
    const failedTags = cancelled.flatMap((result, index) =>
      result.status === "fulfilled" && result.value ? [] : [tags[index]!],
    );
    // A test-only fault models an acknowledgement loss after the target
    // performed its durable tombstone write.  Either way, cancellation is
    // never allowed to replace the primary prepare/commit result.
    if (fault === "tombstone-after-durable" && tags.length > 0 && !failedTags.includes(tags[0]!)) {
      failedTags.push(tags[0]!);
    }
    return Object.freeze({ attemptedTags: [...tags], failedTags });
  }

  private async finishReservationFailure(
    tags: readonly string[],
    attemptId: string,
    failure: ReservationFailure,
    fault: CommitTestFault | undefined,
    traceScope?: CommitTraceScope,
  ): Promise<Response> {
    if (traceScope !== undefined) {
      await traceScope.span("S17", {}, async () => undefined);
    }
    await this.cancelReservations(tags, attemptId, fault, traceScope);
    await this.retiredJournalMilestone("S05e", traceScope, 4);
    const response = failure.outcome === "REFUSED"
      ? error(400, "consistency_conflict", "serialized commit was refused by a consistency reservation")
      : failure.failureCause === "reservation-timeout"
        ? error(504, "timeout", "serialized commit timed out")
        : error(500, "internal_error", "serialized commit failed before writing requested records");
    return responseWithAttempt(response, attemptId, fault !== undefined);
  }

  /**
   * Persist the local partial-write fact for each tag whose append did not
   * commit.  This is not a response decoration: the Tag DO's fence is the
   * source-side authority used by read and repair/reconciliation seams.
   */
  private async installPartialWriteFences(
    tags: readonly string[],
    attemptId: string,
    traceScope?: CommitTraceScope,
  ): Promise<boolean> {
    const install = (stageScope?: CommitTraceScope) => Promise.allSettled(
      tags.map(async (tag) => {
        const response = await this.tagRequest(tag, "/fence/install", {
          attemptId,
          epoch: INITIAL_OWNER_EPOCH,
          reason: PARTIAL_WRITE_FENCE_REASON,
        }, stageScope?.fork());
        return response.status >= 200 && response.status < 300;
      }),
    );
    // S20 remains the frozen G30 observation boundary, but now covers the
    // actual tag-owned partial-fact transition rather than a Journal handoff.
    const installed = traceScope === undefined
      ? await install()
      : await traceScope.span("S20", {}, async (stage) => install(stage));
    return installed.every((result) => result.status === "fulfilled" && result.value);
  }

  private async partialWriteOutcome(
    input: ValidatedCommitEnvelope,
    candidates: readonly AllocatedCommitCandidate[],
    writes: AppendAttempt,
    attemptId: string,
    exposeAttempt: boolean,
  ): Promise<Response> {
    const writtenEventIds = candidates
      .filter((candidate) => candidate.tags.some((tag) => writes.committedTags.has(tag)))
      .map((candidate) => candidate.eventId);
    const failedEventIds = candidates
      .filter((candidate) => !writtenEventIds.includes(candidate.eventId))
      .map((candidate) => candidate.eventId);
    return responseWithAttempt(json({
      error: "serialized commit partially failed",
      code: "partial_write",
      partial: {
        writtenEventIds,
        failedEventIds,
        writtenTags: input.allTags.filter((tag) => writes.committedTags.has(tag)),
        missingTags: [...writes.pendingTags],
        eventsDeleted: false,
        retryable: false,
      },
    }, 500), attemptId, exposeAttempt);
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
      const response = await this.tagRequest(tag, "/head-facts", undefined, stageScope?.fork(), stageScope === undefined ? undefined : "S14", { memberIndex, attemptId });
      if (response.status !== 200) {
        throw new Error("Committed tag state was unavailable while preparing the response");
      }
      const body = (await response.json()) as Partial<TagHeadFacts>;
      if (typeof body.version !== "number" || typeof body.updatedAt !== "string" || typeof body.head !== "string") {
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

  /** The response was lost after tag-local facts may already be authoritative. */
  private noApplicationOutcome(attemptId: string, exposeAttempt: boolean): Response {
    return responseWithAttempt(error(504, "timeout", OUTCOME_UNDETERMINED_ERROR), attemptId, exposeAttempt);
  }
}

export async function handleSerializedCommit(request: Request, env: CommitWorkerEnv, hooks: CommitWorkerHooks = {}): Promise<Response> {
  const serviceIdentity = hooks.serviceIdentityProvider ?? envServiceIdentity(env);
  return new CommitWorker(env, requestServiceIdentity(request, serviceIdentity, {
    allowG11Verification: env.G11_VERIFICATION_ENABLED === "true",
  }), hooks).handle(request);
}
