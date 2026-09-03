import { describe, expect, it } from "vitest";

import { processDeliveryCore, type DeliveryViewHandler } from "../packages/dcb-runtime/src/downstream/DeliveryCore";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import type { GlobalReceiptJoin, PipelineStore } from "../packages/dcb-runtime/src/store/types";
import { g32Message, g32StoredEvent } from "./helpers/g32-fixtures";

function message(): DownstreamOutboxMessage {
  return g32Message({
    serviceId: "g60-post-admission-runtime",
    allocatorLineageId: "g60-post-admission-lineage",
    tag: "reservation:g60-post-admission",
    attemptId: "g60-post-admission-attempt",
    eventId: "g60-post-admission-event",
    suid: "g60-post-admission-suid",
    eventType: "G60PostAdmissionFixture",
    eventTags: ["reservation:g60-post-admission"],
  });
}

function storeFor(input: DownstreamOutboxMessage): PipelineStore {
  const receipt: GlobalReceiptJoin = {
    serviceId: input.serviceId,
    eventId: input.eventId,
    partitionTag: input.tag,
    obligationSequence: input.completeness.obligationSequence,
    eventDigest: input.completeness.eventDigest,
    membershipTag: input.tag,
    receivedAt: input.enqueuedAt,
  };
  return {
    initialize: async () => undefined,
    recordDelivery: async (_message, arrivedAt) => ({
      outcome: "stored",
      kind: "stored",
      event: g32StoredEvent(input, arrivedAt),
    }),
    readGlobalReceiptJoin: async () => receipt,
    currentLagBound: async () => 0,
    upsertPending: async (pending, firstObservedAt, lagBoundMs) => ({
      serviceId: pending.serviceId,
      attemptId: pending.attemptId,
      eventId: pending.eventId,
      suid: pending.suid,
      expectedPaths: [...pending.eventTags],
      observedPaths: [...pending.eventTags],
      firstObservedAt,
      lagBoundMs,
    }),
    hasFinding: async () => false,
    appendFinding: async () => undefined,
    listPending: async () => [],
    listFindings: async () => [],
    appendDeliveryIncident: async () => undefined,
    hasDeliveryIncident: async () => false,
    listDeliveryIncidents: async () => [],
    readAllEvents: async () => [],
    listProjectionTags: async () => [],
    readProjectionCheckpoint: async () => undefined,
    advanceProjectionCheckpoint: async () => true,
    projectionLag: async () => ({
      serviceId: input.serviceId,
      projectionId: "g60-post-admission",
      tag: input.tag,
      checkpointSuid: "",
      headSuid: "",
      behindEvents: 0,
    }),
  };
}

function views(): readonly DeliveryViewHandler[] {
  return ["RoomProjector", "ReservationProjector"].map((id) => ({
    id,
    apply: async () => {
      await Promise.resolve();
      return "applied" as const;
    },
  }));
}

describe("SDT-G60 post-admission decomposition", () => {
  it("records delivery-core boundaries without changing the delivery result", async () => {
    const input = message();
    const substeps: Array<Record<string, unknown>> = [];
    const result = await processDeliveryCore(input, "fast", {}, {
      store: storeFor(input),
      clock: { now: () => 2_000 },
      durableHopObserver: {
        observe: () => undefined,
        observeSubstep: (observation) => { substeps.push({ ...observation }); },
      },
      afterGlobalReceipt: async () => undefined,
      beforeViews: async () => undefined,
      views: views(),
    });

    expect(result).toMatchObject({ outcome: "stored", fastDisposition: "completed", detectorApplied: true });
    expect(result.views.map((view) => view.id)).toEqual(["RoomProjector", "ReservationProjector"]);
    expect(substeps.map((observation) => `${observation.stage}:${observation.boundary}`)).toEqual([
      "post-record-delivery-global-receipt-readback:start",
      "post-record-delivery-global-receipt-readback:end",
      "detector:start",
      "detector:end",
      "unsafe-view-apply:start",
      "unsafe-view-apply:start",
      "unsafe-view-apply:end",
      "unsafe-view-apply:end",
    ]);
    expect(substeps.filter((observation) => observation.stage === "unsafe-view-apply").map((observation) => observation.viewId)).toEqual([
      "RoomProjector",
      "ReservationProjector",
      "RoomProjector",
      "ReservationProjector",
    ]);
    expect(substeps.every((observation) => observation.serviceId === input.serviceId && observation.eventId === input.eventId && observation.suid === input.suid && observation.attemptId === input.attemptId)).toBe(true);
    expect(substeps.find((observation) => observation.stage === "detector" && observation.boundary === "end")?.outcome).toBe("applied");
  });

  it("does not let a diagnostic observer failure change delivery", async () => {
    const input = message();
    const result = await processDeliveryCore(input, "fast", {}, {
      store: storeFor(input),
      durableHopObserver: {
        observe: () => undefined,
        observeSubstep: () => { throw new Error("diagnostic sink unavailable"); },
      },
      views: views(),
    });
    expect(result).toMatchObject({ outcome: "stored", fastDisposition: "completed", detectorApplied: true });
    expect(result.failures).toEqual([]);
  });
});
