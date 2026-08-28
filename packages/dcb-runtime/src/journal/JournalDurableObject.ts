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
  type RepairObservation,
  type RepairObservationPhase,
  type ReservationFailure,
} from "./types";
import { allocatorNameForService } from "../allocator/types";
import { assertCanonicalEventType } from "../eventIdentity";
import { assertSortableUniqueId } from "../allocator/SortableUniqueId";
import { CANONICAL_UTC_TIMESTAMP_PATTERN } from "../eventRecord";
import {
  correlationIdForAttempt,
  DurableObjectActivation,
  enterNativeActorHandleSpan,
  enterNativeCommitSpan,
  enterNativeReconcileRootSpan,
  noOpNativeTracing,
  stableTraceHash,
  traceManifest,
  type DurableObjectActivationObservation,
  type NativeCommitSpanInput,
  type NativeTracing,
} from "../trace/CommitTrace";
import {
  beginDurableObjectHandlerObservation,
  type DurableObjectHandlerObservation,
} from "../trace/ObservationStream";
import {
  G42_JOURNAL_PROBE_ALARM_KEY,
  G42_JOURNAL_PROBE_INTERNAL_PREFIX,
  G42_JOURNAL_PROBE_SCHEMA,
  G42_JOURNAL_PROBE_INDEX_KEY,
  g42ProbeStorageKey,
  isG42ProbeLogicalKey,
  type G42ProbeActivationFact,
} from "./JournalFirstTouchProbe";

const JOURNAL_KEY = "journal";
const INITIAL_ALARM_DELAY_MS = 5_000;
export const MAX_ALARM_BACKOFF_MS = 30_000;
const ALARM_BACKOFF_BASE_MS = 250;
const TEST_FAULT_ALARM_DELAY_MS = 60_000;
/** The probe alarm is deliberately far outside its measurement interval. */
const G42_PROBE_ALARM_DELAY_MS = 24 * 60 * 60 * 1_000;

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
  allocatorLineageId?: string;
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

interface G42ProbeRecord {
  readonly schema: typeof G42_JOURNAL_PROBE_SCHEMA;
  readonly trialId: string;
  readonly logicalKey: string;
  readonly recordKind: "warmup" | "measure";
  readonly payload: string;
  readonly createdAtMs: number;
}

interface G42ProbeIndex {
  readonly schema: typeof G42_JOURNAL_PROBE_SCHEMA;
  readonly logicalKeys: readonly string[];
  /** D warm-up trial IDs, read with the same index read as every cell. */
  readonly warmupTrialIds: readonly string[];
}

interface G42ProbeAlarmMarker {
  readonly schema: typeof G42_JOURNAL_PROBE_SCHEMA;
  readonly dueAt: number;
}

interface G42ProbeInternalRequest {
  readonly action: "ping" | "state" | "write" | "cleanup" | "inventory";
  readonly trialId: string;
  readonly cell?: "A" | "B" | "C" | "D";
  readonly logicalKey?: string;
  readonly recordKind?: "warmup" | "measure";
  readonly payload?: string;
  readonly alarmMode?: "on" | "off";
  readonly requestBytes: number;
}

type RepairObservationInput = Omit<RepairObservation, "observedAt">;

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

type ReconcileRowId =
  | "R00"
  | "R01"
  | "R02"
  | "R03"
  | "R04"
  | "R05"
  | "R06"
  | "R08"
  | "R09"
  | "R10"
  | "R11";

type ReconcileRecoveryKind =
  | "terminal-at-entry"
  | "pre-allocation-vector-absent"
  | "journal-pre-allocation-vector-present"
  | "post-allocation-full-write"
  | "post-allocation-no-write"
  | "post-allocation-partial-write"
  | "permit-release-won"
  | "permit-transfer-won"
  | "permit-corrupt-missing";

interface ReconcileTraceContext {
  readonly attemptId: string;
  readonly serviceId: string;
  readonly activation: DurableObjectActivationObservation;
  /** Observation adapter only; never stored on the durable Journal record. */
  readonly nativeTracing: NativeTracing;
  readonly alarmEventId: string;
  readonly invocationId: string;
  readonly retryCount: number;
  readonly isRetry: boolean;
  recoveryKind?: ReconcileRecoveryKind;
  readonly prefixAtEntry: "pre-takeover" | "takeover-done" | "transfer-done" | "sealed" | "terminal";
}

type ReconcileApplyTrace = Readonly<{
  rowId: "R06" | "R11";
  before: ReconcileTraceContext["prefixAtEntry"];
  after: ReconcileTraceContext["prefixAtEntry"];
}>;

function durablePrefix(record: JournalRecord): ReconcileTraceContext["prefixAtEntry"] {
  if (isTerminalState(record.state)) return "terminal";
  if (record.takeover === null) return "pre-takeover";
  return record.state === "SEALING" ? "takeover-done" : "sealed";
}

function reconcileTraceFor(
  record: JournalRecord | undefined,
  activation: DurableObjectActivationObservation,
  nativeTracing: NativeTracing,
  alarmInfo?: AlarmInvocationInfo,
): ReconcileTraceContext | undefined {
  const context = record?.commitContext;
  if (record === undefined || context === undefined) return undefined;
  return {
    attemptId: context.attemptId,
    serviceId: context.serviceId,
    activation,
    nativeTracing,
    // A platform retry belongs to the generation already captured by the
    // preceding R01. A fresh self-rearmed fire consumes the scheduled
    // generation that was durable at entry. Never attribute either to the
    // generation this invocation subsequently schedules.
    alarmEventId: alarmInfo?.isRetry
      ? record.firedGenerationId ?? record.alarm?.scheduledGenerationId ?? crypto.randomUUID()
      : record.alarm?.scheduledGenerationId ?? record.firedGenerationId ?? crypto.randomUUID(),
    invocationId: crypto.randomUUID(),
    retryCount: alarmInfo?.retryCount ?? 0,
    isRetry: alarmInfo?.isRetry ?? false,
    prefixAtEntry: durablePrefix(record!),
  };
}

function reconcileRow(rowId: ReconcileRowId) {
  const rows = traceManifest().schemas["sdt.commit.reconcile/v1"].rows;
  const found = rows.find((row) => row.rowId === rowId);
  if (found === undefined) throw new Error(`commit trace manifest lacks reconciliation row ${rowId}`);
  return found;
}

async function tracedReconcile<T>(
  trace: ReconcileTraceContext | undefined,
  rowId: ReconcileRowId,
  callback: () => T | Promise<T>,
  options: Readonly<{
    before?: ReconcileTraceContext["prefixAtEntry"];
    after?: ReconcileTraceContext["prefixAtEntry"];
    memberIndex?: number;
    tag?: string;
  }> = {},
): Promise<T> {
  if (trace === undefined) return callback();
  // The manifest is a verifier authority, not a new alarm/commit control
  // dependency. If a malformed deployment artifact cannot describe this
  // observation, retain the original recovery callback unchanged and leave
  // the export incomplete rather than changing reconciliation semantics.
  let input: NativeCommitSpanInput;
  let spanName: string;
  try {
    const row = reconcileRow(rowId);
    spanName = row.span;
    input = {
      schema: "sdt.commit.reconcile/v1",
      face: "reconcile-root",
      rowId,
      correlationId: correlationIdForAttempt(trace.attemptId),
      attemptId: trace.attemptId,
      serviceId: trace.serviceId,
      actorClass: "JOURNAL",
      actorKey: `journal:${trace.attemptId}`,
      activation: trace.activation,
      operation: row.span,
      kind: row.kind as NativeCommitSpanInput["kind"],
      attributes: {
        ...(options.before === undefined ? {} : { "prefix.before": options.before }),
        ...(options.after === undefined ? {} : { "prefix.after": options.after }),
        ...(options.memberIndex === undefined ? {} : { "member.index": options.memberIndex }),
        ...(options.tag === undefined ? {} : { "tag.key_hash": stableTraceHash(options.tag) }),
      },
    };
  } catch {
    return callback();
  }
  return enterNativeCommitSpan(trace.nativeTracing, spanName, input, callback);
}

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

function g42ProbeInternalRequest(value: unknown, requestBytes: number): { value?: G42ProbeInternalRequest; error?: string } {
  if (!isObject(value) || value.schema !== G42_JOURNAL_PROBE_SCHEMA || !isNonEmptyString(value.trialId)) {
    return { error: "G42 probe request requires its schema and trialId" };
  }
  if (value.action !== "ping" && value.action !== "state" && value.action !== "write" && value.action !== "cleanup" && value.action !== "inventory") {
    return { error: "G42 probe action is not recognized" };
  }
  if ((value.action === "state" || value.action === "write") && !isG42ProbeLogicalKey(value.logicalKey)) {
    return { error: "G42 probe logical key lacks the reserved fixed-length prefix" };
  }
  if (value.action === "write") {
    if ((value.recordKind !== "warmup" && value.recordKind !== "measure") || !isNonEmptyString(value.payload)) {
      return { error: "G42 probe write requires recordKind and payload" };
    }
    if (new TextEncoder().encode(value.payload).byteLength > 8_192) {
      return { error: "G42 probe payload exceeds the fixed probe limit" };
    }
    if (value.alarmMode !== "on" && value.alarmMode !== "off") {
      return { error: "G42 probe write requires a recognized alarmMode" };
    }
    if (value.cell !== "A" && value.cell !== "B" && value.cell !== "C" && value.cell !== "D") {
      return { error: "G42 probe write requires a recognized fixed-width cell" };
    }
    if (value.recordKind === "warmup" && value.alarmMode !== "off") {
      return { error: "G42 probe warmup must not install an alarm" };
    }
  }
  return {
    value: {
      action: value.action,
      trialId: value.trialId,
      ...(value.cell === "A" || value.cell === "B" || value.cell === "C" || value.cell === "D" ? { cell: value.cell } : {}),
      ...(isG42ProbeLogicalKey(value.logicalKey) ? { logicalKey: value.logicalKey } : {}),
      ...(value.recordKind === "warmup" || value.recordKind === "measure" ? { recordKind: value.recordKind } : {}),
      ...(isNonEmptyString(value.payload) ? { payload: value.payload } : {}),
      ...(value.alarmMode === "on" || value.alarmMode === "off" ? { alarmMode: value.alarmMode } : {}),
      requestBytes,
    },
  };
}

function g42ProbeIndex(value: unknown): G42ProbeIndex {
  if (!isObject(value) || value.schema !== G42_JOURNAL_PROBE_SCHEMA || !Array.isArray(value.logicalKeys) || !Array.isArray(value.warmupTrialIds)) {
    return { schema: G42_JOURNAL_PROBE_SCHEMA, logicalKeys: [], warmupTrialIds: [] };
  }
  const logicalKeys = value.logicalKeys.filter(isG42ProbeLogicalKey);
  const warmupTrialIds = value.warmupTrialIds.filter(isNonEmptyString);
  if (logicalKeys.length !== value.logicalKeys.length || new Set(logicalKeys).size !== logicalKeys.length
    || warmupTrialIds.length !== value.warmupTrialIds.length || new Set(warmupTrialIds).size !== warmupTrialIds.length) {
    return { schema: G42_JOURNAL_PROBE_SCHEMA, logicalKeys: [], warmupTrialIds: [] };
  }
  return { schema: G42_JOURNAL_PROBE_SCHEMA, logicalKeys, warmupTrialIds };
}

function g42ProbeAlarmMarker(value: unknown): G42ProbeAlarmMarker | undefined {
  if (!isObject(value) || value.schema !== G42_JOURNAL_PROBE_SCHEMA || !isNonNegativeInteger(value.dueAt)) return undefined;
  return { schema: G42_JOURNAL_PROBE_SCHEMA, dueAt: value.dueAt };
}

function g42ProbeActivation(activation: DurableObjectActivationObservation, firstStorageReadMs: number | null): G42ProbeActivationFact {
  return {
    activationId: activation.activationId,
    activationFirst: activation.first,
    constructorToHandlerMs: activation.constructorToHandlerMs,
    firstStorageReadMs,
  };
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
      scheduledGenerationId: crypto.randomUUID(),
    };
  }

  const attempt = (previous?.attempt ?? 0) + 1;
  const exponent = Math.min(attempt - 1, 7);
  const delayMs = Math.min(ALARM_BACKOFF_BASE_MS * 2 ** exponent, MAX_ALARM_BACKOFF_MS);
  return { attempt, delayMs, dueAt: Date.now() + delayMs, scheduledGenerationId: crypto.randomUUID() };
}

function immediateAlarm(previous: AlarmSchedule | null): AlarmSchedule {
  return {
    attempt: previous?.attempt ?? 0,
    delayMs: 0,
    dueAt: Date.now(),
    scheduledGenerationId: crypto.randomUUID(),
  };
}

/** Keeps a test-injected crash observable until the test explicitly wakes it. */
function testFaultAlarm(previous: AlarmSchedule | null): AlarmSchedule {
  return {
    attempt: previous?.attempt ?? 0,
    delayMs: TEST_FAULT_ALARM_DELAY_MS,
    dueAt: Date.now() + TEST_FAULT_ALARM_DELAY_MS,
    scheduledGenerationId: crypto.randomUUID(),
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

function postAllocationRecoveryKind(
  record: JournalRecord,
  input: ReconciliationInput,
): Extract<ReconcileRecoveryKind, `post-allocation-${string}`> {
  if (hasEveryCandidatePresent(record, input)) return "post-allocation-full-write";
  return requeryCount(record, input) > 0
    ? "post-allocation-partial-write"
    : "post-allocation-no-write";
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
    if (!isNonEmptyString(rawCandidate.eventType) || !isNonEmptyString(rawCandidate.timestamp)) {
      return { error: "candidate eventType and timestamp are required" };
    }
    try {
      assertCanonicalEventType(rawCandidate.eventType);
    } catch {
      return { error: "candidate eventType must be a canonical eventPayloadName" };
    }
    if (!CANONICAL_UTC_TIMESTAMP_PATTERN.test(rawCandidate.timestamp)) {
      return { error: "candidate timestamp must be canonical UTC" };
    }
    candidates.push({
      eventId: rawCandidate.eventId,
      payload: rawCandidate.payload,
      eventType: rawCandidate.eventType,
      timestamp: rawCandidate.timestamp,
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
    try {
      assertSortableUniqueId(rawTag.lastSortableUniqueId);
    } catch {
      return { error: "lastSortableUniqueId must be a 30-digit SortableUniqueId" };
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
    if (
      value.commitContext.testFenceInstallFaultOnce !== undefined &&
      typeof value.commitContext.testFenceInstallFaultOnce !== "boolean"
    ) {
      return { error: "commitContext testFenceInstallFaultOnce must be a boolean" };
    }
    if (
      value.commitContext.allocatorLineageId !== undefined &&
      !isNonEmptyString(value.commitContext.allocatorLineageId)
    ) {
      return { error: "commitContext allocatorLineageId must be a non-empty string" };
    }
    commitContext = {
      attemptId: value.commitContext.attemptId,
      serviceId: value.commitContext.serviceId,
      ...(isNonEmptyString(value.commitContext.allocatorLineageId)
        ? { allocatorLineageId: value.commitContext.allocatorLineageId }
        : {}),
      ...(value.commitContext.testFenceNotDurable === true ? { testFenceNotDurable: true } : {}),
      ...(value.commitContext.testFenceInstallFaultOnce === true ? { testFenceInstallFaultOnce: true } : {}),
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
  if (value.allocatorLineageId !== undefined && !isNonEmptyString(value.allocatorLineageId)) {
    return { error: "allocatorLineageId must be a non-empty string when present" };
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
      allocatorLineageId: value.allocatorLineageId,
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

function repairObservationFrom(value: unknown): { value?: RepairObservationInput; error?: string } {
  if (
    !isObject(value) ||
    !isNonEmptyString(value.owner) ||
    !isNonNegativeInteger(value.epoch) ||
    !isNonEmptyString(value.tag) ||
    !isNonEmptyString(value.attemptId) ||
    !isNonEmptyString(value.eventId) ||
    !isNonEmptyString(value.suid) ||
    (value.phase !== "PREPARED" && value.phase !== "VERIFIED" && value.phase !== "CLEARED")
  ) {
    return { error: "repair observation needs owner, epoch, tag, attemptId, eventId, suid, and phase" };
  }
  if (
    value.branch !== undefined &&
    value.branch !== "ROLLED_FORWARD" &&
    value.branch !== "EXCLUDED_AUDITED" &&
    value.branch !== "FAILED_CLOSED"
  ) {
    return { error: "repair observation branch is not recognized" };
  }
  return {
    value: {
      owner: value.owner,
      epoch: value.epoch,
      tag: value.tag,
      attemptId: value.attemptId,
      eventId: value.eventId,
      suid: value.suid,
      phase: value.phase as RepairObservationPhase,
      ...(value.branch === undefined ? {} : { branch: value.branch }),
    },
  };
}

/**
 * Per-commit-attempt durable state machine. Its HTTP surface is an internal
 * test/control boundary; the five Serialized DCB V1 HTTP endpoints remain a
 * later slice.
 */
export class JournalDurableObject implements DurableObject {
  /** Constructor-scoped observation only; never persisted or used for control. */
  private readonly activation = new DurableObjectActivation();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: CommitRecoveryEnv,
    /** Cloudflare entrypoints inject active context; portable paths remain fail-open. */
    private readonly nativeTracing: NativeTracing = noOpNativeTracing,
  ) {}

  async fetch(request: Request): Promise<Response> {
    // Flip before this handler performs its first await.
    const activation = this.activation.beginHandler();
    const observation = beginDurableObjectHandlerObservation("JOURNAL", activation);
    const path = new URL(request.url).pathname;
    // G42 has a private, conformance-only synthetic namespace.  It does not
    // enter the normal commit trace or recovery surface: its receipts carry a
    // distinct schema and its storage keys can never be JOURNAL_KEY.
    if (request.method === "POST" && path.startsWith(`${G42_JOURNAL_PROBE_INTERNAL_PREFIX}/`)) {
      return this.g42Probe(request, path, activation, observation);
    }
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
    if (request.method === "GET" && path === "/repair/workset") {
      return this.repairWorkset();
    }
    if (request.method === "GET" && path === "/repair/observations") {
      return this.repairObservations();
    }

    if (request.method === "POST" && path === "/admit") {
      return this.traceCommitActor(request, activation, observation, (body) => this.admit(body, observation));
    }
    if (request.method === "POST" && path === "/transition") {
      return this.traceCommitActor(request, activation, observation, (body) => this.transition(body, observation));
    }
    if (request.method === "POST" && path === "/reconcile") {
      return this.traceCommitActor(request, activation, observation, (body) => this.reconcile(body, observation));
    }
    if (request.method === "POST" && path === "/reservation-failure") {
      return this.traceCommitActor(request, activation, observation, (body) => this.recordReservationFailure(body, observation));
    }

    const body = await this.jsonBody(request);
    if (body === undefined) {
      return error(400, "malformed_journal_request", "Request body must be JSON");
    }
    if (request.method === "POST" && path === "/takeover") {
      return this.takeover(body);
    }
    if (request.method === "POST" && path === "/fault") {
      return this.setFaults(body);
    }
    if (request.method === "POST" && path === "/repair/observation") {
      return this.recordRepairObservation(body);
    }
    if (request.method === "POST" && path === "/debug/alarm") {
      if (isObject(body) && body.clearTestFenceNotDurable === true) {
        await this.clearTestFenceNotDurableFault();
      }
      const record = await this.runAlarm(activation);
      return record === undefined ? error(404, "journal_not_found", "Journal has not been admitted") : json(record);
    }

    return error(404, "journal_route_not_found", "Journal route was not found");
  }

  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    const activation = this.activation.beginHandler();
    // A deliberately uncleaned G42 probe alarm is inert: it clears only the
    // reserved probe marker and never calls a production recovery port. This
    // branch is selected solely by a probe-only durable marker, not by input.
    if (await this.clearG42ProbeAlarmIfPresent()) return;
    await this.runAlarm(activation, alarmInfo);
  }

  private async traceCommitActor(
    request: Request,
    activation: DurableObjectActivationObservation,
    observation: DurableObjectHandlerObservation,
    callback: (body: unknown) => Promise<Response>,
  ): Promise<Response> {
    return enterNativeActorHandleSpan(
      this.nativeTracing,
      { actorClass: "JOURNAL", actorKey: "journal", activation, observation },
      async () => {
        const body = await this.jsonBody(request.clone());
        if (isObject(body) && isObject(body.commitContext) && isNonEmptyString(body.commitContext.attemptId) && isNonEmptyString(body.commitContext.serviceId)) {
          return {
            attemptId: body.commitContext.attemptId,
            serviceId: body.commitContext.serviceId,
            actorKey: `journal:${body.commitContext.attemptId}`,
          };
        }
        observation.markFirstStorageRead();
        const record = await this.readRecord();
        const context = record?.commitContext;
        return context === undefined ? undefined : {
          attemptId: context.attemptId,
          serviceId: context.serviceId,
          actorKey: `journal:${context.attemptId}`,
        };
      },
      async () => {
        const body = await this.jsonBody(request);
        return body === undefined
          ? error(400, "malformed_journal_request", "Request body must be JSON")
          : callback(body);
      },
    );
  }

  private async readRecord(): Promise<JournalRecord | undefined> {
    return this.ctx.storage.get<JournalRecord>(JOURNAL_KEY);
  }

  /**
   * Implements the G42-only storage-layout screen.  The outer Worker is the
   * sole public entrypoint and authenticates/fences it before a JOURNAL stub
   * is even resolved.  This method still validates its private message so an
   * accidental internal route cannot touch a normal Journal record.
   */
  private async g42Probe(
    request: Request,
    path: string,
    activation: DurableObjectActivationObservation,
    observation: DurableObjectHandlerObservation,
  ): Promise<Response> {
    let raw: string;
    try {
      raw = await request.text();
    } catch {
      return error(400, "g42_probe_malformed", "G42 probe request body is unavailable");
    }
    const requestBytes = new TextEncoder().encode(raw).byteLength;
    let body: unknown;
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      return error(400, "g42_probe_malformed", "G42 probe request body must be JSON");
    }
    const parsed = g42ProbeInternalRequest(body, requestBytes);
    if (parsed.value === undefined) return error(400, "g42_probe_invalid", parsed.error ?? "G42 probe request is invalid");
    const input = parsed.value;
    if (path !== `${G42_JOURNAL_PROBE_INTERNAL_PREFIX}/${input.action}`) {
      return error(404, "g42_probe_route_not_found", "G42 probe action does not match its internal route");
    }

    let firstStorageReadMs: number | null = null;
    const markFirstStorageRead = (): void => {
      if (firstStorageReadMs !== null) return;
      observation.markFirstStorageRead();
      firstStorageReadMs = Math.max(0, Date.now() - activation.handlerStartedAtMs);
    };
    const respond = (
      action: G42ProbeInternalRequest["action"],
      detail: Readonly<{
        transactionWallMs?: number | null;
        recordBytes?: number | null;
        alarmStateBefore?: number | null;
        alarmDueAt?: number | null;
        setAlarmCalls?: number;
        logicalKey?: string;
        expectedWarmupKeyPresent?: boolean;
        keyPresent?: boolean;
        inventory?: readonly string[];
        productionJournalPresent?: boolean;
      }> = {},
    ): Response => json({
      schema: G42_JOURNAL_PROBE_SCHEMA,
      action,
      activation: g42ProbeActivation(activation, firstStorageReadMs),
      handlerWallMs: Math.max(0, Date.now() - activation.handlerStartedAtMs),
      transactionWallMs: detail.transactionWallMs ?? null,
      requestBytes: input.requestBytes,
      recordBytes: detail.recordBytes ?? null,
      alarmStateBefore: detail.alarmStateBefore ?? null,
      alarmDueAt: detail.alarmDueAt ?? null,
      setAlarmCalls: detail.setAlarmCalls ?? 0,
      ...(detail.logicalKey === undefined ? {} : { logicalKey: detail.logicalKey }),
      ...(detail.expectedWarmupKeyPresent === undefined ? {} : { expectedWarmupKeyPresent: detail.expectedWarmupKeyPresent }),
      ...(detail.keyPresent === undefined ? {} : { keyPresent: detail.keyPresent }),
      ...(detail.inventory === undefined ? {} : { inventory: [...detail.inventory] }),
      ...(detail.productionJournalPresent === undefined ? {} : { productionJournalPresent: detail.productionJournalPresent }),
    });

    if (input.action === "ping") {
      return respond("ping");
    }

    if (input.action === "state") {
      const logicalKey = input.logicalKey!;
      markFirstStorageRead();
      const startedAtMs = Date.now();
      const record = await this.ctx.storage.get<G42ProbeRecord>(g42ProbeStorageKey(logicalKey));
      const response = respond("state", {
        transactionWallMs: Math.max(0, Date.now() - startedAtMs),
        logicalKey,
        keyPresent: record !== undefined,
      });
      // C is deliberately a real missing-key storage read. The outer probe
      // helper accepts this schema-preserving 404 as an expected mediator,
      // while retaining the actual status in the per-trial receipt.
      return record === undefined
        ? new Response(response.body, { status: 404, headers: response.headers })
        : response;
    }

    if (input.action === "write") {
      const logicalKey = input.logicalKey!;
      const recordKind = input.recordKind!;
      const payload = input.payload!;
      const alarmMode = input.alarmMode!;
      markFirstStorageRead();
      const startedAtMs = Date.now();
      const result = await this.ctx.storage.transaction(async (txn) => {
        // The G42 namespace is deliberately disjoint. Do not share a physical
        // object with a normal Journal even if an internal caller is buggy.
        const productionJournal = await txn.get<JournalRecord>(JOURNAL_KEY);
        if (productionJournal !== undefined) return { conflict: "production_journal_present" } as const;
        const storageKey = g42ProbeStorageKey(logicalKey);
        const existing = await txn.get<G42ProbeRecord>(storageKey);
        if (existing !== undefined) return { conflict: "logical_key_already_present" } as const;
        const alarmStateBefore = await txn.getAlarm();
        if (alarmStateBefore !== null) return { conflict: "probe_alarm_prestate_not_empty" } as const;
        const record: G42ProbeRecord = {
          schema: G42_JOURNAL_PROBE_SCHEMA,
          trialId: input.trialId,
          logicalKey,
          recordKind,
          payload,
          createdAtMs: Date.now(),
        };
        const index = g42ProbeIndex(await txn.get<G42ProbeIndex>(G42_JOURNAL_PROBE_INDEX_KEY));
        // This is deliberately an index-only check.  A and D execute the
        // same measured storage reads and request shape; D's already-read
        // index proves its distinct alarm-free warm-up by trial ID.
        let expectedWarmupKeyPresent: boolean | undefined;
        if (recordKind === "measure" && input.cell === "D") {
          expectedWarmupKeyPresent = index.warmupTrialIds.includes(input.trialId);
          if (!expectedWarmupKeyPresent) return { conflict: "expected_warmup_record_missing" } as const;
        }
        const nextIndex: G42ProbeIndex = {
          schema: G42_JOURNAL_PROBE_SCHEMA,
          logicalKeys: [...index.logicalKeys, logicalKey].sort(),
          warmupTrialIds: recordKind === "warmup"
            ? [...index.warmupTrialIds, input.trialId].sort()
            : index.warmupTrialIds,
        };
        await txn.put(storageKey, record);
        await txn.put(G42_JOURNAL_PROBE_INDEX_KEY, nextIndex);
        let alarmDueAt: number | null = null;
        let setAlarmCalls = 0;
        if (alarmMode === "on") {
          alarmDueAt = Date.now() + G42_PROBE_ALARM_DELAY_MS;
          await txn.put(G42_JOURNAL_PROBE_ALARM_KEY, {
            schema: G42_JOURNAL_PROBE_SCHEMA,
            dueAt: alarmDueAt,
          } satisfies G42ProbeAlarmMarker);
          await txn.setAlarm(alarmDueAt);
          setAlarmCalls = 1;
        }
        return {
          conflict: undefined,
          recordBytes: new TextEncoder().encode(JSON.stringify(record)).byteLength,
          alarmStateBefore,
          alarmDueAt,
          setAlarmCalls,
          expectedWarmupKeyPresent,
        } as const;
      });
      if (result.conflict !== undefined) {
        return error(409, "g42_probe_conflict", result.conflict);
      }
      return respond("write", {
        transactionWallMs: Math.max(0, Date.now() - startedAtMs),
        recordBytes: result.recordBytes,
        alarmStateBefore: result.alarmStateBefore,
        alarmDueAt: result.alarmDueAt,
        setAlarmCalls: result.setAlarmCalls,
        logicalKey,
        ...(result.expectedWarmupKeyPresent === undefined ? {} : { expectedWarmupKeyPresent: result.expectedWarmupKeyPresent }),
      });
    }

    if (input.action === "cleanup") {
      markFirstStorageRead();
      const startedAtMs = Date.now();
      const result = await this.ctx.storage.transaction(async (txn) => {
        const productionJournal = await txn.get<JournalRecord>(JOURNAL_KEY);
        if (productionJournal !== undefined) return { conflict: "production_journal_present" } as const;
        const index = g42ProbeIndex(await txn.get<G42ProbeIndex>(G42_JOURNAL_PROBE_INDEX_KEY));
        for (const logicalKey of index.logicalKeys) {
          await txn.delete(g42ProbeStorageKey(logicalKey));
        }
        await txn.delete(G42_JOURNAL_PROBE_INDEX_KEY);
        const marker = g42ProbeAlarmMarker(await txn.get<G42ProbeAlarmMarker>(G42_JOURNAL_PROBE_ALARM_KEY));
        if (marker !== undefined) {
          await txn.delete(G42_JOURNAL_PROBE_ALARM_KEY);
          await txn.deleteAlarm();
        }
        return { conflict: undefined, cleared: index.logicalKeys.length, hadAlarm: marker !== undefined } as const;
      });
      if (result.conflict !== undefined) return error(409, "g42_probe_conflict", result.conflict);
      return respond("cleanup", {
        transactionWallMs: Math.max(0, Date.now() - startedAtMs),
        inventory: [],
        alarmDueAt: null,
        productionJournalPresent: false,
      });
    }

    markFirstStorageRead();
    const startedAtMs = Date.now();
    const inventory = await this.ctx.storage.transaction(async (txn) => {
      const index = g42ProbeIndex(await txn.get<G42ProbeIndex>(G42_JOURNAL_PROBE_INDEX_KEY));
      const marker = g42ProbeAlarmMarker(await txn.get<G42ProbeAlarmMarker>(G42_JOURNAL_PROBE_ALARM_KEY));
      const alarmDueAt = await txn.getAlarm();
      const productionJournal = await txn.get<JournalRecord>(JOURNAL_KEY);
      return {
        logicalKeys: index.logicalKeys,
        alarmDueAt: marker === undefined ? null : alarmDueAt,
        productionJournalPresent: productionJournal !== undefined,
      } as const;
    });
    return respond("inventory", {
      transactionWallMs: Math.max(0, Date.now() - startedAtMs),
      inventory: inventory.logicalKeys,
      alarmDueAt: inventory.alarmDueAt,
      productionJournalPresent: inventory.productionJournalPresent,
    });
  }

  /** A probe alarm must be inert even if an interrupted runner never cleans it. */
  private async clearG42ProbeAlarmIfPresent(): Promise<boolean> {
    return this.ctx.storage.transaction(async (txn) => {
      const marker = g42ProbeAlarmMarker(await txn.get<G42ProbeAlarmMarker>(G42_JOURNAL_PROBE_ALARM_KEY));
      if (marker === undefined) return false;
      await txn.delete(G42_JOURNAL_PROBE_ALARM_KEY);
      await txn.deleteAlarm();
      return true;
    });
  }

  private async repairWorkset(): Promise<Response> {
    const record = await this.readRecord();
    if (record === undefined) {
      return error(404, "journal_not_found", "Journal has not been admitted");
    }
    if (record.state !== "PARTIAL") {
      return error(409, "journal_not_partial", "Repair work is available only for a PARTIAL Journal outcome");
    }
    const vector = record.reconciliation?.allocatorVector;
    if (vector === undefined || vector.length !== record.candidates.length) {
      return error(409, "repair_workset_indeterminate", "PARTIAL Journal lacks its durable allocator vector");
    }
    return json({
      attemptId: record.commitContext?.attemptId,
      missingTags: record.reconciliation?.missingTags ?? [],
      candidates: record.candidates.map((candidate, index) => ({
        ...candidate,
        suid: vector[index]!,
        ...(record.commitContext?.allocatorLineageId === undefined
          ? {}
          : { allocatorLineageId: record.commitContext.allocatorLineageId }),
      })),
    });
  }

  private async repairObservations(): Promise<Response> {
    const record = await this.readRecord();
    if (record === undefined) {
      return error(404, "journal_not_found", "Journal has not been admitted");
    }
    return json({ observations: record.repairObservations ?? [] });
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
        ...(record.commitContext.allocatorLineageId === undefined
          ? {}
          : { allocatorLineageId: record.commitContext.allocatorLineageId }),
      };
      await txn.put(JOURNAL_KEY, {
        ...record,
        commitContext,
        version: record.version + 1,
        updatedAt: nowIso(),
      });
    });
  }

  private async jsonBody(request: Pick<Request, "json">): Promise<unknown | undefined> {
    try {
      return await request.json<unknown>();
    } catch {
      return undefined;
    }
  }

  private async admit(body: unknown, observation?: DurableObjectHandlerObservation): Promise<Response> {
    const parsed = admissionFrom(body);
    if (parsed.value === undefined) {
      return error(400, "invalid_journal_admission", parsed.error ?? "Invalid Journal admission");
    }
    if (parsed.value.faultInjection === "before-admission-commit") {
      return error(503, "simulated_admission_crash", "Simulated interruption before durable admission");
    }

    const input = parsed.value;
    observation?.markFirstStorageRead();
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
        repairObservations: [],
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

  private async recordRepairObservation(body: unknown): Promise<Response> {
    const parsed = repairObservationFrom(body);
    if (parsed.value === undefined) {
      return error(400, "invalid_repair_observation", parsed.error ?? "Invalid repair observation");
    }
    const input = parsed.value;
    const result = await this.ctx.storage.transaction(async (txn): Promise<MutationResult> => {
      const record = await txn.get<JournalRecord>(JOURNAL_KEY);
      if (record === undefined) {
        return { ok: false, status: 404, error: "Journal has not been admitted" };
      }
      if (record.state !== "PARTIAL") {
        return { ok: false, status: 409, error: "Repair observations are valid only for a PARTIAL Journal outcome" };
      }
      // The Journal only records observations for its admitted candidate and
      // durable SUID.  This keeps progress useful without making it authority.
      const candidateIndex = record.candidates.findIndex((candidate) =>
        candidate.eventId === input.eventId && candidate.payload !== undefined && candidate.tags.includes(input.tag),
      );
      const vector = record.reconciliation?.allocatorVector;
      if (
        input.attemptId !== record.commitContext?.attemptId ||
        candidateIndex < 0 ||
        vector === undefined ||
        vector[candidateIndex] !== input.suid
      ) {
        return { ok: false, status: 422, error: "Repair observation does not match the durable PARTIAL workset" };
      }
      const observations = record.repairObservations ?? [];
      const alreadyRecorded = observations.some((observation) =>
        observation.owner === input.owner &&
        observation.epoch === input.epoch &&
        observation.tag === input.tag &&
        observation.attemptId === input.attemptId &&
        observation.eventId === input.eventId &&
        observation.suid === input.suid &&
        observation.phase === input.phase &&
        observation.branch === input.branch,
      );
      if (alreadyRecorded) {
        return { ok: true, record };
      }
      const updated: JournalRecord = {
        ...record,
        repairObservations: [...observations, { ...input, observedAt: nowIso() }],
        version: record.version + 1,
        updatedAt: nowIso(),
      };
      await txn.put(JOURNAL_KEY, updated);
      return { ok: true, record: updated };
    });
    return result.ok
      ? json({ status: "repair-observation-recorded", observations: result.record.repairObservations ?? [] })
      : error(result.status, "repair_observation_rejected", result.error);
  }

  private async transition(body: unknown, observation?: DurableObjectHandlerObservation): Promise<Response> {
    const parsed = transitionFrom(body);
    if (parsed.value === undefined) {
      return error(400, "invalid_journal_transition", parsed.error ?? "Invalid Journal transition");
    }
    const input = parsed.value;
    observation?.markFirstStorageRead();
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
        commitContext: input.allocatorLineageId === undefined || record.commitContext === undefined
          ? record.commitContext
          : { ...record.commitContext, allocatorLineageId: input.allocatorLineageId },
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
          // The fence-install crash hook is a commit.test-only fixture. Keep
          // its first recovery behind an explicit debug wake so an unrelated
          // Miniflare alarm cannot consume the one-shot fault before the
          // fixture observes its durable intermediate state.
          const deferTestRecovery = input.alarmFaults !== undefined && input.alarmFaults.length > 0
            || updated.commitContext?.testFenceInstallFaultOnce === true;
          updated.alarm = deferTestRecovery
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

  private async reconcile(body: unknown, observation?: DurableObjectHandlerObservation): Promise<Response> {
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

    observation?.markFirstStorageRead();
    const result = await this.applyReconciliation(expectation.value, reconciliation.value, "worker");
    return result.ok
      ? json(result.record)
      : error(result.status, "journal_reconciliation_rejected", result.error);
  }

  /**
   * Persist the reservation-stage classification before the cancel barrier.
   * That makes a crash after tombstone durability recover to the same outcome.
   */
  private async recordReservationFailure(body: unknown, observation?: DurableObjectHandlerObservation): Promise<Response> {
    const parsed = reservationFailureFrom(body);
    if (parsed.value === undefined) {
      return error(400, "invalid_journal_reservation_failure", parsed.error ?? "Invalid reservation failure");
    }
    const input = parsed.value;
    observation?.markFirstStorageRead();
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
    trace?: ReconcileTraceContext,
    traceRow?: ReconcileApplyTrace,
  ): Promise<MutationResult> {
    const apply = () => this.ctx.storage.transaction(async (txn): Promise<MutationResult> => {
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
    return authority === "alarm" && traceRow !== undefined
      ? tracedReconcile(trace, traceRow.rowId, apply, {
        before: traceRow.before,
        after: traceRow.after,
      })
      : apply();
  }

  private async beginAlarmTakeover(
    expected: JournalRecord,
    trace?: ReconcileTraceContext,
  ): Promise<MutationResult> {
    const begin = () => this.ctx.storage.transaction(async (txn): Promise<MutationResult> => {
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
    return tracedReconcile(trace, "R02", begin, {
      before: "pre-takeover",
      after: "takeover-done",
    });
  }

  private async runAlarm(
    activation: DurableObjectActivationObservation,
    alarmInfo?: AlarmInvocationInfo,
  ): Promise<JournalRecord | undefined> {
    let atEntry: JournalRecord | undefined;
    let trace: ReconcileTraceContext | undefined;
    // R00 must begin at handler entry. Identity is only known after the
    // durable Journal record is read, so the helper resolves it inside the
    // active Cloudflare callback context without a synthetic parent ID.
    return enterNativeReconcileRootSpan(
      this.nativeTracing,
      async () => {
        atEntry = await this.readRecord();
        trace = reconcileTraceFor(atEntry, activation, this.nativeTracing, alarmInfo);
        if (trace === undefined) return undefined;
        return {
          attemptId: trace.attemptId,
          serviceId: trace.serviceId,
          actorKey: `journal:${trace.attemptId}`,
          activation: trace.activation,
          alarmEventId: trace.alarmEventId,
          invocationId: trace.invocationId,
          retryCount: trace.retryCount,
          isRetry: trace.isRetry,
          prefixAtEntry: trace.prefixAtEntry,
        };
      },
      async (_identity, facts) => {
        try {
          if (atEntry === undefined) return undefined;
          if (isTerminalState(atEntry.state)) {
            if (trace !== undefined) trace.recoveryKind = "terminal-at-entry";
            return tracedReconcile(trace, "R08", () => this.clearTerminalAlarm(trace), {
              before: "terminal",
              after: "terminal",
            });
          }
          return this.runAlarmCore(trace);
        } finally {
          if (trace?.recoveryKind !== undefined) facts.setRecoveryKind(trace.recoveryKind);
        }
      },
    );
  }

  /** Terminal-at-entry is an isolated R00/R08 boundary: no recovery work. */
  private async clearTerminalAlarm(trace?: ReconcileTraceContext): Promise<JournalRecord | undefined> {
    const cleared = await this.ctx.storage.transaction(async (txn): Promise<MutationResult> => {
      const record = await txn.get<JournalRecord>(JOURNAL_KEY);
      if (record === undefined) {
        return { ok: false, status: 404, error: "Journal has not been admitted" };
      }
      if (!isTerminalState(record.state)) {
        return { ok: false, status: 409, error: "Journal changed before terminal alarm clear" };
      }
      const firedGenerationId = trace?.alarmEventId ?? record.alarm?.scheduledGenerationId ?? record.firedGenerationId ?? crypto.randomUUID();
      const updated: JournalRecord = {
        ...record,
        firedGenerationId,
        alarm: null,
        updatedAt: nowIso(),
      };
      await txn.put(JOURNAL_KEY, updated);
      await txn.deleteAlarm();
      return { ok: true, record: updated };
    });
    return cleared.ok ? cleared.record : cleared.status === 404 ? undefined : this.readRecord();
  }

  private async runAlarmCore(trace?: ReconcileTraceContext): Promise<JournalRecord | undefined> {
    try {
      const rearmed = await tracedReconcile(trace, "R01", () => this.ctx.storage.transaction(async (txn): Promise<MutationResult> => {
        const record = await txn.get<JournalRecord>(JOURNAL_KEY);
        if (record === undefined) {
          return { ok: false, status: 404, error: "Journal has not been admitted" };
        }
        if (isTerminalState(record.state)) {
          const updated: JournalRecord = {
            ...record,
            firedGenerationId: trace?.alarmEventId ?? record.alarm?.scheduledGenerationId ?? record.firedGenerationId ?? crypto.randomUUID(),
            alarm: null,
            updatedAt: nowIso(),
          };
          await txn.put(JOURNAL_KEY, updated);
          await txn.deleteAlarm();
          return { ok: true, record: updated };
        }

        const updated: JournalRecord = {
          ...record,
          // A retry keeps this handler's fired generation even though R01
          // schedules a new one. The scheduled generation is solely the
          // next fire's identity.
          firedGenerationId: trace?.alarmEventId ?? record.alarm?.scheduledGenerationId ?? record.firedGenerationId ?? crypto.randomUUID(),
          alarm: nextAlarm(record.alarm),
          version: record.version + 1,
          updatedAt: nowIso(),
        };
        const alarm = updated.alarm!;
        await txn.put(JOURNAL_KEY, updated);
        await txn.setAlarm(alarm.dueAt);
        return { ok: true, record: updated };
      }));

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
        return handlerEntryFault ?? this.recoverCommitAttempt(alarmRecord, trace);
      }
      if (alarmRecord.takeover === null && ["ALLOCATED", "WRITING", "SEALING"].includes(alarmRecord.state)) {
        const handoff = await this.beginAlarmTakeover(alarmRecord, trace);
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
        trace,
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
  private async recoverCommitAttempt(
    record: JournalRecord,
    trace?: ReconcileTraceContext,
  ): Promise<JournalRecord | undefined> {
    if (record.commitContext === undefined) {
      return record;
    }
    if (record.state === "ADMITTED" || record.state === "RESERVED") {
      return this.recoverPreAllocationCommit(record, trace);
    }
    if (["ALLOCATED", "WRITING", "SEALING"].includes(record.state)) {
      return this.recoverPostAllocationCommit(record, trace);
    }
    return record;
  }

  /**
   * If allocation committed before the worker could CAS the Journal, the
   * allocator vector is the durable authority. Otherwise cancel every
   * consistency reservation before safely abandoning the attempt.
   */
  private async recoverPreAllocationCommit(
    record: JournalRecord,
    trace?: ReconcileTraceContext,
  ): Promise<JournalRecord | undefined> {
    const vector = await this.readAllocatorVector(record);
    if (vector !== undefined) {
      if (trace !== undefined) trace.recoveryKind = "journal-pre-allocation-vector-present";
      const recovered = await this.applyReconciliation(
        expectationFor(record),
        {
          allocatorVector: vector,
          records: [],
          failureCause: "allocator-failure",
        },
        "alarm",
        trace,
        { rowId: "R11", before: "pre-takeover", after: "pre-takeover" },
      );
      return recovered.ok ? recovered.record : this.readRecord();
    }

    if (trace !== undefined) trace.recoveryKind = "pre-allocation-vector-absent";
    if (!(await this.cancelConsistencyBarrier(record, record.ownerEpoch, trace))) {
      return this.readRecord();
    }
    const reservationFailure = record.reservationFailure;
    if (record.state === "RESERVED" && reservationFailure !== null) {
      const finalized = await tracedReconcile(trace, "R06", () => this.transition({
        ...expectationFor(record),
        nextState: reservationFailure.outcome,
        terminalReason: reservationFailure.reason,
      }), {
        before: "pre-takeover",
        after: "terminal",
      });
      return finalized.status === 200
        ? (await finalized.json()) as JournalRecord
        : this.readRecord();
    }
    const abandoned = await this.applyReconciliation(
      expectationFor(record),
      { records: [], failureCause: "allocator-failure" },
      "alarm",
      trace,
      { rowId: "R11", before: "pre-takeover", after: "terminal" },
    );
    return abandoned.ok ? abandoned.record : this.readRecord();
  }

  /**
   * Post-allocation recovery is deliberately fail-closed: incomplete sealing,
   * requery, fencing, or cancel-barrier work leaves the re-armed Journal in
   * SEALING rather than publishing an absence-bearing result.
   */
  private async recoverPostAllocationCommit(
    record: JournalRecord,
    trace?: ReconcileTraceContext,
  ): Promise<JournalRecord | undefined> {
    let current = record;
    const beforeSealFault = await this.consumeNamedAlarmFault(current, "after-rearm-before-seal");
    if (beforeSealFault !== undefined) {
      return beforeSealFault;
    }

    if (current.takeover === null) {
      const handoff = await this.beginAlarmTakeover(current, trace);
      if (!handoff.ok) {
        return this.readRecord();
      }
      current = handoff.record;
    }

    const partialSealFault = await this.sealCommitTags(current, trace);
    if (partialSealFault !== undefined) {
      return partialSealFault;
    }
    const afterSealFault = await this.consumeNamedAlarmFault(current, "after-full-seal-before-requery");
    if (afterSealFault !== undefined) {
      return afterSealFault;
    }

    const reconciliation = await this.requeryCommitRecords(current);
    if (trace !== undefined) trace.recoveryKind = postAllocationRecoveryKind(current, reconciliation);
    let fences: Array<{ tag: string; fenced: boolean }> = [];
    if (reconciliation.records.some((entry) => entry.present)) {
      const installedFences = await this.installMissingTagFences(current, reconciliation.missingTags ?? []);
      if (installedFences === undefined) {
        return this.readRecord();
      }
      fences = installedFences;
    }
    const afterFenceFault = await this.consumeNamedAlarmFault(current, "after-fence-before-cancel");
    if (afterFenceFault !== undefined) {
      return afterFenceFault;
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
    const terminal = await this.applyReconciliation(
      expectationFor(evidence.journal),
      reconciliation,
      "alarm",
      trace,
      { rowId: "R06", before: "sealed", after: "terminal" },
    );
    return terminal.ok ? terminal.record : this.readRecord();
  }

  private async readAllocatorVector(record: JournalRecord): Promise<string[] | undefined> {
    const context = record.commitContext;
    if (context === undefined) {
      return undefined;
    }
    const allocator = this.env.ALLOCATOR.get(this.env.ALLOCATOR.idFromName(allocatorNameForService(context.serviceId)));
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
  private async cancelConsistencyBarrier(
    record: JournalRecord,
    epoch: number,
    trace?: ReconcileTraceContext,
  ): Promise<boolean> {
    const context = record.commitContext;
    if (context === undefined) {
      return false;
    }
    const cancel = async (): Promise<boolean> => {
      const requests = record.consistencyTags.map(async ({ tag }, index) => {
        const response = await tracedReconcile(trace, "R10", () => this.tagRequest(context, tag, "/cancel", {
          attemptId: context.attemptId,
          epoch,
          forceTombstone: true,
        }), {
          memberIndex: index,
          tag,
        });
        return response.status >= 200 && response.status < 300;
      });
      const settled = await Promise.allSettled(requests);
      return settled.every((result) => result.status === "fulfilled" && result.value);
    };
    // R09/R10 belong only to the vector-absent pre-allocation branch. The
    // post-allocation cancel barrier deliberately remains uninstrumented by
    // these rows because that recovery kind forbids them.
    return trace === undefined
      ? cancel()
      : tracedReconcile(trace, "R09", cancel, {
        before: "pre-takeover",
        after: "pre-takeover",
      });
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
  private async sealCommitTags(
    record: JournalRecord,
    trace?: ReconcileTraceContext,
  ): Promise<JournalRecord | undefined> {
    const context = record.commitContext;
    if (context === undefined) {
      return record;
    }
    return tracedReconcile(trace, "R03", async () => {
      for (let index = 0; index < record.allTags.length; index += 1) {
        const tag = record.allTags[index]!;
        const response = await tracedReconcile(trace, "R04", () => this.tagRequest(context, tag, "/seal", {
          attemptId: context.attemptId,
          epoch: record.ownerEpoch,
        }), {
          memberIndex: index,
          tag,
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
    }, {
      before: "takeover-done",
      after: "sealed",
    });
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
      if (
        context.testFenceInstallFaultOnce === true &&
        await this.consumeTestFenceInstallFault(record)
      ) {
        return undefined;
      }
    }
    return fences;
  }

  /** Consumes the private post-fence crash hook without changing normal recovery. */
  private async consumeTestFenceInstallFault(expected: JournalRecord): Promise<boolean> {
    const result = await this.ctx.storage.transaction(async (txn): Promise<MutationResult> => {
      const record = await txn.get<JournalRecord>(JOURNAL_KEY);
      if (record === undefined) {
        return { ok: false, status: 404, error: "Journal has not been admitted" };
      }
      if (
        record.state !== expected.state ||
        record.version !== expected.version ||
        record.ownerEpoch !== expected.ownerEpoch ||
        record.commitContext?.testFenceInstallFaultOnce !== true
      ) {
        return { ok: false, status: 409, error: "Journal changed while the test fence fault was handled" };
      }
      const commitContext: CommitAttemptContext = {
        attemptId: record.commitContext.attemptId,
        serviceId: record.commitContext.serviceId,
        ...(record.commitContext.allocatorLineageId === undefined
          ? {}
          : { allocatorLineageId: record.commitContext.allocatorLineageId }),
        ...(record.commitContext.testFenceNotDurable === true ? { testFenceNotDurable: true } : {}),
      };
      const updated: JournalRecord = {
        ...record,
        commitContext,
        version: record.version + 1,
        updatedAt: nowIso(),
      };
      await txn.put(JOURNAL_KEY, updated);
      return { ok: true, record: updated };
    });
    return result.ok;
  }

  private async tagRequest(
    context: CommitAttemptContext,
    tag: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const url = new URL(`https://commit-recovery.internal${path}`);
    url.searchParams.set("__tag", tag);
    url.searchParams.set("__serviceId", context.serviceId);
    const tagObject = this.env.TAG.get(this.env.TAG.idFromName(`${context.serviceId}|${tag}`));
    return tagObject.fetch(
      new Request(url.toString(), {
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" } }),
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
