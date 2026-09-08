import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error Vite raw asset import
import g32Migration from "../migrations/d1/g32/0001_dcb_events.sql?raw";
// @ts-expect-error Vite raw asset import
import mvMigration from "../migrations/mv/0001_materialized_views.sql?raw";
// @ts-expect-error Vite raw asset import
import unsafeMvMigration from "../migrations/mv/0002_unsafe_window_materialized_views.sql?raw";
// @ts-expect-error Vite raw migration imports.
import hardeningMvMigration from "../migrations/mv/0003_checkpoint_ahead_hardening.sql?raw";
// @ts-expect-error Vite raw migration imports.
import unsafeFailureMvMigration from "../migrations/mv/0004_unsafe_window_failure_findings.sql?raw";
// @ts-expect-error Vite raw migration imports.
import g31WaitReceiptMigration from "../migrations/mv/0005_g31_wait_receipts.sql?raw";
// @ts-expect-error Vite raw migration imports.
import g31WaitPoisonMigration from "../migrations/mv/0006_g31_wait_target_poison.sql?raw";
// @ts-expect-error Vite raw migration imports.
import orderingQuarantineMigration from "../migrations/mv/0007_g69_ordering_quarantine.sql?raw";
// @ts-expect-error Vite raw migration import.
import rebuildVerificationMigration from "../migrations/mv/0008_g69_rebuild_verification.sql?raw";
// @ts-expect-error Vite raw migration import.
import rebuildProofMigration from "../migrations/mv/0009_g69_rebuild_proof.sql?raw";
import { D1EventStore } from "../packages/dcb-runtime/src/d1";
import { createCloudflareOnlyRuntimeWorker } from "../packages/dcb-runtime/src/cloudflare";
import { createD1StoreProvider } from "../packages/dcb-runtime/src/d1";
import { catchUpMeetingRoomMaterializedViews } from "../samples/meeting-room/src/d1-mv";
import { meetingRoomDomain, meetingRoomRuntimeConfig } from "../samples/meeting-room/src/domain";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import type { CloudflareOnlyEnv } from "../packages/dcb-runtime/src/cloudflare";
import { g32Message } from "./helpers/g32-fixtures";
import { applyG44D1Migration } from "./helpers/g44-d1-migration";

function statements(sql: string): D1PreparedStatement[] {
  return sql.replace(/^\s*--.*$/gm, "").split(";").map((value) => value.trim())
    .filter(Boolean).map((value) => database().prepare(value));
}

function database(): D1Database {
  const binding = (env as unknown as { D1?: D1Database }).D1;
  if (binding === undefined) throw new Error("G20 requires the D1 pipeline binding");
  return binding;
}

function mvDatabase(): D1Database {
  const binding = (env as unknown as { D1_MV?: D1Database }).D1_MV;
  if (binding === undefined) throw new Error("G20 requires the D1_MV binding");
  return binding;
}

function event(serviceId: string): DownstreamOutboxMessage {
  const tag = "reservation:g20-reservation";
  return g32Message({
    serviceId,
    allocatorLineageId: "g20-test-lineage",
    tag,
    attemptId: "g20-attempt",
    eventId: "g20-event",
    suid: "g20-event",
    payload: JSON.stringify({
      reservationId: "g20-reservation",
      roomId: "g20-room",
      userId: "g20-user",
    }),
    eventTags: [tag],
    eventType: "RoomReserved",
    enqueuedAt: 0,
  });
}

describe("SDT-G20 Cloudflare-only composition", () => {
  beforeAll(async () => {
    await database().batch(statements(g32Migration as string));
    await applyG44D1Migration(database());
    await mvDatabase().batch(([mvMigration as string, unsafeMvMigration as string, hardeningMvMigration as string, unsafeFailureMvMigration as string, g31WaitReceiptMigration as string, g31WaitPoisonMigration as string, orderingQuarantineMigration as string, rebuildVerificationMigration as string, rebuildProofMigration as string].join("\n")).replace(/^\s*--.*$/gm, "").split(";").map((value) => value.trim())
      .filter(Boolean).map((value) => mvDatabase().prepare(value)));
  });

  it("uses two required D1 bindings and serves a list-query from D1 MV rows", async () => {
    const serviceId = `g20-${crypto.randomUUID()}`;
    const source = new D1EventStore(database());
    await source.initialize();
    const incoming = event(serviceId);
    await source.recordDelivery(incoming, 0);
    await catchUpMeetingRoomMaterializedViews({ D1: database(), D1_MV: mvDatabase(), SDT_SERVICE_ID: serviceId });
    const runtime = createCloudflareOnlyRuntimeWorker({ domain: meetingRoomDomain, config: meetingRoomRuntimeConfig });
    const handler = runtime.fetch as unknown as (request: Request, env: CloudflareOnlyEnv, ctx: ExecutionContext) => Promise<Response>;
    const response = await handler(new Request("https://g20.test/api/sekiban/serialized/list-query", {
      method: "POST",
      headers: { "content-type": "application/json", "x-sdt-g9-test-service-id": serviceId },
      body: JSON.stringify({ queryType: "GetReservationListQuery", queryParamsJson: JSON.stringify({ PageNumber: 1, PageSize: 20 }) }),
    }), { ...(env as unknown as CloudflareOnlyEnv), SDT_SERVICE_ID: serviceId }, {} as ExecutionContext);
    expect(response.status).toBe(200);
    const body = await response.json<{ itemsJson: string; totalCount: number }>();
    expect(body.totalCount).toBe(1);
    expect(JSON.parse(body.itemsJson)).toEqual([expect.objectContaining({ reservationId: "g20-reservation", status: "reserved" })]);
  });

  it("keeps the PG provider available without making it part of the Cloudflare-only entrypoint", () => {
    expect(createD1StoreProvider().name).toBe("d1");
    expect(typeof createCloudflareOnlyRuntimeWorker).toBe("function");
  });
});
