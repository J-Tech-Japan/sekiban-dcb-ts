import { describe, expect, it } from "vitest";

import { processDeliveryCore, type DeliveryViewHandler } from "../packages/dcb-runtime/src/downstream/DeliveryCore";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import type { GlobalReceiptJoin, PipelineStore } from "../packages/dcb-runtime/src/store/types";
import { g32Message, g32StoredEvent } from "./helpers/g32-fixtures";

function message(): DownstreamOutboxMessage {
  return g32Message({
    serviceId: "g60-unsafe-writer-runtime",
    allocatorLineageId: "g60-unsafe-writer-lineage",
    tag: "reservation:g60-unsafe-writer",
    attemptId: "g60-unsafe-writer-attempt",
    eventId: "g60-unsafe-writer-event",
    suid: "g60-unsafe-writer-suid",
    eventType: "G60UnsafeWriterFixture",
    eventTags: ["reservation:g60-unsafe-writer"],
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
      projectionId: "g60-unsafe-writer",
      tag: input.tag,
      checkpointSuid: "",
      headSuid: "",
      behindEvents: 0,
    }),
  };
}

describe("SDT-G60 unsafe writer admission", () => {
  it("runs the concrete unsafe lane before a BLOCK gate while gated views remain fenced", async () => {
    const input = message();
    let unsafeApplied = 0;
    let gatedApplied = 0;
    const postAdmission: string[] = [];
    const unsafeView: DeliveryViewHandler = {
      id: "ReservationProjector",
      admission: "independent-unsafe",
      apply: async () => {
        unsafeApplied += 1;
        return "applied";
      },
    };
    const gatedView: DeliveryViewHandler = {
      id: "safe-checkpoint-view",
      apply: async () => {
        gatedApplied += 1;
        return "applied";
      },
    };
    const result = await processDeliveryCore(input, "queue", {}, {
      store: storeFor(input),
      beforeViews: async () => { throw new Error("global_completeness_BLOCK/UNSETTLED:source_partition_set_changed"); },
      durableHopObserver: {
        observe: () => undefined,
        observeSubstep: (observation) => {
          if (observation.stage === "unsafe-view-apply") postAdmission.push(`${observation.viewId}:${observation.boundary}`);
        },
      },
      views: [unsafeView, gatedView],
    });

    expect(unsafeApplied).toBe(1);
    expect(gatedApplied).toBe(0);
    expect(postAdmission).toEqual(["ReservationProjector:start", "ReservationProjector:end"]);
    expect(result).toMatchObject({ outcome: "stored", detectorApplied: false, queueDisposition: "retry-to-dlq" });
    expect(result.views.map((view) => view.id)).toEqual(["ReservationProjector"]);
    expect(result.failures).toEqual([expect.objectContaining({ phase: "completeness" })]);
  });

  it("keeps an unmarked ordinary view behind the existing completeness gate", async () => {
    const input = message();
    let applied = 0;
    const result = await processDeliveryCore(input, "queue", {}, {
      store: storeFor(input),
      beforeViews: async () => { throw new Error("global_completeness_BLOCK/UNSETTLED:fixture"); },
      views: [{ id: "ordinary-view", apply: async () => { applied += 1; return "applied"; } }],
    });
    expect(applied).toBe(0);
    expect(result.views).toEqual([]);
    expect(result.failures).toEqual([expect.objectContaining({ phase: "completeness" })]);
  });
});
