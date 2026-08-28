/**
 * SDT-G42's conformance-only Journal first-touch probe protocol.
 *
 * This is deliberately separate from the Serialized DCB commit protocol and
 * from sdt.commit/v1 / sdt.observe/v1.  It gives the primary Worker a small,
 * authenticated control surface for exercising the already-deployed JOURNAL
 * namespace without changing normal commit routing or Journal recovery.
 */

export const G42_JOURNAL_PROBE_SCHEMA = "sdt.g42.journal-first-touch/v1" as const;
export const G42_JOURNAL_PROBE_PATH = "/conformance/v1/g42/journal-first-touch" as const;
export const G42_JOURNAL_PROBE_INTERNAL_PREFIX = "/__sdt_g42/journal-first-touch" as const;

/** These fixed-length prefixes are reserved exclusively for the G42 probe. */
export const G42_JOURNAL_PROBE_IDENTITY_PREFIX = "sdt-g42-p1-identity-" as const;
export const G42_JOURNAL_PROBE_LOGICAL_KEY_PREFIX = "sdt-g42-p1-key-" as const;
export const G42_JOURNAL_PROBE_STORAGE_PREFIX = "__sdt_g42_p1_record__:" as const;
export const G42_JOURNAL_PROBE_INDEX_KEY = "__sdt_g42_p1_index__" as const;
export const G42_JOURNAL_PROBE_ALARM_KEY = "__sdt_g42_p1_alarm__" as const;

const HEX_32 = /^[a-f0-9]{32}$/;
const MAX_PAYLOAD_BYTES = 8_192;
const MIN_PAYLOAD_BYTES = 16;
const TRIAL_ID = /^g42-p1-[a-z0-9-]{8,96}$/;

export type G42ProbeCell = "A" | "B" | "C" | "D";
export type G42ProbeAlarmMode = "on" | "off";
export type G42ProbeMediator = "none" | "handler-ping" | "state-404";

export interface G42JournalProbeTrial {
  readonly schema: typeof G42_JOURNAL_PROBE_SCHEMA;
  readonly action: "trial";
  readonly trialId: string;
  readonly blockId: string;
  readonly cell: G42ProbeCell;
  readonly physicalIdentity: string;
  readonly logicalKey: string;
  /**
   * Fixed-width public-envelope key.  D uses a distinct key for its warm-up;
   * A/B/C repeat logicalKey as padding so the caller-side A/D request shape
   * cannot itself create a byte-count contrast.
   */
  readonly warmupLogicalKey: string;
  readonly payload: string;
  readonly alarmMode: G42ProbeAlarmMode;
  readonly mediator: G42ProbeMediator;
}

/**
 * An idle-regime D trial is deliberately split across two authenticated
 * requests.  The warm-up must finish *before* the requested idle gap, while
 * the later measurement remains the first handler after that gap.  Holding a
 * Worker request open for 180 seconds would itself prevent the observation
 * this probe is intended to make.
 */
export interface G42JournalProbePreparation {
  readonly schema: typeof G42_JOURNAL_PROBE_SCHEMA;
  readonly action: "prepare";
  readonly trialId: string;
  readonly blockId: string;
  readonly cell: "D";
  readonly physicalIdentity: string;
  readonly logicalKey: string;
  readonly warmupLogicalKey: string;
  readonly payload: string;
  readonly alarmMode: G42ProbeAlarmMode;
  readonly mediator: "none";
}

export interface G42JournalProbeMeasurement {
  readonly schema: typeof G42_JOURNAL_PROBE_SCHEMA;
  readonly action: "measure";
  readonly trialId: string;
  readonly blockId: string;
  readonly cell: "D";
  readonly physicalIdentity: string;
  readonly logicalKey: string;
  readonly warmupLogicalKey: string;
  readonly payload: string;
  readonly alarmMode: G42ProbeAlarmMode;
  readonly mediator: "none";
}

export interface G42JournalProbeCleanup {
  readonly schema: typeof G42_JOURNAL_PROBE_SCHEMA;
  readonly action: "cleanup";
  readonly trialId: string;
  readonly physicalIdentity: string;
}

export interface G42JournalProbeInventory {
  readonly schema: typeof G42_JOURNAL_PROBE_SCHEMA;
  readonly action: "inventory";
  readonly trialId: string;
  readonly physicalIdentity: string;
}

export type G42JournalProbeRequest =
  | G42JournalProbeTrial
  | G42JournalProbePreparation
  | G42JournalProbeMeasurement
  | G42JournalProbeCleanup
  | G42JournalProbeInventory;

export interface G42ProbeActivationFact {
  readonly activationId: string;
  readonly activationFirst: boolean;
  readonly constructorToHandlerMs: number;
  readonly firstStorageReadMs: number | null;
}

export interface G42ProbeOperationResult {
  readonly schema: typeof G42_JOURNAL_PROBE_SCHEMA;
  readonly action: "ping" | "state" | "write" | "cleanup" | "inventory";
  readonly status: number;
  readonly activation: G42ProbeActivationFact;
  readonly handlerWallMs: number;
  readonly transactionWallMs: number | null;
  readonly requestBytes: number;
  readonly recordBytes: number | null;
  readonly alarmStateBefore: number | null;
  readonly alarmDueAt: number | null;
  readonly setAlarmCalls: number;
  readonly logicalKey?: string;
  readonly expectedWarmupKeyPresent?: boolean;
  readonly keyPresent?: boolean;
  readonly inventory?: readonly string[];
  readonly productionJournalPresent?: boolean;
}

export interface G42JournalProbeTrialReceipt {
  readonly schema: typeof G42_JOURNAL_PROBE_SCHEMA;
  readonly trialId: string;
  readonly blockId: string;
  readonly cell: G42ProbeCell;
  readonly physicalIdentity: string;
  readonly logicalKey: string;
  readonly warmupLogicalKey?: string;
  readonly callerWallMs: number;
  readonly callerColo: string | null;
  readonly measured: G42ProbeOperationResult;
  readonly preceding?: G42ProbeOperationResult;
  readonly treatmentCompliance: Readonly<{
    readonly measuredActivationFirst: boolean;
    readonly sharedActivationId: boolean | null;
    readonly mediatorCompletedBeforeMeasurement: boolean | null;
    readonly distinctLogicalKey: boolean | null;
    readonly alarmStateEqualized: boolean;
    readonly alarmSetExactlyOnce: boolean;
  }>;
}

export interface G42JournalProbeCleanupReceipt {
  readonly schema: typeof G42_JOURNAL_PROBE_SCHEMA;
  readonly trialId: string;
  readonly physicalIdentity: string;
  readonly cleanupWallMs: number;
  readonly first: G42ProbeOperationResult;
  readonly repeat: G42ProbeOperationResult;
  readonly inventoryEmpty: boolean;
}

export interface G42JournalProbeInventoryReceipt {
  readonly schema: typeof G42_JOURNAL_PROBE_SCHEMA;
  readonly trialId: string;
  readonly physicalIdentity: string;
  readonly inventory: G42ProbeOperationResult;
}

export interface G42JournalProbePreparationReceipt {
  readonly schema: typeof G42_JOURNAL_PROBE_SCHEMA;
  readonly trialId: string;
  readonly blockId: string;
  readonly cell: "D";
  readonly physicalIdentity: string;
  readonly logicalKey: string;
  readonly warmupLogicalKey: string;
  readonly preparation: G42ProbeOperationResult;
}

export interface G42JournalProbeMeasurementReceipt {
  readonly schema: typeof G42_JOURNAL_PROBE_SCHEMA;
  readonly trialId: string;
  readonly blockId: string;
  readonly cell: "D";
  readonly physicalIdentity: string;
  readonly logicalKey: string;
  readonly warmupLogicalKey: string;
  readonly callerWallMs: number;
  readonly callerColo: string | null;
  readonly measured: G42ProbeOperationResult;
  readonly treatmentCompliance: Readonly<{
    readonly measuredActivationFirst: boolean;
    readonly alarmStateEqualized: boolean;
    readonly alarmSetExactlyOnce: boolean;
  }>;
}

type ParseResult<T> = Readonly<{ value: T }> | Readonly<{ error: string }>;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const expected = new Set(allowed);
  return Object.keys(value).every((key) => expected.has(key)) && allowed.every((key) => key in value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isG42ProbeIdentity(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(G42_JOURNAL_PROBE_IDENTITY_PREFIX)
    && HEX_32.test(value.slice(G42_JOURNAL_PROBE_IDENTITY_PREFIX.length));
}

export function isG42ProbeLogicalKey(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(G42_JOURNAL_PROBE_LOGICAL_KEY_PREFIX)
    && HEX_32.test(value.slice(G42_JOURNAL_PROBE_LOGICAL_KEY_PREFIX.length));
}

export function g42ProbeStorageKey(logicalKey: string): string {
  if (!isG42ProbeLogicalKey(logicalKey)) throw new Error("G42 probe logical key lacks the reserved fixed-length prefix");
  return `${G42_JOURNAL_PROBE_STORAGE_PREFIX}${logicalKey}`;
}

export function parseG42JournalProbeRequest(value: unknown): ParseResult<G42JournalProbeRequest> {
  const candidate = object(value);
  if (candidate === undefined) return { error: "G42 probe body must be a JSON object" };
  if (candidate.schema !== G42_JOURNAL_PROBE_SCHEMA) return { error: "G42 probe schema is not recognized" };
  if (!nonEmptyString(candidate.trialId) || !TRIAL_ID.test(candidate.trialId)) return { error: "G42 probe trialId is not a reserved scheduled identity" };
  if (!isG42ProbeIdentity(candidate.physicalIdentity)) return { error: "G42 probe physicalIdentity lacks the reserved fixed-length prefix" };

  if (candidate.action === "cleanup" || candidate.action === "inventory") {
    if (!exactKeys(candidate, ["schema", "action", "trialId", "physicalIdentity"])) return { error: "G42 probe cleanup/inventory body has an unexpected field" };
    return { value: candidate as unknown as G42JournalProbeCleanup | G42JournalProbeInventory };
  }

  if (candidate.action !== "trial" && candidate.action !== "prepare" && candidate.action !== "measure") {
    return { error: "G42 probe action is not recognized" };
  }
  if (!exactKeys(candidate, [
    "schema", "action", "trialId", "blockId", "cell", "physicalIdentity", "logicalKey",
    "warmupLogicalKey", "payload", "alarmMode", "mediator",
  ])) return { error: "G42 probe trial body has an unexpected or missing field" };
  if (!nonEmptyString(candidate.blockId) || !/^g42-p1-block-[0-9]{2}$/.test(candidate.blockId)) return { error: "G42 probe blockId is not scheduled" };
  if (!["A", "B", "C", "D"].includes(String(candidate.cell))) return { error: "G42 probe cell is not recognized" };
  if (!isG42ProbeLogicalKey(candidate.logicalKey)) return { error: "G42 probe logicalKey lacks the reserved fixed-length prefix" };
  if (!nonEmptyString(candidate.payload)) return { error: "G42 probe payload is required" };
  const payloadBytes = new TextEncoder().encode(candidate.payload).byteLength;
  if (payloadBytes < MIN_PAYLOAD_BYTES || payloadBytes > MAX_PAYLOAD_BYTES) return { error: "G42 probe payload byte length is outside the scheduled range" };
  if (candidate.alarmMode !== "on" && candidate.alarmMode !== "off") return { error: "G42 probe alarmMode is not recognized" };
  if (!["none", "handler-ping", "state-404"].includes(String(candidate.mediator))) return { error: "G42 probe mediator is not recognized" };
  if ((candidate.action === "prepare" || candidate.action === "measure") && candidate.cell !== "D") {
    return { error: "G42 probe preparation/measurement is D-only" };
  }
  if (candidate.cell === "A" && candidate.mediator !== "none") return { error: "G42 probe A cell cannot use a diagnostic mediator" };
  if (candidate.cell === "B" && candidate.mediator !== "handler-ping") return { error: "G42 probe B cell requires the handler-ping mediator" };
  if (candidate.cell === "C" && candidate.mediator !== "state-404") return { error: "G42 probe C cell requires the state-404 mediator" };
  if (candidate.cell === "D") {
    if (!isG42ProbeLogicalKey(candidate.warmupLogicalKey) || candidate.warmupLogicalKey === candidate.logicalKey) {
      return { error: "G42 probe D cell requires a distinct reserved warmupLogicalKey" };
    }
    if (candidate.mediator !== "none") return { error: "G42 probe D cell cannot use a diagnostic mediator" };
  } else if (!isG42ProbeLogicalKey(candidate.warmupLogicalKey) || candidate.warmupLogicalKey !== candidate.logicalKey) {
    return { error: "G42 probe non-D envelope padding must equal logicalKey" };
  }
  return { value: candidate as unknown as G42JournalProbeTrial };
}

function responseBody(response: Response): Promise<Record<string, unknown>> {
  return response.json<unknown>().then((value) => {
    const parsed = object(value);
    if (parsed === undefined) throw new Error("G42 Journal probe returned a non-object response");
    return parsed;
  });
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`G42 Journal probe ${label} is not a non-negative finite number`);
  return value;
}

function activation(value: unknown): G42ProbeActivationFact {
  const candidate = object(value);
  if (candidate === undefined || !nonEmptyString(candidate.activationId) || typeof candidate.activationFirst !== "boolean") {
    throw new Error("G42 Journal probe activation fact is malformed");
  }
  const firstStorageReadMs = candidate.firstStorageReadMs;
  if (firstStorageReadMs !== null) finite(firstStorageReadMs, "activation.firstStorageReadMs");
  return Object.freeze({
    activationId: candidate.activationId,
    activationFirst: candidate.activationFirst,
    constructorToHandlerMs: finite(candidate.constructorToHandlerMs, "activation.constructorToHandlerMs"),
    firstStorageReadMs: firstStorageReadMs === null ? null : firstStorageReadMs as number,
  });
}

function operation(result: Record<string, unknown>, status: number): G42ProbeOperationResult {
  if (result.schema !== G42_JOURNAL_PROBE_SCHEMA || !["ping", "state", "write", "cleanup", "inventory"].includes(String(result.action))) {
    throw new Error("G42 Journal probe response schema/action is not recognized");
  }
  const maybeInventory = result.inventory;
  if (maybeInventory !== undefined && (!Array.isArray(maybeInventory) || maybeInventory.some((key) => !isG42ProbeLogicalKey(key)))) {
    throw new Error("G42 Journal probe inventory is malformed");
  }
  return Object.freeze({
    schema: G42_JOURNAL_PROBE_SCHEMA,
    action: result.action as G42ProbeOperationResult["action"],
    status,
    activation: activation(result.activation),
    handlerWallMs: finite(result.handlerWallMs, "handlerWallMs"),
    transactionWallMs: result.transactionWallMs === null ? null : finite(result.transactionWallMs, "transactionWallMs"),
    requestBytes: finite(result.requestBytes, "requestBytes"),
    recordBytes: result.recordBytes === null ? null : finite(result.recordBytes, "recordBytes"),
    alarmStateBefore: result.alarmStateBefore === null ? null : finite(result.alarmStateBefore, "alarmStateBefore"),
    alarmDueAt: result.alarmDueAt === null ? null : finite(result.alarmDueAt, "alarmDueAt"),
    setAlarmCalls: finite(result.setAlarmCalls, "setAlarmCalls"),
    ...(isG42ProbeLogicalKey(result.logicalKey) ? { logicalKey: result.logicalKey } : {}),
    ...(typeof result.expectedWarmupKeyPresent === "boolean" ? { expectedWarmupKeyPresent: result.expectedWarmupKeyPresent } : {}),
    ...(typeof result.keyPresent === "boolean" ? { keyPresent: result.keyPresent } : {}),
    ...(maybeInventory === undefined ? {} : { inventory: Object.freeze([...maybeInventory]) }),
    ...(typeof result.productionJournalPresent === "boolean" ? { productionJournalPresent: result.productionJournalPresent } : {}),
  });
}

async function call(
  stub: DurableObjectStub,
  path: string,
  body: Record<string, unknown>,
  acceptedStatuses: readonly number[] = [200, 201, 202, 204],
): Promise<G42ProbeOperationResult> {
  const response = await stub.fetch(new Request(`https://g42-probe.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  const parsed = await responseBody(response);
  if (!acceptedStatuses.includes(response.status)) {
    const code = typeof parsed.code === "string" ? parsed.code : "unknown";
    throw new Error(`G42 Journal probe ${path} failed HTTP ${response.status} (${code})`);
  }
  return operation(parsed, response.status);
}

function internalBody(trial: G42JournalProbeTrial, action: "ping" | "state" | "write", extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: G42_JOURNAL_PROBE_SCHEMA,
    action,
    trialId: trial.trialId,
    // Fixed-width cell values keep the measured write shape identical across
    // A/B/C/D; only its scheduled value changes.
    cell: trial.cell,
    logicalKey: trial.logicalKey,
    ...extra,
  };
}

function stubFor(namespace: DurableObjectNamespace, physicalIdentity: string): DurableObjectStub {
  if (!isG42ProbeIdentity(physicalIdentity)) throw new Error("G42 Journal probe attempted an unreserved physical identity");
  return namespace.get(namespace.idFromName(physicalIdentity));
}

/**
 * Runs one scheduled logical trial. The caller starts its timer around only
 * the measured write; warm-up/mediator/cleanup are deliberately separate.
 */
export async function runG42JournalProbeTrial(
  namespace: DurableObjectNamespace,
  trial: G42JournalProbeTrial,
  callerColo: string | null = null,
): Promise<G42JournalProbeTrialReceipt> {
  const stub = stubFor(namespace, trial.physicalIdentity);
  let preceding: G42ProbeOperationResult | undefined;
  let mediatorCompletedBeforeMeasurement: boolean | null = null;
  if (trial.cell === "D") {
    preceding = await call(stub, `${G42_JOURNAL_PROBE_INTERNAL_PREFIX}/write`, internalBody(trial, "write", {
      logicalKey: trial.warmupLogicalKey,
      recordKind: "warmup",
      payload: trial.payload,
      alarmMode: "off",
    }));
  } else if (trial.mediator === "handler-ping") {
    preceding = await call(stub, `${G42_JOURNAL_PROBE_INTERNAL_PREFIX}/ping`, internalBody(trial, "ping"));
    mediatorCompletedBeforeMeasurement = preceding.status >= 200 && preceding.status < 300;
  } else if (trial.mediator === "state-404") {
    preceding = await call(stub, `${G42_JOURNAL_PROBE_INTERNAL_PREFIX}/state`, internalBody(trial, "state", {
      logicalKey: trial.logicalKey,
    }), [404]);
    mediatorCompletedBeforeMeasurement = preceding.status === 404 && preceding.keyPresent === false;
  }

  const startedAtMs = Date.now();
  const measured = await call(stub, `${G42_JOURNAL_PROBE_INTERNAL_PREFIX}/write`, internalBody(trial, "write", {
    recordKind: "measure",
    payload: trial.payload,
    alarmMode: trial.alarmMode,
  }));
  const callerWallMs = Math.max(0, Date.now() - startedAtMs);
  const sharedActivationId = preceding === undefined
    ? null
    : preceding.activation.activationId === measured.activation.activationId;
  const alarmStateEqualized = trial.alarmMode === "on"
    ? measured.alarmStateBefore === null
    : measured.alarmStateBefore === null && measured.alarmDueAt === null;
  const alarmSetExactlyOnce = trial.alarmMode === "on"
    ? measured.setAlarmCalls === 1 && measured.alarmDueAt !== null
    : measured.setAlarmCalls === 0 && measured.alarmDueAt === null;
  const distinctLogicalKey = trial.cell === "D" && preceding !== undefined
    ? preceding.logicalKey === trial.warmupLogicalKey
      && measured.logicalKey === trial.logicalKey
      && preceding.logicalKey !== measured.logicalKey
    : null;

  return Object.freeze({
    schema: G42_JOURNAL_PROBE_SCHEMA,
    trialId: trial.trialId,
    blockId: trial.blockId,
    cell: trial.cell,
    physicalIdentity: trial.physicalIdentity,
    logicalKey: trial.logicalKey,
    warmupLogicalKey: trial.warmupLogicalKey,
    callerWallMs,
    callerColo,
    measured,
    ...(preceding === undefined ? {} : { preceding }),
    treatmentCompliance: Object.freeze({
      measuredActivationFirst: measured.activation.activationFirst,
      sharedActivationId,
      mediatorCompletedBeforeMeasurement,
      distinctLogicalKey,
      alarmStateEqualized,
      alarmSetExactlyOnce,
    }),
  });
}

/**
 * Starts the D-only precondition for an idle-regime trial.  The caller must
 * wait outside the Worker, then invoke `measureG42JournalProbeTrial`; this
 * preserves a real opportunity for Durable Object activation continuity to
 * change during the requested idle interval.
 */
export async function prepareG42JournalProbeTrial(
  namespace: DurableObjectNamespace,
  request: G42JournalProbePreparation,
): Promise<G42JournalProbePreparationReceipt> {
  const stub = stubFor(namespace, request.physicalIdentity);
  const preparation = await call(stub, `${G42_JOURNAL_PROBE_INTERNAL_PREFIX}/write`, {
    schema: G42_JOURNAL_PROBE_SCHEMA,
    action: "write",
    trialId: request.trialId,
    cell: "D",
    logicalKey: request.warmupLogicalKey,
    recordKind: "warmup",
    payload: request.payload,
    alarmMode: "off",
  });
  if (preparation.logicalKey !== request.warmupLogicalKey || preparation.setAlarmCalls !== 0 || preparation.alarmDueAt !== null) {
    throw new Error("G42 Journal probe D preparation did not create the alarm-free scheduled warmup record");
  }
  return Object.freeze({
    schema: G42_JOURNAL_PROBE_SCHEMA,
    trialId: request.trialId,
    blockId: request.blockId,
    cell: "D",
    physicalIdentity: request.physicalIdentity,
    logicalKey: request.logicalKey,
    warmupLogicalKey: request.warmupLogicalKey,
    preparation,
  });
}

/** Completes the D-only post-idle measurement without re-running warm-up. */
export async function measureG42JournalProbeTrial(
  namespace: DurableObjectNamespace,
  request: G42JournalProbeMeasurement,
  callerColo: string | null = null,
): Promise<G42JournalProbeMeasurementReceipt> {
  const stub = stubFor(namespace, request.physicalIdentity);
  const startedAtMs = Date.now();
  const measured = await call(stub, `${G42_JOURNAL_PROBE_INTERNAL_PREFIX}/write`, {
    schema: G42_JOURNAL_PROBE_SCHEMA,
    action: "write",
    trialId: request.trialId,
    cell: "D",
    logicalKey: request.logicalKey,
    recordKind: "measure",
    payload: request.payload,
    alarmMode: request.alarmMode,
  });
  const callerWallMs = Math.max(0, Date.now() - startedAtMs);
  const alarmStateEqualized = request.alarmMode === "on"
    ? measured.alarmStateBefore === null
    : measured.alarmStateBefore === null && measured.alarmDueAt === null;
  const alarmSetExactlyOnce = request.alarmMode === "on"
    ? measured.setAlarmCalls === 1 && measured.alarmDueAt !== null
    : measured.setAlarmCalls === 0 && measured.alarmDueAt === null;
  if (measured.logicalKey !== request.logicalKey || measured.expectedWarmupKeyPresent !== true) {
    throw new Error("G42 Journal probe D measurement did not prove the scheduled warmup record remained present");
  }
  return Object.freeze({
    schema: G42_JOURNAL_PROBE_SCHEMA,
    trialId: request.trialId,
    blockId: request.blockId,
    cell: "D",
    physicalIdentity: request.physicalIdentity,
    logicalKey: request.logicalKey,
    warmupLogicalKey: request.warmupLogicalKey,
    callerWallMs,
    callerColo,
    measured,
    treatmentCompliance: Object.freeze({
      measuredActivationFirst: measured.activation.activationFirst,
      alarmStateEqualized,
      alarmSetExactlyOnce,
    }),
  });
}

/** Cleanup is intentionally timed outside a trial's measured write. */
export async function cleanupG42JournalProbeTrial(
  namespace: DurableObjectNamespace,
  request: G42JournalProbeCleanup,
): Promise<G42JournalProbeCleanupReceipt> {
  const stub = stubFor(namespace, request.physicalIdentity);
  const body = {
    schema: G42_JOURNAL_PROBE_SCHEMA,
    action: "cleanup",
    trialId: request.trialId,
  };
  const startedAtMs = Date.now();
  const first = await call(stub, `${G42_JOURNAL_PROBE_INTERNAL_PREFIX}/cleanup`, body);
  const repeat = await call(stub, `${G42_JOURNAL_PROBE_INTERNAL_PREFIX}/cleanup`, body);
  const inventory = await call(stub, `${G42_JOURNAL_PROBE_INTERNAL_PREFIX}/inventory`, {
    schema: G42_JOURNAL_PROBE_SCHEMA,
    action: "inventory",
    trialId: request.trialId,
  });
  const inventoryEmpty = inventory.inventory?.length === 0 && inventory.alarmDueAt === null && inventory.productionJournalPresent === false;
  return Object.freeze({
    schema: G42_JOURNAL_PROBE_SCHEMA,
    trialId: request.trialId,
    physicalIdentity: request.physicalIdentity,
    cleanupWallMs: Math.max(0, Date.now() - startedAtMs),
    first,
    repeat,
    inventoryEmpty,
  });
}

export async function inventoryG42JournalProbeTrial(
  namespace: DurableObjectNamespace,
  request: G42JournalProbeInventory,
): Promise<G42JournalProbeInventoryReceipt> {
  const stub = stubFor(namespace, request.physicalIdentity);
  const inventory = await call(stub, `${G42_JOURNAL_PROBE_INTERNAL_PREFIX}/inventory`, {
    schema: G42_JOURNAL_PROBE_SCHEMA,
    action: "inventory",
    trialId: request.trialId,
  });
  return Object.freeze({
    schema: G42_JOURNAL_PROBE_SCHEMA,
    trialId: request.trialId,
    physicalIdentity: request.physicalIdentity,
    inventory,
  });
}
