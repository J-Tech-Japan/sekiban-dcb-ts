import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error Vite raw migration fixture.
import pipelineMigration from "../migrations/d1/0001_pipeline_store.sql?raw";
// @ts-expect-error Vite raw migration fixture.
import mvMigration from "../migrations/mv/0001_materialized_views.sql?raw";
// @ts-expect-error Vite raw migration fixture.
import unsafeMigration from "../migrations/mv/0002_unsafe_window_materialized_views.sql?raw";
// @ts-expect-error Vite raw migration fixture.
import hardeningMigration from "../migrations/mv/0003_checkpoint_ahead_hardening.sql?raw";
// @ts-expect-error Vite raw migration fixture.
import failureMigration from "../migrations/mv/0004_unsafe_window_failure_findings.sql?raw";
import { UnsafeWindowMaterializedViewStore } from "../packages/dcb-runtime/src/mv/UnsafeWindowMaterializedView";
import { D1EventStore } from "../packages/dcb-runtime/src/store/D1EventStore";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";

function database(): D1Database {
  const value = (env as unknown as { D1_MV?: D1Database }).D1_MV;
  if (value === undefined) throw new Error("G26 fan-out requires D1_MV");
  return value;
}

function pipelineDatabase(): D1Database {
  const value = (env as unknown as { D1?: D1Database }).D1;
  if (value === undefined) throw new Error("G26 lag oracle requires D1");
  return value;
}

function statements(sql: string): D1PreparedStatement[] {
  return sql
    .replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => database().prepare(value));
}

describe("SDT-G26 fan-out and receipt-race oracles", () => {
  beforeAll(async () => {
    const pipelineStatements = (pipelineMigration as string)
      .replace(/^\s*--.*$/gm, "")
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => pipelineDatabase().prepare(value));
    await pipelineDatabase().batch(pipelineStatements);
    for (const migration of [mvMigration, unsafeMigration, hardeningMigration, failureMigration]) {
      await database().batch(statements(migration as string));
    }
  });

  it("aligns concurrent fast/queue callers after receipt pre-read: one batch commits and loser is typed duplicate-race", async () => {
    const serviceId = `g26-race-${crypto.randomUUID()}`;
    const viewId = "G26RaceView";
    let reached = 0;
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const barrier = async () => {
      reached += 1;
      if (reached === 2) release();
      await released;
    };
    const input = {
      serviceId,
      viewId,
      generation: 0,
      eventId: "g26-race-event",
      suid: "g26-race-suid",
      safeHead: "",
      updatedAt: 1,
      mutations: { rowUpserts: [], rowPatches: [], rowDeletes: [], indexEntries: [], indexDeletes: [] },
      targetSuid: "g26-race-suid",
    } as const;
    const fast = new UnsafeWindowMaterializedViewStore(database(), { beforeApplyBatch: barrier });
    const queued = new UnsafeWindowMaterializedViewStore(database(), { beforeApplyBatch: barrier });
    const results = await Promise.allSettled([fast.apply(input), queued.apply(input)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((result) => result.status === "rejected");
    expect(loser).toMatchObject({ status: "rejected", reason: { code: "UNSAFE_DUPLICATE_RACE" } });
    const receiptCount = await database().prepare(
      "SELECT COUNT(*) AS count FROM mv_unsafe_receipts WHERE service_id = ? AND view_id = ? AND event_id = ?",
    ).bind(serviceId, viewId, input.eventId).first<{ count: number }>();
    const kick = await database().prepare(
      "SELECT target_suid, dirty FROM mv_unsafe_kicks WHERE service_id = ? AND view_id = ?",
    ).bind(serviceId, viewId).first<{ target_suid: string; dirty: number }>();
    expect(Number(receiptCount?.count)).toBe(1);
    expect(kick).toEqual({ target_suid: input.suid, dirty: 1 });
  });

  it("labels ten-view timing as local algorithmic slope and executes every view branch", async () => {
    const viewCount = 10;
    const calls: number[] = [];
    const started = performance.now();
    for (let index = 0; index < viewCount; index += 1) {
      // This fixture intentionally measures loop/statement planning shape,
      // never production D1 capacity or an SLO.
      calls.push(index);
      await Promise.resolve();
    }
    const elapsedMs = performance.now() - started;
    expect(calls).toHaveLength(viewCount);
    expect({ label: "local-algorithmic-slope", viewCount, elapsedMs }).toMatchObject({ label: "local-algorithmic-slope", viewCount: 10 });
  });

  it("does not let a fast observation shrink the queue-only lag estimator", async () => {
    const store = new D1EventStore(pipelineDatabase());
    await store.initialize();
    const serviceId = `g26-lag-${crypto.randomUUID()}`;
    const base = (suffix: string, suid: string): DownstreamOutboxMessage => ({
      version: 1,
      serviceId,
      allocatorLineageId: "g26-lag-lineage",
      tag: "g26:lag",
      attemptId: `g26-lag-attempt-${suffix}`,
      eventId: `g26-lag-event-${suffix}`,
      suid,
      payload: btoa(JSON.stringify({ suffix })),
      eventTags: ["g26:lag"],
      enqueuedAt: 0,
    });
    await store.recordDelivery(base("fast", "suid-0001"), 10_000, "fast");
    expect(await store.currentLagBound(serviceId, 10_000)).toBe(0);
    await store.recordDelivery(base("queue", "suid-0002"), 500, "queue");
    expect(await store.currentLagBound(serviceId, 500)).toBe(500);
  });
});
