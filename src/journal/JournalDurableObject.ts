import {
  isAllowedTransition,
  isJournalState,
  isTerminalState,
  type AlarmSchedule,
  type CasExpectation,
  type ConsistencyTag,
  type JournalCandidate,
  type JournalRecord,
  type JournalState,
  type JournalTerminalState,
  type ReconciliationFailureCause,
  type ReconciliationInput,
  type RequeriedRecord,
} from "./types";

const JOURNAL_KEY = "journal";
const INITIAL_ALARM_DELAY_MS = 5_000;
export const MAX_ALARM_BACKOFF_MS = 30_000;
const ALARM_BACKOFF_BASE_MS = 250;

type JsonObject = Record<string, unknown>;

interface AdmissionInput {
  candidates: JournalCandidate[];
  consistencyTags: ConsistencyTag[];
  faultInjection?: "before-admission-commit" | "after-admission-commit";
}

interface TransitionInput extends CasExpectation {
  nextState: JournalState;
}

interface TakeoverInput extends CasExpectation {
  seals: Array<{ tag: string; sealed: boolean }>;
  reconciliation: ReconciliationInput;
}

interface FaultInput extends CasExpectation {
  faultsRemaining: number;
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

function requeryCount(record: JournalRecord, input: ReconciliationInput): number {
  const candidates = new Map(record.candidates.map((candidate) => [candidate.eventId, candidate]));
  return input.records.filter((entry) => {
    const candidate = candidates.get(entry.eventId);
    return candidate !== undefined && candidate.payload === entry.payload && entry.present;
  }).length;
}

function takeoverBarrierSatisfied(record: JournalRecord, input: ReconciliationInput): boolean {
  if (record.takeover === null) {
    return true;
  }

  return (
    record.allTags.every((tag) => record.takeover?.sealedTags.includes(tag)) &&
    hasFullRequery(record, input)
  );
}

function decideReconciliation(record: JournalRecord, input: ReconciliationInput): ReconciliationDecision {
  if (!takeoverBarrierSatisfied(record, input)) {
    return { nextState: record.state, reason: "takeover absence barrier is incomplete" };
  }

  switch (record.state) {
    case "ADMITTED":
      return hasAllocatorVector(input)
        ? { nextState: "RESERVED", reason: "allocator vector is durable" }
        : { nextState: "ABANDONED", reason: "no allocator vector was ever admitted" };
    case "RESERVED":
      return hasAllocatorVector(input)
        ? { nextState: "ALLOCATED", reason: "allocator vector is durable" }
        : {
            nextState: failureState(input.failureCause),
            reason: "reservation has no allocator vector",
          };
    case "ALLOCATED":
    case "WRITING":
    case "SEALING": {
      const observed = requeryCount(record, input);
      if (observed === record.candidates.length) {
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

  return { value: { candidates, consistencyTags, faultInjection } };
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
    failureCause !== "write-failure"
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

  return { value: { allocatorVector, records, failureCause } };
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
  return { value: { ...expectation.value, nextState: value.nextState } };
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
  return { value: { ...expectation.value, seals, reconciliation: reconciliation.value } };
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
  return { value: { ...expectation.value, faultsRemaining: value.faultsRemaining } };
}

/**
 * Per-commit-attempt durable state machine. Its HTTP surface is an internal
 * test/control boundary; the five Serialized DCB V1 HTTP endpoints remain a
 * later slice.
 */
export class JournalDurableObject implements DurableObject {
  constructor(private readonly ctx: DurableObjectState) {}

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
    if (request.method === "POST" && path === "/takeover") {
      return this.takeover(body);
    }
    if (request.method === "POST" && path === "/fault") {
      return this.setFaults(body);
    }
    if (request.method === "POST" && path === "/debug/alarm") {
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
        ownerEpoch: 0,
        state: "ADMITTED",
        version: 0,
        alarm: nextAlarm(null, true),
        reconciliation: null,
        takeover: null,
        faultsRemaining: 0,
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
      if (isTerminalState(input.nextState) && !takeoverBarrierSatisfied(record, record.reconciliation ?? emptyReconciliation())) {
        return { ok: false, status: 409, error: "Takeover absence barrier must complete before terminal state" };
      }

      const updated: JournalRecord = {
        ...record,
        state: input.nextState,
        version: record.version + 1,
        updatedAt: nowIso(),
      };
      if (isTerminalState(updated.state)) {
        updated.alarm = null;
        updated.terminalResponse = terminalResponse(updated.state, updated, "explicit CAS transition");
        await txn.put(JOURNAL_KEY, updated);
        await txn.deleteAlarm();
      } else {
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

    const result = await this.applyReconciliation(expectation.value, reconciliation.value);
    return result.ok
      ? json(result.record)
      : error(result.status, "journal_reconciliation_rejected", result.error);
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
      input.reconciliation.records.some((entry) => candidateById.get(entry.eventId)?.payload !== entry.payload)
    ) {
      return error(400, "invalid_journal_takeover", "Takeover evidence does not match the admitted batch");
    }

    const handoff = await this.ctx.storage.transaction(async (txn): Promise<MutationResult> => {
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

      const takeover = record.takeover ?? { active: true as const, sealedTags: [] };
      const updated: JournalRecord = {
        ...record,
        ownerEpoch: record.takeover === null ? record.ownerEpoch + 1 : record.ownerEpoch,
        state: "SEALING",
        version: record.version + 1,
        takeover,
        updatedAt: nowIso(),
      };
      await txn.put(JOURNAL_KEY, updated);
      return { ok: true, record: updated };
    });

    if (!handoff.ok) {
      return error(handoff.status, "journal_takeover_rejected", handoff.error);
    }

    const evidence = await this.ctx.storage.transaction(async (txn): Promise<MutationResult> => {
      const record = await txn.get<JournalRecord>(JOURNAL_KEY);
      if (record === undefined) {
        return { ok: false, status: 404, error: "Journal disappeared during takeover" };
      }
      if (
        record.state !== handoff.record.state ||
        record.version !== handoff.record.version ||
        record.ownerEpoch !== handoff.record.ownerEpoch
      ) {
        return { ok: false, status: 409, error: "Journal changed before seal evidence could be stored" };
      }

      const sealedTags = unique([
        ...record.takeover!.sealedTags,
        ...input.seals.filter((seal) => seal.sealed).map((seal) => seal.tag),
      ]);
      const updated: JournalRecord = {
        ...record,
        version: record.version + 1,
        takeover: { active: true, sealedTags },
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

      const decision = decideReconciliation(record, reconciliation);
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
        if (updated.alarm === null) {
          updated.alarm = nextAlarm(null, true);
          await txn.setAlarm(updated.alarm.dueAt);
        }
        await txn.put(JOURNAL_KEY, updated);
      }
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
      if (rearmed.record.faultsRemaining > 0) {
        return this.consumeFault(rearmed.record);
      }

      const reconciliation = rearmed.record.reconciliation ?? emptyReconciliation();
      const reconciled = await this.applyReconciliation(
        {
          expectedState: rearmed.record.state,
          expectedVersion: rearmed.record.version,
          expectedOwnerEpoch: rearmed.record.ownerEpoch,
        },
        reconciliation,
      );
      return reconciled.ok ? reconciled.record : this.readRecord();
    } catch {
      return this.recoverAlarmFailure();
    }
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
