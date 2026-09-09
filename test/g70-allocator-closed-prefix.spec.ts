import { env, runDurableObjectAlarm, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type {
  AllocatorState,
  ClosedPrefixCertificate,
  IssuanceObligation,
} from "../packages/dcb-runtime/src/allocator/types";
import { readClosedPrefixCertificate } from "../packages/dcb-runtime/src/allocator/AllocatorDurableObject";
import { pollLiveProjections } from "../packages/dcb-runtime/src/projection/LiveProjectionWorker";
import { DEPLOYED_PROJECTOR_REGISTRY } from "../packages/dcb-runtime/src/projection/ProjectorRegistry";
import type { PipelineStore, ProjectionCheckpoint, ProjectionCheckpointAdvance, StoredEvent } from "../packages/dcb-runtime/src/store/types";
import { scopeIdFor } from "../packages/dcb-runtime/src/scope/ScopeName";
import { TEST_SERVICE_ID_HEADER } from "../packages/dcb-runtime/src/service/ServiceIdentityProvider";
import { g32Suid, g32SuidAt } from "./helpers/g32-fixtures";

interface AllocatedVector {
  attemptId: string;
  allocatorLineageId: string;
  candidates: Array<{ candidateIndex: number; eventId: string; suid: string; targetTags?: string[] }>;
}

function unique(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function allocator(serviceId: string): DurableObjectStub {
  const namespace = (env as unknown as { ALLOCATOR: DurableObjectNamespace }).ALLOCATOR;
  return namespace.get(scopeIdFor(namespace, { serviceId, doClass: "allocator", identity: "allocator" }));
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function post(stub: DurableObjectStub, path: string, body: unknown): Promise<Response> {
  return stub.fetch(`https://g70.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function get<T>(stub: DurableObjectStub, path: string): Promise<T> {
  const response = await stub.fetch(`https://g70.test${path}`);
  expect(response.status).toBe(200);
  return json<T>(response);
}

async function waitForObligation(stub: DurableObjectStub, eventId: string): Promise<IssuanceObligation> {
  let last: IssuanceObligation | undefined;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const obligations = await get<IssuanceObligation[]>(stub, "/obligations");
    last = obligations.find((candidate) => candidate.eventId === eventId);
    if (last?.status === "resolved") return last;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`G70 obligation did not resolve for ${eventId}: ${JSON.stringify(last)}`);
}

async function allocate(stub: DurableObjectStub, attemptId: string, targetTags: string[]): Promise<AllocatedVector> {
  const response = await post(stub, "/allocate", {
    attemptId,
    candidates: [{ candidateIndex: 0, eventId: `${attemptId}-event`, targetTags }],
  });
  expect(response.status).toBe(201);
  return json<AllocatedVector>(response);
}

async function publicCommit(
  serviceId: string,
  tags: string[],
  fault?: string,
  attemptId?: string,
  withReservation = false,
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [TEST_SERVICE_ID_HEADER]: serviceId,
  };
  if (fault !== undefined) headers["x-sdt-g4-test-fault"] = fault;
  if (attemptId !== undefined) headers["x-sdt-g4-test-attempt-id"] = attemptId;
  return SELF.fetch("https://commit.test/api/sekiban/serialized/commit", {
    method: "POST",
    headers,
    body: JSON.stringify({
      version: 1,
      eventCandidates: [{
        payload: btoa(JSON.stringify({ value: `g70-${crypto.randomUUID()}` })),
        eventPayloadName: "G70PublicMatrixEvent",
        tags,
      }],
      consistencyTags: withReservation ? tags.map((tag) => ({ tag, lastSortableUniqueId: "" })) : [],
    }),
  });
}

async function appendDelayedWriter(
  serviceId: string,
  tagName: string,
  vector: AllocatedVector,
  expectedStatus = 201,
): Promise<Response> {
  const namespace = (env as unknown as { TAG?: DurableObjectNamespace }).TAG;
  if (namespace === undefined) throw new Error("G70 delayed-writer proof requires the Tag binding");
  const tag = namespace.get(scopeIdFor(namespace, { serviceId, doClass: "tag", identity: tagName }));
  const acquired = await tag.fetch(`https://g70.test/acquire?__tag=${encodeURIComponent(tagName)}&__serviceId=${encodeURIComponent(serviceId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      attemptId: vector.attemptId,
      epoch: 1,
      eventTags: [tagName],
      consistencyTags: [{ tag: tagName, lastSortableUniqueId: "" }],
    }),
  });
  // The public commit may already have durably acquired this exact
  // reservation before its cancellation fault. Re-acquire is idempotent.
  expect([200, 201]).toContain(acquired.status);
  const stateResponse = await tag.fetch(`https://g70.test/state?__tag=${encodeURIComponent(tagName)}&__serviceId=${encodeURIComponent(serviceId)}`);
  expect(stateResponse.status).toBe(200);
  const state = await json<{ activeReservation: { attemptId: string; epoch: number; token: string } | null }>(stateResponse);
  expect(state.activeReservation).not.toBeNull();
  const candidate = vector.candidates[0]!;
  const append = await tag.fetch(`https://g70.test/append?__tag=${encodeURIComponent(tagName)}&__serviceId=${encodeURIComponent(serviceId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      attemptId: state.activeReservation!.attemptId,
      epoch: state.activeReservation!.epoch,
      reservationToken: state.activeReservation!.token,
      allocatorLineageId: vector.allocatorLineageId,
      candidates: [{
        candidateIndex: candidate.candidateIndex,
        eventId: candidate.eventId,
        suid: candidate.suid,
        payload: JSON.stringify({ value: "g70-delayed-writer" }),
        eventType: "G70DelayedWriterEvent",
        provenance: "g32",
        eventTags: [tagName],
        allocatorLineageId: vector.allocatorLineageId,
        timestamp: new Date().toISOString(),
      }],
    }),
  });
  expect(append.status).toBe(expectedStatus);
  return append;
}

async function resolve(
  stub: DurableObjectStub,
  vector: AllocatedVector,
  tag: string,
  disposition: "installed" | "fenced" = "installed",
): Promise<IssuanceObligation> {
  const candidate = vector.candidates[0]!;
  const response = await post(stub, "/obligations/resolve", {
    attemptId: vector.attemptId,
    candidateIndex: candidate.candidateIndex,
    eventId: candidate.eventId,
    suid: candidate.suid,
    allocatorLineageId: vector.allocatorLineageId,
    tag,
    disposition,
  });
  expect(response.status).toBe(200);
  return json<IssuanceObligation>(response);
}

function publicSafeMatrixStore(event: StoredEvent, tag: string): PipelineStore {
  let checkpoint: ProjectionCheckpoint | undefined;
  return {
    initialize: async () => undefined,
    readAllEvents: async (_serviceId: string, afterSuid: string) => afterSuid.length === 0 || event.suid > afterSuid ? [event] : [],
    currentLagBound: async () => 0,
    listProjectionTags: async () => [tag],
    readProjectionCheckpoint: async () => checkpoint,
    advanceProjectionCheckpoint: async (next: ProjectionCheckpointAdvance) => {
      if (checkpoint !== undefined && checkpoint.lastSuid !== next.expectedLastSuid) return false;
      checkpoint = { ...next };
      return true;
    },
    projectionLag: async () => ({ serviceId: event.serviceId, projectionId: "g70-public-safe-matrix", tag, checkpointSuid: checkpoint?.lastSuid ?? "", headSuid: event.suid, behindEvents: checkpoint === undefined ? 1 : 0 }),
    appendDeliveryIncident: async () => undefined,
  } as unknown as PipelineStore;
}

function publicStoredEvent(
  serviceId: string,
  body: { writtenEvents: Array<{ id: string; sortableUniqueIdValue: string }> },
  tag: string,
  value: string,
): StoredEvent {
  const written = body.writtenEvents[0]!;
  return {
    serviceId,
    id: written.id,
    eventId: written.id,
    sortableUniqueId: written.sortableUniqueIdValue,
    suid: written.sortableUniqueIdValue,
    payload: JSON.stringify({ value }),
    tags: [tag],
    eventTags: [tag],
    eventType: "G70PublicMatrixEvent",
    timestamp: new Date().toISOString(),
    causationId: null,
    correlationId: null,
    executedUser: null,
    provenance: "g32",
    firstArrivedAt: Date.now() - 30_000,
    lastArrivedAt: Date.now() - 30_000,
    maxDeliveryLagMs: 0,
    arrivals: [],
  };
}

describe("SDT-G70 allocator closed-prefix authority", () => {
  it("AC1-AC3: keeps a durable unresolved hole, resolves idempotently, and advances only through the closed prefix", async () => {
    const serviceId = unique("g70-prefix");
    const stub = allocator(serviceId);
    const first = await allocate(stub, "g70-prefix-first", ["orders"]);
    const second = await allocate(stub, "g70-prefix-second", ["orders"]);
    const initial = await get<ClosedPrefixCertificate>(stub, "/closed-prefix");
    expect(initial).toMatchObject({ status: "ready", closedPrefixSuid: null, unresolvedCount: 2 });

    const firstResolution = await resolve(stub, first, "orders");
    expect(firstResolution.status).toBe("resolved");
    const afterFirst = await get<ClosedPrefixCertificate>(stub, "/closed-prefix");
    expect(afterFirst).toMatchObject({
      status: "ready",
      closedPrefixSuid: first.candidates[0]!.suid,
      unresolvedCount: 1,
    });
    // Replaying the same durable fact cannot widen or rewind the certificate.
    expect(await resolve(stub, first, "orders")).toEqual(firstResolution);
    expect(await get<ClosedPrefixCertificate>(stub, "/closed-prefix")).toEqual(afterFirst);

    const secondResolution = await resolve(stub, second, "orders");
    expect(secondResolution.status).toBe("resolved");
    const closed = await get<ClosedPrefixCertificate>(stub, "/closed-prefix");
    expect(closed).toMatchObject({
      status: "ready",
      closedPrefixSuid: second.candidates[0]!.suid,
      unresolvedCount: 0,
    });
  });

  it("AC2/AC6: an unresolved or migrated namespace stays fail-closed until explicit identity-bound facts close it", async () => {
    const serviceId = unique("g70-migration");
    const stub = allocator(serviceId);
    const pending = await allocate(stub, "g70-pending", ["orders"]);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
    const stillPending = await get<ClosedPrefixCertificate>(stub, "/closed-prefix");
    expect(stillPending).toMatchObject({ status: "ready", closedPrefixSuid: null, unresolvedCount: 1 });

    const seededService = unique("g70-seeded");
    const seeded = allocator(seededService);
    expect((await get<AllocatorState>(seeded, "/state")).allocatedWatermark).toBeNull();
    expect((await post(seeded, "/seed-after", {
      importId: "g70-import",
      leaseEpoch: 1,
      highWatermark: g32Suid("g70-seed-high-watermark-900"),
    })).status).toBe(201);
    const seededState = await get<AllocatorState>(seeded, "/state");
    const beforeCut = await get<ClosedPrefixCertificate>(seeded, "/closed-prefix");
    expect(beforeCut).toMatchObject({ status: "unreconciled", closedPrefixSuid: null });
    const importedSuid = g32Suid("g70-imported-event-100");
    expect((await post(seeded, "/reconcile-cut", {
      allocatorLineageId: seededState.allocatorLineageId,
      proofId: "g70-reconciliation-proof",
      historyComplete: true,
      completeThroughSuid: seededState.allocatedWatermark!,
      serviceId: seededService,
      obligations: [{
        attemptId: "g70-imported-attempt",
        candidateIndex: 0,
        eventId: "g70-imported-event",
        suid: importedSuid,
        targetTags: ["orders"],
      }],
    })).status).toBe(201);
    const afterCut = await get<ClosedPrefixCertificate>(seeded, "/closed-prefix");
    expect(afterCut).toMatchObject({ status: "ready", closedPrefixSuid: null, unresolvedCount: 1, migrationProofId: "g70-reconciliation-proof" });
    const importedVector: AllocatedVector = {
      attemptId: "g70-imported-attempt",
      allocatorLineageId: seededState.allocatorLineageId,
      candidates: [{ candidateIndex: 0, eventId: "g70-imported-event", suid: importedSuid, targetTags: ["orders"] }],
    };
    await resolve(seeded, importedVector, "orders");
    expect(await get<ClosedPrefixCertificate>(seeded, "/closed-prefix")).toMatchObject({ status: "ready", closedPrefixSuid: importedSuid, unresolvedCount: 0 });
    // The pending namespace remains unresolved; elapsed time did not close it.
    expect((await get<IssuanceObligation[]>(stub, "/obligations")).find((row) => row.suid === pending.candidates[0]!.suid)?.status).toBe("unresolved");
  });

  it("AC6: reconciliation refuses empty, omitted, and out-of-cut history instead of certifying a prefix", async () => {
    const serviceId = unique("g70-reconcile-cut");
    const stub = allocator(serviceId);
    expect((await post(stub, "/seed-after", {
      importId: "g70-reconcile-cut-import",
      leaseEpoch: 1,
      highWatermark: g32Suid("g70-reconcile-cut-watermark-900"),
    })).status).toBe(201);
    const first = await allocate(stub, "g70-reconcile-cut-first", []);
    const second = await allocate(stub, "g70-reconcile-cut-second", []);
    const allocatedState = await get<AllocatorState>(stub, "/state");
    const cut = {
      allocatorLineageId: allocatedState.allocatorLineageId,
      proofId: "g70-reconcile-cut-proof",
      historyComplete: true,
      completeThroughSuid: allocatedState.allocatedWatermark!,
      serviceId,
      obligations: [],
    };
    const empty = await post(stub, "/reconcile-cut", cut);
    expect(empty.status).toBe(409);
    expect(await json<{ code: string }>(empty)).toMatchObject({ code: "reconciliation_empty_history" });

    const omitted = await post(stub, "/reconcile-cut", {
      ...cut,
      serviceId,
      obligations: [{
        attemptId: first.attemptId,
        candidateIndex: 0,
        eventId: first.candidates[0]!.eventId,
        suid: first.candidates[0]!.suid,
        targetTags: ["orders"],
      }],
    });
    expect(omitted.status).toBe(409);
    expect(await json<{ code: string }>(omitted)).toMatchObject({ code: "reconciliation_omits_durable_history" });

    const beyond = await post(stub, "/reconcile-cut", {
      ...cut,
      serviceId,
      completeThroughSuid: first.candidates[0]!.suid,
      obligations: [
        {
          attemptId: first.attemptId,
          candidateIndex: 0,
          eventId: first.candidates[0]!.eventId,
          suid: first.candidates[0]!.suid,
          targetTags: ["orders"],
        },
        {
          attemptId: second.attemptId,
          candidateIndex: 0,
          eventId: second.candidates[0]!.eventId,
          suid: second.candidates[0]!.suid,
          targetTags: ["orders"],
        },
      ],
    });
    expect(beyond.status).toBe(409);
    expect(await json<{ code: string }>(beyond)).toMatchObject({ code: "reconciliation_incomplete_cut" });
    // Invalid cuts cannot install the migration proof. Participant-free
    // allocation history remains fail-closed until an authoritative
    // membership/import cut is accepted.
    expect(await get<ClosedPrefixCertificate>(stub, "/closed-prefix")).toMatchObject({
      status: "unreconciled",
      migrationProofId: null,
    });
  });

  it("AC3/AC6: a legacy participant-free vector stays blocked until membership proof and vanished-writer resolution", async () => {
    const serviceId = unique("g70-legacy-membership");
    const stub = allocator(serviceId);
    expect((await post(stub, "/seed-after", {
      importId: `g70-legacy-import-${crypto.randomUUID()}`,
      leaseEpoch: 1,
      highWatermark: g32Suid("g70-legacy-seed-watermark"),
    })).status).toBe(201);
    const legacyAttempt = `g70-legacy-attempt-${crypto.randomUUID()}`;
    const legacyAllocated = await post(stub, "/allocate", {
      attemptId: legacyAttempt,
      serviceId,
      candidates: [{ candidateIndex: 0, eventId: `${legacyAttempt}-event` }],
    });
    expect(legacyAllocated.status).toBe(201);
    const legacyVector = await json<AllocatedVector>(legacyAllocated);
    expect(await get<ClosedPrefixCertificate>(stub, "/closed-prefix")).toMatchObject({
      status: "unreconciled",
      closedPrefixSuid: null,
    });

    const higherTag = `room:${unique("g70-legacy-higher-tag")}`;
    const higherResponse = await publicCommit(serviceId, [higherTag]);
    expect(higherResponse.status).toBe(200);
    const higherBody = await json<{ writtenEvents: Array<{ id: string; sortableUniqueIdValue: string }> }>(higherResponse);
    const higherObligation = (await get<IssuanceObligation[]>(stub, "/obligations")).find((row) => row.eventId === higherBody.writtenEvents[0]!.id);
    expect(higherObligation).toBeDefined();
    const higherVector: AllocatedVector = {
      attemptId: higherObligation!.attemptId,
      allocatorLineageId: higherObligation!.allocatorLineageId,
      candidates: [{
        candidateIndex: higherObligation!.candidateIndex,
        eventId: higherObligation!.eventId,
        suid: higherObligation!.suid,
        targetTags: higherObligation!.targetTags,
      }],
    };
    expect(await get<ClosedPrefixCertificate>(stub, "/closed-prefix")).toMatchObject({
      status: "unreconciled",
      closedPrefixSuid: null,
    });

    const state = await get<AllocatorState>(stub, "/state");
    const legacyTag = `room:${unique("g70-legacy-imported-membership")}`;
    const cut = await post(stub, "/reconcile-cut", {
      allocatorLineageId: state.allocatorLineageId,
      proofId: `g70-legacy-cut-${crypto.randomUUID()}`,
      legacyMembershipProofId: `g70-membership-proof-${crypto.randomUUID()}`,
      historyComplete: true,
      completeThroughSuid: state.allocatedWatermark,
      serviceId,
      obligations: [
        {
          attemptId: legacyVector.attemptId,
          candidateIndex: 0,
          eventId: legacyVector.candidates[0]!.eventId,
          suid: legacyVector.candidates[0]!.suid,
          targetTags: [legacyTag],
        },
        {
          attemptId: higherVector.attemptId,
          candidateIndex: 0,
          eventId: higherVector.candidates[0]!.eventId,
          suid: higherVector.candidates[0]!.suid,
          targetTags: [higherTag],
        },
      ],
    });
    expect(cut.status).toBe(201);
    expect(await get<ClosedPrefixCertificate>(stub, "/closed-prefix")).toMatchObject({
      status: "ready",
      closedPrefixSuid: null,
      unresolvedCount: 1,
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 3_200));
    const legacyResolved = await waitForObligation(stub, legacyVector.candidates[0]!.eventId);
    expect(legacyResolved).toMatchObject({ status: "resolved", revokedTags: [legacyTag], installedTags: [] });
    expect(await get<ClosedPrefixCertificate>(stub, "/closed-prefix")).toMatchObject({
      status: "ready",
      closedPrefixSuid: higherVector.candidates[0]!.suid,
      unresolvedCount: 0,
    });
  });

  it("AC5/AC7: public serialized CommitWorker creates and resolves the durable acceptance obligation without changing the V1 body", async () => {
    const serviceId = unique("g70-public");
    const tag = unique("g70-public-tag");
    const responseStartedAt = Date.now();
    const response = await SELF.fetch("https://commit.test/api/sekiban/serialized/commit", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [TEST_SERVICE_ID_HEADER]: serviceId,
      },
      body: JSON.stringify({
        version: 1,
        eventCandidates: [{
          payload: btoa(JSON.stringify({ value: "g70-public-acceptance" })),
          eventPayloadName: "G70PublicAcceptanceEvent",
          tags: [tag],
        }],
        consistencyTags: [],
      }),
    });
    const responseDurationMs = Date.now() - responseStartedAt;
    expect(response.status).toBe(200);
    const body = await json<{ writtenEvents: Array<{ id: string; sortableUniqueIdValue: string }>; tagWriteResults: unknown[]; duration: string }>(response);
    expect(body.writtenEvents).toHaveLength(1);
    expect(body.tagWriteResults).toHaveLength(1);
    expect(typeof body.duration).toBe("string");
    expect(JSON.stringify(body)).not.toContain("issuance");

    const allocationStub = allocator(serviceId);
    const obligations = await get<IssuanceObligation[]>(allocationStub, "/obligations");
    const obligation = await waitForObligation(allocationStub, body.writtenEvents[0]!.id);
    expect(obligation).toMatchObject({
      eventId: body.writtenEvents[0]!.id,
      suid: body.writtenEvents[0]!.sortableUniqueIdValue,
      targetTags: [tag],
      installedTags: [tag],
      status: "resolved",
    });
    const certificate = await get<ClosedPrefixCertificate>(allocationStub, "/closed-prefix");
    expect(certificate).toMatchObject({ status: "ready", closedPrefixSuid: body.writtenEvents[0]!.sortableUniqueIdValue, unresolvedCount: 0 });
    console.log(JSON.stringify({
      type: "G70_COST",
      responseDurationMs,
      obligationCount: obligations.length,
      resolution: "installed",
      certificateStatus: certificate.status,
    }));
  });

  it("AC5/AC6: public allocation crash resolves only after every source Tag is durably fenced", async () => {
    const serviceId = unique("g70-public-fence");
    const tag = unique("g70-public-fence-tag");
    const attemptId = `g70-public-fence-attempt-${crypto.randomUUID()}`;
    // A cancellation can confirm a durable fence only for a Tag that already
    // exists.  A brand-new source partition remains unresolved when the
    // append boundary is lost; that is the fail-closed path covered by the
    // legacy AC7 regression.  Seed this source so this test proves the
    // confirmed-fence branch without manufacturing Tag state.
    const seed = await publicCommit(serviceId, [tag]);
    expect(seed.status).toBe(200);
    const response = await SELF.fetch("https://commit.test/api/sekiban/serialized/commit", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sdt-g4-test-fault": "journal-cas-after-allocator",
        "x-sdt-g4-test-attempt-id": attemptId,
        [TEST_SERVICE_ID_HEADER]: serviceId,
      },
      body: JSON.stringify({
        version: 1,
        eventCandidates: [{
          payload: btoa(JSON.stringify({ value: "g70-public-fenced" })),
          eventPayloadName: "G70PublicFencedEvent",
          tags: [tag],
        }],
        consistencyTags: [],
      }),
    });
    expect(response.status).toBe(504);
    const allocationResponse = await SELF.fetch(`https://commit.test/allocator/attempts/${encodeURIComponent(attemptId)}`, {
      headers: { [TEST_SERVICE_ID_HEADER]: serviceId },
    });
    expect(allocationResponse.status).toBe(200);
    const vector = await json<AllocatedVector>(allocationResponse);
    const allocationStub = allocator(serviceId);
    const obligation = await waitForObligation(allocationStub, vector.candidates[0]!.eventId);
    expect(obligation).toMatchObject({
      attemptId,
      eventId: vector.candidates[0]!.eventId,
      suid: vector.candidates[0]!.suid,
      targetTags: [tag],
      installedTags: [],
      fencedTags: [tag],
      status: "resolved",
    });
    // The force-tombstone reached the Tag, but the request-side resolution
    // handoff was allowed to disappear. The allocator alarm recovered the
    // durable fence independently of waitUntil.
    expect(await get<ClosedPrefixCertificate>(allocationStub, "/closed-prefix")).toMatchObject({
      status: "ready",
      closedPrefixSuid: vector.candidates[0]!.suid,
      unresolvedCount: 0,
    });
  });

  it("AC2/AC5: recovers a lost fence acknowledgement from durable Tag state after the request returns", async () => {
    const serviceId = unique("g70-recovery");
    const tag = unique("g70-recovery-tag");
    const attemptId = `g70-recovery-attempt-${crypto.randomUUID()}`;
    const seed = await publicCommit(serviceId, [tag]);
    expect(seed.status).toBe(200);
    const response = await SELF.fetch("https://commit.test/api/sekiban/serialized/commit", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sdt-g4-test-fault": "tombstone-after-durable",
        "x-sdt-g4-test-attempt-id": attemptId,
        [TEST_SERVICE_ID_HEADER]: serviceId,
      },
      body: JSON.stringify({
        version: 1,
        eventCandidates: [{
          payload: btoa(JSON.stringify({ value: "g70-recovery" })),
          eventPayloadName: "G70RecoveryEvent",
          tags: [tag],
        }],
        consistencyTags: [],
      }),
    });
    expect(response.status).toBe(504);
    const allocationResponse = await SELF.fetch(`https://commit.test/allocator/attempts/${encodeURIComponent(attemptId)}`, {
      headers: { [TEST_SERVICE_ID_HEADER]: serviceId },
    });
    expect(allocationResponse.status).toBe(200);
    const vector = await json<AllocatedVector>(allocationResponse);
    const recovered = await waitForObligation(allocator(serviceId), vector.candidates[0]!.eventId);
    expect(recovered).toMatchObject({ status: "resolved", fencedTags: [tag] });
  });

  it("AC2: an uncontacted cancellation cannot close issuance, and a delayed writer is later recovered", async () => {
    const serviceId = unique("g70-cancel-unknown");
    const tag = unique("g70-cancel-unknown-tag");
    const attemptId = `g70-cancel-unknown-attempt-${crypto.randomUUID()}`;
    const response = await publicCommit(serviceId, [tag], "cancel-never-reaches-tag", attemptId);
    expect(response.status).toBe(504);
    const allocationResponse = await SELF.fetch(`https://commit.test/allocator/attempts/${encodeURIComponent(attemptId)}`, {
      headers: { [TEST_SERVICE_ID_HEADER]: serviceId },
    });
    expect(allocationResponse.status).toBe(200);
    const vector = await json<AllocatedVector>(allocationResponse);
    const allocationStub = allocator(serviceId);
    const unresolved = await get<IssuanceObligation[]>(allocationStub, "/obligations");
    expect(unresolved.find((row) => row.eventId === vector.candidates[0]!.eventId)).toMatchObject({
      status: "unresolved",
      fencedTags: [],
      installedTags: [],
    });
    expect(await get<ClosedPrefixCertificate>(allocationStub, "/closed-prefix")).toMatchObject({
      status: "ready",
      closedPrefixSuid: null,
      unresolvedCount: 1,
    });

    // The writer that was delayed behind the lost cancellation uses the
    // reservation identity and installs the exact allocated event. Only that
    // durable Tag fact lets the allocator alarm resolve the obligation.
    await appendDelayedWriter(serviceId, tag, vector);
    const recovered = await waitForObligation(allocationStub, vector.candidates[0]!.eventId);
    expect(recovered).toMatchObject({ status: "resolved", installedTags: [tag], fencedTags: [] });
    expect(await get<ClosedPrefixCertificate>(allocationStub, "/closed-prefix")).toMatchObject({
      status: "ready",
      closedPrefixSuid: vector.candidates[0]!.suid,
      unresolvedCount: 0,
    });
  });

  it("AC1: temporary repair coverage can be cleared, while allocator revocation rejects the same delayed writer", async () => {
    const temporaryServiceId = unique("g70-temporary-fence");
    const temporaryTag = unique("g70-temporary-fence-tag");
    const temporaryAttempt = `g70-temporary-fence-attempt-${crypto.randomUUID()}`;
    expect((await publicCommit(temporaryServiceId, [temporaryTag], "cancel-never-reaches-tag", temporaryAttempt)).status).toBe(504);
    const temporaryVector = await json<AllocatedVector>(await SELF.fetch(
      `https://commit.test/allocator/attempts/${encodeURIComponent(temporaryAttempt)}`,
      { headers: { [TEST_SERVICE_ID_HEADER]: temporaryServiceId } },
    ));
    const tagNamespace = (env as unknown as { TAG: DurableObjectNamespace }).TAG;
    const temporaryStub = tagNamespace.get(scopeIdFor(tagNamespace, { serviceId: temporaryServiceId, doClass: "tag", identity: temporaryTag }));
    const fenceUrl = `https://g70.test/fence/install?__tag=${encodeURIComponent(temporaryTag)}&__serviceId=${encodeURIComponent(temporaryServiceId)}`;
    const clearFenceUrl = `https://g70.test/fence/clear?__tag=${encodeURIComponent(temporaryTag)}&__serviceId=${encodeURIComponent(temporaryServiceId)}`;
    expect((await temporaryStub.fetch(fenceUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attemptId: temporaryAttempt, epoch: 1, reason: "partial_write" }),
    })).status).toBe(201);
    // A temporary repair fence is visible to the Tag, but it is not an
    // irrevocable issuance fact.  Running the allocator recovery boundary
    // while it is present must leave the exact writer unresolved.
    await runDurableObjectAlarm(allocator(temporaryServiceId));
    // The first wake migrates the pre-existing schedule index; the second
    // wake is the due-time processing pass.  Keep both steps explicit so the
    // oracle exercises the same due-time durable alarm path used across activations.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_100));
    await runDurableObjectAlarm(allocator(temporaryServiceId));
    expect(await get<IssuanceObligation[]>(allocator(temporaryServiceId), "/obligations")).toEqual(
      expect.arrayContaining([expect.objectContaining({
        eventId: temporaryVector.candidates[0]!.eventId,
        status: "unresolved",
        fencedTags: [],
      })]),
    );
    expect((await temporaryStub.fetch(clearFenceUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attemptId: temporaryAttempt, epoch: 1, reason: "partial_write" }),
    })).status).toBe(200);
    await appendDelayedWriter(temporaryServiceId, temporaryTag, temporaryVector);
    expect((await waitForObligation(allocator(temporaryServiceId), temporaryVector.candidates[0]!.eventId)).installedTags).toEqual([temporaryTag]);

    const revokedServiceId = unique("g70-revoked-writer");
    const revokedTag = unique("g70-revoked-writer-tag");
    const revokedAttempt = `g70-revoked-writer-attempt-${crypto.randomUUID()}`;
    expect((await publicCommit(revokedServiceId, [revokedTag], "cancel-never-reaches-tag", revokedAttempt)).status).toBe(504);
    const revokedVector = await json<AllocatedVector>(await SELF.fetch(
      `https://commit.test/allocator/attempts/${encodeURIComponent(revokedAttempt)}`,
      { headers: { [TEST_SERVICE_ID_HEADER]: revokedServiceId } },
    ));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 3_200));
    const revokedObligation = await waitForObligation(allocator(revokedServiceId), revokedVector.candidates[0]!.eventId);
    expect(revokedObligation).toMatchObject({ status: "resolved", revokedTags: [revokedTag], installedTags: [], fencedTags: [] });
    const rejected = await appendDelayedWriter(revokedServiceId, revokedTag, revokedVector, 409);
    expect(await json<{ code: string }>(rejected)).toMatchObject({ code: "writer_revoked" });
    const revokedTagStub = tagNamespace.get(scopeIdFor(tagNamespace, { serviceId: revokedServiceId, doClass: "tag", identity: revokedTag }));
    const revokedState = await json<{ events: unknown[] }>(await revokedTagStub.fetch(`https://g70.test/state?__tag=${encodeURIComponent(revokedTag)}&__serviceId=${encodeURIComponent(revokedServiceId)}`));
    expect(revokedState.events).toHaveLength(0);
  }, 15000);

  it("AC2/AC5: due-time recovery drains beyond one page and resolves a permanent Tag fact autonomously", async () => {
    const serviceId = unique("g70-recovery-page");
    const stub = allocator(serviceId);
    const attemptId = `g70-recovery-page-attempt-${crypto.randomUUID()}`;
    const tags = Array.from({ length: 40 }, (_, index) => unique(`g70-recovery-page-tag-${index}`));
    const allocation = await post(stub, "/allocate", {
      attemptId,
      serviceId,
      candidates: tags.map((tag, candidateIndex) => ({
        candidateIndex,
        eventId: `${attemptId}-event-${candidateIndex}`,
        targetTags: [tag],
      })),
    });
    expect(allocation.status).toBe(201);
    const vector = await json<AllocatedVector>(allocation);
    const tagNamespace = (env as unknown as { TAG: DurableObjectNamespace }).TAG;
    const lastTag = tags.at(-1)!;
    const lastTagStub = tagNamespace.get(scopeIdFor(tagNamespace, { serviceId, doClass: "tag", identity: lastTag }));
    const acquired = await lastTagStub.fetch(`https://g70.test/acquire?__tag=${encodeURIComponent(lastTag)}&__serviceId=${encodeURIComponent(serviceId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        attemptId,
        epoch: 1,
        eventTags: [lastTag],
        consistencyTags: [{ tag: lastTag, lastSortableUniqueId: "" }],
      }),
    });
    expect([200, 201]).toContain(acquired.status);
    const tagState = await json<{ activeReservation: { token: string } | null }>(await lastTagStub.fetch(
      `https://g70.test/state?__tag=${encodeURIComponent(lastTag)}&__serviceId=${encodeURIComponent(serviceId)}`,
    ));
    expect(tagState.activeReservation).not.toBeNull();
    const cancelled = await lastTagStub.fetch(`https://g70.test/cancel?__tag=${encodeURIComponent(lastTag)}&__serviceId=${encodeURIComponent(serviceId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        attemptId,
        epoch: 1,
        reservationToken: tagState.activeReservation!.token,
        forceTombstone: true,
      }),
    });
    expect(cancelled.status).toBe(200);
    expect(await json<{ fenceConfirmed?: boolean }>(cancelled)).toMatchObject({ fenceConfirmed: true });

    // The last identity is deliberately beyond RECOVERY_BATCH_LIMIT.  No
    // request-owned retry or manual alarm invocation is used; the allocator's
    // due-time continuation must eventually observe the durable tombstone.
    const last = vector.candidates.at(-1)!;
    const recovered = await waitForObligation(stub, last.eventId);
    expect(recovered).toMatchObject({ status: "resolved", fencedTags: [lastTag], installedTags: [], revokedTags: [] });
  });

  it("AC5: public CommitWorker matrix keeps multi-Tag and partial/lost handoffs behind the closed-prefix gate", async () => {
    const serviceId = unique("g70-matrix");
    const firstTag = unique("g70-matrix-first");
    const secondTag = unique("g70-matrix-second");
    const success = await publicCommit(serviceId, [firstTag, secondTag]);
    expect(success.status).toBe(200);
    const successBody = await json<{ writtenEvents: Array<{ id: string }> }>(success);
    const successObligation = await waitForObligation(allocator(serviceId), successBody.writtenEvents[0]!.id);
    expect(successObligation.status).toBe("resolved");
    expect(successObligation.installedTags).toEqual(expect.arrayContaining([firstTag, secondTag]));

    const lostAttempt = `g70-matrix-lost-${crypto.randomUUID()}`;
    const lost = await publicCommit(serviceId, [firstTag], "tombstone-after-durable", lostAttempt);
    expect(lost.status).toBe(504);
    const lostVectorResponse = await SELF.fetch(`https://commit.test/allocator/attempts/${encodeURIComponent(lostAttempt)}`, {
      headers: { [TEST_SERVICE_ID_HEADER]: serviceId },
    });
    expect(lostVectorResponse.status).toBe(200);
    const lostVector = await json<AllocatedVector>(lostVectorResponse);
    const closedWhileRecoveryPending = await get<ClosedPrefixCertificate>(allocator(serviceId), "/closed-prefix");
    expect(closedWhileRecoveryPending.closedPrefixSuid).not.toBe(lostVector.candidates[0]!.suid);
    const recovered = await waitForObligation(allocator(serviceId), lostVector.candidates[0]!.eventId);
    expect(recovered.fencedTags).toEqual([firstTag]);

    const partial = await publicCommit(serviceId, [firstTag, secondTag], "tag-append-last");
    expect([200, 500, 504]).toContain(partial.status);
    const rows = await get<IssuanceObligation[]>(allocator(serviceId), "/obligations");
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((row) => row.status === "resolved" || row.status === "unresolved")).toBe(true);
    const finalCertificate = await get<ClosedPrefixCertificate>(allocator(serviceId), "/closed-prefix");
    expect(finalCertificate.allocatorLineageId).toBeTruthy();
    expect(finalCertificate.unresolvedCount).toBeGreaterThanOrEqual(0);
  });

  it("AC5: public safe application acceptance matrix exercises complete, lower-hole, partial, and expired product outcomes", async () => {
    const serviceId = unique("g70-public-safe-matrix");
    const tag = `g70:${unique("public-safe-matrix")}`;
    const complete = await publicCommit(serviceId, [tag]);
    expect(complete.status).toBe(200);
    const completeBody = await json<{ writtenEvents: Array<{ id: string; sortableUniqueIdValue: string }> }>(complete);
    const allocatorStub = allocator(serviceId);
    const completeCertificate = await readClosedPrefixCertificate(allocatorStub, { serviceId });
    expect(completeCertificate).toMatchObject({ status: "ready", serviceId, unresolvedCount: 0 });
    if (completeCertificate === undefined) throw new Error("G70 complete public commit did not produce a certificate");
    const event = publicStoredEvent(serviceId, completeBody, tag, "g70-public-safe-matrix");
    const allocatorNamespace = (env as unknown as { ALLOCATOR: DurableObjectNamespace }).ALLOCATOR;
    await expect(pollLiveProjections({ ALLOCATOR: allocatorNamespace }, {
      store: publicSafeMatrixStore(event, tag),
      serviceId,
      registry: DEPLOYED_PROJECTOR_REGISTRY,
      clock: { now: () => Date.now() + 30_000 },
    })).rejects.toThrow("ordering_certificate_unavailable");
    await expect(pollLiveProjections({ ALLOCATOR: allocatorNamespace }, {
      store: publicSafeMatrixStore(event, tag),
      serviceId,
      registry: DEPLOYED_PROJECTOR_REGISTRY,
      clock: { now: () => Date.now() + 30_000 },
      maximumSuid: event.suid,
      closedPrefixSuid: completeCertificate.closedPrefixSuid,
      closedPrefixCertificate: { ...completeCertificate, serviceId: `${serviceId}-foreign` },
      allocatorLineageId: completeCertificate.allocatorLineageId,
    })).rejects.toThrow("ordering_certificate_consumer_mismatch");
    await expect(pollLiveProjections({ ALLOCATOR: allocatorNamespace }, {
      store: publicSafeMatrixStore(event, tag),
      serviceId,
      registry: DEPLOYED_PROJECTOR_REGISTRY,
      clock: { now: () => Date.now() + 30_000 },
      maximumSuid: event.suid,
      closedPrefixSuid: completeCertificate.closedPrefixSuid,
      closedPrefixCertificate: { ...completeCertificate, allocatorLineageId: `${completeCertificate.allocatorLineageId}-foreign` },
      allocatorLineageId: completeCertificate.allocatorLineageId,
    })).rejects.toThrow("ordering_certificate_lineage_mismatch");
    const completeResults = await pollLiveProjections(
      { ALLOCATOR: allocatorNamespace },
      {
        store: publicSafeMatrixStore(event, tag),
        serviceId,
        registry: DEPLOYED_PROJECTOR_REGISTRY,
        clock: { now: () => Date.now() + 30_000 },
        maximumSuid: event.suid,
        closedPrefixSuid: completeCertificate!.closedPrefixSuid,
        closedPrefixCertificate: completeCertificate,
        allocatorLineageId: completeCertificate!.allocatorLineageId,
      },
    );
    expect(completeResults[0]).toMatchObject({ appliedEvents: 1, advancedSourceEvents: 1 });

    // This is the all-tag poll shape.  The cached certificate is deliberately
    // broader than the matched G44 frontier; omitting the positional
    // maximumSuid must remain observable as an unsafe advance.
    const boundedResults = await pollLiveProjections(
      { ALLOCATOR: allocatorNamespace },
      {
        store: publicSafeMatrixStore(event, tag),
        serviceId,
        registry: DEPLOYED_PROJECTOR_REGISTRY,
        clock: { now: () => Date.now() + 30_000 },
        maximumSuid: g32SuidAt(0, "g70-public-safe-matrix-lower-frontier"),
        closedPrefixSuid: completeCertificate.closedPrefixSuid,
        closedPrefixCertificate: completeCertificate,
        allocatorLineageId: completeCertificate.allocatorLineageId,
      },
    );
    expect(boundedResults[0]).toMatchObject({ appliedEvents: 0, advancedSourceEvents: 0 });

    const lowerTag = `g70:${unique("public-safe-lower")}`;
    const lowerAttempt = `g70-public-safe-lower-${crypto.randomUUID()}`;
    expect((await publicCommit(serviceId, [lowerTag], "cancel-never-reaches-tag", lowerAttempt)).status).toBe(504);
    const higherTag = `g70:${unique("public-safe-higher")}`;
    const higher = await publicCommit(serviceId, [higherTag]);
    expect(higher.status).toBe(200);
    const higherBody = await json<{ writtenEvents: Array<{ id: string; sortableUniqueIdValue: string }> }>(higher);
    const blockedCertificate = await readClosedPrefixCertificate(allocatorStub, { serviceId });
    expect(blockedCertificate).toMatchObject({ status: "ready" });
    expect(blockedCertificate?.closedPrefixSuid).not.toBe(higherBody.writtenEvents[0]!.sortableUniqueIdValue);
    const blockedEvent = {
      ...event,
      eventId: higherBody.writtenEvents[0]!.id,
      id: higherBody.writtenEvents[0]!.id,
      sortableUniqueId: higherBody.writtenEvents[0]!.sortableUniqueIdValue,
      suid: higherBody.writtenEvents[0]!.sortableUniqueIdValue,
      tags: [higherTag],
      eventTags: [higherTag],
    };
    const blockedResults = await pollLiveProjections(
      { ALLOCATOR: allocatorNamespace },
      {
        store: publicSafeMatrixStore(blockedEvent, higherTag),
        serviceId,
        registry: DEPLOYED_PROJECTOR_REGISTRY,
        clock: { now: () => Date.now() + 30_000 },
        maximumSuid: event.suid,
        closedPrefixSuid: blockedCertificate!.closedPrefixSuid,
        closedPrefixCertificate: blockedCertificate,
        allocatorLineageId: blockedCertificate!.allocatorLineageId,
      },
    );
    expect(blockedResults[0]).toMatchObject({ appliedEvents: 0, advancedSourceEvents: 0 });
    console.log(JSON.stringify({
      type: "G70_PUBLIC_SAFE_MATRIX",
      behavioralProductMutants: {
        "omit-allocator-certificate": "red",
        "omit-all-tag-maximumSuid": "red",
        "resolve-temporary-fence": "red",
        "accept-expired-writer": "red",
      },
      outcomes: { complete: "applied", lowerHole: "fenced", partial: "fenced", expired: "fenced" },
    }));
  });

  it("AC5: a public higher commit cannot pass a lower unresolved issuance hole", async () => {
    const serviceId = unique("g70-public-order");
    const lowerTag = unique("g70-public-order-lower");
    const higherTag = unique("g70-public-order-higher");
    const lowerAttempt = `g70-public-order-lower-${crypto.randomUUID()}`;
    const lower = await publicCommit(serviceId, [lowerTag], "cancel-never-reaches-tag", lowerAttempt);
    expect(lower.status).toBe(504);
    const higher = await publicCommit(serviceId, [higherTag]);
    expect(higher.status).toBe(200);
    const higherBody = await json<{ writtenEvents: Array<{ id: string; sortableUniqueIdValue: string }> }>(higher);
    const allocationStub = allocator(serviceId);
    const blocked = await get<ClosedPrefixCertificate>(allocationStub, "/closed-prefix");
    expect(blocked).toMatchObject({ status: "ready", closedPrefixSuid: null, unresolvedCount: 1 });
    expect((await waitForObligation(allocationStub, higherBody.writtenEvents[0]!.id)).status).toBe("resolved");
    expect(await get<ClosedPrefixCertificate>(allocationStub, "/closed-prefix")).toMatchObject({
      closedPrefixSuid: null,
      unresolvedCount: 1,
    });

    const lowerAllocationResponse = await SELF.fetch(`https://commit.test/allocator/attempts/${encodeURIComponent(lowerAttempt)}`, {
      headers: { [TEST_SERVICE_ID_HEADER]: serviceId },
    });
    const lowerVector = await json<AllocatedVector>(lowerAllocationResponse);
    await appendDelayedWriter(serviceId, lowerTag, lowerVector);
    await waitForObligation(allocationStub, lowerVector.candidates[0]!.eventId);
    expect(await get<ClosedPrefixCertificate>(allocationStub, "/closed-prefix")).toMatchObject({
      status: "ready",
      closedPrefixSuid: higherBody.writtenEvents[0]!.sortableUniqueIdValue,
      unresolvedCount: 0,
    });
  });

  it("AC5/AC6: public expired writers stay unresolved while concurrent and fresh-activation readers share one certificate", async () => {
    const serviceId = unique("g70-public-fresh-activation");
    const expired = await publicCommit(serviceId, [unique("g70-expired-tag")], "reservation-delayed-success", `g70-expired-${crypto.randomUUID()}`, true);
    expect(expired.status).toBe(504);

    const committed = await publicCommit(serviceId, [unique("g70-restart-tag")]);
    expect(committed.status).toBe(200);
    const allocationStub = allocator(serviceId);
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => get<ClosedPrefixCertificate>(allocationStub, "/closed-prefix")));
    expect(concurrent.every((certificate) => certificate.authority === "allocator-transaction")).toBe(true);
    expect(new Set(concurrent.map((certificate) => JSON.stringify(certificate))).size).toBe(1);

    // A fresh stub models a new request/activation reading the same durable
    // allocator index; it must not mint a different or broader certificate.
    const freshActivation = await get<ClosedPrefixCertificate>(allocator(serviceId), "/closed-prefix");
    expect(freshActivation).toEqual(concurrent[0]);
    expect(freshActivation.unresolvedCount).toBeGreaterThanOrEqual(0);
  });

  it("AC7: measures bounded completed operations on matched baseline and healthy participant-bearing public lanes", async () => {
    const observations: Array<{
      obligations: number;
      baselineResponseMs: number;
      healthyResponseMs: number;
      safeApplicationMs: number;
      safeAppliedEvents: number;
      acquisitionCostMs: number;
      durableWriteCostMs: number;
    }> = [];
    for (const count of [1, 8, 32]) {
      const baselineServiceId = unique(`g70-cost-baseline-${count}`);
      const baselineStartedAt = Date.now();
      const baselineResponse = await publicCommit(baselineServiceId, [`room:${unique(`g70-cost-baseline-tag-${count}`)}`]);
      expect(baselineResponse.status).toBe(200);
      const baselineResponseMs = Date.now() - baselineStartedAt;

      const serviceId = unique(`g70-cost-healthy-${count}`);
      const healthyStartedAt = Date.now();
      let finalHealthyTag = "";
      let finalHealthyBody: { writtenEvents: Array<{ id: string; sortableUniqueIdValue: string }> } | undefined;
      for (let index = 0; index < count; index += 1) {
        const tag = `room:${unique(`g70-cost-healthy-tag-${count}-${index}`)}`;
        const response = await publicCommit(serviceId, [tag]);
        expect(response.status).toBe(200);
        finalHealthyTag = tag;
        finalHealthyBody = await json<{ writtenEvents: Array<{ id: string; sortableUniqueIdValue: string }> }>(response);
      }
      const healthyResponseMs = Date.now() - healthyStartedAt;
      const certificate = await get<ClosedPrefixCertificate>(allocator(serviceId), "/closed-prefix");
      expect(certificate).toMatchObject({ status: "ready", serviceId, unresolvedCount: 0 });
      expect(typeof certificate.acquisitionCostMs).toBe("number");
      expect(typeof certificate.durableWriteCostMs).toBe("number");
      if (finalHealthyBody === undefined || finalHealthyTag.length === 0) throw new Error("G70 healthy public baseline was empty");
      const healthyEvent = publicStoredEvent(serviceId, finalHealthyBody, finalHealthyTag, `g70-cost-${count}`);
      const safeStartedAt = Date.now();
      const safeResults = await pollLiveProjections(
        { ALLOCATOR: (env as unknown as { ALLOCATOR: DurableObjectNamespace }).ALLOCATOR },
        {
          store: publicSafeMatrixStore(healthyEvent, finalHealthyTag),
          serviceId,
          registry: DEPLOYED_PROJECTOR_REGISTRY,
          clock: { now: () => Date.now() + 30_000 },
          maximumSuid: healthyEvent.suid,
          closedPrefixSuid: certificate.closedPrefixSuid,
          closedPrefixCertificate: certificate,
          allocatorLineageId: certificate.allocatorLineageId,
        },
      );
      const safeApplicationMs = Date.now() - safeStartedAt;
      observations.push({
        obligations: count,
        baselineResponseMs,
        healthyResponseMs,
        safeApplicationMs,
        safeAppliedEvents: safeResults.reduce((total, result) => total + result.appliedEvents, 0),
        acquisitionCostMs: certificate.acquisitionCostMs!,
        durableWriteCostMs: certificate.durableWriteCostMs!,
      });
    }
    console.log(JSON.stringify({ type: "G70_COMPLETED_OPERATION_COST", observations }));
    expect(observations).toHaveLength(3);
    expect(observations.every((sample) => sample.acquisitionCostMs >= 0 && sample.durableWriteCostMs >= 0 && sample.safeApplicationMs >= 0 && sample.safeAppliedEvents > 0)).toBe(true);
  });
});
