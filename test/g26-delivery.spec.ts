import { describe, expect, it } from "vitest";
import {
  handleDownstreamQueue,
  processDeliveryCore,
  processDownstreamDoorbell,
  type DeliveryViewHandler,
} from "../packages/dcb-runtime/src/downstream/DownstreamAdapter";
import {
  downstreamEnvelopeBytes,
  preflightDirectDoorbell,
  readDirectDoorbellConfig,
} from "../packages/dcb-runtime/src/downstream/Doorbell";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import type { DeliveryOutcome, PipelineStore, StoredEvent } from "../packages/dcb-runtime/src/store/types";

function message(suffix = "one"): DownstreamOutboxMessage {
  const tag = `g26:${suffix}`;
  return {
    version: 1,
    serviceId: `g26-service-${suffix}`,
    allocatorLineageId: `g26-lineage-${suffix}`,
    tag,
    attemptId: `g26-attempt-${suffix}`,
    eventId: `g26-event-${suffix}`,
    suid: `g26-suid-${suffix}`,
    payload: btoa(JSON.stringify({ eventType: "G26", suffix })),
    eventTags: [tag],
    enqueuedAt: 1_000,
  };
}

function storedEvent(input: DownstreamOutboxMessage): StoredEvent {
  return {
    serviceId: input.serviceId,
    eventId: input.eventId,
    suid: input.suid,
    payload: input.payload,
    eventTags: input.eventTags,
    firstArrivedAt: 1_010,
    lastArrivedAt: 1_010,
    maxDeliveryLagMs: 10,
    arrivals: [],
  };
}

function storeFor(
  input: DownstreamOutboxMessage,
  trace: string[],
  outcome: DeliveryOutcome = { outcome: "stored", kind: "stored", event: storedEvent(input) },
): PipelineStore {
  return {
    initialize: async () => { trace.push("initialize"); },
    recordDelivery: async (_message, _arrivedAt, source) => {
      trace.push(`recordDelivery:${source}`);
      return outcome;
    },
    currentLagBound: async () => { trace.push("lag-bound"); return 0; },
    upsertPending: async (pending) => {
      trace.push("detector");
      return {
        serviceId: pending.serviceId,
        attemptId: pending.attemptId,
        eventId: pending.eventId,
        suid: pending.suid,
        expectedPaths: [pending.tag],
        observedPaths: [pending.tag],
        firstObservedAt: 1_010,
        lagBoundMs: 0,
      };
    },
    hasFinding: async () => false,
    appendFinding: async () => { trace.push("finding"); },
    listFindings: async () => [],
    listPending: async () => [],
    appendDeliveryIncident: async () => {},
    hasDeliveryIncident: async () => false,
    listDeliveryIncidents: async () => [],
    readAllEvents: async () => [],
    listProjectionTags: async () => [],
    readProjectionCheckpoint: async () => undefined,
    advanceProjectionCheckpoint: async () => true,
    projectionLag: async () => ({ serviceId: input.serviceId, projectionId: "g26", tag: input.tag, checkpointSuid: "", headSuid: "", behindEvents: 0 }),
  } as PipelineStore;
}

function view(id: string, trace: string[], apply: DeliveryViewHandler["apply"]): DeliveryViewHandler {
  return { id, apply: async (input) => { trace.push(`view:${id}`); return apply(input); } };
}

describe("SDT-G26 shared delivery core", () => {
  it("keeps the normative record -> gate -> detector -> every view -> drain order", async () => {
    const input = message("order");
    const trace: string[] = [];
    const result = await processDeliveryCore(input, "fast", {}, {
      store: storeFor(input, trace),
      clock: { now: () => 1_010 },
      views: [
        view("head", trace, async () => "applied"),
        view("tail", trace, async () => "applied"),
      ],
      afterDelivery: async () => { trace.push("drain-trigger"); },
    });
    expect(result.fastDisposition).toBe("completed");
    expect(trace).toEqual([
      "initialize",
      "recordDelivery:fast",
      "lag-bound",
      "detector",
      "view:head",
      "view:tail",
      "drain-trigger",
    ]);
  });

  it("gates lineage and SUID incidents before detector, unsafe observation, view, or drain", async () => {
    const cases: Array<{ name: string; outcome: DeliveryOutcome["outcome"]; kind: "SUID_COLLISION" | "LINEAGE_MISMATCH" }> = [
      { name: "collision", outcome: "suid-collision", kind: "SUID_COLLISION" },
      { name: "lineage", outcome: "lineage-mismatch", kind: "LINEAGE_MISMATCH" },
    ];
    for (const item of cases) {
      const input = message(item.name);
      const trace: string[] = [];
      const incident: DeliveryOutcome = {
        outcome: item.outcome,
        kind: item.outcome,
        incident: { serviceId: input.serviceId, identityKey: item.name, classification: item.kind, observedAt: 1_010 },
      } as DeliveryOutcome;
      const result = await processDeliveryCore(input, "queue", {}, {
        store: storeFor(input, trace, incident),
        views: [view("must-not-run", trace, async () => "applied")],
        afterDelivery: async () => { trace.push("drain-trigger"); },
      });
      expect(result.outcome).toBe(item.outcome);
      expect(result.queueDisposition).toBe("ack");
      expect(trace).toEqual(["initialize", "recordDelivery:queue"]);
    }
  });

  it("continues after poison at the head and sends one aggregate retry-to-DLQ decision", async () => {
    const input = message("poison");
    const trace: string[] = [];
    const poison = view("head-poison", trace, async () => {
      const error = new Error("definition is invalid") as Error & { retryable?: boolean };
      error.retryable = false;
      throw error;
    });
    const result = await processDeliveryCore(input, "queue", {}, {
      store: storeFor(input, trace),
      views: [poison, view("middle", trace, async () => "applied"), view("tail", trace, async () => "applied")],
    });
    expect(trace).toEqual(["initialize", "recordDelivery:queue", "lag-bound", "detector", "view:head-poison", "view:middle", "view:tail"]);
    expect(result.views.map((entry) => entry.id)).toEqual(["head-poison", "middle", "tail"]);
    expect(result.failures[0]).toMatchObject({ class: "nonretryable-definition-poison", viewId: "head-poison" });
    expect(result.queueDisposition).toBe("retry-to-dlq");
  });

  it("treats a typed duplicate-race loser as a receipt no-op for both wrappers", async () => {
    const input = message("duplicate-race");
    const duplicate = view("race", [], async () => {
      throw { code: "UNSAFE_DUPLICATE_RACE" };
    });
    const fast = await processDownstreamDoorbell(input, {}, {
      store: storeFor(input, []),
      views: [duplicate],
    });
    expect(fast.fastDisposition).toBe("completed");
    expect(fast.queueDisposition).toBe("ack");
    expect(fast.failures[0]?.class).toBe("duplicate-race");

    let acked = 0;
    let retried = 0;
    const batch = {
      messages: [{
        body: input,
        attempts: 1,
        ack: () => { acked += 1; },
        retry: () => { retried += 1; },
      }],
    } as unknown as MessageBatch<unknown>;
    await handleDownstreamQueue(batch, {}, {
      store: storeFor(input, []),
      views: [duplicate],
    });
    expect(acked).toBe(1);
    expect(retried).toBe(0);
  });

  it("keeps the two transport envelopes byte-identical and protects queue lag from fast samples", async () => {
    const input = message("bytes");
    const queueEnvelope = JSON.parse(downstreamEnvelopeBytes(input)) as DownstreamOutboxMessage;
    const fastEnvelope = JSON.parse(downstreamEnvelopeBytes(input)) as DownstreamOutboxMessage;
    expect(downstreamEnvelopeBytes(queueEnvelope)).toBe(downstreamEnvelopeBytes(fastEnvelope));
    const source: string[] = [];
    const store = storeFor(input, []);
    await store.recordDelivery(input, 1_050, "fast");
    await store.recordDelivery(input, 1_060, "queue");
    // The source is an explicit third internal argument; the concrete D1/PG/
    // Cosmos stores gate estimator writes on this value.
    const recorder = {
      recordDelivery: async (_: DownstreamOutboxMessage, _at: number, deliverySource?: "fast" | "queue") => { source.push(deliverySource ?? "queue"); return { outcome: "stored", kind: "stored", event: storedEvent(input) } as const; },
    };
    await recorder.recordDelivery(input, 1_050, "fast");
    await recorder.recordDelivery(input, 1_060, "queue");
    expect(source).toEqual(["fast", "queue"]);
  });

  it("fails capability preflight explicitly instead of silently degrading", () => {
    const config = readDirectDoorbellConfig({
      DELIVERY_CLASS: "immediate-preferred",
      DIRECT_DOORBELL: "true",
      DIRECT_DOORBELL_ALLOWED_VIEWS: Array.from({ length: 32 }, (_, index) => `View${index}`).join(","),
      DIRECT_DOORBELL_DEGRADATION: "fail-fast",
    });
    const preflight = preflightDirectDoorbell(config);
    expect(preflight.status).toBe("fail-fast");
    expect(preflight.reason).toContain("budget");
    const disabled = preflightDirectDoorbell(readDirectDoorbellConfig({
      DELIVERY_CLASS: "immediate-preferred",
      DIRECT_DOORBELL: "false",
      DIRECT_DOORBELL_DEGRADATION: "queued-degraded",
      DIRECT_DOORBELL_ALLOWED_VIEWS: "RoomProjector",
    }));
    expect(disabled).toMatchObject({ status: "queued-degraded", reason: "deployment_direct_doorbell_disabled" });
  });
});
