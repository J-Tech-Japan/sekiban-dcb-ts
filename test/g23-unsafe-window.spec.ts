import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error Vite raw asset import
import migration from "../migrations/mv/0001_materialized_views.sql?raw";
import { defineRowMaterializer } from "@sekiban/dcb-core";
import { D1MaterializedViewStore, UnsafeWindowMaterializedViewError, type UnsafeWindowApplyInput, type UnsafeWindowMaterializedViewStore } from "../packages/dcb-runtime/src/d1-mv";

const MATERIALIZER = defineRowMaterializer<{ eventId: string; suid: string; value: string }>({
  id: "g23-unsafe-window-v1",
  version: 1,
  indexDescriptors: [{ id: "value", valueType: "text", value: (row) => (row as { value: string }).value }],
  materialize: (event) => ({ rowUpserts: [{ rowKey: event.eventId, value: { eventId: event.eventId, value: event.value }, rowVersion: 1, sourceSuid: event.suid }] }),
});

function database(): D1Database {
  const binding = (env as unknown as { D1_MV?: D1Database }).D1_MV;
  if (binding === undefined) throw new Error("D1_MV binding is required");
  return binding;
}

async function unsafeStore(viewId = MATERIALIZER.id): Promise<{ mv: D1MaterializedViewStore; unsafe: UnsafeWindowMaterializedViewStore }> {
  const mv = new D1MaterializedViewStore(database());
  await mv.initialize();
  const serviceId = `g23-${crypto.randomUUID()}`;
  await mv.createActive({ serviceId, viewId, definitionVersion: 1, updatedAt: 1 });
  return { mv, unsafe: mv.unsafeWindow() };
}

function input(serviceId: string, eventId: string, suid: string, value: string, extra: Partial<UnsafeWindowApplyInput> = {}): UnsafeWindowApplyInput {
  return {
    serviceId, viewId: MATERIALIZER.id, generation: 0, eventId, suid, safeHead: "", updatedAt: 1,
    mutations: MATERIALIZER.plan({ eventId, suid, value }), ...extra,
  };
}

describe("SDT-G23 unsafe-window MV core", () => {
  beforeAll(async () => {
    const statements = (migration as string).replace(/^\s*--.*$/gm, "").split(";").map((value) => value.trim()).filter(Boolean);
    await database().batch(statements.map((statement) => database().prepare(statement)));
  });

  it("aborts row/index/receipt/marker/kick together on the in-batch row CAS guard", async () => {
    const { mv, unsafe } = await unsafeStore();
    const serviceId = `g23-cas-${crypto.randomUUID()}`;
    await mv.createActive({ serviceId, viewId: MATERIALIZER.id, definitionVersion: 1, updatedAt: 1 });
    await unsafe.apply(input(serviceId, "same", "suid-2", "first"));
    await expect(unsafe.apply(input(serviceId, "other", "suid-3", "second", { expectedRowVersion: 99, mutations: MATERIALIZER.plan({ eventId: "same", suid: "suid-3", value: "second" }) })))
      .rejects.toMatchObject({ code: "UNSAFE_ROW_CAS_MISMATCH", retryable: true });
    expect(await unsafe.hasTargetReceipt(serviceId, MATERIALIZER.id, "other", "suid-3")).toBe(false);
    expect((await mv.queryRowsWithTotal(serviceId, MATERIALIZER.id, { limit: 10 })).rows[0]?.value).toMatchObject({ value: "first" });
  });

  it("keeps a newer unsafe row while an older arrival converges only its receipt and marker", async () => {
    const { mv, unsafe } = await unsafeStore();
    const serviceId = `g23-older-${crypto.randomUUID()}`;
    await mv.createActive({ serviceId, viewId: MATERIALIZER.id, definitionVersion: 1, updatedAt: 1 });
    await unsafe.apply(input(serviceId, "new", "suid-9", "new"));
    await expect(unsafe.apply(input(serviceId, "old", "suid-1", "old", { mutations: MATERIALIZER.plan({ eventId: "new", suid: "suid-1", value: "old" }) }))).resolves.toMatchObject({ outcome: "older" });
    expect(await unsafe.hasTargetReceipt(serviceId, MATERIALIZER.id, "old", "suid-1")).toBe(true);
    expect((await mv.queryRowsWithTotal(serviceId, MATERIALIZER.id, { limit: 10 })).rows[0]?.value).toMatchObject({ value: "new" });
  });

  it("uses a matching receipt transaction, not safeHead alone, to remove a marker", async () => {
    const { unsafe } = await unsafeStore();
    const serviceId = `g23-marker-${crypto.randomUUID()}`;
    await unsafe.apply(input(serviceId, "patch", "suid-5", "ignored", { mutations: { rowUpserts: [], rowDeletes: [], rowPatches: [{ kind: "json_patch", rowKey: "missing", patch: { value: "x" }, rowVersion: 1, sourceSuid: "suid-5", indexEntries: [] }], indexEntries: [], indexDeletes: [] } }));
    await expect(unsafe.observeSafeReceipt(serviceId, MATERIALIZER.id, 0, "wrong", "suid-5")).rejects.toBeTruthy();
    await expect(unsafe.observeSafeReceipt(serviceId, MATERIALIZER.id, 0, "patch", "suid-5")).resolves.toBeUndefined();
  });

  it("detects a behind-frontier first arrival without SafeWindow and fail-closes composed reads", async () => {
    const { mv, unsafe } = await unsafeStore();
    const serviceId = `g23-detector-${crypto.randomUUID()}`;
    await mv.createActive({ serviceId, viewId: MATERIALIZER.id, definitionVersion: 1, updatedAt: 1 });
    await unsafe.apply(input(serviceId, "known", "suid-8", "known"));
    await unsafe.observeSafeReceipt(serviceId, MATERIALIZER.id, 0, "known", "suid-8");
    expect(await unsafe.observeArrival(serviceId, MATERIALIZER.id, 0, "late", "suid-1")).toBe(true);
    expect((await unsafe.readMeta(serviceId, MATERIALIZER.id, 0)).rebuildRequired).toBe(true);
    await expect(mv.queryRowsWithTotal(serviceId, MATERIALIZER.id, { limit: 10 })).rejects.toBeInstanceOf(UnsafeWindowMaterializedViewError);
  });

  it("coalesces durable kicks behind one CAS lease holder and lets lease expiry recover", async () => {
    const { unsafe } = await unsafeStore();
    const serviceId = `g23-kick-${crypto.randomUUID()}`;
    const mv = new D1MaterializedViewStore(database());
    await mv.initialize();
    await mv.createActive({ serviceId, viewId: MATERIALIZER.id, definitionVersion: 1, updatedAt: 1 });
    await unsafe.apply(input(serviceId, "kick", "suid-2", "x"));
    await expect(unsafe.acquireKick(serviceId, MATERIALIZER.id, "holder-a", 10, 10)).resolves.toMatchObject({ targetSuid: "suid-2" });
    await expect(unsafe.acquireKick(serviceId, MATERIALIZER.id, "holder-b", 11, 10)).rejects.toMatchObject({ code: "UNSAFE_KICK_LEASE_HELD" });
    await unsafe.apply(input(serviceId, "kick-2", "suid-3", "y"));
    await expect(unsafe.acquireKick(serviceId, MATERIALIZER.id, "holder-b", 21, 10)).resolves.toMatchObject({ targetSuid: "suid-3" });
  });
});
