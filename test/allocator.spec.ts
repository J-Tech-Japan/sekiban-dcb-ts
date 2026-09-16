import { abortAllDurableObjects, env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type {
  AllocationCandidate,
  AllocationVector,
  AllocatorState,
} from "../packages/dcb-runtime/src/allocator/types";
import { scopeIdFor } from "../packages/dcb-runtime/src/scope/ScopeName";

async function allocatorRequest(path: string, body?: unknown): Promise<Response> {
  const init =
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        };
  return SELF.fetch(`https://allocator.test/allocator${path}`, init);
}

async function namedAllocatorRequest(name: string, path: string, body?: unknown): Promise<Response> {
  const init =
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        };
  const namespace = (env as unknown as { ALLOCATOR: DurableObjectNamespace }).ALLOCATOR;
  const stub = namespace.get(scopeIdFor(namespace, { serviceId: name, doClass: "allocator", identity: "allocator" }));
  return stub.fetch(`https://${name}.allocator.test${path}`, init);
}

async function responseJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function newAttempt(): string {
  return crypto.randomUUID();
}

function unique(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function allocationCandidates(attemptId: string, count = 3): AllocationCandidate[] {
  return Array.from({ length: count }, (_, candidateIndex) => ({
    candidateIndex,
    eventId: `${attemptId}-event-${candidateIndex + 1}`,
  }));
}

async function allocatorState(): Promise<AllocatorState> {
  const response = await allocatorRequest("/state");
  expect(response.status).toBe(200);
  return responseJson<AllocatorState>(response);
}

async function allocation(attemptId: string): Promise<AllocationVector> {
  const response = await allocatorRequest(`/attempts/${encodeURIComponent(attemptId)}`);
  expect(response.status).toBe(200);
  return responseJson<AllocationVector>(response);
}

async function allocate(
  attemptId: string,
  candidates = allocationCandidates(attemptId),
  faultInjection?: "between-vector-and-watermark",
): Promise<Response> {
  return allocatorRequest("/allocate", { attemptId, candidates, faultInjection });
}

function expectOrderedVector(vector: AllocationVector, expected: AllocationCandidate[]): void {
  expect(vector.attemptId).toBeDefined();
  expect(vector.allocatorLineageId.length).toBeGreaterThan(0);
  expect(vector.candidates.map(({ candidateIndex, eventId }) => ({ candidateIndex, eventId }))).toEqual(expected);
  const suids = vector.candidates.map((candidate) => candidate.suid);
  expect(new Set(suids).size).toBe(suids.length);
  expect(suids).toEqual([...suids].sort());
}

describe("AllocatorDurableObject", () => {
  it("generates distinct lineage tokens for independent namespaces and preserves one across restart", async () => {
    const firstNamespace = unique("g17-lineage-first");
    const secondNamespace = unique("g17-lineage-second");
    const firstState = await responseJson<AllocatorState>(await namedAllocatorRequest(firstNamespace, "/state"));
    const secondState = await responseJson<AllocatorState>(await namedAllocatorRequest(secondNamespace, "/state"));
    expect(firstState.allocatorLineageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondState.allocatorLineageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondState.allocatorLineageId).not.toBe(firstState.allocatorLineageId);

    const restartNamespace = unique("g17-lineage-restart");
    const beforeRestart = await responseJson<AllocatorState>(await namedAllocatorRequest(restartNamespace, "/state"));
    await abortAllDurableObjects();
    const afterRestart = await responseJson<AllocatorState>(await namedAllocatorRequest(restartNamespace, "/state"));
    expect(afterRestart.allocatorLineageId).toBe(beforeRestart.allocatorLineageId);
  });

  it("commits each complete ordered vector and its watermark in one transaction", async () => {
    const before = await allocatorState();
    const interruptedAttempt = newAttempt();
    const interrupted = await allocate(
      interruptedAttempt,
      allocationCandidates(interruptedAttempt),
      "between-vector-and-watermark",
    );
    expect(interrupted.status).toBe(503);
    expect((await allocatorRequest(`/attempts/${interruptedAttempt}`)).status).toBe(404);
    expect(await allocatorState()).toEqual(before);

    const attemptId = newAttempt();
    const requested = allocationCandidates(attemptId);
    const response = await allocate(attemptId, [...requested].reverse());
    expect(response.status).toBe(201);
    const vector = await responseJson<AllocationVector>(response);
    expectOrderedVector(vector, requested);
    if (before.allocatedWatermark !== null) {
      expect(vector.candidates[0]!.suid > before.allocatedWatermark).toBe(true);
    }

    const after = await allocatorState();
    expect(after.allocatedWatermark).toBe(vector.candidates[vector.candidates.length - 1]!.suid);
    expect(await allocation(attemptId)).toEqual(vector);
  });

  it("returns the exact durable vector for a repeated attempt without advancing the watermark", async () => {
    const attemptId = newAttempt();
    const initial = await allocate(attemptId);
    expect(initial.status).toBe(201);
    const first = await responseJson<AllocationVector>(initial);
    const stateAfterFirst = await allocatorState();

    const replay = await allocate(attemptId, allocationCandidates(newAttempt(), 1));
    expect(replay.status).toBe(200);
    expect(await responseJson<AllocationVector>(replay)).toEqual(first);
    expect(await allocation(attemptId)).toEqual(first);
    expect(await allocatorState()).toEqual(stateAfterFirst);

    const concurrentAttempt = newAttempt();
    const concurrentCandidates = allocationCandidates(concurrentAttempt);
    const [left, right] = await Promise.all([
      allocate(concurrentAttempt, concurrentCandidates),
      allocate(concurrentAttempt, [...concurrentCandidates].reverse()),
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 201]);
    expect(await responseJson<AllocationVector>(left)).toEqual(await responseJson<AllocationVector>(right));
  });

  it("serializes concurrent attempts into unique, monotonic SUID ranges", async () => {
    const before = await allocatorState();
    const requests = Array.from({ length: 12 }, async () => {
      const attemptId = newAttempt();
      const response = await allocate(attemptId, allocationCandidates(attemptId));
      expect(response.status).toBe(201);
      return responseJson<AllocationVector>(response);
    });
    const vectors = await Promise.all(requests);
    const suids = vectors.flatMap((vector) => vector.candidates.map((candidate) => candidate.suid));
    const ordered = [...suids].sort();

    expect(new Set(suids).size).toBe(suids.length);
    if (before.allocatedWatermark !== null) {
      expect(ordered[0]! > before.allocatedWatermark).toBe(true);
    }
    for (const vector of vectors) {
      expectOrderedVector(vector, allocationCandidates(vector.attemptId));
    }
    expect((await allocatorState()).allocatedWatermark).toBe(ordered[ordered.length - 1]);
  });

  it("G77 registers issuance ledger facts atomically when membership is supplied", async () => {
    const serviceId = `g77-allocator-${crypto.randomUUID()}`;
    const attemptId = newAttempt();
    const tag = "room:g77:allocator";
    const response = await namedAllocatorRequest(serviceId, "/allocate", {
      attemptId,
      serviceId,
      candidates: [{
        candidateIndex: 0,
        eventId: `${attemptId}-event`,
        targetTags: [tag],
        pinnedWriterEpoch: 0,
      }],
    });
    expect(response.status).toBe(201);
    const probe = await namedAllocatorRequest(serviceId, `/__internal/g77/registration/${encodeURIComponent(attemptId)}/0`);
    expect(probe.status).toBe(200);
    expect(await responseJson<{
      envelope: boolean;
      unresolvedIndex: boolean;
      issuedIndex: boolean;
      exactCount: boolean;
      recoverySchedule: boolean;
    }>(probe)).toEqual({
      envelope: true,
      unresolvedIndex: true,
      issuedIndex: true,
      exactCount: true,
      recoverySchedule: true,
    });
  });

  it("G77 rolls back issuance ledger facts with between-vector-and-watermark", async () => {
    const serviceId = `g77-rollback-${crypto.randomUUID()}`;
    const attemptId = newAttempt();
    const response = await namedAllocatorRequest(serviceId, "/allocate", {
      attemptId,
      serviceId,
      candidates: [{
        candidateIndex: 0,
        eventId: `${attemptId}-event`,
        targetTags: ["room:g77:rollback"],
        pinnedWriterEpoch: 0,
      }],
      faultInjection: "between-vector-and-watermark",
    });
    expect(response.status).toBe(503);
    const probe = await namedAllocatorRequest(serviceId, `/__internal/g77/registration/${encodeURIComponent(attemptId)}/0`);
    expect(probe.status).toBe(200);
    const rolledBack = await responseJson<{
      envelope: boolean;
      unresolvedIndex: boolean;
      issuedIndex: boolean;
    }>(probe);
    expect(rolledBack.envelope).toBe(false);
    expect(rolledBack.unresolvedIndex).toBe(false);
    expect(rolledBack.issuedIndex).toBe(false);
  });

  it("continues from the persisted watermark and preserves an allocated vector across restart", async () => {
    const beforeRestartAttempt = newAttempt();
    const beforeRestart = await allocate(beforeRestartAttempt, allocationCandidates(beforeRestartAttempt, 1));
    expect(beforeRestart.status).toBe(201);
    const persistedWatermark = (await allocatorState()).allocatedWatermark;
    expect(persistedWatermark).not.toBeNull();

    await abortAllDurableObjects();

    const afterRestartAttempt = newAttempt();
    const afterRestart = await allocate(afterRestartAttempt, allocationCandidates(afterRestartAttempt, 2));
    expect(afterRestart.status).toBe(201);
    const afterRestartVector = await responseJson<AllocationVector>(afterRestart);
    for (const candidate of afterRestartVector.candidates) {
      expect(candidate.suid > persistedWatermark!).toBe(true);
    }

    const replay = await allocate(afterRestartAttempt, allocationCandidates(newAttempt(), 1));
    expect(replay.status).toBe(200);
    expect(await responseJson<AllocationVector>(replay)).toEqual(afterRestartVector);
  });
});
