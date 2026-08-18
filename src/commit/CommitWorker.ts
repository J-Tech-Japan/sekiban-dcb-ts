import type { AllocationVector } from "../allocator/types";
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
import { SERIALIZED_DCB_SERVICE_ID, serviceIdForRequest } from "../http/testServiceId";

const INITIAL_OWNER_EPOCH = 0;
const MAX_WRITE_ATTEMPTS = 2;
const OUTCOME_UNDETERMINED_ERROR =
  "Commit outcome is undetermined; reread tag heads and event/query state before retrying because blind retry may create duplicate events.";

type JsonObject = Record<string, unknown>;

export interface CommitWorkerEnv {
  ALLOCATOR: DurableObjectNamespace;
  JOURNAL: DurableObjectNamespace;
  TAG: DurableObjectNamespace;
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
export function validateCommitEnvelope(value: unknown):
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
    eventCandidates.push({
      payload: rawCandidate.payload,
      eventPayloadName: rawCandidate.eventPayloadName,
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
    private readonly serviceId = SERIALIZED_DCB_SERVICE_ID,
  ) {}

  async handle(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return error(404, "commit_route_not_found", "Commit route requires POST");
    }

    let body: unknown;
    try {
      body = await request.json<unknown>();
    } catch {
      return error(400, "malformed_commit_envelope", "Commit envelope must be JSON");
    }
    const validated = validateCommitEnvelope(body);
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
    const candidates = input.eventCandidates.map((candidate) => ({ ...candidate, eventId: crypto.randomUUID() }));
    const journal = this.journalFor(attemptId);
    const admitted = await this.postJson<JournalRecord>(journal, "/admit", {
      candidates: candidates.map(({ eventId, payload, tags }) => ({ eventId, payload, tags })),
      consistencyTags: input.consistencyTags,
      commitContext: {
        attemptId,
        serviceId: this.serviceId,
        ...(fault === "fence-not-durable" ? { testFenceNotDurable: true } : {}),
        ...(fault === "fence-install-partial" ? { testFenceInstallFaultOnce: true } : {}),
      },
    });
    if (admitted.response.status !== 201 || admitted.body === undefined) {
      return responseWithAttempt(error(500, "internal_error", "Commit Journal admission failed"), attemptId, fault !== undefined);
    }

    // RESERVED means that the reservation phase is now durable. It permits a
    // pre-allocation REFUSED/FAILED only after the cancel barrier completes.
    const reserved = await this.transition(journal, admitted.body, "RESERVED");
    if (reserved === undefined) {
      return this.noApplicationOutcome(attemptId, fault !== undefined);
    }

    const reservations = await this.acquireReservations(input, attemptId, fault);
    if (reservations.failure !== undefined) {
      return this.finishReservationFailure(
        journal,
        reserved,
        input.consistencyTags,
        attemptId,
        reservations.failure,
        fault,
      );
    }

    const allocation = await this.allocate(candidates, attemptId, fault);
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
      );
    }
    const allocatedCandidates = this.withAllocatedSuids(candidates, allocation);
    if (allocatedCandidates === undefined) {
      return this.noApplicationOutcome(attemptId, fault !== undefined);
    }
    if (fault === "journal-cas-after-allocator") {
      return this.noApplicationOutcome(attemptId, true);
    }

    const allocated = await this.transition(journal, reserved, "ALLOCATED");
    if (allocated === undefined) {
      return this.noApplicationOutcome(attemptId, fault !== undefined);
    }
    const writing = await this.transition(journal, allocated, "WRITING");
    if (writing === undefined) {
      return this.noApplicationOutcome(attemptId, fault !== undefined);
    }

    const writesSucceeded = await this.appendAllTags(
      input,
      allocatedCandidates,
      attemptId,
      reservations.successes,
      fault,
    );
    if (!writesSucceeded) {
      return this.handoffToAlarm(journal, writing, allocation, attemptId, fault);
    }

    const complete = await this.transition(journal, writing, "COMPLETE");
    if (complete === undefined) {
      return this.noApplicationOutcome(attemptId, fault !== undefined);
    }
    try {
      const success = await this.successResponse(input, allocatedCandidates, attemptId, startedAt, fault);
      return responseWithAttempt(json(success, 200), attemptId, fault !== undefined);
    } catch {
      return responseWithAttempt(
        error(500, "internal_error", "Committed records could not be read while preparing the response"),
        attemptId,
        fault !== undefined,
      );
    }
  }

  private journalFor(attemptId: string): DurableObjectStub {
    return this.env.JOURNAL.get(this.env.JOURNAL.idFromName(attemptId));
  }

  private tagFor(tag: string): DurableObjectStub {
    return this.env.TAG.get(this.env.TAG.idFromName(`${this.serviceId}|${tag}`));
  }

  private async postJson<T>(stub: DurableObjectStub, path: string, body: unknown): Promise<{ response: Response; body?: T }> {
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
  }

  private async tagRequest(tag: string, path: string, body?: unknown): Promise<Response> {
    const url = new URL(`https://commit-worker.internal${path}`);
    url.searchParams.set("__tag", tag);
    return this.tagFor(tag).fetch(
      new Request(url.toString(), body === undefined ? undefined : {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  private async transition(
    journal: DurableObjectStub,
    record: JournalRecord,
    nextState: JournalRecord["state"],
    terminalReason?: string,
  ): Promise<JournalRecord | undefined> {
    const result = await this.postJson<JournalRecord>(journal, "/transition", {
      expectedState: record.state,
      expectedVersion: record.version,
      expectedOwnerEpoch: record.ownerEpoch,
      nextState,
      terminalReason,
    });
    return result.response.status === 200 ? result.body : undefined;
  }

  private async acquireReservations(
    input: ValidatedCommitEnvelope,
    attemptId: string,
    fault: CommitTestFault | undefined,
  ): Promise<ReservationAttempt> {
    const responses = await Promise.allSettled(
      input.consistencyTags.map(async (entry) => ({
        tag: entry.tag,
        response: await this.tagRequest(entry.tag, "/acquire", {
          attemptId,
          epoch: INITIAL_OWNER_EPOCH,
          eventTags: input.allTags,
          consistencyTags: input.consistencyTags,
        }),
      })),
    );
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
  ): Promise<AllocationVector | undefined> {
    const allocator = this.env.ALLOCATOR.get(this.env.ALLOCATOR.idFromName("service-wide-allocator"));
    try {
      const result = await this.postJson<AllocationVector>(allocator, "/allocate", {
        attemptId,
        candidates: candidates.map((candidate, candidateIndex) => ({ candidateIndex, eventId: candidate.eventId })),
        faultInjection: fault === "allocator-commit" ? "between-vector-and-watermark" : undefined,
      });
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
    candidates: Array<{ eventId: string; payload: string; eventPayloadName: string; tags: string[] }>,
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
    reservations: Map<string, ReservationSuccess>,
    fault: CommitTestFault | undefined,
  ): Promise<boolean> {
    let pending = [...input.allTags];
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS && pending.length > 0; attempt += 1) {
      const results = await Promise.allSettled(
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
            reservationToken: reservations.get(tag)?.reservationToken,
            candidates: candidates
              .filter((candidate) => candidate.tags.includes(tag))
              .map(({ eventId, suid, payload, tags }) => ({ eventId, suid, payload, eventTags: tags })),
            faultInjection: injectFault ? "after-append-before-confirm" : undefined,
          });
          return { tag, success: response.status >= 200 && response.status < 300 };
        }),
      );
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
    });
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
  ): Promise<Response> {
    const classified = await this.postJson<JournalRecord>(journal, "/reservation-failure", {
      expectedState: reserved.state,
      expectedVersion: reserved.version,
      expectedOwnerEpoch: reserved.ownerEpoch,
      outcome: failure.outcome,
      failureCause: failure.failureCause,
      reason: failure.reason,
    });
    if (classified.response.status !== 200 || classified.body === undefined) {
      return this.noApplicationOutcome(attemptId, fault !== undefined);
    }
    const cancelled = await Promise.allSettled(
      consistencyTags.map(async ({ tag }) => {
        const response = await this.tagRequest(tag, "/cancel", {
          attemptId,
          epoch: INITIAL_OWNER_EPOCH,
          forceTombstone: true,
        });
        return response.status >= 200 && response.status < 300;
      }),
    );
    if (!cancelled.every((result) => result.status === "fulfilled" && result.value)) {
      return this.noApplicationOutcome(attemptId, fault !== undefined);
    }
    if (fault === "tombstone-after-durable") {
      return this.noApplicationOutcome(attemptId, true);
    }
    const terminal = await this.transition(journal, classified.body, failure.outcome, failure.reason);
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
  ): Promise<CompleteCommitResponse> {
    const tagWriteResults = await Promise.all(input.allTags.map(async (tag): Promise<TagWriteResultResponse> => {
      if (fault === "tag-state-unavailable") {
        throw new Error("Test fault made the committed tag state unavailable");
      }
      const response = await this.tagRequest(tag, "/state");
      if (response.status !== 200) {
        throw new Error("Committed tag state was unavailable while preparing the response");
      }
      const body = (await response.json()) as Partial<TagStateResponse>;
      if (typeof body.version !== "number" || typeof body.updatedAt !== "string") {
        throw new Error("Committed tag state was malformed while preparing the response");
      }
      return { tag, version: body.version, writtenAt: body.updatedAt };
    }));
    return {
      writtenEvents: candidates.map((candidate) => ({
        payload: candidate.payload,
        sortableUniqueIdValue: candidate.suid,
        id: candidate.eventId,
        eventMetadata: {
          causationId: attemptId,
          correlationId: attemptId,
          executedUser: "serialized-dcb-v1",
        },
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

export async function handleSerializedCommit(request: Request, env: CommitWorkerEnv): Promise<Response> {
  return new CommitWorker(env, serviceIdForRequest(request)).handle(request);
}
