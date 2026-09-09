import { describe, expect, it } from "vitest";

import type { ClosedPrefixCertificate } from "../packages/dcb-runtime/src/allocator/types";
import { pollLiveProjections } from "../packages/dcb-runtime/src/projection/LiveProjectionWorker";
import {
  DEPLOYED_PROJECTOR_REGISTRY,
  tagStateIdentityFrom,
} from "../packages/dcb-runtime/src/projection/ProjectorRegistry";
import {
  ProjectionRuntime,
  type SafeViewCoverageContext,
} from "../packages/dcb-runtime/src/projection/ProjectionRuntime";
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
const IDENTITY = tagStateIdentityFrom(`${TAG}:test-projector`, DEPLOYED_PROJECTOR_REGISTRY).value!;

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

function certificate(closedPrefixSuid: string | null, serviceId = SERVICE_ID): ClosedPrefixCertificate {
  return {
    certificateVersion: 1,
    authority: "allocator-transaction",
    status: "ready",
    allocatorLineageId: LINEAGE_ID,
    serviceId,
    closedPrefixSuid,
    unresolvedCount: closedPrefixSuid === null ? 1 : 0,
    generatedAt: NOW_MS,
    migrationProofId: null,
  };
}

function coverage(
  kind: SafeViewCoverageContext["kind"],
  frontierSuid: string | null,
  serviceId = SERVICE_ID,
): SafeViewCoverageContext {
  if (kind === "FULL") {
    return {
      authority: "g44-g62",
      serviceId,
      startOfPass: "PROVEN",
      kind,
      frontierSuid: null,
    };
  }
  return {
    authority: "g44-g62",
    serviceId,
    startOfPass: "PROVEN",
    kind,
    frontierSuid,
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
    readonly safeViewCoverage?: SafeViewCoverageContext;
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
  it("AC1: unmarked direct catchUp and pollRegistered ignore absent, null, and malformed certificate fields", async () => {
    const absent = new ProjectionStoreFixture([event("direct-absent")]);
    const absentResult = await new ProjectionRuntime(absent.store).catchUp(
      SERVICE_ID,
      IDENTITY,
      NOW_MS,
    );
    expect(absentResult.advancedSourceEvents).toBe(1);

    const malformed = { serviceId: 17, closedPrefixSuid: { invalid: true } } as unknown as ClosedPrefixCertificate;
    const nullPrefix = new ProjectionStoreFixture([event("direct-null")]);
    const nullResult = await new ProjectionRuntime(nullPrefix.store).catchUp(
      SERVICE_ID,
      IDENTITY,
      NOW_MS,
      {},
      {
        closedPrefixSuid: null,
        closedPrefixCertificate: malformed,
        expectedServiceId: "irrelevant-service",
        expectedAllocatorLineageId: "irrelevant-lineage",
      },
    );
    expect(nullResult.advancedSourceEvents).toBe(1);

    const registered = new ProjectionStoreFixture([event("direct-registered")]);
    const registeredResults = await new ProjectionRuntime(registered.store).pollRegistered(
      SERVICE_ID,
      NOW_MS,
      undefined,
      null,
      malformed,
      false,
      "irrelevant-service",
      "irrelevant-lineage",
    );
    expect(registeredResults[0]?.advancedSourceEvents).toBe(1);
    expect(registered.checkpointValue()?.lastSuid).toBe(event("direct-registered").suid);
  });

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
      safeViewCoverage: coverage("FULL", null, "other-service"),
    })).rejects.toThrow("ordering_certificate_consumer_mismatch");
    expect(wrongConsumer.checkpointValue()).toBeUndefined();

    const valid = new ProjectionStoreFixture([event("valid")]);
    const validEvent = event("valid");
    const results = await poll(valid, {
      safeViewAdvance: true,
      closedPrefixSuid: validEvent.suid,
      closedPrefixCertificate: certificate(validEvent.suid),
      maximumSuid: validEvent.suid,
      safeViewCoverage: coverage("FULL", null),
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
      safeViewCoverage: coverage("FULL", null),
    });
    expect(taggedResults[0]?.advancedSourceEvents).toBe(1);
  });

  it("F2: direct safe catchUp and pollRegistered bind certificate and context to actual serviceId", async () => {
    const directEvent = event("foreign-direct");
    const direct = new ProjectionStoreFixture([directEvent]);
    await expect(new ProjectionRuntime(direct.store).catchUp(
      SERVICE_ID,
      IDENTITY,
      NOW_MS,
      {},
      {
        closedPrefixSuid: directEvent.suid,
        closedPrefixCertificate: certificate(directEvent.suid, "other-service"),
        requireClosedPrefixCertificate: true,
        expectedServiceId: "other-service",
        expectedAllocatorLineageId: LINEAGE_ID,
        safeViewCoverage: coverage("FULL", null, "other-service"),
      },
    )).rejects.toThrow("ordering_certificate_consumer_mismatch");
    expect(direct.checkpointValue()).toBeUndefined();

    const registeredEvent = event("foreign-registered");
    const registered = new ProjectionStoreFixture([registeredEvent]);
    await expect(new ProjectionRuntime(registered.store).pollRegistered(
      SERVICE_ID,
      NOW_MS,
      undefined,
      undefined,
      certificate(registeredEvent.suid),
      true,
      "other-service",
      LINEAGE_ID,
      coverage("FULL", null, "other-service"),
    )).rejects.toThrow("ordering_certificate_consumer_mismatch");
    expect(registered.checkpointValue()).toBeUndefined();
  });

  it("AC3: marked safe advancement requires a proven G44/G62 coverage context", async () => {
    const first = event("no-coverage-first", 0);
    const fixture = new ProjectionStoreFixture([first]);

    await expect(poll(fixture, {
      safeViewAdvance: true,
      closedPrefixCertificate: certificate(first.suid),
    })).rejects.toThrow("ordering_coverage_unavailable");
    expect(fixture.checkpointValue()).toBeUndefined();
  });

  it("AC3: a proven BLOCK/UNSETTLED null frontier remains non-advancing", async () => {
    const first = event("unsettled-first", 0);
    const second = event("unsettled-second", 1);
    const fixture = new ProjectionStoreFixture([first, second]);

    const results = await poll(fixture, {
      safeViewAdvance: true,
      closedPrefixCertificate: certificate(second.suid),
      safeViewCoverage: coverage("BLOCK/UNSETTLED", null),
    });

    expect(results[0]?.advancedSourceEvents).toBe(0);
    expect(fixture.checkpointValue()).toBeUndefined();
  });

  it("AC3: explicit proven-FULL context permits the unbounded safe decision", async () => {
    const first = event("full-first", 0);
    const second = event("full-second", 1);
    const fixture = new ProjectionStoreFixture([first, second]);

    const results = await poll(fixture, {
      safeViewAdvance: true,
      closedPrefixCertificate: certificate(second.suid),
      safeViewCoverage: coverage("FULL", null),
    });

    expect(results[0]?.advancedSourceEvents).toBe(2);
    expect(fixture.checkpointValue()?.lastSuid).toBe(second.suid);
  });

  it("AC3: certificate alone cannot replace the existing G44 settled frontier even with proven-FULL context", async () => {
    const first = event("g44-first", 0);
    const second = event("g44-second", 1);
    const fixture = new ProjectionStoreFixture([first, second]);

    const results = await poll(fixture, {
      safeViewAdvance: true,
      maximumSuid: first.suid,
      closedPrefixCertificate: certificate(second.suid),
      safeViewCoverage: coverage("FULL", null),
    });

    expect(results[0]?.advancedSourceEvents).toBe(1);
    expect(fixture.checkpointValue()?.lastSuid).toBe(first.suid);
  });

  it("AC3: the proven G44/G62 coverage frontier remains independent from the certificate closed prefix", async () => {
    const first = event("coverage-first", 0);
    const second = event("coverage-second", 1);
    const fixture = new ProjectionStoreFixture([first, second]);

    const results = await poll(fixture, {
      safeViewAdvance: true,
      closedPrefixCertificate: certificate(second.suid),
      safeViewCoverage: coverage("SETTLED", first.suid),
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
      safeViewCoverage: coverage("FULL", null),
    });

    expect(results[0]?.advancedSourceEvents).toBe(1);
    expect(fixture.checkpointValue()?.lastSuid).toBe(first.suid);
  });
});
