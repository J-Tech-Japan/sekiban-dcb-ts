import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error Vite raw migration imports.
import migration0001 from "../migrations/mv/0001_materialized_views.sql?raw";
// @ts-expect-error Vite raw migration imports.
import migration0002 from "../migrations/mv/0002_unsafe_window_materialized_views.sql?raw";
import fixture from "./fixtures/g23-csharp-fixture.generated.json";
// @ts-expect-error Vite raw asset import preserves the committed C# generator bytes.
import fixtureBytes from "./fixtures/g23-csharp-fixture.generated.json?raw";
import provenance from "./fixtures/g23-csharp-fixture.provenance.json";
import { defineRowMaterializer } from "@sekiban/dcb-core";
import { D1MaterializedViewStore, UnsafeWindowMaterializedViewError, type UnsafeWindowApplyInput, type UnsafeWindowMaterializedViewStore } from "../packages/dcb-runtime/src/d1-mv";
import { createRuntimeWorker, type MaterializedViewRow } from "../packages/dcb-runtime/src/index";
import { TEST_SERVICE_ID_HEADER } from "../packages/dcb-runtime/src/http/testServiceId";

const MATERIALIZER = defineRowMaterializer<{ eventId: string; suid: string; value: string }>({
  id: "g23-unsafe-window-v1", version: 1,
  indexDescriptors: [{ id: "value", valueType: "text", value: (row) => (row as { value: string }).value }],
  materialize: (event) => ({ rowUpserts: [{ rowKey: event.eventId, value: { eventId: event.eventId, value: event.value }, rowVersion: 1, sourceSuid: event.suid }] }),
});

function database(): D1Database {
  const binding = (env as unknown as { D1_MV?: D1Database }).D1_MV;
  if (binding === undefined) throw new Error("D1_MV binding is required");
  return binding;
}
function statements(sql: string): D1PreparedStatement[] {
  return sql.replace(/^\s*--.*$/gm, "").split(";").map((value) => value.trim()).filter(Boolean).map((statement) => database().prepare(statement));
}
async function unsafeStore(): Promise<{ mv: D1MaterializedViewStore; unsafe: UnsafeWindowMaterializedViewStore; serviceId: string }> {
  const mv = new D1MaterializedViewStore(database());
  await mv.initialize();
  const serviceId = `g23-${crypto.randomUUID()}`;
  await mv.createActive({ serviceId, viewId: MATERIALIZER.id, definitionVersion: 1, updatedAt: 1 });
  return { mv, unsafe: mv.unsafeWindow(), serviceId };
}
function input(serviceId: string, eventId: string, suid: string, value: string, extra: Partial<UnsafeWindowApplyInput> = {}): UnsafeWindowApplyInput {
  return { serviceId, viewId: MATERIALIZER.id, generation: 0, eventId, suid, safeHead: "", updatedAt: 1, mutations: MATERIALIZER.plan({ eventId, suid, value }), ...extra };
}
function sameRow(serviceId: string, eventId: string, suid: string, value: string, extra: Partial<UnsafeWindowApplyInput> = {}): UnsafeWindowApplyInput {
  return input(serviceId, eventId, suid, value, { mutations: { rowUpserts: [{ rowKey: "shared", value: { eventId, value }, rowVersion: 1, sourceSuid: suid }], rowPatches: [], rowDeletes: [], indexEntries: [], indexDeletes: [] }, ...extra });
}
async function seedGc(tombstone = false): Promise<{ mv: D1MaterializedViewStore; unsafe: UnsafeWindowMaterializedViewStore; serviceId: string }> {
  const state = await unsafeStore();
  await state.unsafe.apply(input(state.serviceId, "gc-event", "suid-5", "gc"));
  await state.unsafe.observeSafeReceipt(state.serviceId, MATERIALIZER.id, 0, "gc-event", "suid-5");
  if (tombstone) await database().prepare("UPDATE mv_unsafe_rows SET tombstone = 1 WHERE service_id = ? AND view_id = ?").bind(state.serviceId, MATERIALIZER.id).run();
  return state;
}
async function gc(state: Awaited<ReturnType<typeof seedGc>>, overrides: Partial<{ rowVersion: number; sourceSuid: string; safeHead: string; definitionVersion: number }> = {}): Promise<boolean> {
  return state.unsafe.garbageCollect({ serviceId: state.serviceId, viewId: MATERIALIZER.id, generation: 0, definitionVersion: overrides.definitionVersion ?? 1, rowKey: "gc-event", expectedRowVersion: overrides.rowVersion ?? 1, expectedSourceSuid: overrides.sourceSuid ?? "suid-5", safeHead: overrides.safeHead ?? "suid-5" });
}
function fixtureMutation(eventId: string, suid: string) {
  return { rowUpserts: [{ rowKey: "reference-row", value: { eventId }, rowVersion: 1, sourceSuid: suid }], rowPatches: [], rowDeletes: [], indexEntries: [], indexDeletes: [] };
}

describe("SDT-G23 unsafe-window MV core", () => {
  let upgradeSawMissingUnsafeTable = false;
  beforeAll(async () => {
    // This mirrors Wrangler's versioned apply path: G20 has 0001 recorded, so
    // only the newly named 0002 deploys the unsafe schema.
    await database().batch(statements(migration0001 as string));
    try { await database().prepare("SELECT 1 FROM mv_unsafe_rows LIMIT 1").all(); } catch { upgradeSawMissingUnsafeTable = true; }
    await database().batch(statements(migration0002 as string));
  });

  it("upgrades a G20 database with 0001 already applied by applying deployable 0002 only", async () => {
    expect(upgradeSawMissingUnsafeTable).toBe(true);
    await expect(database().prepare("SELECT 1 FROM mv_unsafe_rows LIMIT 1").all()).resolves.toBeTruthy();
  });
  it("aborts row/index/receipt/marker/kick together on the in-batch row CAS guard", async () => {
    const { mv, unsafe, serviceId } = await unsafeStore();
    await unsafe.apply(input(serviceId, "same", "suid-2", "first"));
    await expect(unsafe.apply(input(serviceId, "other", "suid-3", "second", { expectedRowVersion: 99, mutations: MATERIALIZER.plan({ eventId: "same", suid: "suid-3", value: "second" }) }))).rejects.toMatchObject({ code: "UNSAFE_ROW_CAS_MISMATCH", retryable: true });
    expect(await unsafe.hasTargetReceipt(serviceId, MATERIALIZER.id, "other", "suid-3")).toBe(false);
    expect((await mv.queryRowsWithTotal(serviceId, MATERIALIZER.id, { limit: 10 })).rows[0]?.value).toMatchObject({ value: "first" });
  });
  it("AC11 post-recordDelivery unsafe crash retry has exactly one durable receipt", async () => {
    const { unsafe, serviceId } = await unsafeStore();
    await unsafe.apply(input(serviceId, "crash", "suid-2", "once")); // simulated hook throws after this atomic call
    await expect(unsafe.apply(input(serviceId, "crash", "suid-2", "once"))).resolves.toEqual({ outcome: "no-change", duplicate: true });
    expect(await unsafe.hasTargetReceipt(serviceId, MATERIALIZER.id, "crash", "suid-2")).toBe(true);
  });
  it("AC11 duplicate retry oracle is isolated from crash handling", async () => {
    const { mv, unsafe, serviceId } = await unsafeStore();
    await unsafe.apply(input(serviceId, "duplicate", "suid-2", "once"));
    await unsafe.apply(input(serviceId, "duplicate", "suid-2", "once"));
    expect((await mv.queryRowsWithTotal(serviceId, MATERIALIZER.id, { limit: 10 })).totalCount).toBe(1);
  });
  it("AC11 same-key reverse arrival retains the newer unsafe candidate and records older", async () => {
    const { mv, unsafe, serviceId } = await unsafeStore();
    await unsafe.apply(sameRow(serviceId, "late", "suid-9", "late"));
    await expect(unsafe.apply(sameRow(serviceId, "early", "suid-1", "early"))).resolves.toMatchObject({ outcome: "older" });
    expect((await mv.queryRowsWithTotal(serviceId, MATERIALIZER.id, { limit: 10 })).rows[0]?.value).toMatchObject({ value: "late" });
  });
  it("AC11 safe-ahead resurrection is rejected by its dedicated guard", async () => {
    const state = await seedGc(); expect(await gc(state)).toBe(true);
    await expect(state.unsafe.apply(input(state.serviceId, "resurrect", "suid-5", "no", { safeHead: "suid-5" }))).rejects.toMatchObject({ code: "UNSAFE_SAFE_AHEAD" });
  });
  it("AC11 patch-missing writes a receipt and marker without fabricating a row", async () => {
    const { mv, unsafe, serviceId } = await unsafeStore();
    const mutations = { rowUpserts: [], rowDeletes: [], rowPatches: [{ kind: "json_patch" as const, rowKey: "missing", patch: { value: "x" }, rowVersion: 1, sourceSuid: "suid-5", indexEntries: [] }], indexEntries: [], indexDeletes: [] };
    await expect(unsafe.apply(input(serviceId, "patch", "suid-5", "ignored", { mutations }))).resolves.toMatchObject({ outcome: "patch-not-found" });
    expect(await unsafe.hasTargetReceipt(serviceId, MATERIALIZER.id, "patch", "suid-5")).toBe(true);
    expect((await mv.queryRowsWithTotal(serviceId, MATERIALIZER.id, { limit: 10 })).totalCount).toBe(0);
  });
  it("AC11 delete-without-row and no-change have distinct isolated receipt outcomes", async () => {
    const { unsafe, serviceId } = await unsafeStore();
    const deleteMissing = { rowUpserts: [], rowPatches: [], rowDeletes: [{ rowKey: "missing", rowVersion: 1, sourceSuid: "suid-6", indexDeletes: [] }], indexEntries: [], indexDeletes: [] };
    await expect(unsafe.apply(input(serviceId, "delete", "suid-6", "x", { mutations: deleteMissing }))).resolves.toMatchObject({ outcome: "delete-without-row" });
    await expect(unsafe.apply(input(serviceId, "none", "suid-7", "x", { mutations: { rowUpserts: [], rowPatches: [], rowDeletes: [], indexEntries: [], indexDeletes: [] } }))).resolves.toMatchObject({ outcome: "no-change" });
  });
  it("uses a matching receipt transaction, not safeHead alone, to remove a marker", async () => {
    const { unsafe, serviceId } = await unsafeStore();
    const mutations = { rowUpserts: [], rowDeletes: [], rowPatches: [{ kind: "json_patch" as const, rowKey: "missing", patch: { value: "x" }, rowVersion: 1, sourceSuid: "suid-5", indexEntries: [] }], indexEntries: [], indexDeletes: [] };
    await unsafe.apply(input(serviceId, "patch", "suid-5", "ignored", { mutations }));
    await expect(unsafe.observeSafeReceipt(serviceId, MATERIALIZER.id, 0, "wrong", "suid-5")).rejects.toBeTruthy();
    await expect(unsafe.observeSafeReceipt(serviceId, MATERIALIZER.id, 0, "patch", "suid-5")).resolves.toBeUndefined();
  });
  it("detects a behind-frontier first arrival without SafeWindow and fail-closes composed reads", async () => {
    const { mv, unsafe, serviceId } = await unsafeStore();
    await unsafe.apply(input(serviceId, "known", "suid-8", "known")); await unsafe.observeSafeReceipt(serviceId, MATERIALIZER.id, 0, "known", "suid-8");
    expect(await unsafe.observeArrival(serviceId, MATERIALIZER.id, 0, "late", "suid-1")).toBe(true);
    expect((await unsafe.readMeta(serviceId, MATERIALIZER.id, 0)).rebuildRequired).toBe(true);
    await expect(mv.queryRowsWithTotal(serviceId, MATERIALIZER.id, { limit: 10 })).rejects.toBeInstanceOf(UnsafeWindowMaterializedViewError);
  });
  it("GC oracle safe-ahead-then-late-retry removes all repairable unsafe state", async () => {
    const state = await seedGc(); expect(await gc(state)).toBe(true);
    expect(await state.unsafe.hasTargetReceipt(state.serviceId, MATERIALIZER.id, "gc-event", "suid-5")).toBe(false);
  });
  it("GC oracle newer-unsafe-during-GC keeps the row on compare-and-delete mismatch", async () => {
    const state = await seedGc(); expect(await gc(state, { rowVersion: 99 })).toBe(false);
    expect((await state.mv.queryRowsWithTotal(state.serviceId, MATERIALIZER.id, { limit: 10 })).totalCount).toBe(1);
  });
  it("GC oracle open-behind-frontier keeps unsafe state until rebuild", async () => {
    const state = await seedGc(); await state.unsafe.observeArrival(state.serviceId, MATERIALIZER.id, 0, "behind", "suid-1"); expect(await gc(state)).toBe(false);
  });
  it("GC oracle tombstone is collected only after every other guard is true", async () => {
    const state = await seedGc(true); expect(await gc(state)).toBe(true);
  });
  it("GC mutation evidence: safe-head guard is independently required", async () => {
    const state = await seedGc(); expect(await gc(state, { safeHead: "suid-4" })).toBe(false);
  });
  it("GC mutation evidence: observed-arrival receipt guard is independently required", async () => {
    const state = await unsafeStore(); await state.unsafe.apply(input(state.serviceId, "gc-event", "suid-5", "gc"));
    expect(await state.unsafe.garbageCollect({ serviceId: state.serviceId, viewId: MATERIALIZER.id, generation: 0, definitionVersion: 1, rowKey: "gc-event", expectedRowVersion: 1, expectedSourceSuid: "suid-5", safeHead: "suid-5" })).toBe(false);
  });
  it("GC mutation evidence: active-generation guard is independently required", async () => {
    // Candidate generation, matching definition, receipt/arrival, source and
    // row CAS are all legal; only the active pointer still selects generation 0.
    const state = await unsafeStore(); await state.mv.createCandidate({ serviceId: state.serviceId, viewId: MATERIALIZER.id, generation: 1, definitionVersion: 1, updatedAt: 2 });
    await state.unsafe.apply(input(state.serviceId, "gc-event", "suid-5", "gc", { generation: 1 }));
    await state.unsafe.observeSafeReceipt(state.serviceId, MATERIALIZER.id, 1, "gc-event", "suid-5");
    expect(await state.unsafe.garbageCollect({ serviceId: state.serviceId, viewId: MATERIALIZER.id, generation: 1, definitionVersion: 1, rowKey: "gc-event", expectedRowVersion: 1, expectedSourceSuid: "suid-5", safeHead: "suid-5" })).toBe(false);
  });
  it("GC mutation evidence: definition-version guard is independently required", async () => {
    // The active pointer remains valid; mutate only the current instance's
    // definition so this cannot be absorbed by the active-generation guard.
    const state = await seedGc();
    await database().prepare("UPDATE mv_instances SET definition_version = 2 WHERE service_id = ? AND view_id = ? AND generation = 0").bind(state.serviceId, MATERIALIZER.id).run();
    expect(await gc(state)).toBe(false);
  });
  it("GC mutation evidence: behind-frontier guard is independently required", async () => {
    // Arrival receipt/watermark, active generation, definition and row CAS
    // stay valid; only the latched rebuild finding makes collection a no-op.
    const state = await seedGc();
    await database().prepare("UPDATE mv_unsafe_arrivals SET rebuild_required = 1 WHERE service_id = ? AND view_id = ? AND generation = 0").bind(state.serviceId, MATERIALIZER.id).run();
    expect(await gc(state)).toBe(false);
  });
  it("AC9 N concurrent kicks elects one holder", async () => {
    const { unsafe, serviceId } = await unsafeStore(); await unsafe.apply(input(serviceId, "kick", "suid-2", "x"));
    const attempts = await Promise.allSettled(["a", "b", "c", "d"].map((owner) => unsafe.acquireKick(serviceId, MATERIALIZER.id, owner, 10, 10)));
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
  });
  it("AC9 mid-drain dirty arrival requires another drain", async () => {
    const { unsafe, serviceId } = await unsafeStore(); await unsafe.apply(input(serviceId, "kick", "suid-2", "x")); await unsafe.acquireKick(serviceId, MATERIALIZER.id, "a", 10, 10);
    await unsafe.apply(input(serviceId, "kick-2", "suid-3", "y")); expect(await unsafe.finishKick(serviceId, MATERIALIZER.id, "a")).toBe(false);
    await expect(unsafe.acquireKick(serviceId, MATERIALIZER.id, "a", 11, 10)).resolves.toMatchObject({ targetSuid: "suid-3" });
  });
  it("AC9 crashed holder is recovered after lease expiry", async () => {
    const { unsafe, serviceId } = await unsafeStore(); await unsafe.apply(input(serviceId, "kick", "suid-2", "x")); await unsafe.acquireKick(serviceId, MATERIALIZER.id, "a", 10, 10);
    // A new durable dirty bit makes the abandoned holder's unfinished work
    // eligible for the recovery lease.
    await unsafe.apply(input(serviceId, "kick-after-crash", "suid-3", "y"));
    await expect(unsafe.acquireKick(serviceId, MATERIALIZER.id, "b", 11, 10)).rejects.toMatchObject({ code: "UNSAFE_KICK_LEASE_HELD" });
    await expect(unsafe.acquireKick(serviceId, MATERIALIZER.id, "b", 21, 10)).resolves.toMatchObject({ targetSuid: "suid-3" });
  });
  it("AC9 missed waitUntil is recoverable by later cron acquisition", async () => {
    const { unsafe, serviceId } = await unsafeStore(); await unsafe.apply(input(serviceId, "kick", "suid-2", "x"));
    await expect(unsafe.acquireKick(serviceId, MATERIALIZER.id, "cron", 100, 10)).resolves.toMatchObject({ targetSuid: "suid-2" });
  });
  it("AC6 Worker paging mutation fails if supportsServerPaging regresses to full-table queryRows", async () => {
    const calls: Array<{ serviceId: string; viewId: string; options: unknown }> = [];
    const port = {
      initialize: async () => {},
      queryRows: async (): Promise<MaterializedViewRow[]> => { throw new Error("full-table materialization is forbidden"); },
      queryRowsWithTotal: async (serviceId: string, viewId: string, options: { limit?: number; offset?: number } = {}) => {
        calls.push({ serviceId, viewId, options });
        return { rows: [{ serviceId, viewId, generation: 0, rowKey: "r", value: { eventId: "r" }, rowVersion: 1, sourceSuid: "suid-3" }], totalCount: 3 };
      },
    };
    const worker = createRuntimeWorker({ queryBacking: "d1-mv", materializedViewQueryPort: port });
    if (worker.fetch === undefined) throw new Error("Runtime worker fetch handler was not composed");
    const fetchHandler = worker.fetch as unknown as (request: Request, env: unknown, context: ExecutionContext) => Promise<Response>;
    const response = await fetchHandler(new Request("https://query.test/api/sekiban/serialized/list-query", {
      method: "POST", headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: "g23-worker-paging" },
      body: JSON.stringify({ queryType: "GetTestListQuery", queryParamsJson: JSON.stringify({ PageNumber: 2, PageSize: 2 }) }),
    }), {} as never, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ itemsJson: JSON.stringify([{ eventId: "r" }]), totalCount: 3, totalPages: 2, currentPage: 2, pageSize: 2 });
    // If Worker-side supportsServerPaging becomes false, this receives
    // {limit:null} and this exact oracle fails before a full-table fallback.
    expect(calls).toEqual([{ serviceId: "g23-worker-paging", viewId: "test-projector", options: { limit: 2, offset: 2 } }]);
  });
  it("drives unsafe and safe TS paths against the provenance-fixed C# reorder trace", async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fixtureBytes));
    expect([...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(provenance.sha256);
    const trace = fixture as { arrivals: Array<{ eventId: string; suid: string }>; unsafeTentative: string[]; safeOrderedFold: string[] };
    const { mv, unsafe, serviceId } = await unsafeStore();
    for (const event of trace.arrivals) {
      await unsafe.apply(input(serviceId, event.eventId, event.suid, event.eventId, { mutations: fixtureMutation(event.eventId, event.suid) }));
    }
    const tentative = await mv.queryRowsWithTotal(serviceId, MATERIALIZER.id, { limit: 10 });
    expect(tentative.rows.map((row) => (row.value as { eventId: string }).eventId)).toEqual(trace.unsafeTentative);
    let checkpoint = "";
    for (const event of [...trace.arrivals].sort((left, right) => left.suid.localeCompare(right.suid))) {
      await mv.applyMutationsAndAdvanceCheckpoint({ serviceId, viewId: MATERIALIZER.id, generation: 0, expectedLastSuid: checkpoint, lastSuid: event.suid, definitionVersion: 1, updatedAt: 1, mutations: fixtureMutation(event.eventId, event.suid) });
      checkpoint = event.suid;
    }
    const safeFinal = await mv.queryRows(serviceId, MATERIALIZER.id, { generation: 0 });
    expect(safeFinal.map((row) => (row.value as { eventId: string }).eventId)).toEqual(trace.safeOrderedFold);
  });
});
