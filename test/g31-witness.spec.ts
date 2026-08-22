import { describe, expect, it } from "vitest";
import {
  assertFinalWitnessIdentity,
  assertSourceCommit,
  assertWitnessStable,
  shouldRetryConformanceStatus,
} from "../scripts/deploy/g31-witness.mjs";
import { summarizeMeasurements } from "../scripts/deploy/g31-measure.mjs";
// @ts-expect-error JavaScript topology CLI is exercised directly by Vitest.
import { assertPrimaryConsumerExclusive, needsReceiverConsumerRemoval } from "../scripts/deploy/g31-receiver-consumer-topology.mjs";
// @ts-expect-error Vite raw receiver deployment config fixture.
import receiverDeployConfigText from "../samples/meeting-room/wrangler.meeting-room-doorbell-production.jsonc?raw";
// @ts-expect-error Vite raw primary deployment config fixture.
import primaryDeployConfigText from "../samples/meeting-room/wrangler.cloudflare-only-doorbell.jsonc?raw";
// @ts-expect-error Vite raw deployment script fixture.
import deployScriptText from "../scripts/deploy/g31-deploy-witness.sh?raw";
// @ts-expect-error Vite raw measurement fixture.
import measureScriptText from "../scripts/deploy/g31-measure.mjs?raw";

const expected = {
  worker: "sekiban-dcb-meeting-room-cloudflare-only",
  serviceId: "g25-38219c8-20260820f",
  pipelineDatabaseId: "3c3b1641-7969-4d72-97a9-2ea65085c9bb",
  materializedViewDatabaseId: "5db45136-f1dd-4f4d-bfe3-b6328193a1ac",
  queue: "sekiban-dcb-meeting-room-cloudflare-outbox",
  generation: "v2",
  waitFor: {
    sourceTarget: "unique-indexed-point-read",
    activeReceipt: "generation-definition-bound",
    safeHead: "unique-source-required",
    maxPointReads: 252,
  },
  directDoorbell: true,
  allowedViews: ["RoomProjector", "ReservationProjector"],
};

function witness() {
  return {
    ...expected,
    endpoint: "/conformance/v1/g31-config",
    identitySource: "remote-g31-conformance",
    identityVerified: true,
    sourceCommit: "c".repeat(40),
    data: {
      digest: "data-witness",
      roomQuery: { status: 200, body: { resultJson: "{\"count\":1,\"scope\":\"fixture\",\"nested\":{\"count\":7}}" } },
      reservationList: { status: 200, body: { itemsJson: "[{\"reservationId\":\"fixture-reservation\",\"roomId\":\"fixture-room\",\"status\":\"reserved\",\"version\":1}]", totalCount: 1, currentPage: 1, pageSize: 100 } },
      knownRooms: [{ roomId: "fixture-room", status: 200, body: { state: { roomId: "fixture-room", status: "created" }, lastSortedUniqueId: "suid-room" } }],
      knownReservations: [{ reservationId: "fixture-reservation", status: 200, body: { state: { reservationId: "fixture-reservation", status: "reserved" }, lastSortedUniqueId: "suid-reservation" } }],
      eventHeads: { rooms: { "fixture-room": "suid-room" }, reservations: { "fixture-reservation": "suid-reservation" } },
    },
    rawV1: { status: 404 },
  };
}

function publicPreWitness() {
  return {
    capturedAt: "2026-08-22T00:00:00.000Z",
    endpoint: null,
    identitySource: "public-pre-deploy-data",
    identityVerified: false,
    sourceCommit: null,
    data: structuredClone(witness().data),
    rawV1: { status: 404 },
  };
}

describe("SDT-G31 witnessed deployment and one-list-redraw oracles", () => {
  it("preserves the pre-captured witness set and requires the authenticated final-C source identity", () => {
    expect(assertWitnessStable(witness(), witness(), expected).stable).toBe(true);
    expect(assertWitnessStable(publicPreWitness(), witness(), expected).stable).toBe(true);
    const added = witness();
    added.data.reservationList.body.itemsJson = "[{\"reservationId\":\"fixture-reservation\",\"roomId\":\"fixture-room\",\"status\":\"reserved\",\"version\":1},{\"reservationId\":\"post\",\"roomId\":\"post-room\",\"status\":\"reserved\",\"version\":1}]";
    added.data.reservationList.body.totalCount = 2;
    added.data.roomQuery.body.resultJson = "{\"count\":2,\"scope\":\"fixture\",\"nested\":{\"count\":7}}";
    expect(assertWitnessStable(witness(), added, expected).dataPreservation.countDelta.reservations).toBe(1);
    const missing = witness();
    missing.data.reservationList.body.itemsJson = "[]";
    expect(() => assertWitnessStable(witness(), missing, expected)).toThrow("reservation list missing");
    const changedHead = witness();
    changedHead.data.eventHeads.rooms["fixture-room"] = "suid-changed";
    expect(() => assertWitnessStable(witness(), changedHead, expected)).toThrow("event heads changed");
    expect(() => assertWitnessStable(publicPreWitness(), { ...witness(), sourceCommit: "d".repeat(40) }, expected)).not.toThrow();
    expect(assertFinalWitnessIdentity("c".repeat(40), publicPreWitness(), witness())).toMatchObject({ match: true });
    expect(() => assertFinalWitnessIdentity("d".repeat(40), publicPreWitness(), witness())).toThrow("sourceCommit mismatch");
    expect(assertSourceCommit(witness(), "c".repeat(40))).toEqual({ sourceCommit: "c".repeat(40), match: true });
    expect(() => assertSourceCommit(witness(), "d".repeat(40))).toThrow("sourceCommit mismatch");
    expect(shouldRetryConformanceStatus(403)).toBe(true);
    expect(shouldRetryConformanceStatus(404)).toBe(true);
    expect(shouldRetryConformanceStatus(500)).toBe(false);
  });

  it("records fixed N timing as one commit response to one list redraw and requires a post-GC old SUID proof", () => {
    const values = Array.from({ length: 10 }, (_, index) => ({
      index,
      roomId: `room-${index}`,
      reservationId: `reservation-${index}`,
      commitSuid: `suid-${index}`,
      commandStartAt: "2026-08-22T00:00:00.000Z",
      responseAt: "2026-08-22T00:00:01.000Z",
      listRequestStartedAt: "2026-08-22T00:00:01.000Z",
      listRenderedAt: "2026-08-22T00:00:01.100Z",
      commandStartToResponseMs: 1000 + index,
      responseToListRedrawMs: 100 + index,
      commandStartToListRedrawMs: 1100 + index,
      commandStatus: 200,
      commandKind: "committed",
      listStatus: 200,
      listCode: null,
    }));
    const summary = summarizeMeasurements(values);
    expect(summary.sampleCount).toBe(10);
    expect(summary.responseToListRedrawMs.p50).toBe(104);
    expect(summary.commandStartToListRedrawMs.p50).toBe(1104);
    expect(summary.errorCount).toBe(0);
    expect(summary.statusRaw).toHaveLength(10);
    expect(measureScriptText).toContain("waitForSortableUniqueId=${encodeURIComponent(suid)}");
    expect(measureScriptText).toContain("source-target-plus-active-safe-head success after target receipt GC");
    expect(measureScriptText).not.toContain("while (performance.now() - started <= timeoutMs) {\n    for");
  });

  it("retains the service-binding-only receiver and sealed final-C witness order", () => {
    const receiverConfig = JSON.parse(receiverDeployConfigText);
    const primaryConfig = JSON.parse(primaryDeployConfigText);
    expect(receiverConfig.queues).toBeUndefined();
    expect(primaryConfig.queues.consumers).toHaveLength(1);
    expect(deployScriptText).toContain("G31_SOURCE_COMMIT must equal the sealed checked-out final candidate");
    expect(deployScriptText).toContain("--mode pre-deploy-public");
    expect(deployScriptText).toContain('--secrets-file "${SECRETS_FILE}"');
    expect(deployScriptText).toContain('--source-commit "${SOURCE_COMMIT}"');
    expect(deployScriptText).toContain("g31-receiver-consumer-topology.mjs");
    expect(deployScriptText).not.toContain("G31_ACCEPT_DEPLOYED_C");
    expect(deployScriptText).not.toContain("secret put CONFORMANCE_TOKEN");
    const receiver = "sekiban-dcb-meeting-room-doorbell";
    const primary = "sekiban-dcb-meeting-room-cloudflare-only";
    expect(needsReceiverConsumerRemoval([{ script: receiver }, { script: primary }], receiver, primary)).toBe(true);
    expect(assertPrimaryConsumerExclusive([{ script: primary }], receiver, primary).consumerCount).toBe(1);
    expect(() => assertPrimaryConsumerExclusive([{ script: receiver }, { script: primary }], receiver, primary)).toThrow("must not be a Queue consumer");
  });
});
