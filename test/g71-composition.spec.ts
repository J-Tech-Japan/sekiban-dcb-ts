import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
// @ts-expect-error Vite raw migration import.
import pipelineMigration from "../migrations/d1/g32/0001_dcb_events.sql?raw";
// @ts-expect-error Vite raw migration import.
import mvMigration from "../migrations/mv/0001_materialized_views.sql?raw";
// @ts-expect-error Vite raw migration import.
import unsafeMvMigration from "../migrations/mv/0002_unsafe_window_materialized_views.sql?raw";
// @ts-expect-error Vite raw migration import.
import hardeningMvMigration from "../migrations/mv/0003_checkpoint_ahead_hardening.sql?raw";
// @ts-expect-error Vite raw migration import.
import unsafeFailureMvMigration from "../migrations/mv/0004_unsafe_window_failure_findings.sql?raw";
// @ts-expect-error Vite raw migration import.
import g31WaitReceiptMigration from "../migrations/mv/0005_g31_wait_receipts.sql?raw";
// @ts-expect-error Vite raw migration import.
import g31WaitPoisonMigration from "../migrations/mv/0006_g31_wait_target_poison.sql?raw";
// @ts-expect-error Vite raw migration import.
import orderingQuarantineMigration from "../migrations/mv/0007_g69_ordering_quarantine.sql?raw";
// @ts-expect-error Vite raw migration import.
import rebuildVerificationMigration from "../migrations/mv/0008_g69_rebuild_verification.sql?raw";
// @ts-expect-error Vite raw migration import.
import rebuildProofMigration from "../migrations/mv/0009_g69_rebuild_proof.sql?raw";
import { createSekibanExecutor } from "../packages/dcb-client/src";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { createCloudflareOnlyRuntimeWorker, scopeIdFor, TEST_SERVICE_ID_HEADER } from "../packages/dcb-runtime/src/cloudflare";
import { createV1Transport } from "../samples/meeting-room/src/transport";
import meetingRoomWorker, { scheduleMeetingRoomSafeLaneKick } from "../samples/meeting-room/src/worker.cloudflare-only";
import { meetingRoomDomain, meetingRoomRuntimeConfig, reservationTag, roomTag } from "../samples/meeting-room/src/domain";
import { applyG44D1Migration } from "./helpers/g44-d1-migration";

const COMPOSITION_ORACLE = "G71 composition: safe and unsafe pages diverge while SafeWindow holds";

function statements(database: D1Database, sql: string): D1PreparedStatement[] {
  return sql.replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => database.prepare(statement));
}

function mvDatabase(): D1Database {
  const database = (env as unknown as { D1_MV?: D1Database }).D1_MV;
  if (database === undefined) throw new Error("G71 composition requires the D1_MV binding");
  return database;
}

function tagStub(serviceId: string, tag: string): DurableObjectStub {
  const namespace = (env as unknown as { TAG?: DurableObjectNamespace }).TAG;
  if (namespace === undefined) throw new Error("G71 composition requires the Tag Durable Object binding");
  return namespace.get(scopeIdFor(namespace, { serviceId, doClass: "tag", identity: tag }));
}

async function disableTagAutoDrain(serviceId: string, tag: string): Promise<void> {
  await runInDurableObject(tagStub(serviceId, tag), (instance) => {
    const runtime = instance as unknown as { env: { AUTO_DRAIN_OUTBOX?: string } };
    runtime.env.AUTO_DRAIN_OUTBOX = "false";
  });
}

async function pendingTagDelivery(serviceId: string, tag: string, nowMs: number): Promise<DownstreamOutboxMessage[]> {
  const response = await tagStub(serviceId, tag).fetch(new Request(
    `https://tag.test/outbox/pending?__tag=${encodeURIComponent(tag)}&__serviceId=${encodeURIComponent(serviceId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nowMs, force: true, limit: 32 }),
    },
  ));
  if (!response.ok) throw new Error(`G71 composition pending outbox failed: ${response.status}`);
  const body = await response.json<{ rows?: DownstreamOutboxMessage[] }>();
  return body.rows ?? [];
}

function environment(serviceId: string): Record<string, unknown> {
  return {
    ...(env as unknown as Record<string, unknown>),
    SDT_SERVICE_ID: serviceId,
    D1: (env as unknown as { D1: D1Database }).D1,
    D1_MV: mvDatabase(),
    G32_COMPONENT: "primary",
    CONFORMANCE_TOKEN: "g71-local-conformance",
    AUTO_DRAIN_OUTBOX: "false",
  };
}

interface QueueInvocation {
  readonly acked: number;
  readonly retried: number;
  readonly waits: readonly Promise<unknown>[];
}

async function invokeSampleQueue(
  messages: readonly DownstreamOutboxMessage[],
  requestEnvironment: Record<string, unknown>,
  arrivedAt: number,
): Promise<QueueInvocation> {
  let acked = 0;
  let retried = 0;
  const waits: Promise<unknown>[] = [];
  const queue = meetingRoomWorker.queue as unknown as (
    batch: MessageBatch<unknown>,
    inputEnvironment: Record<string, unknown>,
    ctx: ExecutionContext,
  ) => Promise<void>;
  await queue({
    messages: messages.map((body) => ({
      body,
      id: body.attemptId,
      timestamp: new Date(arrivedAt),
      attempts: 1,
      ack: () => { acked += 1; },
      retry: () => { retried += 1; },
    })),
  } as unknown as MessageBatch<unknown>, requestEnvironment, {
    waitUntil: (promise: Promise<unknown>) => { waits.push(promise); },
  } as unknown as ExecutionContext);
  return { acked, retried, waits };
}

interface CommitResult {
  readonly eventId: string;
  readonly suid: string;
  readonly roomId: string;
  readonly reservationId: string;
}

async function commitReservation(
  serviceId: string,
  roomId: string,
  reservationId: string,
): Promise<CommitResult> {
  const room = roomTag(roomId).id;
  const reservation = reservationTag(reservationId).id;
  await disableTagAutoDrain(serviceId, room);
  await disableTagAutoDrain(serviceId, reservation);
  const response = await SELF.fetch("https://g71.test/api/sekiban/serialized/commit", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [TEST_SERVICE_ID_HEADER]: serviceId,
    },
    body: JSON.stringify({
      version: 1,
      eventCandidates: [{
        payload: btoa(JSON.stringify({ roomId, reservationId, userId: "g71-composition-user" })),
        eventPayloadName: "RoomReserved",
        tags: [room, reservation],
      }],
      consistencyTags: [
        { tag: room, lastSortableUniqueId: "" },
        { tag: reservation, lastSortableUniqueId: "" },
      ],
    }),
  });
  const body = await response.json<{ writtenEvents?: Array<{ id: string; sortableUniqueIdValue: string }> }>();
  expect(response.status, JSON.stringify(body)).toBe(200);
  const written = body.writtenEvents?.[0];
  if (written === undefined) throw new Error("G71 composition commit returned no written event");
  return { eventId: written.id, suid: written.sortableUniqueIdValue, roomId, reservationId };
}

async function deliveriesFor(commit: CommitResult, serviceId: string, nowMs: number): Promise<DownstreamOutboxMessage[]> {
  const queued = [
    ...(await pendingTagDelivery(serviceId, roomTag(commit.roomId).id, nowMs)),
    ...(await pendingTagDelivery(serviceId, reservationTag(commit.reservationId).id, nowMs)),
  ];
  expect(new Set(queued.map((message) => message.eventId))).toEqual(new Set([commit.eventId]));
  expect(queued).toHaveLength(2);
  return queued;
}

interface ListPage {
  readonly itemsJson: string;
  readonly totalCount: number;
  readonly totalPages: number;
  readonly currentPage: number;
  readonly pageSize: number;
  readonly readHead?: string;
}

function rows(page: ListPage): Array<{ reservationId?: string; status?: string }> {
  return JSON.parse(page.itemsJson) as Array<{ reservationId?: string; status?: string }>;
}

async function sampleUnsafePage(
  serviceId: string,
  requestEnvironment: Record<string, unknown>,
  pageNumber: number,
): Promise<ListPage> {
  const waits: Promise<unknown>[] = [];
  const fetch = meetingRoomWorker.fetch as unknown as (
    request: Request,
    inputEnvironment: Record<string, unknown>,
    ctx: ExecutionContext,
  ) => Promise<Response>;
  const response = await fetch(new Request(
    `https://g71.test/api/read/reservations?pageNumber=${pageNumber}&pageSize=20`,
    { method: "GET" },
  ), requestEnvironment, {
    waitUntil: (promise: Promise<unknown>) => { waits.push(promise); },
  } as unknown as ExecutionContext);
  await Promise.all(waits);
  const body = await response.json<ListPage & { error?: string }>();
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(body.currentPage).toBe(pageNumber);
  expect(body.pageSize).toBe(20);
  expect(serviceId.length).toBeGreaterThan(0);
  return body;
}

async function safePage(
  serviceId: string,
  requestEnvironment: Record<string, unknown>,
  pageNumber: number,
): Promise<ListPage> {
  const runtime = createCloudflareOnlyRuntimeWorker({ domain: meetingRoomDomain, config: meetingRoomRuntimeConfig });
  const runtimeFetch = runtime.fetch as unknown as (
    request: Request,
    inputEnvironment: Record<string, unknown>,
    ctx: ExecutionContext,
  ) => Promise<Response>;
  const transport = createV1Transport({
    fetch: (input, init) => runtimeFetch(new Request(input, init), requestEnvironment, {
      waitUntil: () => undefined,
    } as unknown as ExecutionContext),
  }, serviceId);
  const executor = createSekibanExecutor(transport, { serviceId });
  return executor.listQuery({
    queryType: "GetReservationListQuery",
    queryParamsJson: JSON.stringify({ PageNumber: pageNumber, PageSize: 20 }),
  }, { consistency: "safe" });
}

beforeAll(async () => {
  const database = (env as unknown as { D1?: D1Database }).D1;
  if (database === undefined) throw new Error("G71 composition requires the D1 pipeline binding");
  await database.batch(statements(database, pipelineMigration as string));
  await applyG44D1Migration(database);
  for (const migration of [
    mvMigration,
    unsafeMvMigration,
    hardeningMvMigration,
    unsafeFailureMvMigration,
    g31WaitReceiptMigration,
    g31WaitPoisonMigration,
    orderingQuarantineMigration,
    rebuildVerificationMigration,
    rebuildProofMigration,
  ]) {
    await mvDatabase().batch(statements(mvDatabase(), migration as string));
  }
});

describe("SDT-G71 Cloudflare-only composition", () => {
  it(COMPOSITION_ORACLE, async () => {
    const serviceId = `g71-composition-${crypto.randomUUID()}`;
    const requestEnvironment = environment(serviceId);
    const clock = vi.spyOn(Date, "now");
    const firstCommittedAt = 2_000_000;
    const firstDeliveredAt = firstCommittedAt + 100;
    const firstSafeAt = firstCommittedAt + 60_000;
    const secondCommittedAt = firstSafeAt + 60_000;
    const secondDeliveredAt = secondCommittedAt + 100;
    const secondSafeAt = secondCommittedAt + 60_000;
    try {
      clock.mockReturnValue(firstCommittedAt);
      const commitA = await commitReservation(serviceId, "g71-room-a", "g71-reservation-a");
      clock.mockReturnValue(firstDeliveredAt);
      const firstQueue = await invokeSampleQueue(
        await deliveriesFor(commitA, serviceId, firstDeliveredAt),
        requestEnvironment,
        firstDeliveredAt,
      );
      expect(firstQueue.acked + firstQueue.retried).toBe(2);
      clock.mockReturnValue(firstSafeAt);
      await Promise.all(firstQueue.waits);
      const firstReleaseWaits: Promise<unknown>[] = [];
      scheduleMeetingRoomSafeLaneKick(requestEnvironment as never, serviceId, {
        waitUntil: (promise: Promise<unknown>) => { firstReleaseWaits.push(promise); },
      } as unknown as ExecutionContext);
      await Promise.all(firstReleaseWaits);

      const firstSafePage = await safePage(serviceId, requestEnvironment, 1);
      expect(rows(firstSafePage)).toEqual([expect.objectContaining({ reservationId: commitA.reservationId, status: "reserved" })]);
      expect(firstSafePage.readHead).toBe(commitA.suid);

      clock.mockReturnValue(secondCommittedAt);
      const commitB = await commitReservation(serviceId, "g71-room-b", "g71-reservation-b");
      expect(commitB.suid).not.toBe(commitA.suid);
      clock.mockReturnValue(secondDeliveredAt);
      const secondQueue = await invokeSampleQueue(
        await deliveriesFor(commitB, serviceId, secondDeliveredAt),
        requestEnvironment,
        secondDeliveredAt,
      );
      expect(secondQueue.acked + secondQueue.retried).toBe(2);
      await Promise.all(secondQueue.waits);

      const heldUnsafePage1 = await sampleUnsafePage(serviceId, requestEnvironment, 1);
      expect(rows(heldUnsafePage1)).toEqual(expect.arrayContaining([
        expect.objectContaining({ reservationId: commitA.reservationId, status: "reserved" }),
        expect.objectContaining({ reservationId: commitB.reservationId, status: "reserved" }),
      ]));
      expect(rows(heldUnsafePage1)).toHaveLength(2);
      expect(heldUnsafePage1.readHead).toBe(commitB.suid);

      const heldSafePage1 = await safePage(serviceId, requestEnvironment, 1);
      expect(rows(heldSafePage1)).toEqual([expect.objectContaining({ reservationId: commitA.reservationId, status: "reserved" })]);
      expect(heldSafePage1.readHead).toBe(commitA.suid);

      const heldSafePage2 = await safePage(serviceId, requestEnvironment, 2);
      expect(rows(heldSafePage2)).toEqual([]);
      expect(heldSafePage2.readHead).toBe(commitA.suid);

      const heldUnsafePage2 = await sampleUnsafePage(serviceId, requestEnvironment, 2);
      expect(rows(heldUnsafePage2)).toEqual([]);
      expect(heldUnsafePage2.readHead).not.toBe(commitA.suid);

      // The second Queue delivery registered the real SafeWindow follow-up.
      // This explicit production scheduler kick supplies the same logical
      // clock release without a wall-clock sleep or a test timeout.
      clock.mockReturnValue(secondSafeAt);
      const releaseWaits: Promise<unknown>[] = [];
      scheduleMeetingRoomSafeLaneKick(requestEnvironment as never, serviceId, {
        waitUntil: (promise: Promise<unknown>) => { releaseWaits.push(promise); },
      } as unknown as ExecutionContext);
      await Promise.all(releaseWaits);

      const releasedSafePage = await safePage(serviceId, requestEnvironment, 1);
      expect(rows(releasedSafePage)).toEqual(expect.arrayContaining([
        expect.objectContaining({ reservationId: commitA.reservationId, status: "reserved" }),
        expect.objectContaining({ reservationId: commitB.reservationId, status: "reserved" }),
      ]));
      expect(rows(releasedSafePage)).toHaveLength(2);
      expect(releasedSafePage.readHead).toBe(commitB.suid);
      expect(releasedSafePage.readHead).toBe(heldUnsafePage1.readHead);

      console.log(`G71_COMPOSITION_PROOF ${JSON.stringify({
        serviceId,
        commitA: { eventId: commitA.eventId, suid: commitA.suid },
        commitB: { eventId: commitB.eventId, suid: commitB.suid },
        held: {
          unsafePage1: { rows: rows(heldUnsafePage1), readHead: heldUnsafePage1.readHead },
          safePage1: { rows: rows(heldSafePage1), readHead: heldSafePage1.readHead },
          safePage2: { rows: rows(heldSafePage2), readHead: heldSafePage2.readHead },
          unsafePage2: { rows: rows(heldUnsafePage2), readHead: heldUnsafePage2.readHead },
        },
        released: { rows: rows(releasedSafePage), readHead: releasedSafePage.readHead },
      })}`);
    } finally {
      clock.mockRestore();
    }
  }, 10_000);
});
