import { describe, expect, it } from "vitest";

import type { ClosedPrefixCertificate } from "../packages/dcb-runtime/src/allocator/types";
import { pollLiveProjections } from "../packages/dcb-runtime/src/projection/LiveProjectionWorker";
import { DEPLOYED_PROJECTOR_REGISTRY } from "../packages/dcb-runtime/src/projection/ProjectorRegistry";
import type {
  PipelineStore,
  ProjectionCheckpoint,
  ProjectionCheckpointAdvance,
  StoredEvent,
} from "../packages/dcb-runtime/src/store/types";
import { g32Message, g32SuidAt, g32StoredEvent } from "./helpers/g32-fixtures";

const SERVICE_ID = "g75-certificate-service";
const LINEAGE_ID = "g75-allocator-lineage";
const TAG = "orders:g75-certificate";
const NOW_MS = 100_000;

class ProjectionStoreFixture {
  private checkpoint: ProjectionCheckpoint | undefined;

  constructor(private readonly events: readonly StoredEvent[]) {}

  readonly store = {
    initialize: async (): Promise<void> => undefined,
    readAllEvents: async (_serviceId: string, since: string): Promise<StoredEvent[]> =>
      this.events.filter((event) => since.length === 0 || event.suid > since),
    currentLagBound: async (): Promise<number> => 0,
    listProjectionTags: async (): Promise<string[]> => [TAG],
    readProjectionCheckpoint: async (): Promise<ProjectionCheckpoint | undefined> => this.checkpoint,
    advanceProjectionCheckpoint: async (input: ProjectionCheckpointAdvance): Promise<boolean> => {
      if ((this.checkpoint?.lastSuid ?? null) !== input.expectedLastSuid) return false;
      this.checkpoint = { ...input };
      return true;
    },
    projectionLag: async (): Promise<{
      serviceId: string;
      projectionId: string;
      tag: string;
      checkpointSuid: string;
      headSuid: string;
      behindEvents: number;
    }> => ({
      serviceId: SERVICE_ID,
      projectionId: "g75-projection",
      tag: TAG,
      checkpointSuid: this.checkpoint?.lastSuid ?? "",
      headSuid: this.events.at(-1)?.suid ?? "",
      behindEvents: this.checkpoint === undefined ? this.events.length : 0,
    }),
    appendDeliveryIncident: async (): Promise<void> => undefined,
  } as unknown as PipelineStore;

  checkpointValue(): ProjectionCheckpoint | undefined {
    return this.checkpoint;
  }
}

function event(seed: string, unixMs = 0): StoredEvent {
  return g32StoredEvent(g32Message({
    serviceId: SERVICE_ID,
    tag: TAG,
    eventId: `g75-event-${seed}`,
    suid: g32SuidAt(unixMs, `g75-suid-${seed}`),
    eventTags: [TAG],
    enqueuedAt: 0,
  }));
}

function certificate(closedPrefixSuid: string | null): ClosedPrefixCertificate {
  return {
    certificateVersion: 1,
    authority: "allocator-transaction",
    status: "ready",
    allocatorLineageId: LINEAGE_ID,
    serviceId: SERVICE_ID,
    closedPrefixSuid,
    unresolvedCount: closedPrefixSuid === null ? 1 : 0,
    generatedAt: NOW_MS,
    migrationProofId: null,
  };
}

async function poll(
  fixture: ProjectionStoreFixture,
  options: {
    readonly tag?: string;
    readonly maximumSuid?: string | null;
    readonly safeViewAdvance?: boolean;
    readonly closedPrefixSuid?: string | null;
    readonly closedPrefixCertificate?: ClosedPrefixCertificate;
  } = {},
) {
  return pollLiveProjections(
    {},
    {
      ...options,
      store: fixture.store,
      serviceId: SERVICE_ID,
      registry: DEPLOYED_PROJECTOR_REGISTRY,
      clock: { now: () => NOW_MS },
      allocatorLineageId: LINEAGE_ID,
    },
  );
}

describe("SDT-G75 certificate scope", () => {
  it("AC1: ordinary scheduled and diagnostic-style polling does not validate a certificate", async () => {
    const fixture = new ProjectionStoreFixture([event("ordinary")]);
    const malformed = { status: "not-a-certificate" } as unknown as ClosedPrefixCertificate;

    const results = await poll(fixture, {
      closedPrefixCertificate: malformed,
      closedPrefixSuid: "not-a-suid",
    });

    expect(results[0]?.advancedSourceEvents).toBe(1);
    expect(fixture.checkpointValue()?.lastSuid).toBe(event("ordinary").suid);
  });

  it("AC1/AC2: the explicit safe-view decision is certificate-gated and consumer-bound", async () => {
    const missing = new ProjectionStoreFixture([event("missing")]);
    await expect(poll(missing, { safeViewAdvance: true })).rejects.toThrow("ordering_certificate_unavailable");
    expect(missing.checkpointValue()).toBeUndefined();

    const wrongConsumer = new ProjectionStoreFixture([event("wrong-consumer")]);
    await expect(poll(wrongConsumer, {
      safeViewAdvance: true,
      closedPrefixCertificate: { ...certificate(null), serviceId: "other-service" },
    })).rejects.toThrow("ordering_certificate_consumer_mismatch");
    expect(wrongConsumer.checkpointValue()).toBeUndefined();

    const valid = new ProjectionStoreFixture([event("valid")]);
    const validEvent = event("valid");
    const results = await poll(valid, {
      safeViewAdvance: true,
      closedPrefixSuid: validEvent.suid,
      closedPrefixCertificate: certificate(validEvent.suid),
      maximumSuid: validEvent.suid,
    });
    expect(results[0]?.advancedSourceEvents).toBe(1);

    const tagged = new ProjectionStoreFixture([event("tagged")]);
    const taggedEvent = event("tagged");
    const taggedResults = await poll(tagged, {
      tag: TAG,
      safeViewAdvance: true,
      closedPrefixSuid: taggedEvent.suid,
      closedPrefixCertificate: certificate(taggedEvent.suid),
      maximumSuid: taggedEvent.suid,
    });
    expect(taggedResults[0]?.advancedSourceEvents).toBe(1);
  });

  it("AC3: certificate alone cannot replace the existing G44 settled frontier", async () => {
    const first = event("g44-first", 0);
    const second = event("g44-second", 1);
    const fixture = new ProjectionStoreFixture([first, second]);

    const results = await poll(fixture, {
      safeViewAdvance: true,
      maximumSuid: first.suid,
      closedPrefixCertificate: certificate(second.suid),
    });

    expect(results[0]?.advancedSourceEvents).toBe(1);
    expect(fixture.checkpointValue()?.lastSuid).toBe(first.suid);
  });

  it("AC3: the safe view cannot advance beyond the certificate closed prefix", async () => {
    const first = event("g62-first", 0);
    const second = event("g62-second", 1);
    const fixture = new ProjectionStoreFixture([first, second]);

    const results = await poll(fixture, {
      safeViewAdvance: true,
      maximumSuid: second.suid,
      closedPrefixCertificate: certificate(first.suid),
    });

    expect(results[0]?.advancedSourceEvents).toBe(1);
    expect(fixture.checkpointValue()?.lastSuid).toBe(first.suid);
  });
});
