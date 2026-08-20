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
import unsafeFailureMigration from "../migrations/mv/0004_unsafe_window_failure_findings.sql?raw";
import { createCloudflareOnlyRuntimeWorker, type CloudflareOnlyEnv } from "../packages/dcb-runtime/src/cloudflare";
import { D1MaterializedViewStore } from "../packages/dcb-runtime/src/d1-mv";
import { handleDownstreamQueue } from "../packages/dcb-runtime/src/downstream/DownstreamAdapter";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { D1EventStore } from "../packages/dcb-runtime/src/d1";
import { meetingRoomDomain, meetingRoomRuntimeConfig } from "../samples/meeting-room/src/domain";
import { applyMeetingRoomUnsafeArrival, drainMeetingRoomUnsafeKicks } from "../samples/meeting-room/src/d1-mv";

function statements(sql: string, database: D1Database): D1PreparedStatement[] {
  return sql.replace(/^\s*--.*$/gm, "").split(";").map((value) => value.trim()).filter(Boolean).map((value) => database.prepare(value));
}
function database(): D1Database {
  const binding = (env as unknown as { D1?: D1Database }).D1;
  if (binding === undefined) throw new Error("G25 requires D1");
  return binding;
}
function mvDatabase(): D1Database {
  const binding = (env as unknown as { D1_MV?: D1Database }).D1_MV;
  if (binding === undefined) throw new Error("G25 requires D1_MV");
  return binding;
}
function message(serviceId: string, suffix: string): DownstreamOutboxMessage {
  const tag = `reservation:g25-${suffix}`;
  return {
    version: 1, serviceId, allocatorLineageId: `g25-lineage-${suffix}`, tag,
    attemptId: `g25-attempt-${suffix}`, eventId: `g25-event-${suffix}`,
    suid: `suid-999999999999999999999999${suffix.padStart(8, "0")}`,
    payload: btoa(JSON.stringify({ eventType: "RoomReserved", reservationId: `g25-${suffix}`, roomId: "g25-room", userId: "g25-user" })),
    eventTags: [tag], enqueuedAt: Date.now(),
  };
}

describe("SDT-G25 unsafe-window consumer composition", () => {
  beforeAll(async () => {
    await database().batch(statements(pipelineMigration as string, database()));
    for (const migration of [mvMigration, unsafeMigration, hardeningMigration, unsafeFailureMigration]) {
      await mvDatabase().batch(statements(migration as string, mvDatabase()));
    }
  });

  it("applies only the stored Queue outcome, exposes its tentative composed winner, and acks after G23 apply", async () => {
    const serviceId = `g25-${crypto.randomUUID()}`;
    const waits: Promise<unknown>[] = [];
    let acked = 0; let retried = 0;
    const runtime = createCloudflareOnlyRuntimeWorker({
      domain: meetingRoomDomain,
      config: meetingRoomRuntimeConfig,
      afterStoredDownstreamDelivery: async ({ event, env: input, ctx }) => {
        await applyMeetingRoomUnsafeArrival(input, event);
        ctx.waitUntil(drainMeetingRoomUnsafeKicks(input));
      },
    });
    const queued = message(serviceId, "1");
    const queue = runtime.queue as (batch: MessageBatch<unknown>, input: CloudflareOnlyEnv, ctx: ExecutionContext) => Promise<void>;
    await queue({ messages: [{ body: queued, ack: () => { acked += 1; }, retry: () => { retried += 1; } }] } as unknown as MessageBatch<unknown>, {
      ...(env as unknown as CloudflareOnlyEnv), SDT_SERVICE_ID: serviceId,
    }, { waitUntil: (promise: Promise<unknown>) => { waits.push(promise); } } as unknown as ExecutionContext);
    expect(acked).toBe(1); expect(retried).toBe(0);
    await Promise.all(waits);
    const views = new D1MaterializedViewStore(mvDatabase()); await views.initialize();
    const page = await views.queryRowsWithTotal(serviceId, "ReservationProjector", { limit: 20 });
    expect(page.totalCount).toBe(1);
    expect(page.rows[0]?.value).toMatchObject({ reservationId: "g25-1", status: "reserved" });
  });

  it("does not acknowledge an unsafe post-store failure and records the retry finding", async () => {
    const serviceId = `g25-${crypto.randomUUID()}`;
    const store = new D1EventStore(database()); await store.initialize();
    const queued = message(serviceId, "2");
    let acked = 0; let retried = 0;
    await handleDownstreamQueue({ messages: [{ body: queued, ack: () => { acked += 1; }, retry: () => { retried += 1; } }] } as unknown as MessageBatch<unknown>, { D1: database(), SDT_SERVICE_ID: serviceId }, {
      store,
      onStored: async ({ message: stored }) => {
        const views = new D1MaterializedViewStore(mvDatabase()); await views.initialize();
        await views.recordUnsafeFailureFinding({ serviceId, viewId: "ReservationProjector", eventId: stored.eventId, suid: stored.suid, observedAt: 1 });
        throw new Error("forced unsafe apply failure");
      },
    });
    expect(acked).toBe(0); expect(retried).toBe(1);
    const finding = await mvDatabase().prepare("SELECT classification FROM mv_unsafe_failure_findings WHERE service_id = ? AND view_id = ? AND event_id = ?")
      .bind(serviceId, "ReservationProjector", queued.eventId).first<{ classification: string }>();
    expect(finding?.classification).toBe("UNSAFE_APPLY_RETRY");
  });
});
