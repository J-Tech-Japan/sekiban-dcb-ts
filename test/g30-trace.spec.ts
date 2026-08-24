import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  beginWorkerInvocationObservation,
  classifyReactivationCause,
  CommitTrace,
  DurableObjectActivation,
  enterNativeActorHandleSpan,
  enterNativeCommitSpan,
  enterNativeReconcileRootSpan,
  IDLE_EXPERIMENT_SCHEDULE_MS,
  observedIdleGapLowerBoundMs,
  stableTraceHash,
  traceManifest,
  type CommitTraceFace,
  type CommitTraceSchema,
  type CommitTraceSnapshot,
  type CommitTraceSpan,
  type DurableObjectActivationObservation,
  type NativeTraceSpan,
  type NativeTracing,
} from "../packages/dcb-runtime/src/trace/CommitTrace";
import {
  beginDurableObjectHandlerObservation,
  observeFaultBarrier,
  observeWorkerInvocation,
  type ObservationEvent,
} from "../packages/dcb-runtime/src/trace/ObservationStream";
import { CommitWorker, type CommitWorkerEnv } from "../packages/dcb-runtime/src/commit/CommitWorker";
import { JournalDurableObject } from "../packages/dcb-runtime/src/journal/JournalDurableObject";
import type { JournalRecord } from "../packages/dcb-runtime/src/journal/types";
import { RepairWorker, type RepairWorkerEnv } from "../packages/dcb-runtime/src/repair/RepairWorker";
import type { ExclusionLookupPort } from "../packages/dcb-runtime/src/downstream/ExclusionLookup";
import {
  CommitTraceVerificationError,
  calculateUnattributedRatio,
  verifyCommitTrace,
} from "../packages/dcb-runtime/src/trace/CommitTraceVerifier";

const ATTEMPT = "a0a0a0a0-1111-4111-8111-a0a0a0a0a0a0";
const CORRELATION = "corr-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SERVICE = "g30-trace-fixture";
const ROOT = "g30-root";

type Row = {
  readonly rowId: string;
  readonly span: string;
  readonly emitter: string;
  readonly logicalParent: string | null;
  readonly kind: string;
};

function row(schema: CommitTraceSchema, rowId: string): Row {
  const found = traceManifest().schemas[schema].rows.find((candidate) => candidate.rowId === rowId);
  if (found === undefined) throw new Error(`missing fixture row ${schema}/${rowId}`);
  return found;
}

function actorFor(emitter: string): "ROOT" | "BOOTSTRAP" | "JOURNAL" | "ALLOCATOR" | "TAG" | "REPAIR" {
  if (emitter === "root-worker") return "ROOT";
  if (emitter === "repair-runner") return "REPAIR";
  if (emitter === "allocator-do") return "ALLOCATOR";
  if (emitter === "journal-do") return "JOURNAL";
  if (emitter === "callee-do") return "TAG";
  if (emitter === "caller") return "REPAIR";
  if (emitter === "caller-worker") return "TAG";
  throw new Error(`fixture does not know ${emitter}`);
}

function isRowScoped(attribute: string, rowId: string): boolean {
  const declaration = traceManifest().attributeMatrix.attributes[attribute];
  return declaration?.rowScope?.includes(rowId) ?? false;
}

function attributes(
  schema: CommitTraceSchema,
  rowId: string,
  face: CommitTraceFace,
  extra: Readonly<Record<string, string | number | boolean>> = {},
): Record<string, string | number | boolean> {
  const definition = row(schema, rowId);
  const value: Record<string, string | number | boolean> = {
    "schema.version": schema,
    "correlation.id": CORRELATION,
    "service.id": SERVICE,
    "actor.class": actorFor(definition.emitter),
    operation: definition.span,
    "span.kind": definition.kind,
    outcome: "success",
  };
  if (face !== "pre-admission") {
    value["attempt.id"] = ATTEMPT;
    value["actor.key_hash"] = stableTraceHash(`${definition.emitter}:${rowId}`);
  }
  if (["S05a", "S05b", "S05c", "S05d", "S05e"].includes(rowId)) {
    value["phase.ordinal"] = ["S05a", "S05b", "S05c", "S05d", "S05e"].indexOf(rowId);
  }
  if (isRowScoped("member.index", rowId)) {
    value["member.index"] = 0;
  }
  if (isRowScoped("tag.key_hash", rowId)) {
    value["tag.key_hash"] = stableTraceHash(`tag:${rowId}`);
  }
  if (face === "reconcile-root") {
    value["activation.id"] = "a0a0a0a0-1111-4111-8111-a0a0a0a0a0a0";
    value["activation.first"] = true;
    if (isRowScoped("alarm.event.id", rowId)) value["alarm.event.id"] = "alarm-generation-1";
    if (isRowScoped("alarm.invocation.id", rowId)) value["alarm.invocation.id"] = "alarm-invocation-1";
    if (isRowScoped("alarm.retryCount", rowId)) value["alarm.retryCount"] = 0;
    if (isRowScoped("alarm.isRetry", rowId)) value["alarm.isRetry"] = false;
    if (isRowScoped("recovery.kind", rowId)) value["recovery.kind"] = "post-allocation-full-write";
    if (isRowScoped("durable.prefix.at_entry", rowId)) value["durable.prefix.at_entry"] = "sealed";
  }
  if (face === "repair-root" && isRowScoped("repair.execution.id", rowId)) {
    value["repair.execution.id"] = "repair-execution-1";
  }
  return { ...value, ...extra };
}

function span(
  schema: CommitTraceSchema,
  rowId: string,
  face: CommitTraceFace,
  options: Partial<Pick<CommitTraceSpan, "rootId" | "clockDomain" | "startMs" | "endMs" | "logicalParent">> & {
    readonly attributes?: Readonly<Record<string, string | number | boolean>>;
  } = {},
): CommitTraceSpan {
  const definition = row(schema, rowId);
  const startMs = options.startMs ?? 0;
  const endMs = options.endMs ?? 100;
  return {
    rowId,
    schema,
    face,
    span: definition.span,
    emitter: definition.emitter,
    logicalParent: options.logicalParent ?? definition.logicalParent,
    rootId: options.rootId ?? ROOT,
    clockDomain: options.clockDomain ?? "caller",
    startMs,
    endMs,
    present: true,
    attributes: attributes(schema, rowId, face, options.attributes),
    zeroDurationPlatformLimited: startMs === endMs,
  };
}

function snapshot(schema: CommitTraceSchema, spans: readonly CommitTraceSpan[]): CommitTraceSnapshot {
  return {
    schema,
    rootId: spans[0]?.rootId ?? ROOT,
    correlationId: CORRELATION,
    serviceId: SERVICE,
    spans,
    provider: {},
    diagnostics: {},
  };
}

function v1Success(options: { readonly strictlyNested?: boolean } = {}): CommitTraceSnapshot {
  const schema = "sdt.commit/v1" as const;
  const rows = (traceManifest().schemas[schema].boundaries ?? [])
    .find((boundary) => boundary.name === "success")?.requiredRows ?? [];
  return snapshot(schema, rows.map((rowId) => {
    const definition = row(schema, rowId);
    // Most traces deliberately share the root wall so the coverage-union
    // fixture models nested caller work. The isolated unrelated oracle opts
    // into strict timing; that makes the equal-boundary mutant attributable
    // solely to its named fixture.
    const timing = options.strictlyNested === true
      ? definition.logicalParent === null
        ? { startMs: 0, endMs: 100 }
        : definition.logicalParent === "S00"
          ? { startMs: 10, endMs: 90 }
          : { startMs: 20, endMs: 80 }
      : { startMs: 0, endMs: 100 };
    return span(schema, rowId, rowId === "S00" || rowId === "S01" ? "pre-admission" : "accepted", timing);
  }));
}

function expectCode(callback: () => unknown, code: string): void {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(CommitTraceVerificationError);
    expect((error as CommitTraceVerificationError).code).toBe(code);
    return;
  }
  throw new Error(`expected verifier code ${code}`);
}

interface CapturedNativeSpan {
  readonly name: string;
  readonly attributes: Record<string, string | number | boolean>;
}

function recordingNativeTracing(): {
  readonly tracing: NativeTracing;
  readonly spans: CapturedNativeSpan[];
} {
  const spans: CapturedNativeSpan[] = [];
  const tracing: NativeTracing = {
    enterSpan: ((name: string, callback: (native: NativeTraceSpan) => unknown) => {
      const attributes: Record<string, string | number | boolean> = {};
      spans.push({ name, attributes });
      return callback({
        setAttribute: (key, value) => {
          if (value !== undefined) attributes[key] = value;
        },
      });
    }) as NativeTracing["enterSpan"],
  };
  return { tracing, spans };
}

/**
 * Exercise the real alarm handler with a minimal terminal Journal record.
 * The injected tracer is a test-only callback adapter; durable state remains
 * exactly the same shape consumed by the production handler.
 */
function terminalJournalAlarmFixture(nativeTracing: NativeTracing): {
  readonly journal: JournalDurableObject;
  readonly alarmDeletes: () => number;
} {
  let record: JournalRecord = {
    schemaVersion: 1,
    candidates: [],
    consistencyTags: [],
    allTags: [],
    commitContext: { attemptId: ATTEMPT, serviceId: SERVICE },
    ownerEpoch: 3,
    state: "COMPLETE",
    version: 8,
    alarm: { attempt: 2, dueAt: 1_000, delayMs: 250, scheduledGenerationId: "g30-terminal-generation" },
    reconciliation: null,
    reservationFailure: null,
    takeover: null,
    faultsRemaining: 0,
    alarmFaults: [],
    terminalResponse: { outcome: "COMPLETE", ownerEpoch: 3, stateVersion: 8, reason: "complete" },
    repairObservations: [],
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
  };
  let deletes = 0;
  const storage = {
    get: async <T>() => record as unknown as T,
    transaction: async <T>(callback: (transaction: {
      get: <V>() => Promise<V>;
      put: (key: string, value: unknown) => Promise<void>;
      deleteAlarm: () => Promise<void>;
    }) => Promise<T>) => callback({
      get: async <V>() => record as unknown as V,
      put: async (_key, value) => { record = value as JournalRecord; },
      deleteAlarm: async () => { deletes += 1; },
    }),
  };
  return {
    journal: new JournalDurableObject(
      { storage } as unknown as DurableObjectState,
      {} as never,
      nativeTracing,
    ),
    alarmDeletes: () => deletes,
  };
}

type CommitTraceScenario = "success" | "reservation-failure" | "allocator-failure" | "partial-handoff";

function nonSuccessWorker(
  scenario: CommitTraceScenario,
  snapshots: CommitTraceSnapshot[],
  tags: readonly string[] = ["room:g30-non-success"],
): CommitWorker {
  const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
  const stubFor = (kind: "bootstrap" | "journal" | "allocator" | "tag") => ({
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      if (kind === "bootstrap") return response({ leaseEpoch: 1 });
      if (kind === "journal") {
        if (url.pathname === "/admit") return response({ state: "ADMITTED", version: 0, ownerEpoch: 0 }, 201);
        if (url.pathname === "/transition") {
          const body = await request.json() as { nextState: string; expectedVersion: number; expectedOwnerEpoch: number };
          return response({ state: body.nextState, version: body.expectedVersion + 1, ownerEpoch: body.expectedOwnerEpoch });
        }
        if (url.pathname === "/reservation-failure") {
          const body = await request.json() as { outcome: "REFUSED" | "FAILED" };
          return response({ state: body.outcome, version: 2, ownerEpoch: 0 });
        }
        if (url.pathname === "/reconcile") return response({ state: "SEALING", version: 4, ownerEpoch: 0 });
        if (url.pathname === "/debug/alarm") {
          return response({
            state: "PARTIAL",
            allTags: tags,
            reconciliation: { records: [], missingTags: tags },
          });
        }
      }
      if (kind === "allocator") {
        if (url.pathname === "/allocate") {
          if (scenario === "allocator-failure") return response({ code: "allocator_failed" }, 500);
          const body = await request.json() as { candidates: Array<{ eventId: string }> };
          return response({
            attemptId: "g30-trace-attempt",
            allocatorLineageId: "g30-trace-lineage",
            candidates: body.candidates.map((candidate) => ({
              ...candidate,
              suid: "063891500000000000000000000000",
            })),
            allocatedAt: "2026-08-23T00:00:00.000Z",
          });
        }
        if (url.pathname.startsWith("/attempts/")) return response({ code: "allocation_not_found" }, 404);
      }
      if (kind === "tag") {
        if (url.pathname === "/acquire") {
          return scenario === "reservation-failure"
            ? response({ reason: "consistency_head_mismatch" }, 409)
            : response({ reservation: { token: "g30-reservation" } }, 201);
        }
        if (url.pathname === "/cancel") return response({ cancelled: true });
        if (url.pathname === "/append") return scenario === "partial-handoff"
          ? response({ code: "append_failed" }, 500)
          : response({ appended: true }, 201);
        if (url.pathname === "/state") {
          return response({ version: 5, updatedAt: "2026-08-23T00:00:00.000Z" });
        }
      }
      return response({ code: "unexpected" }, 500);
    },
  } as unknown as DurableObjectStub);
  const namespace = (kind: "bootstrap" | "journal" | "allocator" | "tag"): DurableObjectNamespace => ({
    idFromName: () => ({ toString: () => kind }) as DurableObjectId,
    get: () => stubFor(kind),
  } as unknown as DurableObjectNamespace);
  return new CommitWorker({
    ALLOCATOR: namespace("allocator"),
    JOURNAL: namespace("journal"),
    TAG: namespace("tag"),
    BOOTSTRAP: namespace("bootstrap"),
  }, SERVICE, {
    commitTraceSink: { record: (snapshot) => snapshots.push(snapshot) },
    // Boundary ownership is the subject here. A zero-resolution injected
    // clock records the platform-limited form explicitly, avoiding a local
    // wall-clock quantization artifact from becoming an attribution finding.
    commitTraceClock: { now: () => 0 },
  });
}

async function nonSuccessTrace(
  scenario: Exclude<CommitTraceScenario, "success">,
  tags: readonly string[] = ["room:g30-non-success"],
): Promise<CommitTraceSnapshot> {
  const snapshots: CommitTraceSnapshot[] = [];
  const response = await nonSuccessWorker(scenario, snapshots, tags).handle(new Request("https://commit.test/api/sekiban/serialized/commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version: 1,
      eventCandidates: [{
        payload: btoa(JSON.stringify({ roomId: "g30-non-success" })),
        eventPayloadName: "Trace",
        tags,
      }],
      consistencyTags: tags.map((tag) => ({
        tag,
        lastSortableUniqueId: "063891500000000000000000000000",
      })),
    }),
  }));
  const body = await response.clone().json() as { code?: unknown };
  expect(response.status, JSON.stringify(body)).toBe(scenario === "reservation-failure" ? 400 : 500);
  expect(body.code).toBe(
    scenario === "reservation-failure"
      ? "consistency_conflict"
      : scenario === "allocator-failure"
        ? "internal_error"
        : "partial_write",
  );
  expect(snapshots).toHaveLength(1);
  return snapshots[0]!;
}

/**
 * This is the primary Worker path, not a hand-built success snapshot. S09 is
 * deliberately absent from this local sink because the real allocator DO
 * owns its callback span; its exported/native coverage is fixed separately.
 */
async function successTrace(): Promise<CommitTraceSnapshot> {
  const snapshots: CommitTraceSnapshot[] = [];
  const tags = ["room:g30-success"];
  const response = await nonSuccessWorker("success", snapshots, tags).handle(new Request("https://commit.test/api/sekiban/serialized/commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version: 1,
      eventCandidates: [{
        payload: btoa(JSON.stringify({ roomId: "g30-success" })),
        eventPayloadName: "Trace",
        tags,
      }],
      consistencyTags: tags.map((tag) => ({
        tag,
        lastSortableUniqueId: "063891500000000000000000000000",
      })),
    }),
  }));

  expect(response.status).toBe(200);
  expect(snapshots).toHaveLength(1);
  return snapshots[0]!;
}

function emittedRows(snapshot: CommitTraceSnapshot): string[] {
  return snapshot.spans.map((entry) => entry.rowId);
}

type RepairTraceScenario = "dry-run" | "resume-skip" | "execute";

function repairTraceFixture(scenario: RepairTraceScenario): {
  readonly worker: RepairWorker;
  readonly snapshots: CommitTraceSnapshot[];
  readonly calls: Readonly<Record<"facts" | "acquire" | "scopeUnion" | "apply" | "audit" | "clear" | "observation" | "exclusion", number>>;
} {
  const tag = "room:g30-repair";
  const attemptId = ATTEMPT;
  const eventId = "018f9c51-6b74-7f5e-8ca1-0123456789ab";
  const suid = "063891500000000000000000000000";
  const calls = { facts: 0, acquire: 0, scopeUnion: 0, apply: 0, audit: 0, clear: 0, observation: 0, exclusion: 0 };
  const item = {
    attemptId,
    eventId,
    suid,
    payload: JSON.stringify({ roomId: "g30-repair" }),
    eventTags: [tag],
    allocatorLineageId: "g30-repair-lineage",
    eventType: "RepairTrace:1",
    provenance: "g32" as const,
    timestamp: "2026-08-23T00:00:00.000Z",
  };
  const state = {
    fences: scenario === "resume-skip" ? [] : [{ reason: "partial_write", attemptId, epoch: 0 }],
    repairOwner: null as string | null,
    repairLeaseUntil: null as number | null,
    highestRepairEpoch: 0,
    repairScope: [] as typeof item[],
    repairScopeVersion: 0,
    resolutions: scenario === "resume-skip"
      ? [{ attemptId, eventId, suid, branch: "ROLLED_FORWARD" as const, epoch: 1, owner: "g30-repair-owner", recordedAt: "2026-08-23T00:00:00.000Z" }]
      : [] as Array<{ attemptId: string; eventId: string; suid: string; branch: "ROLLED_FORWARD"; epoch: number; owner: string; recordedAt: string }>,
    audits: scenario === "resume-skip"
      ? [{ attemptId, eventId, suid, branch: "ROLLED_FORWARD" as const, actor: "g30-operator", epoch: 1, owner: "g30-repair-owner", recordedAt: "2026-08-23T00:00:00.000Z" }]
      : [] as Array<{ attemptId: string; eventId: string; suid: string; branch: "ROLLED_FORWARD"; actor: string; epoch: number; owner: string; recordedAt: string }>,
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
  const requestFrom = (input: RequestInfo | URL, init?: RequestInit): Request =>
    input instanceof Request ? input : new Request(input, init);
  const facts = () => ({
    tag,
    head: suid,
    version: 1,
    events: [],
    outbox: [],
    fences: state.fences,
    clearedFences: [],
    repairOwner: state.repairOwner,
    repairLeaseUntil: state.repairLeaseUntil,
    highestRepairEpoch: state.highestRepairEpoch,
    repairScope: state.repairScope,
    repairScopeVersion: state.repairScopeVersion,
    facts: { resolutions: state.resolutions, audits: state.audits },
  });
  const journal = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = requestFrom(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/repair/workset") {
        return json({ attemptId, missingTags: [tag], candidates: [{ ...item, tags: [tag] }] });
      }
      if (url.pathname === "/repair/observation") {
        calls.observation += 1;
        return json({ observed: true });
      }
      return json({ code: "unexpected_journal" }, 500);
    },
  } as unknown as DurableObjectStub;
  const tagStub = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = requestFrom(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/repair/facts") {
        calls.facts += 1;
        return json(facts());
      }
      const body = await request.json().catch(() => undefined) as Record<string, unknown> | undefined;
      if (url.pathname === "/repair/acquire") {
        calls.acquire += 1;
        state.repairOwner = "g30-repair-owner";
        state.repairLeaseUntil = 1_800_000_000_000;
        state.highestRepairEpoch = 1;
        return json({ epoch: 1 }, 201);
      }
      if (url.pathname === "/repair/scope-union") {
        calls.scopeUnion += 1;
        state.repairScope = (body?.scope as typeof item[] | undefined) ?? [];
        state.repairScopeVersion += 1;
        return json({ scopeVersion: state.repairScopeVersion });
      }
      if (url.pathname === "/repair/apply") {
        calls.apply += 1;
        state.resolutions = [{
          attemptId,
          eventId,
          suid,
          branch: "ROLLED_FORWARD",
          epoch: 1,
          owner: "g30-repair-owner",
          recordedAt: "2026-08-23T00:00:00.000Z",
        }];
        return json({ status: "ROLLED_FORWARD" });
      }
      if (url.pathname === "/repair/audit") {
        calls.audit += 1;
        state.audits = [{
          attemptId,
          eventId,
          suid,
          branch: "ROLLED_FORWARD",
          actor: "g30-operator",
          epoch: 1,
          owner: "g30-repair-owner",
          recordedAt: "2026-08-23T00:00:00.000Z",
        }];
        return json({ audited: true });
      }
      if (url.pathname === "/repair/clear") {
        calls.clear += 1;
        state.fences = [];
        return json({ cleared: true });
      }
      return json({ code: "unexpected_tag" }, 500);
    },
  } as unknown as DurableObjectStub;
  const namespace = (stub: DurableObjectStub): DurableObjectNamespace => ({
    idFromName: () => ({ toString: () => tag }) as DurableObjectId,
    get: () => stub,
  } as unknown as DurableObjectNamespace);
  const snapshots: CommitTraceSnapshot[] = [];
  const exclusions: ExclusionLookupPort = { recordExclusion: async () => { calls.exclusion += 1; } };
  return {
    worker: new RepairWorker({ JOURNAL: namespace(journal), TAG: namespace(tagStub), SDT_SERVICE_ID: SERVICE } as RepairWorkerEnv, exclusions, SERVICE, {
      commitTraceSink: { record: (snapshot) => snapshots.push(snapshot) },
      commitTraceClock: { now: () => 0 },
    }),
    snapshots,
    calls,
  };
}

describe("SDT-G30 runtime trace verifier", () => {
  it("keeps the real validation-reject boundary pre-admission and performs zero durable calls", async () => {
    const snapshots: CommitTraceSnapshot[] = [];
    const calls = { allocator: 0, journal: 0, tag: 0, bootstrap: 0 };
    const namespace = (kind: keyof typeof calls): DurableObjectNamespace => ({
      idFromName: () => ({ toString: () => kind }) as DurableObjectId,
      get: () => {
        calls[kind] += 1;
        return { fetch: async () => new Response("unexpected", { status: 500 }) } as unknown as DurableObjectStub;
      },
    } as unknown as DurableObjectNamespace);
    const worker = new CommitWorker({
      ALLOCATOR: namespace("allocator"),
      JOURNAL: namespace("journal"),
      TAG: namespace("tag"),
      BOOTSTRAP: namespace("bootstrap"),
    } as CommitWorkerEnv, SERVICE, {
      commitTraceSink: { record: (snapshot) => snapshots.push(snapshot) },
    });

    const response = await worker.handle(new Request("https://commit.test/api/sekiban/serialized/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, eventCandidates: [{ eventPayloadName: "Trace", tags: ["room:trace"] }], consistencyTags: [] }),
    }));

    expect(response.status).toBe(400);
    expect(calls).toEqual({ allocator: 0, journal: 0, tag: 0, bootstrap: 0 });
    expect(snapshots).toHaveLength(1);
    const captured = snapshots[0]!;
    expect(() => verifyCommitTrace(captured, { boundary: "validation-reject" })).not.toThrow();
    expect(captured.runtimeVerification).toEqual({ passed: true });
    expect(captured.spans.map((entry) => entry.face)).toEqual(["pre-admission", "pre-admission", "pre-admission"]);
    expect(captured.spans.some((entry) => "attempt.id" in entry.attributes)).toBe(false);
  });

  it("keeps a real validation response byte-identical when native trace or sink observation is unavailable", async () => {
    const calls = { allocator: 0, journal: 0, tag: 0, bootstrap: 0 };
    const namespace = (kind: keyof typeof calls): DurableObjectNamespace => ({
      idFromName: () => ({ toString: () => kind }) as DurableObjectId,
      get: () => {
        calls[kind] += 1;
        return { fetch: async () => new Response("unexpected", { status: 500 }) } as unknown as DurableObjectStub;
      },
    } as unknown as DurableObjectNamespace);
    const createEnv = (): CommitWorkerEnv => ({
      ALLOCATOR: namespace("allocator"),
      JOURNAL: namespace("journal"),
      TAG: namespace("tag"),
      BOOTSTRAP: namespace("bootstrap"),
    } as CommitWorkerEnv);
    const request = () => new Request("https://commit.test/api/sekiban/serialized/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, eventCandidates: [{ eventPayloadName: "Trace", tags: ["room:trace"] }], consistencyTags: [] }),
    });
    const baseline = await new CommitWorker(createEnv(), SERVICE).handle(request());
    const snapshots: CommitTraceSnapshot[] = [];
    const unavailable: NativeTracing = {
      enterSpan: (() => { throw new Error("trace platform unavailable"); }) as NativeTracing["enterSpan"],
    };
    const observed = await new CommitWorker(createEnv(), SERVICE, {
      nativeTracing: unavailable,
      commitTraceSink: {
        record: (snapshot) => {
          snapshots.push(snapshot);
          throw new Error("exporter unavailable");
        },
      },
    }).handle(request());

    expect(observed.status).toBe(baseline.status);
    expect(await observed.text()).toBe(await baseline.text());
    expect(calls).toEqual({ allocator: 0, journal: 0, tag: 0, bootstrap: 0 });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.runtimeVerification).toEqual({ passed: false, code: "trace-observation-error" });
  });

  it("moves only the real accepted root onto the accepted face before bootstrap rejection", async () => {
    const snapshots: CommitTraceSnapshot[] = [];
    const bootstrap: DurableObjectNamespace = {
      idFromName: () => ({ toString: () => "bootstrap" }) as DurableObjectId,
      get: () => ({ fetch: async () => {
        // A real service-binding call occupies the caller wall. Retain that
        // timing fact so the actual per-accepted-request union verifier is
        // exercised rather than relying on a zero-ms mock artifact.
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Response(JSON.stringify({ code: "bootstrap_command_rejected" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      } }) as unknown as DurableObjectStub,
    } as unknown as DurableObjectNamespace;
    const unexpected = (): DurableObjectNamespace => ({
      idFromName: () => ({ toString: () => "unexpected" }) as DurableObjectId,
      get: () => ({ fetch: async () => new Response("unexpected", { status: 500 }) }) as unknown as DurableObjectStub,
    } as unknown as DurableObjectNamespace);
    const worker = new CommitWorker({
      ALLOCATOR: unexpected(),
      JOURNAL: unexpected(),
      TAG: unexpected(),
      BOOTSTRAP: bootstrap,
    }, SERVICE, {
      commitTraceSink: { record: (snapshot) => snapshots.push(snapshot) },
      // The branch oracle owns face/boundary attribution. Pin this isolated
      // adapter to explicit platform-limited zero durations; the separate
      // ratio tests and B0 exporter own wall-clock coverage evidence.
      commitTraceClock: { now: () => 0 },
    });

    const payload = btoa(JSON.stringify({ roomId: "room-trace" }));
    const response = await worker.handle(new Request("https://commit.test/api/sekiban/serialized/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        eventCandidates: [{ payload, eventPayloadName: "Trace", tags: ["room:trace"] }],
        consistencyTags: [],
      }),
    }));

    expect(response.status).toBe(409);
    const captured = snapshots[0]!;
    expect(() => verifyCommitTrace(captured, { boundary: "bootstrap-reject" })).not.toThrow();
    expect(captured.runtimeVerification).toEqual({ passed: true });
    const root = captured.spans.find((entry) => entry.rowId === "S00")!;
    const decode = captured.spans.find((entry) => entry.rowId === "S01")!;
    expect(root.face).toBe("accepted");
    expect(root.attributes["attempt.id"]).toEqual(expect.any(String));
    expect(decode.face).toBe("pre-admission");
    expect(decode.attributes["attempt.id"]).toBeUndefined();
  });

  it("forbids an attempt identity before admission and requires it after admission", async () => {
    const preAdmission = new CommitTrace({
      schema: "sdt.commit/v1",
      correlationId: CORRELATION,
      serviceId: SERVICE,
      failOpen: false,
    });
    await expect(preAdmission.root("S00", {
      face: "pre-admission",
      actorKey: "root:g30-pre-admission",
      attemptId: ATTEMPT,
    }, async () => new Response(null, { status: 400 }))).rejects.toThrow("must not emit attempt.id");

    const accepted = new CommitTrace({
      schema: "sdt.commit/v1",
      correlationId: CORRELATION,
      serviceId: SERVICE,
      failOpen: false,
    });
    await expect(accepted.root("S00", {
      face: "accepted",
      actorKey: "root:g30-accepted",
    }, async () => new Response(null, { status: 200 }))).rejects.toThrow("missing required attempt.id");
  });

  it("emits every caller-owned success row from the real CommitWorker path", async () => {
    const captured = await successTrace();

    expect(emittedRows(captured)).toEqual([
      "S00", "S01", "S02", "S03", "S04", "S05a", "S06", "S07", "S08",
      "S05b", "S05c", "S10", "S11", "S12", "S05d", "S13", "S14", "S15",
    ]);
    expect(captured.spans.some((entry) => entry.rowId === "S09")).toBe(false);
    expect(captured.spans.some((entry) => entry.rowId === "S05e" || entry.rowId === "S17" || entry.rowId === "S20")).toBe(false);
    expect(captured.spans.filter((entry) => entry.rowId === "S05a" || entry.rowId === "S05b" || entry.rowId === "S05c" || entry.rowId === "S05d" || entry.rowId === "S05e")
      .map((entry) => entry.attributes["phase.ordinal"]))
      .toEqual([0, 1, 2, 3]);
    expect(captured.spans.find((entry) => entry.rowId === "S14")?.attributes).toMatchObject({
      "member.index": 0,
      "tag.key_hash": stableTraceHash("room:g30-success"),
    });
    expect(captured.runtimeVerification).toEqual({ passed: true });
  });

  it("emits the reservation-failure boundary from the real cancel-barrier path", async () => {
    const tags = ["room:g30-non-success:a", "room:g30-non-success:b"];
    const captured = await nonSuccessTrace("reservation-failure", tags);

    expect(emittedRows(captured)).toEqual([
      "S00", "S01", "S02", "S03", "S04", "S05a", "S06", "S07", "S07",
      "S17", "S18", "S19", "S19", "S05e", "S15",
    ]);
    expect(captured.spans.filter((entry) => entry.rowId === "S07").map((entry) => entry.attributes)).toEqual([
      expect.objectContaining({ "member.index": 0, "tag.key_hash": stableTraceHash(tags[0]!) }),
      expect.objectContaining({ "member.index": 1, "tag.key_hash": stableTraceHash(tags[1]!) }),
    ]);
    expect(captured.spans.filter((entry) => entry.rowId === "S19").map((entry) => entry.attributes)).toEqual([
      expect.objectContaining({ "member.index": 0, "tag.key_hash": stableTraceHash(tags[0]!) }),
      expect.objectContaining({ "member.index": 1, "tag.key_hash": stableTraceHash(tags[1]!) }),
    ]);
    expect(captured.spans.some((entry) => entry.rowId === "S08")).toBe(false);
    expect(captured.runtimeVerification).toEqual({ passed: true });
  });

  it("emits the allocator-failure boundary and routes it through the same cancel barrier", async () => {
    const tags = ["room:g30-non-success:a", "room:g30-non-success:b"];
    const captured = await nonSuccessTrace("allocator-failure", tags);

    expect(emittedRows(captured)).toEqual([
      "S00", "S01", "S02", "S03", "S04", "S05a", "S06", "S07", "S07", "S08",
      "S17", "S18", "S19", "S19", "S05e", "S15",
    ]);
    expect(captured.spans.filter((entry) => entry.rowId === "S07").map((entry) => entry.attributes)).toEqual([
      expect.objectContaining({ "member.index": 0, "tag.key_hash": stableTraceHash(tags[0]!) }),
      expect.objectContaining({ "member.index": 1, "tag.key_hash": stableTraceHash(tags[1]!) }),
    ]);
    expect(captured.spans.filter((entry) => entry.rowId === "S19").map((entry) => entry.attributes)).toEqual([
      expect.objectContaining({ "member.index": 0, "tag.key_hash": stableTraceHash(tags[0]!) }),
      expect.objectContaining({ "member.index": 1, "tag.key_hash": stableTraceHash(tags[1]!) }),
    ]);
    expect(captured.spans.some((entry) => entry.rowId === "S05b")).toBe(false);
    // S09 is emitted by the allocator DO itself. It is deliberately not
    // forged into this Worker-local sink; the B0 exported trace joins it by
    // Cloudflare trace context and verifies its required presence.
    expect(captured.spans.some((entry) => entry.rowId === "S09")).toBe(false);
    expect(captured.runtimeVerification).toEqual({ passed: true });
  });

  it("emits the partial-handoff boundary and never claims the complete transition", async () => {
    const captured = await nonSuccessTrace("partial-handoff");
    const rows = emittedRows(captured);

    expect(rows).toEqual([
      "S00", "S01", "S02", "S03", "S04", "S05a", "S06", "S07", "S08",
      "S05b", "S05c", "S10", "S11", "S12", "S11", "S12", "S20", "S15",
    ]);
    expect(captured.spans.filter((entry) => entry.rowId === "S11").map((entry) => entry.attributes["retry.index"])).toEqual([0, 1]);
    expect(captured.spans.filter((entry) => entry.rowId === "S12").map((entry) => entry.attributes["retry.index"])).toEqual([0, 1]);
    expect(captured.spans.some((entry) => entry.rowId === "S05d")).toBe(false);
    expect(captured.spans.some((entry) => entry.rowId === "S14")).toBe(false);
    expect(captured.runtimeVerification).toEqual({ passed: true });
  });

  it("emits the real dry-run repair boundary without taking a lease or writing a Tag", async () => {
    const fixture = repairTraceFixture("dry-run");
    const result = await fixture.worker.execute({
      attemptIds: [ATTEMPT],
      tags: ["room:g30-repair"],
      actor: "g30-operator",
      owner: "g30-repair-owner",
      mode: "dry-run",
      maxItems: 1,
    });

    expect(result).toMatchObject({ dryRun: true, processed: 0, pending: 1 });
    expect(fixture.calls).toMatchObject({ acquire: 0, scopeUnion: 0, apply: 0, audit: 0, clear: 0, exclusion: 0 });
    expect(fixture.snapshots).toHaveLength(1);
    expect(emittedRows(fixture.snapshots[0]!)).toEqual(["X00", "X03p"]);
    expect(() => verifyCommitTrace(fixture.snapshots[0]!, { boundary: "dry-run", cardinalities: { X03p: 1 } })).not.toThrow();
  });

  it("emits the real resume-skip repair boundary with zero Tag mutation calls", async () => {
    const fixture = repairTraceFixture("resume-skip");
    const result = await fixture.worker.execute({
      attemptIds: [ATTEMPT],
      tags: ["room:g30-repair"],
      actor: "g30-operator",
      owner: "g30-repair-owner",
      mode: "execute",
      maxItems: 1,
    });

    expect(result).toMatchObject({ dryRun: false, processed: 0, rolledForward: 0, cleared: 0 });
    expect(fixture.calls).toMatchObject({ acquire: 0, scopeUnion: 0, apply: 0, audit: 0, clear: 0, exclusion: 0 });
    expect(fixture.snapshots).toHaveLength(1);
    expect(emittedRows(fixture.snapshots[0]!)).toEqual(["X00", "X03r"]);
    expect(() => verifyCommitTrace(fixture.snapshots[0]!, { boundary: "all-items-resume-skip", cardinalities: { X03r: 1 } })).not.toThrow();
  });

  it("emits the real mutating repair lease and item boundary without a G36 permit claim", async () => {
    const fixture = repairTraceFixture("execute");
    const result = await fixture.worker.execute({
      attemptIds: [ATTEMPT],
      tags: ["room:g30-repair"],
      actor: "g30-operator",
      owner: "g30-repair-owner",
      mode: "execute",
      maxItems: 1,
    });

    expect(result).toMatchObject({ dryRun: false, processed: 1, rolledForward: 1, cleared: 1, pending: 0 });
    expect(fixture.calls).toMatchObject({ acquire: 1, scopeUnion: 1, apply: 1, audit: 1, clear: 1, exclusion: 0 });
    expect(fixture.snapshots).toHaveLength(1);
    const captured = fixture.snapshots[0]!;
    expect(emittedRows(captured)).toEqual(["X00", "X02", "X03e"]);
    expect(captured.spans.find((entry) => entry.rowId === "X02")?.attributes["repair.lease.id"])
      .toEqual(captured.spans.find((entry) => entry.rowId === "X03e")?.attributes["repair.lease.id"]);
    expect(captured.spans.some((entry) => entry.rowId === "X01")).toBe(false);
    expect(() => verifyCommitTrace(captured, {
      boundary: "execute-mutating-single-tag",
      conditionals: { X01: false },
      cardinalities: { X02: 1, X03e: 1 },
    })).not.toThrow();
  });

  it("emits S14 member identity from the real CommitWorker completion path", async () => {
    const snapshots: CommitTraceSnapshot[] = [];
    const serviceId = `g30-s14-${crypto.randomUUID()}`;
    const tag = `room:g30-s14-${crypto.randomUUID()}`;
    const worker = new CommitWorker(env as unknown as CommitWorkerEnv, serviceId, {
      commitTraceSink: { record: (snapshot) => snapshots.push(snapshot) },
    });

    const response = await worker.handle(new Request("https://commit.test/api/sekiban/serialized/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        eventCandidates: [{
          payload: btoa(JSON.stringify({ roomId: "g30-s14" })),
          eventPayloadName: "G30S14",
          tags: [tag],
        }],
        consistencyTags: [],
      }),
    }));

    expect(response.status).toBe(200);
    const captured = snapshots.at(-1);
    expect(captured).toBeDefined();
    expect(emittedRows(captured!)).toEqual([
      "S00", "S01", "S02", "S03", "S04", "S05a", "S06", "S08",
      "S05b", "S05c", "S10", "S11", "S12", "S05d", "S13", "S14", "S15",
    ]);
    const s14 = captured!.spans.filter((entry) => entry.rowId === "S14");
    expect(s14).toHaveLength(1);
    expect(s14[0]!.attributes).toMatchObject({
      "member.index": 0,
      "tag.key_hash": stableTraceHash(tag),
    });
    // This integration fixture owns the S14 contract, not the remote B0
    // timing cohort. The in-memory adapter intentionally retains Miniflare's
    // coarse local clock as observed data; B0 validates the <=5% ratio from
    // exported caller-clock traces without substituting a fixture clock.
    expect(() => verifyCommitTrace(captured!)).not.toThrow();

    const noMemberIndex = captured!.spans.map((entry) => entry.rowId === "S14"
      ? { ...entry, attributes: Object.fromEntries(Object.entries(entry.attributes).filter(([key]) => key !== "member.index")) }
      : entry);
    expectCode(() => verifyCommitTrace(snapshot("sdt.commit/v1", noMemberIndex)), "fanout-member-index");
  });

  it("emits terminal-at-entry R00/R08 from the real Journal alarm handler", async () => {
    const capture = recordingNativeTracing();
    const fixture = terminalJournalAlarmFixture(capture.tracing);
    const runner = fixture.journal as unknown as {
      runAlarm(activation: DurableObjectActivationObservation): Promise<JournalRecord | undefined>;
    };

    const result = await runner.runAlarm({ activationId: ATTEMPT, first: true, handlerStartedAtMs: 0, constructorToHandlerMs: 0 });

    expect(result).toMatchObject({ state: "COMPLETE", alarm: null });
    expect(fixture.alarmDeletes()).toBe(1);
    expect(capture.spans.map((span) => span.name)).toEqual([
      "sdt.commit.reconcile",
      "journal.alarm_clear",
    ]);
    const root = capture.spans[0]!;
    const clear = capture.spans[1]!;
    expect(root.attributes).toMatchObject({
      "schema.version": "sdt.commit.reconcile/v1",
      "span.kind": "root",
      "recovery.kind": "terminal-at-entry",
      "durable.prefix.at_entry": "terminal",
      "alarm.event.id": "g30-terminal-generation",
    });
    expect(clear.attributes).toMatchObject({
      operation: "journal.alarm_clear",
      "span.kind": "direct",
      "prefix.before": "terminal",
      "prefix.after": "terminal",
    });
    expect(clear.attributes).not.toHaveProperty("recovery.kind");
    expect(clear.attributes).not.toHaveProperty("alarm.event.id");
  });

  it("adds the late full-write recovery fact only to the still-open R00 native span", async () => {
    const capture = recordingNativeTracing();
    await enterNativeReconcileRootSpan(
      capture.tracing,
      async () => ({
        attemptId: ATTEMPT,
        serviceId: SERVICE,
        actorKey: "journal:g30-r00",
        activation: { activationId: ATTEMPT, first: true, handlerStartedAtMs: 0, constructorToHandlerMs: 0 },
        alarmEventId: "alarm-generation-1",
        invocationId: "alarm-invocation-1",
        retryCount: 0,
        isRetry: false,
        prefixAtEntry: "sealed",
      }),
      async (_identity, facts) => {
        await enterNativeCommitSpan(capture.tracing, "journal.alarm_rearm", {
          schema: "sdt.commit.reconcile/v1",
          face: "reconcile-root",
          rowId: "R01",
          correlationId: CORRELATION,
          attemptId: ATTEMPT,
          serviceId: SERVICE,
          actorClass: "JOURNAL",
          actorKey: "journal:g30-r00",
          activation: { activationId: ATTEMPT, first: true, handlerStartedAtMs: 0, constructorToHandlerMs: 0 },
          operation: "journal.alarm_rearm",
          kind: "direct",
        }, async () => undefined);
        facts.setRecoveryKind("post-allocation-full-write");
      },
    );

    const root = capture.spans.find((entry) => entry.name === "sdt.commit.reconcile")!;
    const rearm = capture.spans.find((entry) => entry.name === "journal.alarm_rearm")!;
    expect(root.attributes).toMatchObject({
      "recovery.kind": "post-allocation-full-write",
      "durable.prefix.at_entry": "sealed",
      "alarm.event.id": "alarm-generation-1",
    });
    expect(rearm.attributes).not.toHaveProperty("recovery.kind");
    expect(rearm.attributes).not.toHaveProperty("durable.prefix.at_entry");
    expect(rearm.attributes).not.toHaveProperty("alarm.event.id");

    const reconcile = snapshot("sdt.commit.reconcile/v1", [
      span("sdt.commit.reconcile/v1", "R00", "reconcile-root"),
    ]);
    const unknownKind = reconcile.spans.map((entry) => ({
      ...entry,
      attributes: { ...entry.attributes, "recovery.kind": "not-a-recovery-kind" },
    }));
    expectCode(() => verifyCommitTrace(snapshot("sdt.commit.reconcile/v1", unknownKind)), "attribute-enum");
  });

  it("emits manifest-attributed native spans at allocator and callee callback boundaries", async () => {
    const capture = recordingNativeTracing();
    const activation = { activationId: ATTEMPT, first: true, handlerStartedAtMs: 0, constructorToHandlerMs: 0 };

    await enterNativeCommitSpan(capture.tracing, "allocator.bootstrap.finalize", {
      schema: "sdt.commit/v1",
      face: "accepted",
      rowId: "S09",
      correlationId: CORRELATION,
      attemptId: ATTEMPT,
      serviceId: SERVICE,
      actorClass: "ALLOCATOR",
      actorKey: "allocator:g30",
      activation,
      operation: "allocator.bootstrap.finalize",
      kind: "nested",
    }, async () => new Response(null, { status: 204 }));

    await enterNativeActorHandleSpan(
      capture.tracing,
      { actorClass: "TAG", actorKey: "tag:g30:room", activation },
      async () => ({ attemptId: ATTEMPT, serviceId: SERVICE }),
      async () => new Response(null, { status: 201 }),
    );

    expect(capture.spans).toHaveLength(2);
    const finalize = capture.spans.find((entry) => entry.name === "allocator.bootstrap.finalize")!;
    const actor = capture.spans.find((entry) => entry.name === "actor.handle")!;
    expect(finalize.attributes).toMatchObject({
      "schema.version": "sdt.commit/v1",
      "correlation.id": CORRELATION,
      "attempt.id": ATTEMPT,
      "service.id": SERVICE,
      "actor.class": "ALLOCATOR",
      "actor.key_hash": stableTraceHash("allocator:g30"),
      operation: "allocator.bootstrap.finalize",
      "span.kind": "nested",
      outcome: "success",
      "http.status": 204,
    });
    expect(actor.attributes).toMatchObject({
      "schema.version": "sdt.commit/v1",
      "correlation.id": expect.any(String),
      "attempt.id": ATTEMPT,
      "service.id": SERVICE,
      "actor.class": "TAG",
      "actor.key_hash": stableTraceHash("tag:g30:room"),
      operation: "actor.handle",
      "span.kind": "callee",
      outcome: "success",
      "http.status": 201,
    });
  });

  it("fails open without emitting a native span when callback attributes violate the manifest type", async () => {
    const capture = recordingNativeTracing();
    let callbackRuns = 0;

    const response = await enterNativeCommitSpan(capture.tracing, "allocator.bootstrap.finalize", {
      schema: "sdt.commit/v1",
      face: "accepted",
      rowId: "S09",
      correlationId: CORRELATION,
      attemptId: ATTEMPT,
      serviceId: SERVICE,
      actorClass: "ALLOCATOR",
      actorKey: "allocator:g30",
      activation: { activationId: "not-a-uuid", first: true, handlerStartedAtMs: 0, constructorToHandlerMs: 0 },
      operation: "allocator.bootstrap.finalize",
      kind: "nested",
    }, async () => {
      callbackRuns += 1;
      return new Response(null, { status: 204 });
    });

    expect(response.status).toBe(204);
    expect(callbackRuns).toBe(1);
    expect(capture.spans).toHaveLength(0);
  });

  it("accepts the literal v1 success boundary and uses interval union for the caller-only attribution ratio", () => {
    const trace = v1Success();
    const result = verifyCommitTrace(trace, {
      boundary: "success",
      cardinalities: { S07: 1, S12: 1, S14: 1 },
      accepted: true,
    });
    expect(result.unattributed?.unattributedRatio).toBe(0);
    // The nested stage coverage overlaps the direct intervals. A sum would
    // over-count this fixture; union is capped to the root duration.
    expect(calculateUnattributedRatio(trace)).toEqual({
      rootDurationMs: 100,
      coveredDurationMs: 100,
      unattributedRatio: 0,
    });
  });

  it("uses union rather than a sum when caller coverage overlaps only part of the root", () => {
    const trace = v1Success();
    const partial = trace.spans.map((entry) => entry.rowId === "S01" || entry.rowId === "S02"
      ? { ...entry, startMs: 0, endMs: 60 }
      : entry.rowId === "S00"
        ? { ...entry, startMs: 0, endMs: 100 }
        : { ...entry, startMs: 100, endMs: 100, zeroDurationPlatformLimited: true });
    // S01/S02 cover the same sixty milliseconds. A sum would incorrectly
    // cap at 100ms and hide the forty-millisecond unattributed interval.
    expect(calculateUnattributedRatio(snapshot("sdt.commit/v1", partial))).toEqual({
      rootDurationMs: 100,
      coveredDurationMs: 60,
      unattributedRatio: 0.4,
    });
  });

  it("excludes a provider/callee interval from caller attribution coverage", () => {
    const trace = v1Success();
    const callee = span("sdt.commit/v1", "S16", "accepted", {
      rootId: ROOT,
      clockDomain: "callee",
      startMs: 0,
      endMs: 100,
    });

    // S16 may be present in the Cloudflare trace context, but it is the
    // provider-subrequest universe and must never fill a caller-side gap.
    expect(calculateUnattributedRatio(snapshot("sdt.commit/v1", [...trace.spans, callee]))).toEqual({
      rootDurationMs: 100,
      coveredDurationMs: 100,
      unattributedRatio: 0,
    });
  });

  it("rejects parent containment, cross-root linkage, and caller/callee clock mixing independently", () => {
    const containment = v1Success({ strictlyNested: true });
    const brokenContainment = containment.spans.map((entry) => entry.rowId === "S01"
      ? { ...entry, startMs: 101, endMs: 102 }
      : entry);
    expectCode(() => verifyCommitTrace(snapshot("sdt.commit/v1", brokenContainment)), "parent-containment");

    const crossRoot = v1Success({ strictlyNested: true });
    const brokenRoot = crossRoot.spans.map((entry) => entry.rowId === "S01"
      ? { ...entry, rootId: "other-root" }
      : entry);
    expectCode(() => verifyCommitTrace(snapshot("sdt.commit/v1", brokenRoot)), "cross-root-parent");

    const clockMix = v1Success({ strictlyNested: true });
    const brokenClock = clockMix.spans.map((entry) => entry.rowId === "S07"
      ? { ...entry, clockDomain: "callee" as const }
      : entry);
    expectCode(() => verifyCommitTrace(snapshot("sdt.commit/v1", brokenClock)), "clock-domain-mix");
  });

  it("accepts equal parent/child timestamp boundaries without making zero-duration presence disappear", () => {
    const trace = v1Success();
    const startEqual = trace.spans.map((entry) => entry.rowId === "S07"
      ? { ...entry, startMs: 10, endMs: 80 }
      : entry);
    const endEqual = trace.spans.map((entry) => entry.rowId === "S07"
      ? { ...entry, startMs: 20, endMs: 90 }
      : entry);
    const zeroDuration = trace.spans.map((entry) => entry.rowId === "S07"
      ? { ...entry, startMs: 10, endMs: 10, zeroDurationPlatformLimited: true }
      : entry);
    for (const equal of [startEqual, endEqual, zeroDuration]) expect(() => verifyCommitTrace(snapshot("sdt.commit/v1", equal), {
      boundary: "success",
      cardinalities: { S07: 1, S12: 1, S14: 1 },
    })).not.toThrow();
  });

  it("retains a zero-duration platform-limited span as present", () => {
    const trace = v1Success();
    const zeroDuration = trace.spans.map((entry) => entry.rowId === "S07"
      ? { ...entry, startMs: 40, endMs: 40, zeroDurationPlatformLimited: true }
      : entry);

    expect(() => verifyCommitTrace(snapshot("sdt.commit/v1", zeroDuration), {
      boundary: "success",
      cardinalities: { S07: 1, S12: 1, S14: 1 },
    })).not.toThrow();
  });

  it("keeps retried append work as a 0..n sequence rather than mislabelling it a duplicate", () => {
    const trace = v1Success();
    const append = trace.spans.find((entry) => entry.rowId === "S11")!;
    const first = { ...append, attributes: { ...append.attributes, "retry.index": 0 } };
    const retry = { ...append, attributes: { ...append.attributes, "retry.index": 1 } };
    const withRetry = trace.spans.flatMap((entry) => entry.rowId === "S11" ? [first, retry] : [entry]);
    expect(() => verifyCommitTrace(snapshot("sdt.commit/v1", withRetry), { boundary: "success" })).not.toThrow();
  });

  it("keeps S16 in the provider subrequest universe rather than fabricating a local parent", () => {
    const remote = span("sdt.commit/v1", "S16", "accepted", {
      rootId: "provider-trace",
      clockDomain: "callee",
    });
    expect(() => verifyCommitTrace(snapshot("sdt.commit/v1", [remote]))).not.toThrow();
  });

  it("requires the repair lease link while keeping X03e as a child of X00", () => {
    const schema = "sdt.commit.repair/v1" as const;
    const root = span(schema, "X00", "repair-root", { attributes: { "repair.execution.id": "repair-execution-1" } });
    const lease = span(schema, "X02", "repair-root", {
      attributes: {
        "repair.lease.id": "lease-1",
        "tag.key_hash": stableTraceHash("orders"),
        "member.index": 0,
      },
    });
    const execute = span(schema, "X03e", "repair-root", {
      attributes: {
        "repair.lease.id": "lease-1",
        "tag.key_hash": stableTraceHash("orders"),
        "member.index": 0,
        repairEpoch: 1,
      },
    });
    const valid = snapshot(schema, [root, lease, execute]);
    expect(() => verifyCommitTrace(valid, {
      boundary: "execute-mutating-single-tag",
      conditionals: { X01: false },
      cardinalities: { X02: 1, X03e: 1 },
    })).not.toThrow();
    const wrongLease = valid.spans.map((entry) => entry.rowId === "X03e"
      ? { ...entry, attributes: { ...entry.attributes, "repair.lease.id": "other" } }
      : entry);
    expectCode(() => verifyCommitTrace(snapshot(schema, wrongLease)), "repair-link");
  });

  it("uses the literal 2s/15s/180s idle experiment schedule and keeps activation IDs independent", () => {
    expect(IDLE_EXPERIMENT_SCHEDULE_MS).toEqual([2_000, 15_000, 180_000]);
    const worker = beginWorkerInvocationObservation();
    const activation = new DurableObjectActivation();
    expect(activation.beginHandler()).toMatchObject({ activationId: expect.any(String), first: true });
    expect(activation.beginHandler()).toMatchObject({ activationId: activation.activationId, first: false });
    expect(activation.activationId).not.toBe(worker.isolateInstanceId);
  });

  it("observes activation and idle only in process memory / external ledgers", () => {
    const activation = new DurableObjectActivation();
    expect(activation.beginHandler()).toMatchObject({ activationId: expect.any(String), first: true });
    expect(activation.beginHandler()).toMatchObject({ activationId: activation.activationId, first: false });
    expect(observedIdleGapLowerBoundMs(undefined, 100)).toBeNull();
    expect(observedIdleGapLowerBoundMs({ actorKeyHash: "a", endMs: 10, complete: false }, 100)).toBeNull();
    expect(observedIdleGapLowerBoundMs({ actorKeyHash: "a", endMs: 10, complete: true }, 100)).toBe(90);
    expect(classifyReactivationCause({ deployedVersionChanged: false })).toBe("unknown");
    expect(classifyReactivationCause({ deployedVersionChanged: false, elapsedMs: 180_000 })).toBe("unknown");
    expect(classifyReactivationCause({ deployedVersionChanged: false, platformEvidence: "runtime-restart" })).toBe("platform-evidenced");
    expect(classifyReactivationCause({ deployedVersionChanged: true, platformEvidence: "runtime-restart" })).toBe("deployment-correlated");
  });

  it("emits isolated sdt.observe events from actual Worker and DO handler measurements", async () => {
    const events: ObservationEvent[] = [];
    const sink = { emit: (event: ObservationEvent) => events.push(event) };
    observeWorkerInvocation({
      isolateInstanceId: "worker-isolate-fixture",
      firstInvocation: true,
      requestId: "fixture-ray",
      correlationId: "corr-fixture-attempt",
      scriptVersion: "worker-version-fixture",
      colo: "SJC",
    }, sink);
    const activation = new DurableObjectActivation().beginHandler();
    const handler = beginDurableObjectHandlerObservation("TAG", activation, sink);
    handler.bindCorrelation("corr-fixture-attempt");
    handler.markFirstStorageRead();
    await handler.subrequest(async () => undefined);
    handler.finish();
    handler.finish();
    observeFaultBarrier({ barrierId: "fixture-fault", stage: "started", boundedWindowMs: 10 }, sink);

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      schema: "sdt.observe/v1",
      event: "worker.invocation",
      requestId: "fixture-ray",
      correlationId: "corr-fixture-attempt",
      isolateInstanceId: "worker-isolate-fixture",
      scriptVersion: "worker-version-fixture",
      colo: "SJC",
      storageWrites: 0,
      usedForControl: false,
      exposedInPublicResponse: false,
    });
    expect(events[1]).toMatchObject({
      schema: "sdt.observe/v1",
      event: "do.handler",
      correlationId: "corr-fixture-attempt",
      actorClass: "TAG",
      activationId: activation.activationId,
      activationFirst: true,
      storageWrites: 0,
      usedForControl: false,
      exposedInPublicResponse: false,
    });
    expect((events[1] as Extract<ObservationEvent, { event: "do.handler" }>).firstStorageReadMs).not.toBeNull();
    expect(events[2]).toMatchObject({ schema: "sdt.observe/v1", event: "fault.barrier", stage: "started", barrierId: "fixture-fault" });
  });

  it("ends S00 before a detached waitUntil-style observation can complete", async () => {
    let now = 0;
    let release!: () => void;
    const detached = new Promise<void>((resolve) => {
      release = () => {
        now = 1_000;
        resolve();
      };
    });
    const snapshots: CommitTraceSnapshot[] = [];
    const trace = new CommitTrace({
      schema: "sdt.commit/v1",
      correlationId: CORRELATION,
      serviceId: SERVICE,
      clock: { now: () => now },
      sink: { record: (snapshot) => snapshots.push(snapshot) },
      scheduleDetachedObservation: () => detached,
    });

    const pending = trace.root("S00", {
      face: "accepted",
      actorKey: "root:g30-detached-observation",
      attemptId: ATTEMPT,
    }, async (scope) => scope.span("S15", {}, async () => new Response(null, { status: 200 })));
    try {
      const outcome = await Promise.race([
        pending.then(() => "response-returned"),
        new Promise<string>((resolve) => setTimeout(() => resolve("held-by-detached-work"), 25)),
      ]);
      expect(outcome).toBe("response-returned");
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]!.spans.find((entry) => entry.rowId === "S00")?.endMs).toBe(0);
    } finally {
      release();
      await detached;
      await pending;
    }
  });

  it("rejects a raw tag attribute before it can become telemetry and keeps the hash as the only tag identity", async () => {
    const trace = new CommitTrace({
      schema: "sdt.commit/v1",
      correlationId: CORRELATION,
      serviceId: SERVICE,
      failOpen: false,
    });
    await expect(trace.root("S00", {
      face: "accepted",
      actorKey: "root",
      attemptId: ATTEMPT,
    }, async (scope) => scope.span("S01", {
      attributes: { "tag.value": "room:raw-value" },
    }, async () => undefined))).rejects.toThrow("forbids raw tag attribute");
    expect(stableTraceHash("room:raw-value")).toMatch(/^[0-9a-f]{64}$/);
  });
});
