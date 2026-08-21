import { describe, expect, it } from "vitest";
// @ts-expect-error Vite raw source import for the atomic-batch guard oracle.
import unsafeWindowSource from "../packages/dcb-runtime/src/mv/UnsafeWindowMaterializedView.ts?raw";
// @ts-expect-error Vite raw source import for the Tag/Queue separation oracle.
import downstreamAdapterSource from "../packages/dcb-runtime/src/downstream/DownstreamAdapter.ts?raw";
import {
  handleDownstreamQueue,
  processDeliveryCore,
  processDownstreamDoorbell,
  type DeliveryViewHandler,
} from "../packages/dcb-runtime/src/downstream/DownstreamAdapter";
import {
  classifyDirectDoorbellFailure,
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

  it("classifies every direct failure boundary and keeps self-binding proof behind the budget preflight", () => {
    expect(classifyDirectDoorbellFailure({ status: 503 })).toBe("non-2xx");
    expect(classifyDirectDoorbellFailure(new Error("receiver timeout"))).toBe("timeout");
    expect(classifyDirectDoorbellFailure({ name: "AbortError" })).toBe("cancel");
    expect(classifyDirectDoorbellFailure(new Error("receiver threw"))).toBe("throw");
    const self = readDirectDoorbellConfig({
      DELIVERY_CLASS: "immediate-preferred",
      DIRECT_DOORBELL: "true",
      DIRECT_DOORBELL_ALLOWED_VIEWS: "RoomProjector",
      DIRECT_DOORBELL_RECEIVER_MODE: "self",
      DIRECT_DOORBELL_DEGRADATION: "fail-fast",
    });
    expect(preflightDirectDoorbell(self).status).toBe("fail-fast");
    const proof = readDirectDoorbellConfig({
      DELIVERY_CLASS: "immediate-preferred",
      DIRECT_DOORBELL: "true",
      DIRECT_DOORBELL_ALLOWED_VIEWS: "RoomProjector",
      DIRECT_DOORBELL_RECEIVER_MODE: "self",
      DIRECT_DOORBELL_SELF_BINDING_PROOF: "true",
      DIRECT_DOORBELL_DEGRADATION: "fail-fast",
    });
    expect(preflightDirectDoorbell(proof).status).toBe("ready");
  });

  it("preserves the four cancellation prefixes through replay and never moves kick out of the MV batch", async () => {
    const coreSource = unsafeWindowSource as string;
    const adapterSource = downstreamAdapterSource as string;
    const applyStart = coreSource.indexOf("async apply(input");
    const kick = coreSource.indexOf("INSERT INTO mv_unsafe_kicks", applyStart);
    const batch = coreSource.indexOf("await this.database.batch(statements)", applyStart);
    expect(applyStart).toBeGreaterThanOrEqual(0);
    expect(kick).toBeGreaterThan(applyStart);
    expect(kick).toBeLessThan(batch);
    expect(coreSource.slice(kick, batch)).not.toMatch(/\.run\(/);
    expect(adapterSource).not.toMatch(/DOWNSTREAM_DOORBELL.*recordDelivery|recordDelivery.*DOWNSTREAM_DOORBELL/s);

    const boundaries = [
      async () => {
        const input = message("before-record");
        const trace: string[] = [];
        const store = storeFor(input, trace);
        store.recordDelivery = async () => { throw new Error("cancel-before-record"); };
        const result = await processDeliveryCore(input, "fast", {}, {
          store,
          views: [view("must-not-run", trace, async () => "applied")],
          afterDelivery: async () => { trace.push("drain-trigger"); },
        });
        expect(result.fastDisposition).toBe("failed");
        expect(result.correlationId).toContain(input.eventId);
        expect(trace).toEqual(["initialize"]);
      },
      async () => {
        const input = message("after-pipeline");
        const trace: string[] = [];
        const result = await processDeliveryCore(input, "queue", {}, {
          store: storeFor(input, trace),
          views: [view("retry", trace, async () => { throw new Error("transient-after-pipeline"); }), view("later", trace, async () => "applied")],
        });
        expect(result.queueDisposition).toBe("retry-to-dlq");
        expect(result.views.map((entry) => entry.id)).toEqual(["retry", "later"]);
      },
      async () => {
        const input = message("after-k-views");
        const trace: string[] = [];
        let unfinished = true;
        const replaySafe = (id: string): DeliveryViewHandler => view(id, trace, async () => {
          if (id === "middle" && unfinished) {
            unfinished = false;
            throw new Error("cancel-after-k");
          }
          return id === "head" || id === "tail" ? "duplicate-race" : "applied";
        });
        const first = await processDeliveryCore(input, "fast", {}, {
          store: storeFor(input, trace),
          views: [replaySafe("head"), replaySafe("middle"), replaySafe("tail")],
        });
        expect(first.fastDisposition).toBe("failed");
        const replay = await processDeliveryCore(input, "queue", {}, {
          store: storeFor(input, trace),
          views: [replaySafe("head"), replaySafe("middle"), replaySafe("tail")],
        });
        expect(replay.queueDisposition).toBe("ack");
        expect(replay.views).toHaveLength(3);
      },
      async () => {
        const input = message("after-all-views");
        const trace: string[] = [];
        let firstDrain = true;
        const result = await processDeliveryCore(input, "fast", {}, {
          store: storeFor(input, trace),
          views: [view("head", trace, async () => "applied"), view("tail", trace, async () => "applied")],
          afterDelivery: async () => {
            if (firstDrain) {
              firstDrain = false;
              throw new Error("cancel-after-all-views");
            }
          },
        });
        expect(result.fastDisposition).toBe("failed");
        expect(result.failures.at(-1)?.phase).toBe("drain");
      },
    ];
    for (const boundary of boundaries) await boundary();
  });
});
