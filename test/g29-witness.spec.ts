import { describe, expect, it } from "vitest";
import { assertFinalWitnessIdentity, assertSourceCommit, assertWitnessStable, shouldRetryConformanceStatus } from "../scripts/deploy/g29-witness.mjs";
import { summarizeMeasurements } from "../scripts/deploy/g29-measure.mjs";
// @ts-expect-error JavaScript topology CLI is exercised directly by Vitest.
import { assertPrimaryConsumerExclusive, needsReceiverConsumerRemoval } from "../scripts/deploy/g29-receiver-consumer-topology.mjs";
// @ts-expect-error Vite raw receiver deployment config fixture.
import receiverDeployConfigText from "../samples/meeting-room/wrangler.meeting-room-doorbell-production.jsonc?raw";
// @ts-expect-error Vite raw primary deployment config fixture.
import primaryDeployConfigText from "../samples/meeting-room/wrangler.cloudflare-only-doorbell.jsonc?raw";
// @ts-expect-error Vite raw deployment script fixture.
import deployScriptText from "../scripts/deploy/g29-deploy-witness.sh?raw";

const expected = {
  worker: "sekiban-dcb-meeting-room-cloudflare-only",
  serviceId: "g25-38219c8-20260820f",
  viewCount: 2,
  allowedViews: ["RoomProjector", "ReservationProjector"],
  domainDeliveryClass: "immediate-preferred",
  resolvedDeliveryClass: "immediate-preferred",
  domainViewDeliveryClasses: { RoomProjector: "immediate-preferred", ReservationProjector: "immediate-preferred" },
  directDoorbell: true,
  receiverMode: "separate",
  degradation: "queued-degraded",
  maxServiceBindingInvocations: 32,
  pipelineDatabaseId: "REPLACE_WITH_SAMPLE_DOORBELL_PIPELINE_D1_ID",
  materializedViewDatabaseId: "REPLACE_WITH_SAMPLE_DOORBELL_MV_D1_ID",
  queue: "sekiban-dcb-meeting-room-cloudflare-outbox",
  generation: "v2",
};

function witness() {
  return {
    ...expected,
    endpoint: "/conformance/v1/g29-config",
    identitySource: "remote-g29-conformance",
    identityVerified: true,
    sourceCommit: "c".repeat(40),
    data: {
      digest: "data-witness",
      listQuery: { status: 200, body: { resultJson: "{\"count\":1,\"scope\":\"fixture\",\"nested\":{\"count\":7}}" } },
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

describe("SDT-G29 witnessed deploy and measurement oracles", () => {
  it("requires stable topology, raw V1 closure, and preservation of the pre-captured witness set", () => {
    expect(assertWitnessStable(witness(), witness(), expected).stable).toBe(true);
    expect(() => assertWitnessStable({ ...witness(), serviceId: "fresh-service" }, witness(), expected)).toThrow("serviceId");
    const added = witness();
    added.data.reservationList.body.itemsJson = "[{\"reservationId\":\"fixture-reservation\",\"roomId\":\"fixture-room\",\"status\":\"reserved\",\"version\":1},{\"reservationId\":\"post-probe\",\"roomId\":\"post-room\",\"status\":\"reserved\",\"version\":1}]";
    added.data.reservationList.body.totalCount = 2;
    added.data.listQuery.body.resultJson = "{\"count\":2,\"scope\":\"fixture\",\"nested\":{\"count\":7}}";
    expect(assertWitnessStable(witness(), added, expected).dataPreservation.countDelta.reservations).toBe(1);
    const missing = witness();
    missing.data.reservationList.body.itemsJson = "[]";
    expect(() => assertWitnessStable(witness(), missing, expected)).toThrow("reservation list missing");
    const changedHead = witness();
    changedHead.data.eventHeads.rooms["fixture-room"] = "suid-changed";
    expect(() => assertWitnessStable(witness(), changedHead, expected)).toThrow("event heads changed");
    const changedNestedCount = witness();
    changedNestedCount.data.listQuery.body.resultJson = "{\"count\":1,\"scope\":\"fixture\",\"nested\":{\"count\":8}}";
    expect(() => assertWitnessStable(witness(), changedNestedCount, expected)).toThrow("list query changed");
    const missingItems = witness();
    Reflect.deleteProperty(missingItems.data.reservationList.body, "itemsJson");
    expect(() => assertWitnessStable(witness(), missingItems, expected)).toThrow("items are missing");
    expect(() => assertWitnessStable(witness(), { ...witness(), rawV1: { status: 200 } }, expected)).toThrow("public V1");
    expect(() => assertWitnessStable({ ...witness(), identityVerified: false }, witness(), expected)).toThrow("pre-witness");
    expect(assertSourceCommit(witness(), "c".repeat(40))).toEqual({ sourceCommit: "c".repeat(40), match: true });
    expect(() => assertSourceCommit(witness(), "d".repeat(40))).toThrow("sourceCommit mismatch");
  });

  it("preserves a public pre-witness set and requires the authenticated final-C G29 post-witness", () => {
    const pre = publicPreWitness();
    expect(assertWitnessStable(pre, witness(), expected).stable).toBe(true);
    expect(() => assertWitnessStable({ ...pre, identitySource: "untrusted" }, witness(), expected)).toThrow("before");
    expect(() => assertWitnessStable(pre, { ...witness(), identityVerified: false }, expected)).toThrow("post-witness");
    expect(assertFinalWitnessIdentity("c".repeat(40), pre, witness())).toEqual({ preIdentitySource: "public-pre-deploy-data", postSourceCommit: "c".repeat(40), match: true });
    expect(() => assertFinalWitnessIdentity("c".repeat(40), { ...pre, endpoint: "/conformance/v1/g26-config" }, witness())).toThrow("pre-witness");
    expect(() => assertFinalWitnessIdentity("d".repeat(40), pre, witness())).toThrow("sourceCommit mismatch");
    expect(shouldRetryConformanceStatus(403)).toBe(true);
    expect(shouldRetryConformanceStatus(404)).toBe(true);
    expect(shouldRetryConformanceStatus(200)).toBe(false);
    expect(shouldRetryConformanceStatus(500)).toBe(false);
  });

  it("keeps three timing distributions and status/fallback raw evidence", () => {
    const values = Array.from({ length: 10 }, (_, index) => ({
      commandStartToResponseMs: 1200 + index,
      responseToVisibleMs: 100 + index,
      commandStartToVisibleMs: 1300 + index,
      status: 200,
      kind: "committed",
      fallback: false,
    }));
    const summary = summarizeMeasurements(values);
    expect(summary.sampleCount).toBe(10);
    expect(summary.commandStartToResponseMs.samples).toBe(10);
    expect(summary.responseToVisibleMs.p50).toBe(104);
    expect(summary.commandStartToVisibleMs.p50).toBe(1304);
    expect(summary.errorCount).toBe(0);
    expect(summary.fallbackCount).toBe(0);
    expect(summary.statusRaw).toHaveLength(10);
  });

  it("keeps the Queue consumer on the primary and deploys the receiver with no consumer block", () => {
    const receiverDeployConfig = JSON.parse(receiverDeployConfigText);
    const primaryConfig = JSON.parse(primaryDeployConfigText);
    expect(receiverDeployConfig.queues).toBeUndefined();
    expect(primaryConfig.queues.consumers).toHaveLength(1);
    expect(deployScriptText).toContain("wrangler.meeting-room-doorbell-production.jsonc");
    expect(deployScriptText).toContain('--cwd "${D1_CONFIG_DIR}" --config "${D1_CONFIG}" --remote');
    expect(deployScriptText).not.toContain("--config samples/meeting-room/wrangler.cloudflare-only.jsonc --remote");
    expect(deployScriptText).not.toContain("G29_ACCEPT_DEPLOYED_C");
    expect(deployScriptText).toContain('--primary-deploy-mode "deployed-final-c"');
    expect(deployScriptText).toContain("--mode pre-deploy-public");
    expect(deployScriptText).toContain('--secrets-file "${SECRETS_FILE}"');
    expect(deployScriptText).not.toContain("secret put CONFORMANCE_TOKEN");
    expect(deployScriptText).toContain("--conformance-retry-attempts 15 --conformance-retry-delay-ms 1000");
    const primary = "sekiban-dcb-meeting-room-cloudflare-only";
    const receiver = "sekiban-dcb-meeting-room-doorbell";
    expect(needsReceiverConsumerRemoval([{ script: receiver }, { script: primary }], receiver, primary)).toBe(true);
    expect(assertPrimaryConsumerExclusive([{ script: primary }], receiver, primary).consumerCount).toBe(1);
    expect(() => assertPrimaryConsumerExclusive([{ script: receiver }, { script: primary }], receiver, primary)).toThrow("must not be a Queue consumer");
  });

});
