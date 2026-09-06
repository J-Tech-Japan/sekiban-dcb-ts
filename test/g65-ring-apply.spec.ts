import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error Vite raw migration fixture.
import g32Migration from "../migrations/d1/g32/0001_dcb_events.sql?raw";
import { MeetingRoomDownstreamDoorbell, type MeetingRoomCloudflareEnv } from "../samples/meeting-room/src/worker.cloudflare-only";
import type { PipelineStore, StoredEvent } from "../packages/dcb-runtime/src/store/types";
import type { DeliveryViewHandler } from "../packages/dcb-runtime/src/downstream/DeliveryCore";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { g32Message, g32StoredEvent } from "./helpers/g32-fixtures";
import { applyG44D1Migration } from "./helpers/g44-d1-migration";

function database(): D1Database {
  const value = (env as unknown as { D1?: D1Database }).D1;
  if (value === undefined) throw new Error("G65 RING/APPLY requires the local D1 binding");
  return value;
}

function statements(databaseValue: D1Database, sql: string): D1PreparedStatement[] {
  return sql.replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => databaseValue.prepare(statement));
}

function bootstrapAccepting(): DurableObjectNamespace {
  return {
    idFromName: () => ({ toString: () => "bootstrap" }) as DurableObjectId,
    get: () => ({ fetch: async () => new Response(null, { status: 200 }) }) as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace;
}

function fakeStore(): PipelineStore {
  return {
    initialize: async () => undefined,
    recordDelivery: async (input, arrivedAt) => ({
      outcome: "stored",
      kind: "stored",
      event: g32StoredEvent(input, arrivedAt) satisfies StoredEvent,
    }),
    readAllEvents: async () => [],
    currentLagBound: async () => 0,
    projectDeliveryIncidents: async () => 0,
    upsertPending: async (input, firstObservedAt, lagBoundMs) => ({
      serviceId: input.serviceId,
      attemptId: input.attemptId,
      eventId: input.eventId,
      suid: input.suid,
      expectedPaths: [...input.eventTags],
      observedPaths: [...input.eventTags],
      firstObservedAt,
      lagBoundMs,
    }),
    listPending: async () => [],
    appendFinding: async () => undefined,
    hasFinding: async () => false,
    listFindings: async () => [],
    appendDeliveryIncident: async () => undefined,
    hasDeliveryIncident: async () => false,
    listDeliveryIncidents: async () => [],
    listProjectionTags: async () => [],
    readProjectionCheckpoint: async () => undefined,
    advanceProjectionCheckpoint: async () => true,
    projectionLag: async () => ({ serviceId: "g65-ring", projectionId: "fixture", tag: "reservation:g65-ring", checkpointSuid: "", headSuid: "", behindEvents: 0 }),
  };
}

function message(suffix: string): DownstreamOutboxMessage {
  const tag = `reservation:g65-ring:${suffix}`;
  return g32Message({
    serviceId: "g65-ring-service",
    allocatorLineageId: "g65-ring-lineage",
    tag,
    attemptId: `g65-ring-attempt-${suffix}`,
    eventId: `g65-ring-event-${suffix}`,
    suid: `g65-ring-suid-${suffix}`,
    payload: JSON.stringify({ eventType: "G65RingApply", suffix }),
    eventTags: [tag],
    eventType: "G65RingApply",
    enqueuedAt: 1_000,
  });
}

function views(release: Promise<void>[], entered: () => void): readonly DeliveryViewHandler[] {
  return [{
    id: "ReservationProjector",
    admission: "independent-unsafe",
    apply: async () => {
      entered();
      await release[0];
      return "applied";
    },
  }];
}

describe("SDT-G65 RING/APPLY direct receiver", () => {
  beforeAll(async () => {
    const d1 = database();
    const existing = await d1.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dcb_events'").first<{ name: string }>();
    if (existing === null || existing === undefined) await d1.batch(statements(d1, g32Migration as string));
    await applyG44D1Migration(d1);
  });

  it("returns after the durable ring while the receiver applies asynchronously", async () => {
    let releaseApply!: () => void;
    const applyGate = new Promise<void>((resolve) => { releaseApply = resolve; });
    let applyEntered = false;
    const input = message(crypto.randomUUID());
    const ctx = createExecutionContext();
    const receiver = new MeetingRoomDownstreamDoorbell(ctx, {
      BOOTSTRAP: bootstrapAccepting(),
      D1: database(),
      DIRECT_DOORBELL: "true",
      DIRECT_DOORBELL_ALLOWED_VIEWS: "ReservationProjector",
      DIRECT_DOORBELL_DEGRADATION: "fail-fast",
      SDT_SERVICE_ID: input.serviceId,
      __G29_DOORBELL_TEST__: {
        store: fakeStore(),
        views: views([applyGate], () => { applyEntered = true; }),
      },
    } as unknown as MeetingRoomCloudflareEnv);

    const started = performance.now();
    const result = await Promise.race([
      receiver.deliver(input),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("receiver ring did not return")), 500)),
    ]);
    const returnedMs = performance.now() - started;
    expect(result).toMatchObject({ fastDisposition: "completed", ringOutcome: "rung", applyOutcome: "scheduled" });
    expect(returnedMs).toBeLessThan(500);

    const ring = await database().prepare(`
      SELECT ring_outcome, apply_started_at, apply_finished_at, apply_outcome
        FROM serialized_dcb_g65_direct_rings
       WHERE service_id = ? AND event_id = ? AND attempt_id = ?
    `).bind(input.serviceId, input.eventId, input.attemptId).first<{
      ring_outcome: string;
      apply_started_at: number | null;
      apply_finished_at: number | null;
      apply_outcome: string | null;
    }>();
    expect(ring).toMatchObject({ ring_outcome: "rung" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(applyEntered).toBe(true);
    expect(ring?.apply_finished_at).toBeNull();

    releaseApply();
    await waitOnExecutionContext(ctx);
    const completed = await database().prepare(`
      SELECT ring_started_at, ring_finished_at, apply_started_at, apply_finished_at, apply_outcome
        FROM serialized_dcb_g65_direct_rings
       WHERE service_id = ? AND event_id = ? AND attempt_id = ?
    `).bind(input.serviceId, input.eventId, input.attemptId).first<{
      ring_started_at: number;
      ring_finished_at: number;
      apply_started_at: number | null;
      apply_finished_at: number | null;
      apply_outcome: string | null;
    }>();
    expect(completed?.ring_finished_at).toBeGreaterThanOrEqual(completed?.ring_started_at ?? 0);
    expect(completed?.apply_started_at).not.toBeNull();
    expect(completed?.apply_finished_at).not.toBeNull();
    expect(completed?.apply_outcome).toBe("applied");
  });

  it("records unsafe APPLY success when completeness remains unresolved", async () => {
    const input = message(crypto.randomUUID());
    const ctx = createExecutionContext();
    let completenessChecked = false;
    const receiver = new MeetingRoomDownstreamDoorbell(ctx, {
      BOOTSTRAP: bootstrapAccepting(),
      D1: database(),
      DIRECT_DOORBELL: "true",
      DIRECT_DOORBELL_ALLOWED_VIEWS: "ReservationProjector",
      DIRECT_DOORBELL_DEGRADATION: "fail-fast",
      SDT_SERVICE_ID: input.serviceId,
      __G29_DOORBELL_TEST__: {
        store: fakeStore(),
        views: [{
          id: "ReservationProjector",
          admission: "independent-unsafe",
          apply: async () => "applied",
        }],
        beforeViews: async () => {
          completenessChecked = true;
          throw new Error("global_completeness_BLOCK: simulated unresolved coverage");
        },
      },
    } as unknown as MeetingRoomCloudflareEnv);

    const result = await receiver.deliver(input);
    expect(result).toMatchObject({ fastDisposition: "completed", ringOutcome: "rung", applyOutcome: "scheduled" });
    await waitOnExecutionContext(ctx);

    expect(completenessChecked).toBe(true);
    const ring = await database().prepare(`
      SELECT apply_outcome, apply_error
        FROM serialized_dcb_g65_direct_rings
       WHERE service_id = ? AND event_id = ? AND attempt_id = ?
    `).bind(input.serviceId, input.eventId, input.attemptId).first<{
      apply_outcome: string | null;
      apply_error: string | null;
    }>();
    expect(ring).toEqual({ apply_outcome: "applied", apply_error: null });
  });
});
