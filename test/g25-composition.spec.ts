import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error Vite raw migration fixture.
import g32Migration from "../migrations/d1/g32/0001_dcb_events.sql?raw";
// @ts-expect-error Vite raw migration fixture.
import mvMigration from "../migrations/mv/0001_materialized_views.sql?raw";
// @ts-expect-error Vite raw migration fixture.
import unsafeMigration from "../migrations/mv/0002_unsafe_window_materialized_views.sql?raw";
// @ts-expect-error Vite raw migration fixture.
import hardeningMigration from "../migrations/mv/0003_checkpoint_ahead_hardening.sql?raw";
// @ts-expect-error Vite raw migration fixture.
import unsafeFailureMigration from "../migrations/mv/0004_unsafe_window_failure_findings.sql?raw";
// @ts-expect-error Vite raw migration fixture.
import g31WaitReceiptMigration from "../migrations/mv/0005_g31_wait_receipts.sql?raw";
// @ts-expect-error Vite raw migration fixture.
import g31WaitPoisonMigration from "../migrations/mv/0006_g31_wait_target_poison.sql?raw";
// @ts-expect-error Vite raw migration imports.
import orderingQuarantineMigration from "../migrations/mv/0007_g69_ordering_quarantine.sql?raw";
// @ts-expect-error Vite raw migration import.
import rebuildVerificationMigration from "../migrations/mv/0008_g69_rebuild_verification.sql?raw";
// @ts-expect-error Vite raw migration import.
import rebuildProofMigration from "../migrations/mv/0009_g69_rebuild_proof.sql?raw";
import { D1MaterializedViewStore } from "../packages/dcb-runtime/src/d1-mv";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { g32Message, g32Suid } from "./helpers/g32-fixtures";
import { applyG44D1Migration } from "./helpers/g44-d1-migration";
// @ts-expect-error Vite raw deployed Queue configuration fixture.
import workerConfig from "../samples/meeting-room/wrangler.cloudflare-only.jsonc?raw";
import worker from "../samples/meeting-room/src/worker.cloudflare-only";

// This is intentionally a public test fixture value, not a deployed secret.
// Its SHA-256 is the paired test fingerprint injected below, so the deployed
// entrypoints exercise the final-fence success path without weakening the
// production phase/release/token/fingerprint validation.
const G32_FINAL_FENCE_FIXTURE_TOKEN = "g32-final-fence-fixture";
const G32_FINAL_FENCE_FIXTURE_FINGERPRINT = "62cd8d0ecb2c2f5f6fc14f4cd11e76dbf7e4893e42db37789f2b7df8688b4c36";

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
  return g32Message({
    serviceId, allocatorLineageId: `g25-lineage-${suffix}`, tag,
    attemptId: `g25-attempt-${suffix}`, eventId: `g25-event-${suffix}`,
    suid: `g25-suid-${suffix}`,
    payload: JSON.stringify({ eventType: "RoomReserved", reservationId: `g25-${suffix}`, roomId: "g25-room", userId: "g25-user" }),
    eventTags: [tag], eventType: "RoomReserved", enqueuedAt: Date.now(),
  });
}

interface QueueResult {
  readonly acked: number;
  readonly retried: number;
  readonly waits: readonly Promise<unknown>[];
}

function deployedEnvironment(serviceId: string): Record<string, unknown> {
  // G25 deliberately exercises a receiver-only direct delivery fixture, not
  // a source Tag obligation. Removing this test-only binding keeps it from
  // pretending that its handcrafted envelope is a registered G44 source;
  // G44's actual Tag/D1 acknowledgement path is covered separately.
  return {
    ...(env as unknown as Record<string, unknown>),
    SDT_SERVICE_ID: serviceId,
    TAG: undefined,
    G32_COMPONENT: "primary",
    G32_CUTOVER_PHASE: "final-g32",
    G32_FREEZE_RELEASE: "after-new-bindings",
    G32_CUTOVER_FENCE_TOKEN: G32_FINAL_FENCE_FIXTURE_TOKEN,
    G32_CUTOVER_FENCE_FINGERPRINT: G32_FINAL_FENCE_FIXTURE_FINGERPRINT,
  };
}

async function invokeDeployedQueue(body: DownstreamOutboxMessage, serviceId: string, attempts = 1): Promise<QueueResult> {
  let acked = 0;
  let retried = 0;
  const waits: Promise<unknown>[] = [];
  const batch = {
    messages: [{
      body,
      attempts,
      ack: () => { acked += 1; },
      retry: () => { retried += 1; },
    }],
  } as unknown as MessageBatch<unknown>;
  const queue = worker.queue as unknown as ((
    input: MessageBatch<unknown>,
    inputEnv: Record<string, unknown>,
    ctx: ExecutionContext,
  ) => Promise<void>) | undefined;
  if (queue === undefined) throw new Error("deployed meeting-room Worker must expose queue");
  await queue(batch, deployedEnvironment(serviceId), {
    waitUntil: (promise: Promise<unknown>) => { waits.push(promise); },
  } as unknown as ExecutionContext);
  return { acked, retried, waits };
}

async function invokeDeployedScheduled(serviceId: string): Promise<void> {
  const scheduled = worker.scheduled as unknown as ((
    controller: ScheduledController,
    inputEnv: Record<string, unknown>,
    ctx: ExecutionContext,
  ) => Promise<void>) | undefined;
  if (scheduled === undefined) throw new Error("deployed meeting-room Worker must expose scheduled");
  await scheduled({} as ScheduledController, deployedEnvironment(serviceId), {} as ExecutionContext);
}

describe("SDT-G25 unsafe-window consumer composition", () => {
  beforeAll(async () => {
    await database().batch(statements(g32Migration as string, database()));
    await applyG44D1Migration(database());
    for (const migration of [mvMigration, unsafeMigration, hardeningMigration, unsafeFailureMigration, g31WaitReceiptMigration, g31WaitPoisonMigration, orderingQuarantineMigration, rebuildVerificationMigration, rebuildProofMigration]) {
      await mvDatabase().batch(statements(migration as string, mvDatabase()));
    }
  });

  it("uses the deployed Worker entrypoint for stored-only unsafe apply and retains the durable kick for scheduled safe convergence", async () => {
    const serviceId = `g25-${crypto.randomUUID()}`;
    const queued = message(serviceId, "1");
    const stored = await invokeDeployedQueue(queued, serviceId);
    expect(stored.acked).toBe(1); expect(stored.retried).toBe(0);
    // G55 must not start safe follow in the same Queue execution: it would
    // collect the just-applied unsafe row before an app list can observe it.
    // G69's diagnostic receipt is the only waitUntil work here and is not a
    // safe-lane kick; await it before inspecting the diagnostic ledger.
    expect(stored.waits).toHaveLength(1);
    await Promise.all(stored.waits);
    const views = new D1MaterializedViewStore(mvDatabase()); await views.initialize();
    const page = await views.queryRowsWithTotal(serviceId, "ReservationProjector", { limit: 20 });
    expect(page.totalCount).toBe(1);
    expect(page.rows[0]?.value).toMatchObject({ reservationId: "g25-1", status: "reserved" });
    expect(await mvDatabase().prepare(
      "SELECT COUNT(*) AS count FROM mv_unsafe_rows WHERE service_id = ? AND view_id = 'ReservationProjector'",
    ).bind(serviceId).first<{ count: number }>()).toEqual({ count: 1 });
    const atomicArrival = await mvDatabase().prepare(
      `SELECT receipt.suid AS receipt_suid, kick.target_suid AS kick_target_suid
         FROM mv_unsafe_receipts receipt
         JOIN mv_unsafe_kicks kick ON kick.service_id = receipt.service_id AND kick.view_id = receipt.view_id
        WHERE receipt.service_id = ? AND receipt.view_id = 'ReservationProjector' AND receipt.event_id = ?`,
    ).bind(serviceId, queued.eventId).first<{ receipt_suid: string; kick_target_suid: string }>();
    expect(atomicArrival).toEqual({ receipt_suid: queued.suid, kick_target_suid: queued.suid });

    // A source SUID collision is a non-stored outcome. The deployed hook must
    // not reach the unsafe port or schedule another drain for it.
    const nonStored = { ...message(serviceId, "non-stored"), suid: queued.suid };
    const rejected = await invokeDeployedQueue(nonStored, serviceId);
    expect(rejected.acked).toBe(1); expect(rejected.retried).toBe(0);
    expect(rejected.waits).toHaveLength(1);
    await Promise.all(rejected.waits);
    expect((await views.queryRowsWithTotal(serviceId, "ReservationProjector", { limit: 20 })).totalCount).toBe(1);
  });

  it("keeps the scalar V1 query's unpaged composed read in one statement", async () => {
    const serviceId = `g25-scalar-${crypto.randomUUID()}`;
    const views = new D1MaterializedViewStore(mvDatabase()); await views.initialize();
    await views.createActive({ serviceId, viewId: "RoomProjector", generation: 0, definitionVersion: 1, updatedAt: 1 });
    await mvDatabase().prepare(
      "INSERT INTO mv_rows (service_id, view_id, generation, row_key, value_json, row_version, source_suid) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(serviceId, "RoomProjector", 0, "room", '{"roomId":"room","status":"created"}', 1, g32Suid("g25-scalar-row")).run();
    const page = await views.queryRowsWithTotal(serviceId, "RoomProjector", { limit: null });
    expect(page.totalCount).toBe(1);
    expect(page.rows).toHaveLength(1);
  });

  it("retries the deployed unsafe failure through exhaustion, writes one identity finding, and cron safe catch-up recovers", async () => {
    const serviceId = `g25-${crypto.randomUUID()}`;
    const queued = message(serviceId, "fault");
    // This is a legal test seam for an atomic-port contradiction: the real
    // stored event has a different SUID, so the deployed apply path throws
    // after its arrival observation and must record the production finding.
    await mvDatabase().prepare(
      `INSERT INTO mv_unsafe_receipts (service_id, view_id, event_id, suid, outcome, observed_at)
       VALUES (?, 'ReservationProjector', ?, ?, 'applied', 0)`,
    ).bind(serviceId, queued.eventId, g32Suid("g25-contradiction")).run();

    const attempts = await Promise.all([1, 2, 3].map((attempt) => invokeDeployedQueue(queued, serviceId, attempt)));
    expect(attempts.map((result) => result.acked)).toEqual([0, 0, 0]);
    expect(attempts.map((result) => result.retried)).toEqual([1, 1, 1]);
    expect(attempts.every((result) => result.waits.length === 1)).toBe(true);
    await Promise.all(attempts.flatMap((result) => result.waits));

    const finding = await mvDatabase().prepare(
      `SELECT service_id, view_id, event_id, suid, classification, COUNT(*) OVER () AS total
         FROM mv_unsafe_failure_findings
        WHERE service_id = ? AND view_id = 'ReservationProjector' AND event_id = ?`,
    ).bind(serviceId, queued.eventId).first<{
      service_id: string; view_id: string; event_id: string; suid: string; classification: string; total: number;
    }>();
    expect(finding).toMatchObject({
      service_id: serviceId,
      view_id: "ReservationProjector",
      event_id: queued.eventId,
      suid: queued.suid,
      classification: "UNSAFE_APPLY_RETRY",
      total: 1,
    });
    const queuePolicy = JSON.parse(workerConfig as string) as { queues: { consumers: Array<{ max_retries: number; dead_letter_queue: string }> } };
    expect(queuePolicy.queues.consumers).toContainEqual(expect.objectContaining({ max_retries: 3, dead_letter_queue: "sekiban-dcb-meeting-room-cloudflare-outbox-dlq" }));

    // Make the persisted source old enough for the published safe window, then
    // use the deployed scheduled entrypoint as the recovery net. It must fold
    // the durable event even though every immediate Queue delivery retried.
    await database().prepare('UPDATE dcb_event_ops SET "LastArrivedAt" = 0 WHERE "ServiceId" = ? AND "Id" = ?')
      .bind(serviceId, queued.eventId).run();
    await invokeDeployedScheduled(serviceId);
    const views = new D1MaterializedViewStore(mvDatabase()); await views.initialize();
    const recovered = await views.queryRowsWithTotal(serviceId, "ReservationProjector", { limit: 20 });
    expect(recovered.rows[0]?.value).toMatchObject({ reservationId: "g25-fault", status: "reserved" });
  });
});
