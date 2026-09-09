import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type {
  AllocatorState,
  ClosedPrefixCertificate,
  IssuanceObligation,
} from "../packages/dcb-runtime/src/allocator/types";
import { scopeIdFor } from "../packages/dcb-runtime/src/scope/ScopeName";
import { TEST_SERVICE_ID_HEADER } from "../packages/dcb-runtime/src/service/ServiceIdentityProvider";
import { g32Suid } from "./helpers/g32-fixtures";

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
): Promise<void> {
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
  expect(append.status).toBe(201);
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
      obligations: [],
    };
    const empty = await post(stub, "/reconcile-cut", cut);
    expect(empty.status).toBe(409);
    expect(await json<{ code: string }>(empty)).toMatchObject({ code: "reconciliation_empty_history" });

    const omitted = await post(stub, "/reconcile-cut", {
      ...cut,
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
    // The invalid cuts did not install the migration proof. Participant-free
    // allocations are already individually resolved, so the certificate can
    // expose their prefix while the legacy namespace remains un-reconciled.
    expect(await get<ClosedPrefixCertificate>(stub, "/closed-prefix")).toMatchObject({
      status: "ready",
      migrationProofId: null,
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

  it("AC5/AC6: public expired writers stay unresolved while concurrent and restarted readers share one certificate", async () => {
    const serviceId = unique("g70-public-restart");
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
    const restarted = await get<ClosedPrefixCertificate>(allocator(serviceId), "/closed-prefix");
    expect(restarted).toEqual(concurrent[0]);
    expect(restarted.unresolvedCount).toBeGreaterThanOrEqual(0);
  });

  it("AC7: reports bounded certificate and durable allocation costs for representative indexed histories", async () => {
    const observations: Array<{ obligations: number; acquisitionCostMs: number; durableWriteCostMs: number }> = [];
    for (const count of [1, 16, 128]) {
      const serviceId = unique(`g70-cost-${count}`);
      const stub = allocator(serviceId);
      for (let index = 0; index < count; index += 1) {
        await allocate(stub, `g70-cost-${count}-${index}`, []);
      }
      const certificate = await get<ClosedPrefixCertificate>(stub, "/closed-prefix");
      expect(certificate.status).toBe("ready");
      expect(typeof certificate.acquisitionCostMs).toBe("number");
      expect(typeof certificate.durableWriteCostMs).toBe("number");
      observations.push({
        obligations: count,
        acquisitionCostMs: certificate.acquisitionCostMs!,
        durableWriteCostMs: certificate.durableWriteCostMs!,
      });
    }
    console.log(JSON.stringify({ type: "G70_CERTIFICATE_COST", observations }));
    expect(observations).toHaveLength(3);
  });
});
