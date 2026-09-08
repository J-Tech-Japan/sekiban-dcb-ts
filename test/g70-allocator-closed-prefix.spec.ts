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
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const obligations = await get<IssuanceObligation[]>(stub, "/obligations");
    last = obligations.find((candidate) => candidate.eventId === eventId);
    if (last?.status === "resolved") return last;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 4));
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
      highWatermark: g32Suid("g70-seed-high-watermark"),
    })).status).toBe(201);
    const seededState = await get<AllocatorState>(seeded, "/state");
    const beforeCut = await get<ClosedPrefixCertificate>(seeded, "/closed-prefix");
    expect(beforeCut).toMatchObject({ status: "unreconciled", closedPrefixSuid: null });
    const importedSuid = g32Suid("g70-imported-event");
    expect((await post(seeded, "/reconcile-cut", {
      allocatorLineageId: seededState.allocatorLineageId,
      proofId: "g70-reconciliation-proof",
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
    expect(await get<ClosedPrefixCertificate>(allocationStub, "/closed-prefix")).toMatchObject({
      status: "ready",
      closedPrefixSuid: vector.candidates[0]!.suid,
      unresolvedCount: 0,
    });
  });
});
