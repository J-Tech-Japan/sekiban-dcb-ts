import {
  type JournalRecord,
  type RepairObservation,
  type RepairObservationPhase,
} from "./types";
import {
  DurableObjectActivation,
  type DurableObjectActivationObservation,
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
/** The probe alarm is deliberately far outside its measurement interval. */
const G42_PROBE_ALARM_DELAY_MS = 24 * 60 * 60 * 1_000;

type JsonObject = Record<string, unknown>;

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
 * Retained non-commit Journal support: the fenced G42 probe, a direct legacy
 * state diagnostic, and RepairWorker's historical-workset/audit surface.
 */
export class JournalDurableObject implements DurableObject {
  /** Constructor-scoped observation only; never persisted or used for control. */
  private readonly activation = new DurableObjectActivation();

  constructor(
    private readonly ctx: DurableObjectState,
    _env?: unknown,
    _nativeTracing?: unknown,
  ) {
    // Preserve the Durable Object constructor ABI used by existing fixtures.
    void _env;
    void _nativeTracing;
  }

  async fetch(request: Request): Promise<Response> {
    // Flip before this handler performs its first await.
    const activation = this.activation.beginHandler();
    const observation = beginDurableObjectHandlerObservation("JOURNAL", activation);
    const path = new URL(request.url).pathname;
    // G42 has a private, conformance-only synthetic namespace. It does not
    // enter the normal commit trace or recovery surface: its receipts carry a
    // distinct schema and its storage keys can never be JOURNAL_KEY.
    if (request.method === "POST" && path.startsWith(`${G42_JOURNAL_PROBE_INTERNAL_PREFIX}/`)) {
      return this.g42Probe(request, path, activation, observation);
    }
    if (request.method === "GET" && path === "/state") {
      const record = await this.readRecord();
      return record === undefined ? error(404, "journal_not_found", "Journal has not been admitted") : json(record);
    }
    if (request.method === "GET" && path === "/repair/workset") {
      return this.repairWorkset();
    }
    if (request.method === "GET" && path === "/repair/observations") {
      return this.repairObservations();
    }
    if (request.method === "POST" && path === "/repair/observation") {
      const body = await this.jsonBody(request);
      return body === undefined
        ? error(400, "malformed_journal_request", "Request body must be JSON")
        : this.recordRepairObservation(body);
    }

    return error(404, "journal_route_not_found", "Journal route was not found");
  }

  /**
   * A G42 probe can intentionally leave an alarm behind. Any non-probe alarm
   * is a pre-cleanup remnant in C-0 and is cleared without reviving recovery.
   */
  async alarm(): Promise<void> {
    // The G38 tombstone fixture supplies only deleteAlarm. Keep that binding
    // neutral without assuming the full DurableObjectStorage shape.
    if (typeof this.ctx.storage.transaction !== "function") {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (await this.clearG42ProbeAlarmIfPresent()) return;
    await this.ctx.storage.deleteAlarm();
  }

  private async readRecord(): Promise<JournalRecord | undefined> {
    return this.ctx.storage.get<JournalRecord>(JOURNAL_KEY);
  }

  /**
   * Implements the G42-only storage-layout screen. The outer Worker is the
   * sole public entrypoint and authenticates/fences it before a JOURNAL stub
   * is even resolved. This method still validates its private message so an
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
        // This is deliberately an index-only check. A and D execute the
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

  private async jsonBody(request: Pick<Request, "json">): Promise<unknown | undefined> {
    try {
      return await request.json<unknown>();
    } catch {
      return undefined;
    }
  }

  private async recordRepairObservation(body: unknown): Promise<Response> {
    const parsed = repairObservationFrom(body);
    if (parsed.value === undefined) {
      return error(400, "invalid_repair_observation", parsed.error ?? "Invalid repair observation");
    }
    const input = parsed.value;
    const result = await this.ctx.storage.transaction(async (txn) => {
      const record = await txn.get<JournalRecord>(JOURNAL_KEY);
      if (record === undefined) {
        return { ok: false, status: 404, error: "Journal has not been admitted" } as const;
      }
      if (record.state !== "PARTIAL") {
        return { ok: false, status: 409, error: "Repair observations are valid only for a PARTIAL Journal outcome" } as const;
      }
      // The Journal only records observations for its admitted candidate and
      // durable SUID. This keeps progress useful without making it authority.
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
        return { ok: false, status: 422, error: "Repair observation does not match the durable PARTIAL workset" } as const;
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
        return { ok: true, record } as const;
      }
      const updated: JournalRecord = {
        ...record,
        repairObservations: [...observations, { ...input, observedAt: new Date().toISOString() }],
        version: record.version + 1,
        updatedAt: new Date().toISOString(),
      };
      await txn.put(JOURNAL_KEY, updated);
      return { ok: true, record: updated } as const;
    });
    return result.ok
      ? json({ status: "repair-observation-recorded", observations: result.record.repairObservations ?? [] })
      : error(result.status, "repair_observation_rejected", result.error);
  }
}
