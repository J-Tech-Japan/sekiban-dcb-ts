import {
  ALARM_FAULT_POINTS,
  isAllowedTransition,
  isJournalState,
  isTerminalState,
  type AlarmFaultPoint,
  type AlarmSchedule,
  type CasExpectation,
  type CommitAttemptContext,
  type ConsistencyTag,
  type JournalCandidate,
  type JournalRecord,
  type JournalState,
  type JournalTerminalState,
  type ReconciliationFailureCause,
  type ReconciliationInput,
  type RequeriedRecord,
  type ReservationFailure,
} from "./types";

const JOURNAL_KEY = "journal";
const INITIAL_ALARM_DELAY_MS = 5_000;
export const MAX_ALARM_BACKOFF_MS = 30_000;
const ALARM_BACKOFF_BASE_MS = 250;
const TEST_FAULT_ALARM_DELAY_MS = 60_000;

type JsonObject = Record<string, unknown>;

interface AdmissionInput {
  candidates: JournalCandidate[];
  consistencyTags: ConsistencyTag[];
  commitContext?: CommitAttemptContext;
  faultInjection?: "before-admission-commit" | "after-admission-commit";
}

interface TransitionInput extends CasExpectation {
  nextState: JournalState;
  terminalReason?: string;
  alarmFaults?: AlarmFaultPoint[];
}

interface TakeoverInput extends CasExpectation {
  seals: Array<{ tag: string; sealed: boolean }>;
  fences: Array<{ tag: string; fenced: boolean }>;
  reconciliation: ReconciliationInput;
}

interface FaultInput extends CasExpectation {
  faultsRemaining: number;
  alarmFaults: AlarmFaultPoint[];
}

interface ReservationFailureInput extends CasExpectation, ReservationFailure {}

interface CommitRecoveryEnv {
  ALLOCATOR: DurableObjectNamespace;
  TAG: DurableObjectNamespace;
}

interface ReconciliationDecision {
  nextState: JournalState;
  reason: string;
}

interface MutationSuccess {
  ok: true;
  record: JournalRecord;
}

interface MutationConflict {
  ok: false;
  status: 404 | 409 | 422;
  error: string;
}

type MutationResult = MutationSuccess | MutationConflict;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
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

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function nowIso(): string {
  return new Date().toISOString();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sameExpectation(record: JournalRecord, expectation: CasExpectation): boolean {
  return (
    record.state === expectation.expectedState &&
    record.version === expectation.expectedVersion &&
    record.ownerEpoch === expectation.expectedOwnerEpoch
  );
}

function expectationFor(record: JournalRecord): CasExpectation {
  return {
    expectedState: record.state,
    expectedVersion: record.version,
    expectedOwnerEpoch: record.ownerEpoch,
  };
}

function nextAlarm(previous: AlarmSchedule | null, initial = false): AlarmSchedule {
  if (initial) {
    return {
      attempt: 0,
      delayMs: INITIAL_ALARM_DELAY_MS,
      dueAt: Date.now() + INITIAL_ALARM_DELAY_MS,
    };
  }

  const attempt = (previous?.attempt ?? 0) + 1;
  const exponent = Math.min(attempt - 1, 7);
  const delayMs = Math.min(ALARM_BACKOFF_BASE_MS * 2 ** exponent, MAX_ALARM_BACKOFF_MS);
  return { attempt, delayMs, dueAt: Date.now() + delayMs };
}

function immediateAlarm(previous: AlarmSchedule | null): AlarmSchedule {
  return {
    attempt: previous?.attempt ?? 0,
    delayMs: 0,
    dueAt: Date.now(),
  };
}

/** Keeps a test-injected crash observable until the test explicitly wakes it. */
function testFaultAlarm(previous: AlarmSchedule | null): AlarmSchedule {
  return {
    attempt: previous?.attempt ?? 0,
    delayMs: TEST_FAULT_ALARM_DELAY_MS,
    dueAt: Date.now() + TEST_FAULT_ALARM_DELAY_MS,
  };
}

function terminalResponse(
  state: JournalTerminalState,
  record: JournalRecord,
  reason: string,
): JournalRecord["terminalResponse"] {
  return {
    outcome: state,
    ownerEpoch: record.ownerEpoch,
    stateVersion: record.version,
    reason,
  };
}

function hasAllocatorVector(input: ReconciliationInput): boolean {
  return (input.allocatorVector?.length ?? 0) > 0;
}

function failureState(cause: ReconciliationFailureCause): JournalTerminalState {
  return cause === "reservation-conflict" ? "REFUSED" : "FAILED";
}

function isAbsenceBearingTerminalState(state: JournalState): state is JournalTerminalState {
  return state === "REFUSED" || state === "FAILED" || state === "PARTIAL";
}

function hasFullRequery(record: JournalRecord, input: ReconciliationInput): boolean {
  if (input.records.length !== record.candidates.length) {
    return false;
  }

  const byId = new Map(input.records.map((entry) => [entry.eventId, entry]));
  if (byId.size !== record.candidates.length) {
    return false;
  }

  return record.candidates.every((candidate) => {
    const observed = byId.get(candidate.eventId);
    return observed !== undefined && observed.payload === candidate.payload;
  });
}

function hasEveryCandidatePresent(record: JournalRecord, input: ReconciliationInput): boolean {
  if (!hasFullRequery(record, input) || (input.missingTags ?? []).length > 0) {
    return false;
  }
  return input.records.every((entry) => entry.present);
}

function requeryCount(record: JournalRecord, input: ReconciliationInput): number {
  const candidates = new Map(record.candidates.map((candidate) => [candidate.eventId, candidate]));
  return input.records.filter((entry) => {
    const candidate = candidates.get(entry.eventId);
    return candidate !== undefined && candidate.payload === entry.payload && entry.present;
  }).length;
}

function takeoverBarrierSatisfied(
  record: JournalRecord,
  input: ReconciliationInput,
  outcome: JournalTerminalState,
): boolean {
  const takeover = record.takeover;
  if (takeover === null) {
    return false;
  }

  const sealsAndRequery =
    record.allTags.every((tag) => takeover.sealedTags.includes(tag)) &&
    hasFullRequery(record, input);
  if (!sealsAndRequery) {
    return false;
  }
  return outcome !== "PARTIAL" ||
    (input.missingTags ?? []).every((tag) => (takeover.fencedTags ?? []).includes(tag));
}

function decideReconciliation(
  record: JournalRecord,
  input: ReconciliationInput,
  authority: "worker" | "alarm",
): ReconciliationDecision {
  const decision: ReconciliationDecision = (() => {
    switch (record.state) {
    case "ADMITTED":
      return hasAllocatorVector(input)
        ? { nextState: "ALLOCATED", reason: "allocator vector is durable" }
        : { nextState: "ABANDONED", reason: "no allocator vector was ever admitted" };
    case "RESERVED":
      return hasAllocatorVector(input)
        ? { nextState: "ALLOCATED", reason: "allocator vector is durable" }
        : { nextState: "ABANDONED", reason: "reservation has no allocator vector to retain" };
    case "ALLOCATED":
    case "WRITING":
    case "SEALING": {
      const observed = requeryCount(record, input);
      if (hasEveryCandidatePresent(record, input)) {
        return { nextState: "COMPLETE", reason: "full batch requery found every candidate" };
      }
      if (observed > 0) {
        return { nextState: "PARTIAL", reason: "batch requery found only a subset of candidates" };
      }
      return {
        nextState: failureState(input.failureCause),
        reason: "batch requery found no durable candidate records",
      };
    }
    default:
      return { nextState: record.state, reason: "journal is already terminal" };
    }
  })();

  if (
    isAbsenceBearingTerminalState(decision.nextState) &&
    (authority !== "alarm" || !takeoverBarrierSatisfied(record, input, decision.nextState))
  ) {
    return {
      nextState: "SEALING",
      reason: "absence-bearing outcome awaits alarm-owned takeover, seals, and full requery",
    };
  }

  return decision;
}

function admissionFrom(value: unknown): { value?: AdmissionInput; error?: string } {
  if (!isObject(value) || !Array.isArray(value.candidates) || !Array.isArray(value.consistencyTags)) {
    return { error: "candidates and consistencyTags must be arrays" };
  }

  if (value.candidates.length === 0) {
    return { error: "a Journal admission requires at least one candidate" };
  }

  const candidates: JournalCandidate[] = [];
  for (const rawCandidate of value.candidates) {
    if (
      !isObject(rawCandidate) ||
      !isNonEmptyString(rawCandidate.eventId) ||
      typeof rawCandidate.payload !== "string" ||
      !Array.isArray(rawCandidate.tags) ||
      rawCandidate.tags.length === 0 ||
      !rawCandidate.tags.every(isNonEmptyString)
    ) {
      return { error: "each candidate needs eventId, payload, and one or more non-empty tags" };
    }
    candidates.push({
      eventId: rawCandidate.eventId,
      payload: rawCandidate.payload,
      tags: [...rawCandidate.tags],
    });
  }

  if (new Set(candidates.map((candidate) => candidate.eventId)).size !== candidates.length) {
    return { error: "candidate eventId values must be unique" };
  }

  const allTags = new Set(candidates.flatMap((candidate) => candidate.tags));
  const consistencyTags: ConsistencyTag[] = [];
  for (const rawTag of value.consistencyTags) {
    if (
      !isObject(rawTag) ||
      !isNonEmptyString(rawTag.tag) ||
      typeof rawTag.lastSortableUniqueId !== "string"
    ) {
      return { error: "each consistency tag needs a non-null string lastSortableUniqueId" };
    }
    if (!allTags.has(rawTag.tag)) {
      return { error: "every consistency tag must occur in a candidate" };
    }
    consistencyTags.push({
      tag: rawTag.tag,
      lastSortableUniqueId: rawTag.lastSortableUniqueId,
    });
  }

  if (new Set(consistencyTags.map((tag) => tag.tag)).size !== consistencyTags.length) {
    return { error: "consistency tags must be unique" };
  }

  const faultInjection = value.faultInjection;
  if (
    faultInjection !== undefined &&
    faultInjection !== "before-admission-commit" &&
    faultInjection !== "after-admission-commit"
  ) {
    return { error: "unsupported faultInjection" };
  }

  let commitContext: CommitAttemptContext | undefined;
  if (value.commitContext !== undefined) {
    if (
      !isObject(value.commitContext) ||
      !isNonEmptyString(value.commitContext.attemptId) ||
      !isNonEmptyString(value.commitContext.serviceId)
    ) {
      return { error: "commitContext needs non-empty attemptId and serviceId" };
    }
    if (
      value.commitContext.testFenceNotDurable !== undefined &&
      typeof value.commitContext.testFenceNotDurable !== "boolean"
    ) {
      return { error: "commitContext testFenceNotDurable must be a boolean" };
    }
    commitContext = {
      attemptId: value.commitContext.attemptId,
      serviceId: value.commitContext.serviceId,
      ...(value.commitContext.testFenceNotDurable === true ? { testFenceNotDurable: true } : {}),
    };
  }

  return { value: { candidates, consistencyTags, commitContext, faultInjection } };
}

function expectationFrom(value: JsonObject): { value?: CasExpectation; error?: string } {
  if (
    !isJournalState(value.expectedState) ||
    !isNonNegativeInteger(value.expectedVersion) ||
    !isNonNegativeInteger(value.expectedOwnerEpoch)
  ) {
    return { error: "expectedState, expectedVersion, and expectedOwnerEpoch are required" };
  }

  return {
    value: {
      expectedState: value.expectedState,
      expectedVersion: value.expectedVersion,
      expectedOwnerEpoch: value.expectedOwnerEpoch,
    },
  };
}

function reconciliationFrom(value: unknown): { value?: ReconciliationInput; error?: string } {
  if (!isObject(value) || !Array.isArray(value.records)) {
    return { error: "reconciliation records must be an array" };
  }

  let allocatorVector: string[] | undefined;
  if (value.allocatorVector !== undefined) {
    if (!Array.isArray(value.allocatorVector) || !value.allocatorVector.every(isNonEmptyString)) {
      return { error: "allocatorVector must be an array of non-empty strings" };
    }
    allocatorVector = [...value.allocatorVector];
  }

  const failureCause = value.failureCause ?? "write-failure";
  if (
    failureCause !== "reservation-conflict" &&
    failureCause !== "allocator-failure" &&
    failureCause !== "write-failure" &&
    failureCause !== "reservation-timeout" &&
    failureCause !== "guard-rejection"
  ) {
    return { error: "failureCause is not recognized" };
  }

  const records: RequeriedRecord[] = [];
  for (const rawRecord of value.records) {
    if (
      !isObject(rawRecord) ||
      !isNonEmptyString(rawRecord.eventId) ||
      typeof rawRecord.payload !== "string" ||
      typeof rawRecord.present !== "boolean"
    ) {
      return { error: "each requery record needs eventId, payload, and present" };
    }
    records.push({
      eventId: rawRecord.eventId,
      payload: rawRecord.payload,
      present: rawRecord.present,
    });
  }

  if (new Set(records.map((record) => record.eventId)).size !== records.length) {
    return { error: "requery records must have unique eventId values" };
  }

  let missingTags: string[] | undefined;
  if (value.missingTags !== undefined) {
    if (!Array.isArray(value.missingTags) || !value.missingTags.every(isNonEmptyString)) {
      return { error: "missingTags must be an array of non-empty strings" };
    }
    if (new Set(value.missingTags).size !== value.missingTags.length) {
      return { error: "missingTags must be unique" };
    }
    missingTags = [...value.missingTags];
  }

  return { value: { allocatorVector, records, failureCause, missingTags } };
}

function transitionFrom(value: unknown): { value?: TransitionInput; error?: string } {
  if (!isObject(value)) {
    return { error: "transition body must be an object" };
  }
  const expectation = expectationFrom(value);
  if (expectation.value === undefined) {
    return { error: expectation.error };
  }
  if (!isJournalState(value.nextState)) {
    return { error: "nextState must be a Journal state" };
  }
  if (value.terminalReason !== undefined && !isNonEmptyString(value.terminalReason)) {
    return { error: "terminalReason must be a non-empty string when present" };
  }
  let alarmFaults: AlarmFaultPoint[] | undefined;
  if (value.alarmFaults !== undefined) {
    if (!Array.isArray(value.alarmFaults) || !value.alarmFaults.every((fault) =>
      typeof fault === "string" && ALARM_FAULT_POINTS.includes(fault as AlarmFaultPoint),
    )) {
      return { error: "alarmFaults must contain recognized alarm fault points" };
    }
    if (new Set(value.alarmFaults).size !== value.alarmFaults.length) {
      return { error: "alarmFaults must be unique" };
    }
    alarmFaults = [...(value.alarmFaults as AlarmFaultPoint[])];
  }
  return {
    value: {
      ...expectation.value,
      nextState: value.nextState,
      terminalReason: value.terminalReason,
      alarmFaults,
    },
  };
}

function reservationFailureFrom(value: unknown): { value?: ReservationFailureInput; error?: string } {
  if (!isObject(value)) {
    return { error: "reservation failure body must be an object" };
  }
  const expectation = expectationFrom(value);
  if (expectation.value === undefined) {
    return { error: expectation.error };
  }
  if ((value.outcome !== "REFUSED" && value.outcome !== "FAILED") || !isNonEmptyString(value.reason)) {
    return { error: "outcome must be REFUSED or FAILED and reason must be non-empty" };
  }
  if (
    value.failureCause !== "reservation-conflict" &&
    value.failureCause !== "allocator-failure" &&
    value.failureCause !== "write-failure" &&
    value.failureCause !== "reservation-timeout" &&
    value.failureCause !== "guard-rejection"
  ) {
    return { error: "failureCause is not recognized" };
  }
  return {
    value: {
      ...expectation.value,
      outcome: value.outcome,
      reason: value.reason,
      failureCause: value.failureCause,
    },
  };
}

function takeoverFrom(value: unknown): { value?: TakeoverInput; error?: string } {
  if (!isObject(value) || !Array.isArray(value.seals)) {
    return { error: "takeover body must contain a seals array" };
  }
  const expectation = expectationFrom(value);
  if (expectation.value === undefined) {
    return { error: expectation.error };
  }
  const reconciliation = reconciliationFrom(value.reconciliation);
  if (reconciliation.value === undefined) {
    return { error: reconciliation.error };
  }
  const seals: Array<{ tag: string; sealed: boolean }> = [];
  for (const rawSeal of value.seals) {
    if (!isObject(rawSeal) || !isNonEmptyString(rawSeal.tag) || typeof rawSeal.sealed !== "boolean") {
      return { error: "each seal needs a tag and sealed boolean" };
    }
    seals.push({ tag: rawSeal.tag, sealed: rawSeal.sealed });
  }
  if (new Set(seals.map((seal) => seal.tag)).size !== seals.length) {
    return { error: "seal tags must be unique" };
  }
  const fences: Array<{ tag: string; fenced: boolean }> = [];
  if (value.fences !== undefined) {
    if (!Array.isArray(value.fences)) {
      return { error: "fences must be an array when present" };
    }
    for (const rawFence of value.fences) {
      if (!isObject(rawFence) || !isNonEmptyString(rawFence.tag) || typeof rawFence.fenced !== "boolean") {
        return { error: "each fence needs a tag and fenced boolean" };
      }
      fences.push({ tag: rawFence.tag, fenced: rawFence.fenced });
    }
    if (new Set(fences.map((fence) => fence.tag)).size !== fences.length) {
      return { error: "fence tags must be unique" };
    }
  }
  return { value: { ...expectation.value, seals, fences, reconciliation: reconciliation.value } };
}

function faultFrom(value: unknown): { value?: FaultInput; error?: string } {
  if (!isObject(value)) {
    return { error: "fault body must be an object" };
  }
  const expectation = expectationFrom(value);
  if (expectation.value === undefined) {
    return { error: expectation.error };
  }
  if (!isNonNegativeInteger(value.faultsRemaining)) {
    return { error: "faultsRemaining must be a non-negative integer" };
  }
  const alarmFaults: AlarmFaultPoint[] = [];
  if (value.alarmFaults !== undefined) {
    if (!Array.isArray(value.alarmFaults) || !value.alarmFaults.every((fault) =>
      typeof fault === "string" && ALARM_FAULT_POINTS.includes(fault as AlarmFaultPoint),
    )) {
      return { error: "alarmFaults must contain recognized alarm fault points" };
    }
    if (new Set(value.alarmFaults).size !== value.alarmFaults.length) {
      return { error: "alarmFaults must be unique" };
    }
    alarmFaults.push(...(value.alarmFaults as AlarmFaultPoint[]));
  }
  return { value: { ...expectation.value, faultsRemaining: value.faultsRemaining, alarmFaults } };
}

/**
 * Per-commit-attempt durable state machine. Its HTTP surface is an internal
 * test/control boundary; the five Serialized DCB V1 HTTP endpoints remain a
 * later slice.
 */
export class JournalDurableObject implements DurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: CommitRecoveryEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/state") {
      const record = await this.readRecord();
      return record === undefined ? error(404, "journal_not_found", "Journal has not been admitted") : json(record);
    }
    if (request.method === "GET" && path === "/result") {
      const record = await this.readRecord();
      if (record === undefined) {
        return error(404, "journal_not_found", "Journal has not been admitted");
      }
      if (!isTerminalState(record.state) || record.terminalResponse === null) {
        return error(409, "journal_not_terminal", "Terminal response is not durable yet");
      }
      return json(record.terminalResponse);
    }

    const body = await this.jsonBody(request);
    if (body === undefined) {
      return error(400, "malformed_journal_request", "Request body must be JSON");
    }

    if (request.method === "POST" && path === "/admit") {
      return this.admit(body);
    }
    if (request.method === "POST" && path === "/transition") {
      return this.transition(body);
    }
    if (request.method === "POST" && path === "/reconcile") {
      return this.reconcile(body);
    }
    if (request.method === "POST" && path === "/reservation-failure") {
      return this.recordReservationFailure(body);
    }
    if (request.method === "POST" && path === "/takeover") {
      return this.takeover(body);
    }
    if (request.method === "POST" && path === "/fault") {
      return this.setFaults(body);
    }
    if (request.method === "POST" && path === "/debug/alarm") {
      if (isObject(body) && body.clearTestFenceNotDurable === true) {
        await this.clearTestFenceNotDurableFault();
      }
      const record = await this.runAlarm();
      return record === undefined ? error(404, "journal_not_found", "Journal has not been admitted") : json(record);
    }

    return error(404, "journal_route_not_found", "Journal route was not found");
  }

  async alarm(): Promise<void> {
    await this.runAlarm();
  }

  private async readRecord(): Promise<JournalRecord | undefined> {
    return this.ctx.storage.get<JournalRecord>(JOURNAL_KEY);
  }

  /** Releases the private fence fault after the response-boundary oracle has observed it. */
  private async clearTestFenceNotDurableFault(): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const record = await txn.get<JournalRecord>(JOURNAL_KEY);
      if (record?.commitContext?.testFenceNotDurable !== true) {
        return;
      }
      const commitContext: CommitAttemptContext = {
        attemptId: record.commitContext.attemptId,
        serviceId: record.commitContext.serviceId,
      };
      await txn.put(JOURNAL_KEY, {
        ...record,
        commitContext,
        version: record.version + 1,
        updatedAt: nowIso(),
      });
    });
  }

  private async jsonBody(request: Request): Promise<unknown | undefined> {
    try {
      return await request.json<unknown>();
    } catch {
      return undefined;
    }
  }

  private async admit(body: unknown): Promise<Response> {
    const parsed = admissionFrom(body);
    if (parsed.value === undefined) {
      return error(400, "invalid_journal_admission", parsed.error ?? "Invalid Journal admission");
    }
    if (parsed.value.faultInjection === "before-admission-commit") {
      return error(503, "simulated_admission_crash", "Simulated interruption before durable admission");
    }

    const input = parsed.value;
    const result = await this.ctx.storage.transaction(async (txn): Promise<MutationResult> => {
      const existing = await txn.get<JournalRecord>(JOURNAL_KEY);
      if (existing !== undefined) {
        return { ok: false, status: 409, error: "Journal already has a durable admission" };
      }

      const timestamp = nowIso();
      const record: JournalRecord = {
        schemaVersion: 1,
        candidates: input.candidates,
        consistencyTags: input.consistencyTags,
        allTags: unique(input.candidates.flatMap((candidate) => candidate.tags)),
        commitContext: input.commitContext,
        ownerEpoch: 0,
        state: "ADMITTED",
        version: 0,
        alarm: nextAlarm(null, true),
        reconciliation: null,
        reservationFailure: null,
        takeover: null,
        faultsRemaining: 0,
        alarmFaults: [],
        terminalResponse: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      const alarm = record.alarm!;
      await txn.put(JOURNAL_KEY, record);
      await txn.setAlarm(alarm.dueAt);
      return { ok: true, record };
    });

    if (!result.ok) {
      return error(result.status, "journal_admission_conflict", result.error);
    }
    if (input.faultInjection === "after-admission-commit") {
      return error(503, "simulated_admission_crash", "Simulated interruption after durable admission");
    }
    return json(result.record, 201);
  }

  private async transition(body: unknown): Promise<Response> {
    const parsed = transitionFrom(body);
    if (parsed.value === undefined) {
      return error(400, "invalid_journal_transition", parsed.error ?? "Invalid Journal transition");
    }
    const input = parsed.value;
    const result = await this.ctx.storage.transaction(async (txn): Promise<MutationResult> => {
      const record = await txn.get<JournalRecord>(JOURNAL_KEY);
      if (record === undefined) {
        return { ok: false, status: 404, error: "Journal has not been admitted" };
      }
      if (!sameExpectation(record, input)) {
        return { ok: false, status: 409, error: "CAS expectation did not match the durable Journal" };
      }
      if (isTerminalState(record.state)) {
        return { ok: false, status: 409, error: "Terminal Journal states are immutable" };
      }
      if (!isAllowedTransition(record.state, input.nextState)) {
        return { ok: false, status: 422, error: "Transition is not permitted by the Journal state machine" };
      }
      if (
        isAbsenceBearingTerminalState(input.nextState) &&
        (record.state !== "RESERVED" || input.nextState === "PARTIAL" || record.reservationFailure === null)
      ) {
        return {
          ok: false,
          status: 422,
          error: "Only a recorded reservation-stage cancel barrier or alarm reconciliation may fix an absence-bearing terminal outcome",
        };
      }

      const updated: JournalRecord = {
        ...record,
        state: input.nextState,
        alarmFaults: input.alarmFaults ?? record.alarmFaults,
        version: record.version + 1,
        updatedAt: nowIso(),
      };
      if (isTerminalState(updated.state)) {
        updated.alarm = null;
        updated.terminalResponse = terminalResponse(
          updated.state,
          updated,
          input.terminalReason ?? "explicit CAS transition",
        );
        await txn.put(JOURNAL_KEY, updated);
        await txn.deleteAlarm();
      } else {
        if (updated.state === "SEALING" && updated.takeover === null) {
          updated.alarm = input.alarmFaults !== undefined && input.alarmFaults.length > 0
            ? testFaultAlarm(record.alarm)
            : immediateAlarm(record.alarm);
          await txn.setAlarm(updated.alarm.dueAt);
        }
        await txn.put(JOURNAL_KEY, updated);
      }
      return { ok: true, record: updated };
    });

    return result.ok
      ? json(result.record)
      : error(result.status, "journal_transition_rejected", result.error);
  }

  private async reconcile(body: unknown): Promise<Response> {
    if (!isObject(body)) {
      return error(400, "invalid_journal_reconciliation", "Reconciliation body must be an object");
    }
    const expectation = expectationFrom(body);
    const reconciliation = reconciliationFrom(body.reconciliation);
    if (expectation.value === undefined || reconciliation.value === undefined) {
      return error(
        400,
        "invalid_journal_reconciliation",
        expectation.error ?? reconciliation.error ?? "Invalid reconciliation",
      );
    }

    const result = await this.applyReconciliation(expectation.value, reconciliation.value, "worker");
    return result.ok
      ? json(result.record)
      : error(result.status, "journal_reconciliation_rejected", result.error);
  }

  /**
   * Persist the reservation-stage classification before the cancel barrier.
   * That makes a crash after tombstone durability recover to the same outcome.
   */
  private async recordReservationFailure(body: unknown): Promise<Response> {
    const parsed = reservationFailureFrom(body);
    if (parsed.value === undefined) {
      return error(400, "invalid_journal_reservation_failure", parsed.error ?? "Invalid reservation failure");
    }
    const input = parsed.value;
    const result = await this.ctx.storage.transaction(async (txn): Promise<MutationResult> => {
      const record = await txn.get<JournalRecord>(JOURNAL_KEY);
      if (record === undefined) {
        return { ok: false, status: 404, error: "Journal has not been admitted" };
      }
      if (!sameExpectation(record, input)) {
        return { ok: false, status: 409, error: "CAS expectation did not match the durable Journal" };
      }
      if (record.state !== "RESERVED" || isTerminalState(record.state)) {
        return { ok: false, status: 409, error: "Reservation failure can only be recorded in RESERVED" };
      }
      const updated: JournalRecord = {
        ...record,
        reservationFailure: {
          outcome: input.outcome,
          reason: input.reason,
          failureCause: input.failureCause,
        },
        reconciliation: {
          records: [],
          failureCause: input.failureCause,
        },
        version: record.version + 1,
        updatedAt: nowIso(),
      };
      await txn.put(JOURNAL_KEY, updated);
      return { ok: true, record: updated };
    });
    return result.ok
      ? json(result.record)
      : error(result.status, "journal_reservation_failure_rejected", result.error);
  }

  private async takeover(body: unknown): Promise<Response> {
    const parsed = takeoverFrom(body);
    if (parsed.value === undefined) {
      return error(400, "invalid_journal_takeover", parsed.error ?? "Invalid takeover");
    }
    const input = parsed.value;

    const knownRecord = await this.readRecord();
    if (knownRecord === undefined) {
      return error(404, "journal_not_found", "Journal has not been admitted");
    }
    const candidateById = new Map(knownRecord.candidates.map((candidate) => [candidate.eventId, candidate]));
    if (
      input.seals.some((seal) => !knownRecord.allTags.includes(seal.tag)) ||
      input.fences.some((fence) => !knownRecord.allTags.includes(fence.tag)) ||
      input.reconciliation.records.some((entry) => candidateById.get(entry.eventId)?.payload !== entry.payload)
    ) {
      return error(400, "invalid_journal_takeover", "Takeover evidence does not match the admitted batch");
    }

    const evidence = await this.ctx.storage.transaction(async (txn): Promise<MutationResult> => {
      const record = await txn.get<JournalRecord>(JOURNAL_KEY);
      if (record === undefined) {
        return { ok: false, status: 404, error: "Journal has not been admitted" };
      }
      if (!sameExpectation(record, input)) {
        return { ok: false, status: 409, error: "CAS expectation did not match the durable Journal" };
      }
      if (isTerminalState(record.state)) {
        return { ok: false, status: 409, error: "Terminal Journal states are immutable" };
      }
      if (record.state !== "SEALING" || record.takeover === null) {
        return {
          ok: false,
          status: 409,
          error: "Alarm-owned takeover must increment the epoch before seal evidence is accepted",
        };
      }

      const sealedTags = unique([
        ...record.takeover.sealedTags,
        ...input.seals.filter((seal) => seal.sealed).map((seal) => seal.tag),
      ]);
      const fencedTags = unique([
        ...(record.takeover.fencedTags ?? []),
        ...input.fences.filter((fence) => fence.fenced).map((fence) => fence.tag),
      ]);
      const updated: JournalRecord = {
        ...record,
        version: record.version + 1,
        takeover: { active: true, sealedTags, fencedTags },
        reconciliation: input.reconciliation,
        updatedAt: nowIso(),
      };
      await txn.put(JOURNAL_KEY, updated);
      return { ok: true, record: updated };
    });

    return evidence.ok
      ? json({ status: "takeover-sealing", journal: evidence.record }, 202)
      : error(evidence.status, "journal_takeover_rejected", evidence.error);
  }

  private async setFaults(body: unknown): Promise<Response> {
    const parsed = faultFrom(body);
    if (parsed.value === undefined) {
      return error(400, "invalid_journal_fault", parsed.error ?? "Invalid fault injection");
    }
    const input = parsed.value;
    const result = await this.ctx.storage.transaction(async (txn): Promise<MutationResult> => {
      const record = await txn.get<JournalRecord>(JOURNAL_KEY);
      if (record === undefined) {
        return { ok: false, status: 404, error: "Journal has not been admitted" };
      }
      if (!sameExpectation(record, input)) {
        return { ok: false, status: 409, error: "CAS expectation did not match the durable Journal" };
      }
      if (isTerminalState(record.state)) {
        return { ok: false, status: 409, error: "Terminal Journal states are immutable" };
      }
      const updated: JournalRecord = {
        ...record,
        faultsRemaining: input.faultsRemaining,
        alarmFaults: input.alarmFaults,
        version: record.version + 1,
        updatedAt: nowIso(),
      };
      await txn.put(JOURNAL_KEY, updated);
      return { ok: true, record: updated };
    });
    return result.ok ? json(result.record) : error(result.status, "journal_fault_rejected", result.error);
  }

  private async applyReconciliation(
    expectation: CasExpectation,
    reconciliation: ReconciliationInput,
    authority: "worker" | "alarm",
  ): Promise<MutationResult> {
    return this.ctx.storage.transaction(async (txn): Promise<MutationResult> => {
      const record = await txn.get<JournalRecord>(JOURNAL_KEY);
      if (record === undefined) {
        return { ok: false, status: 404, error: "Journal has not been admitted" };
      }
      if (!sameExpectation(record, expectation)) {
        return { ok: false, status: 409, error: "CAS expectation did not match the durable Journal" };
      }
      if (isTerminalState(record.state)) {
        return { ok: false, status: 409, error: "Terminal Journal states are immutable" };
      }

      const decision = decideReconciliation(record, reconciliation, authority);
      if (decision.nextState !== record.state && !isAllowedTransition(record.state, decision.nextState)) {
        return { ok: false, status: 422, error: "Reconciler selected an invalid state transition" };
      }

      const updated: JournalRecord = {
        ...record,
        state: decision.nextState,
        version: record.version + 1,
        reconciliation,
        updatedAt: nowIso(),
      };
      if (isTerminalState(updated.state)) {
        updated.alarm = null;
        updated.terminalResponse = terminalResponse(updated.state, updated, decision.reason);
        await txn.put(JOURNAL_KEY, updated);
        await txn.deleteAlarm();
      } else {
        if (updated.state === "SEALING" && updated.takeover === null) {
          updated.alarm = immediateAlarm(record.alarm);
          await txn.setAlarm(updated.alarm.dueAt);
        } else if (updated.alarm === null) {
          updated.alarm = nextAlarm(null, true);
          await txn.setAlarm(updated.alarm.dueAt);
        }
        await txn.put(JOURNAL_KEY, updated);
      }
      return { ok: true, record: updated };
    });
  }

  private async beginAlarmTakeover(expected: JournalRecord): Promise<MutationResult> {
    return this.ctx.storage.transaction(async (txn): Promise<MutationResult> => {
      const record = await txn.get<JournalRecord>(JOURNAL_KEY);
      if (record === undefined) {
        return { ok: false, status: 404, error: "Journal has not been admitted" };
      }
      if (
        record.state !== expected.state ||
        record.version !== expected.version ||
        record.ownerEpoch !== expected.ownerEpoch
      ) {
        return { ok: false, status: 409, error: "Journal changed before alarm takeover" };
      }
      if (isTerminalState(record.state)) {
        return { ok: false, status: 409, error: "Terminal Journal states are immutable" };
      }
      if (record.takeover !== null) {
        return { ok: true, record };
      }

      const updated: JournalRecord = {
        ...record,
        state: "SEALING",
        ownerEpoch: record.ownerEpoch + 1,
        version: record.version + 1,
        takeover: { active: true, sealedTags: [], fencedTags: [] },
        updatedAt: nowIso(),
      };
      await txn.put(JOURNAL_KEY, updated);
      return { ok: true, record: updated };
    });
  }

  private async runAlarm(): Promise<JournalRecord | undefined> {
    try {
      const rearmed = await this.ctx.storage.transaction(async (txn): Promise<MutationResult> => {
        const record = await txn.get<JournalRecord>(JOURNAL_KEY);
        if (record === undefined) {
          return { ok: false, status: 404, error: "Journal has not been admitted" };
        }
        if (isTerminalState(record.state)) {
          const updated: JournalRecord = { ...record, alarm: null, updatedAt: nowIso() };
          await txn.put(JOURNAL_KEY, updated);
          await txn.deleteAlarm();
          return { ok: true, record: updated };
        }

        const updated: JournalRecord = {
          ...record,
          alarm: nextAlarm(record.alarm),
          version: record.version + 1,
          updatedAt: nowIso(),
        };
        const alarm = updated.alarm!;
        await txn.put(JOURNAL_KEY, updated);
        await txn.setAlarm(alarm.dueAt);
        return { ok: true, record: updated };
      });

      if (!rearmed.ok) {
        return rearmed.status === 404 ? undefined : this.readRecord();
      }
      if (isTerminalState(rearmed.record.state)) {
        return rearmed.record;
      }
      let alarmRecord = rearmed.record;
      if (alarmRecord.faultsRemaining > 0) {
        return this.consumeFault(alarmRecord);
      }
      if (alarmRecord.commitContext !== undefined) {
        const handlerEntryFault = await this.consumeNamedAlarmFault(alarmRecord, "handler-entry");
        return handlerEntryFault ?? this.recoverCommitAttempt(alarmRecord);
      }
      if (alarmRecord.takeover === null && ["ALLOCATED", "WRITING", "SEALING"].includes(alarmRecord.state)) {
        const handoff = await this.beginAlarmTakeover(alarmRecord);
        if (!handoff.ok) {
          return this.readRecord();
        }
        alarmRecord = handoff.record;
      }

      const reconciliation = alarmRecord.reconciliation ?? emptyReconciliation();
      const reconciled = await this.applyReconciliation(
        {
          expectedState: alarmRecord.state,
          expectedVersion: alarmRecord.version,
          expectedOwnerEpoch: alarmRecord.ownerEpoch,
        },
        reconciliation,
        "alarm",
      );
      return reconciled.ok ? reconciled.record : this.readRecord();
    } catch {
      return this.recoverAlarmFailure();
    }
  }

  /**
   * Recovery for a real serialized commit. The Journal is the only actor that
   * turns a post-allocation absence observation into a terminal outcome.
   */
  private async recoverCommitAttempt(record: JournalRecord): Promise<JournalRecord | undefined> {
    if (record.commitContext === undefined) {
      return record;
    }
    if (record.state === "ADMITTED" || record.state === "RESERVED") {
      return this.recoverPreAllocationCommit(record);
    }
    if (["ALLOCATED", "WRITING", "SEALING"].includes(record.state)) {
      return this.recoverPostAllocationCommit(record);
    }
    return record;
  }

  /**
   * If allocation committed before the worker could CAS the Journal, the
   * allocator vector is the durable authority. Otherwise cancel every
   * consistency reservation before safely abandoning the attempt.
   */
  private async recoverPreAllocationCommit(record: JournalRecord): Promise<JournalRecord | undefined> {
    const vector = await this.readAllocatorVector(record);
    if (vector !== undefined) {
      const recovered = await this.applyReconciliation(
        expectationFor(record),
        {
          allocatorVector: vector,
          records: [],
          failureCause: "allocator-failure",
        },
        "alarm",
      );
      return recovered.ok ? recovered.record : this.readRecord();
    }

    if (!(await this.cancelConsistencyBarrier(record, record.ownerEpoch))) {
      return this.readRecord();
    }
    if (record.state === "RESERVED" && record.reservationFailure !== null) {
      const finalized = await this.transition({
        ...expectationFor(record),
        nextState: record.reservationFailure.outcome,
        terminalReason: record.reservationFailure.reason,
      });
      return finalized.status === 200
        ? (await finalized.json()) as JournalRecord
        : this.readRecord();
    }
    const abandoned = await this.applyReconciliation(
      expectationFor(record),
      { records: [], failureCause: "allocator-failure" },
      "alarm",
    );
    return abandoned.ok ? abandoned.record : this.readRecord();
  }

  /**
   * Post-allocation recovery is deliberately fail-closed: incomplete sealing,
   * requery, fencing, or cancel-barrier work leaves the re-armed Journal in
   * SEALING rather than publishing an absence-bearing result.
   */
  private async recoverPostAllocationCommit(record: JournalRecord): Promise<JournalRecord | undefined> {
    let current = record;
    const beforeSealFault = await this.consumeNamedAlarmFault(current, "after-rearm-before-seal");
    if (beforeSealFault !== undefined) {
      return beforeSealFault;
    }

    if (current.takeover === null) {
      const handoff = await this.beginAlarmTakeover(current);
      if (!handoff.ok) {
        return this.readRecord();
      }
      current = handoff.record;
    }

    const partialSealFault = await this.sealCommitTags(current);
    if (partialSealFault !== undefined) {
      return partialSealFault;
    }
    const afterSealFault = await this.consumeNamedAlarmFault(current, "after-full-seal-before-requery");
    if (afterSealFault !== undefined) {
      return afterSealFault;
    }

    const reconciliation = await this.requeryCommitRecords(current);
    let fences: Array<{ tag: string; fenced: boolean }> = [];
    if (reconciliation.records.some((entry) => entry.present)) {
      const installedFences = await this.installMissingTagFences(current, reconciliation.missingTags ?? []);
      if (installedFences === undefined) {
        return this.readRecord();
      }
      fences = installedFences;
    }
    if (!(await this.cancelConsistencyBarrier(current, current.ownerEpoch))) {
      return this.readRecord();
    }

    const beforeOutcomeFault = await this.consumeNamedAlarmFault(current, "before-outcome-cas");
    if (beforeOutcomeFault !== undefined) {
      return beforeOutcomeFault;
    }

    const latest = await this.readRecord();
    if (latest === undefined || isTerminalState(latest.state)) {
      return latest;
    }
    if (
      latest.state !== "SEALING" ||
      latest.takeover === null ||
      latest.ownerEpoch !== current.ownerEpoch
    ) {
      return latest;
    }

    const evidenceResponse = await this.takeover({
      ...expectationFor(latest),
      seals: latest.allTags.map((tag) => ({ tag, sealed: true })),
      fences,
      reconciliation,
    });
    if (evidenceResponse.status !== 202) {
      return this.readRecord();
    }
    const evidence = (await evidenceResponse.json()) as { journal?: JournalRecord };
    if (evidence.journal === undefined) {
      return this.readRecord();
    }
    const terminal = await this.applyReconciliation(expectationFor(evidence.journal), reconciliation, "alarm");
    return terminal.ok ? terminal.record : this.readRecord();
  }

  private async readAllocatorVector(record: JournalRecord): Promise<string[] | undefined> {
    const context = record.commitContext;
    if (context === undefined) {
      return undefined;
    }
    const allocator = this.env.ALLOCATOR.get(this.env.ALLOCATOR.idFromName("service-wide-allocator"));
    const response = await allocator.fetch(
      new Request(`https://commit-recovery.internal/attempts/${encodeURIComponent(context.attemptId)}`),
    );
    if (response.status === 404) {
      return undefined;
    }
    if (response.status !== 200) {
      throw new Error("allocator vector requery failed");
    }
    const body = (await response.json()) as { candidates?: Array<{ suid?: unknown }> };
    if (!Array.isArray(body.candidates) || !body.candidates.every((candidate) => isNonEmptyString(candidate.suid))) {
      throw new Error("allocator vector requery returned an invalid body");
    }
    return body.candidates.map((candidate) => candidate.suid as string);
  }

  /** Tombstone every observed tag, retaining any unrelated active owner. */
  private async cancelConsistencyBarrier(record: JournalRecord, epoch: number): Promise<boolean> {
    const context = record.commitContext;
    if (context === undefined) {
      return false;
    }
    const requests = record.consistencyTags.map(async ({ tag }) => {
      const response = await this.tagRequest(context, tag, "/cancel", {
        attemptId: context.attemptId,
        epoch,
        forceTombstone: true,
      });
      return response.status >= 200 && response.status < 300;
    });
    const settled = await Promise.allSettled(requests);
    return settled.every((result) => result.status === "fulfilled" && result.value);
  }

  /** Returns a consumed fault record only when the named point was armed. */
  private async consumeNamedAlarmFault(
    expected: JournalRecord,
    point: AlarmFaultPoint,
  ): Promise<JournalRecord | undefined> {
    if (!(expected.alarmFaults ?? []).includes(point)) {
      return undefined;
    }
    const result = await this.ctx.storage.transaction(async (txn): Promise<MutationResult> => {
      const record = await txn.get<JournalRecord>(JOURNAL_KEY);
      if (record === undefined) {
        return { ok: false, status: 404, error: "Journal has not been admitted" };
      }
      if (
        record.state !== expected.state ||
        record.version !== expected.version ||
        record.ownerEpoch !== expected.ownerEpoch ||
        !(record.alarmFaults ?? []).includes(point)
      ) {
        return { ok: false, status: 409, error: "Journal changed while alarm fault was handled" };
      }
      const updated: JournalRecord = {
        ...record,
        alarmFaults: (record.alarmFaults ?? []).filter((fault) => fault !== point),
        alarm: testFaultAlarm(record.alarm),
        version: record.version + 1,
        updatedAt: nowIso(),
      };
      await txn.put(JOURNAL_KEY, updated);
      await txn.setAlarm(updated.alarm!.dueAt);
      return { ok: true, record: updated };
    });
    return result.ok ? result.record : this.readRecord();
  }

  /**
   * Seal each tag serially so the partial-seal crash point can be observed.
   * Repeating a completed seal is explicitly idempotent in the Tag DO.
   */
  private async sealCommitTags(record: JournalRecord): Promise<JournalRecord | undefined> {
    const context = record.commitContext;
    if (context === undefined) {
      return record;
    }
    for (let index = 0; index < record.allTags.length; index += 1) {
      const tag = record.allTags[index]!;
      const response = await this.tagRequest(context, tag, "/seal", {
        attemptId: context.attemptId,
        epoch: record.ownerEpoch,
      });
      if (response.status < 200 || response.status >= 300) {
        return this.readRecord();
      }
      if (index + 1 < record.allTags.length) {
        const fault = await this.consumeNamedAlarmFault(record, "after-partial-seal");
        if (fault !== undefined) {
          return fault;
        }
      }
    }
    return undefined;
  }

  /** Requery every EventId from every requested tag and preserve exact bytes. */
  private async requeryCommitRecords(record: JournalRecord): Promise<ReconciliationInput> {
    const context = record.commitContext;
    if (context === undefined) {
      return emptyReconciliation();
    }
    const states = new Map<string, Array<{ eventId: string; payload: string }>>();
    for (const tag of record.allTags) {
      const response = await this.tagRequest(context, tag, "/state");
      if (response.status === 404) {
        states.set(tag, []);
        continue;
      }
      if (response.status !== 200) {
        throw new Error("tag requery failed");
      }
      const body = (await response.json()) as { events?: unknown };
      if (!Array.isArray(body.events)) {
        throw new Error("tag requery returned an invalid body");
      }
      const events = body.events.flatMap((event): Array<{ eventId: string; payload: string }> => {
        if (!isObject(event) || !isNonEmptyString(event.eventId) || typeof event.payload !== "string") {
          return [];
        }
        return [{ eventId: event.eventId, payload: event.payload }];
      });
      states.set(tag, events);
    }

    const hasRecord = (tag: string, candidate: JournalCandidate): boolean =>
      (states.get(tag) ?? []).some(
        (event) => event.eventId === candidate.eventId && event.payload === candidate.payload,
      );
    const missingTags = record.allTags.filter((tag) =>
      record.candidates.filter((candidate) => candidate.tags.includes(tag)).some((candidate) => !hasRecord(tag, candidate)),
    );
    return {
      allocatorVector: record.reconciliation?.allocatorVector,
      records: record.candidates.map((candidate) => ({
        eventId: candidate.eventId,
        payload: candidate.payload,
        present: candidate.tags.some((tag) => hasRecord(tag, candidate)),
      })),
      failureCause: record.reconciliation?.failureCause ?? "write-failure",
      missingTags,
    };
  }

  private async installMissingTagFences(
    record: JournalRecord,
    missingTags: string[],
  ): Promise<Array<{ tag: string; fenced: boolean }> | undefined> {
    const context = record.commitContext;
    if (context === undefined || context.testFenceNotDurable === true) {
      return undefined;
    }
    const fences: Array<{ tag: string; fenced: boolean }> = [];
    for (const tag of missingTags) {
      const response = await this.tagRequest(context, tag, "/fence/install", {
        attemptId: context.attemptId,
        epoch: record.ownerEpoch,
        reason: "partial_write",
      });
      if (response.status < 200 || response.status >= 300) {
        return undefined;
      }
      fences.push({ tag, fenced: true });
    }
    return fences;
  }

  private async tagRequest(
    context: CommitAttemptContext,
    tag: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const url = new URL(`https://commit-recovery.internal${path}`);
    url.searchParams.set("__tag", tag);
    const tagObject = this.env.TAG.get(this.env.TAG.idFromName(`${context.serviceId}|${tag}`));
    return tagObject.fetch(
      new Request(url.toString(), body === undefined ? undefined : {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  private async consumeFault(expected: JournalRecord): Promise<JournalRecord | undefined> {
    const result = await this.ctx.storage.transaction(async (txn): Promise<MutationResult> => {
      const record = await txn.get<JournalRecord>(JOURNAL_KEY);
      if (record === undefined) {
        return { ok: false, status: 404, error: "Journal has not been admitted" };
      }
      if (
        record.state !== expected.state ||
        record.version !== expected.version ||
        record.ownerEpoch !== expected.ownerEpoch
      ) {
        return { ok: false, status: 409, error: "Journal changed while alarm fault was handled" };
      }
      const updated: JournalRecord = {
        ...record,
        faultsRemaining: Math.max(0, record.faultsRemaining - 1),
        version: record.version + 1,
        updatedAt: nowIso(),
      };
      await txn.put(JOURNAL_KEY, updated);
      return { ok: true, record: updated };
    });
    return result.ok ? result.record : this.readRecord();
  }

  private async recoverAlarmFailure(): Promise<JournalRecord | undefined> {
    try {
      const result = await this.ctx.storage.transaction(async (txn): Promise<JournalRecord | undefined> => {
        const record = await txn.get<JournalRecord>(JOURNAL_KEY);
        if (record === undefined || isTerminalState(record.state)) {
          return record;
        }
        const updated: JournalRecord = {
          ...record,
          alarm: nextAlarm(record.alarm),
          version: record.version + 1,
          updatedAt: nowIso(),
        };
        const alarm = updated.alarm!;
        await txn.put(JOURNAL_KEY, updated);
        await txn.setAlarm(alarm.dueAt);
        return updated;
      });
      return result;
    } catch {
      return this.readRecord();
    }
  }
}

function emptyReconciliation(): ReconciliationInput {
  return { records: [], failureCause: "write-failure" };
}
