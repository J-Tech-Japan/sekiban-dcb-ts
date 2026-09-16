import { abortAllDurableObjects, env, runInDurableObject } from "cloudflare:test";

import type { ClosedPrefixCertificate } from "../../packages/dcb-runtime/src/allocator/types";
import { pollLiveProjections } from "../../packages/dcb-runtime/src/projection/LiveProjectionWorker";
import { DEPLOYED_PROJECTOR_REGISTRY } from "../../packages/dcb-runtime/src/projection/ProjectorRegistry";
import type { SafeViewCoverageContext } from "../../packages/dcb-runtime/src/projection/ProjectionRuntime";
import type { StoredEvent } from "../../packages/dcb-runtime/src/store/types";
import {
  allocatorStub,
  candidateEventId,
  commitRequest,
  commitWorker,
  probeG77Capabilities,
  probeIssuanceRegistration,
  readCertificate,
  seedObservedTagHead,
  tagPost,
  triggerReconcile,
} from "./g77-fixtures";
import { g32EventId, g32Message, g32StoredEvent, g32Suid } from "./g32-fixtures";

/** Frozen in evidence before first scored sample (AC1). */
export const G77_AC6_PINNED_MAIN = "2fb1c1f7c603d56fb2a2b33db715a499ddfc8a99";
export const G77_AC6_RESOLVED_HISTORY = 30;
export const G77_AC6_UNRESOLVED_BACKLOG = 10;
export const G77_AC6_LEGACY_PRECUT = 5;
export const G77_AC6_WARMUP_PAIRS = 4;
export const G77_AC6_SCORED_PAIRS = 24;
export const G77_AC6_SAFE_PASS_BAR = 0.05;
export const G77_AC6_COMMIT_P95_BAR = 0.10;

export type G77Ac6CommitVector = "new" | "replayed" | "multi-candidate" | "multi-tag";

export interface G77Ac6StorageSnapshot {
  readonly keyCount: number;
  readonly byteEstimate: number;
  readonly storageOps: number;
}

export interface G77Ac6SampleMetrics {
  readonly wallMs: number;
  readonly storageBefore: G77Ac6StorageSnapshot;
  readonly storageAfter: G77Ac6StorageSnapshot;
  readonly storageDeltaKeys: number;
  readonly storageDeltaBytes: number;
  readonly storageDeltaOps: number;
}

export interface G77Ac6SafePassPairSample {
  readonly pairIndex: number;
  readonly gateOff: G77Ac6SampleMetrics;
  readonly gateOn: G77Ac6SampleMetrics;
  readonly deltaMs: number;
}

export interface G77Ac6CommitSample {
  readonly vector: G77Ac6CommitVector;
  readonly wallMs: number;
  readonly issuanceEnvelope: boolean;
  readonly storageDeltaKeys: number;
  readonly storageDeltaBytes: number;
  readonly storageDeltaOps: number;
}

async function allocatorPostQuiet(serviceId: string, path: string, body?: unknown): Promise<Response> {
  return allocatorStub(serviceId).fetch(new Request(`https://allocator.test${path}`, {
    method: "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "x-sdt-g77-suppress-recovery-alarm": "1",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

async function seedResolvedAllocation(serviceId: string, index: number): Promise<void> {
  const tag = `room:g77:ac6-resolved:${index}`;
  const attemptId = `g77-ac6-resolved-${index}:${crypto.randomUUID()}`;
  const eventId = candidateEventId(`resolved-${index}`);
  await allocatorPostQuiet(serviceId, "/allocate", {
    attemptId,
    serviceId,
    candidates: [{
      candidateIndex: 0,
      eventId,
      targetTags: [tag],
      pinnedWriterEpoch: 0,
    }],
  });
  const head = await seedObservedTagHead(serviceId, tag, `resolved-${index}`);
  await tagPost(serviceId, tag, "/append", {
    attemptId,
    epoch: 0,
    candidates: [{ candidateIndex: 0, eventId, suid: head, targetTags: [tag] }],
    consistencyTags: [{ tag, lastSortableUniqueId: head }],
  });
  await triggerReconcile(serviceId);
}

function projectionEnv(serviceId: string) {
  return {
    ...(env as Record<string, unknown>),
    SDT_SERVICE_ID: serviceId,
  } as never;
}

async function snapshotAllocatorStorage(serviceId: string): Promise<G77Ac6StorageSnapshot> {
  return runInDurableObject(allocatorStub(serviceId), async (_instance, state) => {
    const listed = await state.storage.list<unknown>();
    let byteEstimate = 0;
    for (const [, value] of listed) {
      byteEstimate += JSON.stringify(value).length;
    }
    return {
      keyCount: listed.size,
      byteEstimate,
      storageOps: listed.size,
    };
  });
}

function coverage(serviceId: string): SafeViewCoverageContext {
  return {
    authority: "g44-g62",
    serviceId,
    startOfPass: "PROVEN",
    kind: "FULL",
    frontierSuid: null,
  };
}

class MeasurementStoreFixture {
  private checkpoint: { lastSuid: string } | undefined;

  constructor(
    private readonly serviceId: string,
    private readonly events: readonly StoredEvent[],
  ) {}

  readonly store = {
    initialize: async (): Promise<void> => undefined,
    readAllEvents: async (_serviceId: string, since: string): Promise<StoredEvent[]> =>
      this.events.filter((event) => since.length === 0 || event.suid > since),
    currentLagBound: async (): Promise<number> => 0,
    listProjectionTags: async (): Promise<string[]> => [
      this.events[0]?.eventTags[0] ?? this.events[0]?.tags[0] ?? "orders:g77-ac6",
    ],
    readProjectionCheckpoint: async (): Promise<{ lastSuid: string } | undefined> => this.checkpoint,
    advanceProjectionCheckpoint: async (input: {
      expectedLastSuid: string | null;
      lastSuid: string;
    }): Promise<boolean> => {
      if ((this.checkpoint?.lastSuid ?? null) !== input.expectedLastSuid) return false;
      this.checkpoint = { lastSuid: input.lastSuid };
      return true;
    },
    projectionLag: async () => ({
      serviceId: this.serviceId,
      projectionId: "g77-ac6",
      tag: this.events[0]?.eventTags[0] ?? this.events[0]?.tags[0] ?? "orders:g77-ac6",
      checkpointSuid: this.checkpoint?.lastSuid ?? "",
      headSuid: this.events.at(-1)?.suid ?? "",
      behindEvents: 0,
    }),
    appendDeliveryIncident: async (): Promise<void> => undefined,
  } as never;
}

function projectionEvent(serviceId: string, seed: string): StoredEvent {
  const tag = "orders:g77-ac6";
  return g32StoredEvent(g32Message({
    serviceId,
    tag,
    eventId: g32EventId(`g77-ac6-${seed}`),
    suid: g32Suid(`g77-ac6-suid-${seed}`),
    eventTags: [tag],
    enqueuedAt: 0,
  }));
}

export async function seedLongHistoryAndBacklog(serviceId: string): Promise<{
  readonly certificate: ClosedPrefixCertificate;
  readonly resolvedCount: number;
  readonly backlogCount: number;
  readonly legacyCount: number;
}> {
  const caps = await probeG77Capabilities(serviceId);
  if (!caps.issuanceLedger) {
    for (let index = 0; index < G77_AC6_LEGACY_PRECUT; index += 1) {
      await allocatorPostQuiet(serviceId, "/allocate", {
        attemptId: `g77-ac6-legacy-${index}:${crypto.randomUUID()}`,
        serviceId,
        candidates: [{ candidateIndex: 0, eventId: candidateEventId(`legacy-${index}`) }],
      });
    }
    return {
      certificate: {
        certificateVersion: 1,
        authority: "allocator-transaction",
        status: "ready",
        allocatorLineageId: "legacy-only",
        serviceId,
        closedPrefixSuid: null,
        unresolvedCount: 0,
        generatedAt: Date.now(),
        migrationProofId: null,
      },
      resolvedCount: 0,
      backlogCount: 0,
      legacyCount: G77_AC6_LEGACY_PRECUT,
    };
  }

  for (let index = 0; index < G77_AC6_LEGACY_PRECUT; index += 1) {
    await allocatorPostQuiet(serviceId, "/allocate", {
      attemptId: `g77-ac6-legacy-${index}:${crypto.randomUUID()}`,
      serviceId,
      candidates: [{ candidateIndex: 0, eventId: candidateEventId(`legacy-${index}`) }],
    });
  }

  if (caps.migrationCut) {
    await allocatorPostQuiet(serviceId, "/__internal/g77/migration-cut", { cutAt: Date.now() });
    let complete = false;
    let pages = 0;
    while (!complete && pages < 32) {
      const page = await allocatorPostQuiet(serviceId, "/__internal/g77/legacy-inventory-page", { pageSize: 8 });
      const body = await page.json<{ inventoryComplete: boolean }>();
      complete = body.inventoryComplete;
      pages += 1;
    }
    await allocatorPostQuiet(serviceId, "/__internal/g77/migration-proof", {
      migrationProofId: "g77-ac6-measure-proof",
      boundEvidence: { serviceId, inventory: "complete" },
    });
  }

  for (let index = 0; index < G77_AC6_RESOLVED_HISTORY; index += 1) {
    await seedResolvedAllocation(serviceId, index);
  }

  for (let index = 0; index < G77_AC6_UNRESOLVED_BACKLOG; index += 1) {
    const tag = `room:g77:ac6-backlog:${index}`;
    const attemptId = `g77-ac6-backlog-${index}:${crypto.randomUUID()}`;
    await allocatorPostQuiet(serviceId, "/allocate", {
      attemptId,
      serviceId,
      candidates: [{
        candidateIndex: 0,
        eventId: candidateEventId(`backlog-${index}`),
        targetTags: [tag],
        pinnedWriterEpoch: 0,
      }],
    });
  }

  const certificate = await readCertificate(serviceId);
  if (caps.issuanceLedger && certificate.status !== "ready") {
    throw new Error(`G77 AC6 certificate not ready after seed: ${JSON.stringify(certificate)}`);
  }
  if (caps.issuanceLedger && certificate.unresolvedCount < G77_AC6_UNRESOLVED_BACKLOG) {
    throw new Error(
      `G77 AC6 backlog under-seeded: expected >= ${G77_AC6_UNRESOLVED_BACKLOG}, got ${certificate.unresolvedCount}`,
    );
  }
  return {
    certificate,
    resolvedCount: G77_AC6_RESOLVED_HISTORY,
    backlogCount: G77_AC6_UNRESOLVED_BACKLOG,
    legacyCount: G77_AC6_LEGACY_PRECUT,
  };
}

async function measureSafePassOnce(
  serviceId: string,
  gateOn: boolean,
  seed: string,
): Promise<G77Ac6SampleMetrics> {
  const events = [projectionEvent(serviceId, seed)];
  const fixture = new MeasurementStoreFixture(serviceId, events);
  const tag = events[0]!.eventTags[0] ?? events[0]!.tags[0] ?? "orders:g77-ac6";
  const lineageId = (await readCertificate(serviceId)).allocatorLineageId;

  const storageBefore = await snapshotAllocatorStorage(serviceId);
  const started = performance.now();
  if (gateOn) {
    await pollLiveProjections(projectionEnv(serviceId), {
      serviceId,
      tag,
      store: fixture.store,
      registry: DEPLOYED_PROJECTOR_REGISTRY,
      clock: { now: () => 100_000 },
      allocatorLineageId: lineageId,
      safeViewAdvance: true,
      safeViewCoverage: coverage(serviceId),
    });
  } else {
    await pollLiveProjections(projectionEnv(serviceId), {
      serviceId,
      tag,
      store: fixture.store,
      registry: DEPLOYED_PROJECTOR_REGISTRY,
      clock: { now: () => 100_000 },
      allocatorLineageId: lineageId,
    });
  }
  const wallMs = performance.now() - started;
  const storageAfter = await snapshotAllocatorStorage(serviceId);
  return {
    wallMs,
    storageBefore,
    storageAfter,
    storageDeltaKeys: storageAfter.keyCount - storageBefore.keyCount,
    storageDeltaBytes: storageAfter.byteEstimate - storageBefore.byteEstimate,
    storageDeltaOps: storageAfter.storageOps - storageBefore.storageOps,
  };
}

export async function runSafePassPair(
  pairIndex: number,
  options: { readonly restarted?: boolean } = {},
): Promise<G77Ac6SafePassPairSample> {
  if (options.restarted === true) {
    await abortAllDurableObjects();
  }
  const serviceId = `g77-ac6-safe-${pairIndex}-${crypto.randomUUID()}`;
  await seedLongHistoryAndBacklog(serviceId);
  const gateOff = await measureSafePassOnce(serviceId, false, `pair-${pairIndex}-off`);
  const gateOn = await measureSafePassOnce(serviceId, true, `pair-${pairIndex}-on`);
  return {
    pairIndex,
    gateOff,
    gateOn,
    deltaMs: gateOn.wallMs - gateOff.wallMs,
  };
}

function attemptIdFromResponse(response: Response, fallback: string): string {
  return response.headers.get("x-sdt-g4-attempt-id") ?? fallback;
}

async function envelopeExists(serviceId: string, attemptId: string, candidateIndex = 0): Promise<boolean> {
  return runInDurableObject(allocatorStub(serviceId), async (_instance, state) => {
    const envelope = await state.storage.get(`issuance:envelope:${attemptId}:${candidateIndex}`);
    return envelope !== undefined;
  });
}

export async function runCommitSample(vector: G77Ac6CommitVector): Promise<G77Ac6CommitSample> {
  const serviceId = `g77-ac6-commit-${vector}-${crypto.randomUUID()}`;
  const storageBefore = await snapshotAllocatorStorage(serviceId);
  const started = performance.now();
  let envelopeAttemptId = `g77-ac6-commit:${crypto.randomUUID()}`;

  if (vector === "new") {
    const tag = "room:g77:ac6-commit-new";
    const head = await seedObservedTagHead(serviceId, tag, "commit-new");
    const response = await commitWorker(serviceId).handle(commitRequest([tag], {
      fault: "tag-append-last",
      attemptId: envelopeAttemptId,
      consistencyHeads: [head],
    }));
    envelopeAttemptId = attemptIdFromResponse(response, envelopeAttemptId);
  } else if (vector === "replayed") {
    const tag = "room:g77:ac6-commit-replay";
    const head = await seedObservedTagHead(serviceId, tag, "commit-replay");
    const first = await commitWorker(serviceId).handle(commitRequest([tag], {
      fault: "tag-append-last",
      attemptId: envelopeAttemptId,
      consistencyHeads: [head],
    }));
    envelopeAttemptId = attemptIdFromResponse(first, envelopeAttemptId);
    await commitWorker(serviceId).handle(commitRequest([tag], {
      fault: "tag-append-last",
      attemptId: envelopeAttemptId,
      consistencyHeads: [head],
    }));
  } else if (vector === "multi-candidate") {
    const tagA = "room:g77:ac6-commit-a";
    const tagB = "room:g77:ac6-commit-b";
    const headA = await seedObservedTagHead(serviceId, tagA, "commit-a");
    const headB = await seedObservedTagHead(serviceId, tagB, "commit-b");
    envelopeAttemptId = `g77-ac6-multi:${crypto.randomUUID()}`;
    const response = await commitWorker(serviceId).handle(commitRequest([tagA, tagB], {
      fault: "tag-append-last",
      attemptId: envelopeAttemptId,
      consistencyHeads: [headA, headB],
    }));
    envelopeAttemptId = attemptIdFromResponse(response, envelopeAttemptId);
  } else {
    const tagA = "room:g77:ac6-multi-tag-a";
    const tagB = "room:g77:ac6-multi-tag-b";
    const headA = await seedObservedTagHead(serviceId, tagA, "mt-a");
    const headB = await seedObservedTagHead(serviceId, tagB, "mt-b");
    envelopeAttemptId = `g77-ac6-multitag:${crypto.randomUUID()}`;
    const response = await commitWorker(serviceId).handle(commitRequest([tagA, tagB], {
      fault: "tag-append-last",
      attemptId: envelopeAttemptId,
      consistencyHeads: [headA, headB],
    }));
    envelopeAttemptId = attemptIdFromResponse(response, envelopeAttemptId);
  }

  const wallMs = performance.now() - started;
  const registration = await probeIssuanceRegistration(serviceId, envelopeAttemptId);
  const envelopeWritten = registration.envelope || await envelopeExists(serviceId, envelopeAttemptId);
  const storageAfter = await snapshotAllocatorStorage(serviceId);
  return {
    vector,
    wallMs,
    issuanceEnvelope: envelopeWritten,
    storageDeltaKeys: storageAfter.keyCount - storageBefore.keyCount,
    storageDeltaBytes: storageAfter.byteEstimate - storageBefore.byteEstimate,
    storageDeltaOps: storageAfter.storageOps - storageBefore.storageOps,
  };
}

export function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) throw new Error("percentile requires at least one value");
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index]!;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median requires at least one value");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

export function medianAbsoluteDeviation(values: readonly number[]): number {
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
}

export function summarizeSafePassPairs(pairs: readonly G77Ac6SafePassPairSample[]) {
  const gateOffMs = pairs.map((pair) => pair.gateOff.wallMs);
  const gateOnMs = pairs.map((pair) => pair.gateOn.wallMs);
  const deltas = pairs.map((pair) => pair.deltaMs);
  const mad = medianAbsoluteDeviation(deltas);
  const deltaMedian = median(deltas);
  return {
    pairCount: pairs.length,
    gateOff: {
      wallMs: gateOffMs,
      p50: median(gateOffMs),
      p95: percentile(gateOffMs, 0.95),
      storageDeltaKeys: pairs.map((pair) => pair.gateOff.storageDeltaKeys),
      storageDeltaBytes: pairs.map((pair) => pair.gateOff.storageDeltaBytes),
      storageDeltaOps: pairs.map((pair) => pair.gateOff.storageDeltaOps),
    },
    gateOn: {
      wallMs: gateOnMs,
      p50: median(gateOnMs),
      p95: percentile(gateOnMs, 0.95),
      storageDeltaKeys: pairs.map((pair) => pair.gateOn.storageDeltaKeys),
      storageDeltaBytes: pairs.map((pair) => pair.gateOn.storageDeltaBytes),
      storageDeltaOps: pairs.map((pair) => pair.gateOn.storageDeltaOps),
    },
    pairedDeltaMs: deltas,
    deltaMedianMs: deltaMedian,
    deltaMadMs: mad,
    deltaRatioMedian: median(gateOffMs.map((value, index) => value === 0 ? 0 : deltas[index]! / value)),
  };
}

export function dispositionAgainstBar(
  observedRatio: number,
  bar: number,
  inconclusive: boolean,
): "pass" | "exceed" | "inconclusive" {
  if (inconclusive) return "inconclusive";
  return observedRatio <= bar ? "pass" : "exceed";
}
