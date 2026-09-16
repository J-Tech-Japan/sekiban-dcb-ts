import { abortAllDurableObjects, env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type {
  AllocationCandidate,
  AllocationVector,
  AllocatorState,
  ClosedPrefixCertificate,
} from "../packages/dcb-runtime/src/allocator/types";
import {
  applyTargetResolution,
  ISSUANCE_NEVER_CONTACTED_GRACE_MS,
  issuedIndexKey,
  predecessorIssuedSuid,
  shouldArmIssuanceRecovery,
  unresolvedIndexKey,
} from "../packages/dcb-runtime/src/allocator/IssuanceLedger";
import { G32_FIXTURE_TIMESTAMP, g32EventId, g32Suid } from "./helpers/g32-fixtures";
import { reconcileIssuanceBatch } from "../packages/dcb-runtime/src/allocator/IssuanceReconciler";
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

async function namedAllocatorRequest(
  name: string,
  path: string,
  body?: unknown,
  suppressRecoveryAlarm = false,
): Promise<Response> {
  const init =
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(suppressRecoveryAlarm ? { "x-sdt-g77-suppress-recovery-alarm": "1" } : {}),
          },
          body: JSON.stringify(body),
        };
  const namespace = (env as unknown as { ALLOCATOR: DurableObjectNamespace }).ALLOCATOR;
  const stub = namespace.get(scopeIdFor(namespace, { serviceId: name, doClass: "allocator", identity: "allocator" }));
  return stub.fetch(`https://${name}.allocator.test${path}`, init);
}

async function allocateG77(
  serviceId: string,
  body: Record<string, unknown>,
  options?: { suppressRecoveryAlarm?: boolean },
): Promise<Response> {
  const suppressRecoveryAlarm = options?.suppressRecoveryAlarm !== false;
  return namedAllocatorRequest(serviceId, "/allocate", body, suppressRecoveryAlarm);
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

  it("G77 arms recovery alarm after membership-carrying allocation", async () => {
    const serviceId = `g77-recovery-alarm-${crypto.randomUUID()}`;
    const attemptId = newAttempt();
    const beforeAllocate = Date.now();
    const response = await namedAllocatorRequest(serviceId, "/allocate", {
      attemptId,
      serviceId,
      candidates: [{
        candidateIndex: 0,
        eventId: `${attemptId}-event`,
        targetTags: ["room:g77:recovery-alarm"],
        pinnedWriterEpoch: 0,
      }],
    });
    expect(response.status).toBe(201);
    const alarmProbe = await namedAllocatorRequest(serviceId, "/__internal/g77/recovery-alarm");
    expect(alarmProbe.status).toBe(200);
    const probe = await responseJson<{
      alarmAt: number | null;
      armedAt: number | null;
      unresolvedCount: number;
    }>(alarmProbe);
    expect(probe.alarmAt).not.toBeNull();
    expect(probe.alarmAt!).toBeGreaterThanOrEqual(beforeAllocate + ISSUANCE_NEVER_CONTACTED_GRACE_MS - 250);
    expect(probe.alarmAt!).toBeLessThanOrEqual(Date.now() + ISSUANCE_NEVER_CONTACTED_GRACE_MS + 250);
    expect(probe.unresolvedCount).toBe(1);
  });

  it("G77 in-flight allocation stays pending during never-contacted grace without reconcile poke", async () => {
    const serviceId = `g77-grace-pending-${crypto.randomUUID()}`;
    const attemptId = newAttempt();
    const tag = "room:g77:grace-pending";
    const allocate = await namedAllocatorRequest(serviceId, "/allocate", {
      attemptId,
      serviceId,
      candidates: [{
        candidateIndex: 0,
        eventId: `${attemptId}-event`,
        targetTags: [tag],
        pinnedWriterEpoch: 0,
      }],
    });
    expect(allocate.status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const namespace = (env as unknown as { ALLOCATOR: DurableObjectNamespace }).ALLOCATOR;
    const target = await runInDurableObject(
      namespace.get(scopeIdFor(namespace, { serviceId, doClass: "allocator", identity: "allocator" })),
      async (_instance, state) => state.storage.get<{ status: string }>(`issuance:target:${attemptId}:0:${tag}`),
    );
    expect(target?.status).toBe("pending");
    const certificate = await responseJson<ClosedPrefixCertificate>(
      await namedAllocatorRequest(serviceId, `/__internal/g77/certificate?serviceId=${encodeURIComponent(serviceId)}`),
    );
    expect(certificate.unresolvedCount).toBe(1);
  });

  it("shouldArmIssuanceRecovery is true only when schedule exists and is due", () => {
    const schedule = { nextDueAt: 100, cursor: null, attempts: 0 };
    expect(shouldArmIssuanceRecovery(undefined, 100)).toBe(false);
    expect(shouldArmIssuanceRecovery(schedule, 99)).toBe(false);
    expect(shouldArmIssuanceRecovery(schedule, 100)).toBe(true);
    expect(shouldArmIssuanceRecovery(schedule, 101)).toBe(true);
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

  it("G77 predecessor prefix excludes the least unresolved hole", async () => {
    const serviceId = `g77-prefix-oracle-${crypto.randomUUID()}`;
    const attemptId = newAttempt();
    const allocated = await namedAllocatorRequest(serviceId, "/allocate", {
      attemptId,
      serviceId,
      candidates: [{
        candidateIndex: 0,
        eventId: `${attemptId}-event`,
        targetTags: ["room:g77:prefix-only"],
        pinnedWriterEpoch: 0,
      }],
    });
    expect(allocated.status).toBe(201);
    const issuedSuid = (await responseJson<AllocationVector>(allocated)).candidates[0]!.suid;
    const certificate = await responseJson<ClosedPrefixCertificate>(
      await namedAllocatorRequest(serviceId, `/__internal/g77/certificate?serviceId=${encodeURIComponent(serviceId)}`),
    );
    expect(certificate.unresolvedCount).toBe(1);
    expect(certificate.closedPrefixSuid).toBeNull();
    expect(certificate.closedPrefixSuid).not.toBe(issuedSuid);
  });

  it("G77 positive predecessor oracle with multi-candidate hole", async () => {
    const serviceId = `g77-prefix-positive-${crypto.randomUUID()}`;
    const tag = (suffix: string) => `room:g77:prefix-positive-${suffix}`;
    const attemptOne = newAttempt();
    const attemptTwo = newAttempt();
    const attemptThree = newAttempt();
    const vectorOne = await responseJson<AllocationVector>(await allocateG77(serviceId, {
      attemptId: attemptOne,
      serviceId,
      candidates: [{
        candidateIndex: 0,
        eventId: `${attemptOne}-event`,
        targetTags: [tag("one")],
        pinnedWriterEpoch: 0,
      }],
    }));
    expect(vectorOne.candidates[0]!.suid).toBeTruthy();
    const vectorTwo = await responseJson<AllocationVector>(await allocateG77(serviceId, {
      attemptId: attemptTwo,
      serviceId,
      candidates: [{
        candidateIndex: 0,
        eventId: `${attemptTwo}-event`,
        targetTags: [tag("two")],
        pinnedWriterEpoch: 0,
      }],
    }));
    const vectorThree = await responseJson<AllocationVector>(await allocateG77(serviceId, {
      attemptId: attemptThree,
      serviceId,
      candidates: [{
        candidateIndex: 0,
        eventId: `${attemptThree}-event`,
        targetTags: [tag("three")],
        pinnedWriterEpoch: 0,
      }],
    }));
    const suidOne = vectorOne.candidates[0]!.suid;
    const suidTwo = vectorTwo.candidates[0]!.suid;
    const suidThree = vectorThree.candidates[0]!.suid;
    const tagNamespace = (env as unknown as { TAG: DurableObjectNamespace }).TAG;
    const allocatorNamespace = (env as unknown as { ALLOCATOR: DurableObjectNamespace }).ALLOCATOR;
    const allocatorDo = allocatorNamespace.get(scopeIdFor(allocatorNamespace, {
      serviceId,
      doClass: "allocator",
      identity: "allocator",
    }));
    for (const [attemptId, tagName, candidateIndex] of [
      [attemptOne, tag("one"), 0],
      [attemptThree, tag("three"), 0],
    ] as const) {
      const envelope = await runInDurableObject(allocatorDo, async (_instance, state) =>
        state.storage.get<{
          serviceId: string;
          allocatorLineageId: string;
          suid: string;
          identityDigest: string;
          pinnedWriterEpoch: number;
        }>(`issuance:envelope:${attemptId}:${candidateIndex}`));
      expect(envelope).toBeTruthy();
      const tagStub = tagNamespace.get(scopeIdFor(tagNamespace, { serviceId, doClass: "tag", identity: tagName }));
      await tagStub.fetch(new Request(`https://tag.test/acquire?__serviceId=${encodeURIComponent(serviceId)}&__tag=${encodeURIComponent(tagName)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attemptId, epoch: 0, eventTags: [tagName], consistencyTags: [] }),
      }));
      await tagStub.fetch(new Request(`https://tag.test/cancel?__serviceId=${encodeURIComponent(serviceId)}&__tag=${encodeURIComponent(tagName)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attemptId, epoch: 0, forceTombstone: true }),
      }));
      const inspect = await tagStub.fetch(new Request(`https://tag.test/__internal/g77/inspect-target?__serviceId=${encodeURIComponent(serviceId)}&__tag=${encodeURIComponent(tagName)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          eventId: `${attemptId}-event`,
          suid: envelope!.suid,
          attemptId,
          pinnedWriterEpoch: 0,
        }),
      }));
      expect(inspect.status).toBe(200);
      const observation = await responseJson<{
        terminalStatus: "installed-and-covered" | "absent-and-irrevocably-fenced";
        tombstoneEpoch?: number;
        obligationDigest?: string;
      }>(inspect);
      const resolve = await namedAllocatorRequest(serviceId, "/__internal/g77/resolve-target", {
        serviceId: envelope!.serviceId,
        allocatorLineageId: envelope!.allocatorLineageId,
        attemptId,
        candidateIndex,
        suid: envelope!.suid,
        tag: tagName,
        identityDigest: envelope!.identityDigest,
        pinnedWriterEpoch: envelope!.pinnedWriterEpoch,
        tagObservation: observation.terminalStatus === "installed-and-covered"
          ? {
              terminalStatus: "installed-and-covered",
              obligationDigest: observation.obligationDigest!,
            }
          : {
              terminalStatus: "absent-and-irrevocably-fenced",
              tombstoneEpoch: observation.tombstoneEpoch!,
            },
      });
      expect(resolve.status).toBe(200);
    }
    const state = await responseJson<AllocatorState>(await namedAllocatorRequest(serviceId, "/state"));
    const certificate = await responseJson<ClosedPrefixCertificate>(
      await namedAllocatorRequest(serviceId, `/__internal/g77/certificate?serviceId=${encodeURIComponent(serviceId)}`),
    );
    expect(certificate.unresolvedCount).toBe(1);
    expect(certificate.closedPrefixSuid).toBe(suidOne);
    expect(certificate.closedPrefixSuid).not.toBe(suidTwo);
    expect(certificate.closedPrefixSuid).not.toBe(suidThree);
    expect(certificate.closedPrefixSuid).not.toBe(state.allocatedWatermark);
  });

  it("G77 predecessor lookup stays correct beyond 256 issuances", async () => {
    const serviceId = `g77-prefix-window-${crypto.randomUUID()}`;
    const allocatorNamespace = (env as unknown as { ALLOCATOR: DurableObjectNamespace }).ALLOCATOR;
    const allocatorDo = allocatorNamespace.get(scopeIdFor(allocatorNamespace, {
      serviceId,
      doClass: "allocator",
      identity: "allocator",
    }));
    await runInDurableObject(allocatorDo, async (_instance, state) => {
      const issuedSuids: string[] = [];
      for (let index = 0; index < 300; index += 1) {
        const attemptId = `seed-${index}`;
        const suid = g32Suid(`g77-predecessor-seed-${String(index).padStart(4, "0")}`);
        issuedSuids.push(suid);
        await state.storage.put(issuedIndexKey(suid, attemptId, 0), {
          attemptId,
          candidateIndex: 0,
          suid,
        });
      }
      const holeSuid = g32Suid("g77-predecessor-hole");
      const holeAttempt = "seed-hole";
      await state.storage.put(unresolvedIndexKey(holeSuid, holeAttempt, 0), {
        attemptId: holeAttempt,
        candidateIndex: 0,
        suid: holeSuid,
      });
      let listReads = 0;
      const reader = {
        list: async (options: Parameters<DurableObjectStorage["list"]>[0]) => {
          listReads += 1;
          return state.storage.list(options);
        },
      };
      const predecessor = await predecessorIssuedSuid(reader as DurableObjectStorage, holeSuid);
      expect(predecessor).toBe(issuedSuids[issuedSuids.length - 1]!);
      expect(listReads).toBe(1);
    });
  });

  it("G77 inspection failure does not force-tombstone pending targets", async () => {
    const serviceId = `g77-inspect-retry-${crypto.randomUUID()}`;
    const attemptId = newAttempt();
    const tag = "room:g77:inspect-retry";
    await allocateG77(serviceId, {
      attemptId,
      serviceId,
      candidates: [{
        candidateIndex: 0,
        eventId: `${attemptId}-event`,
        targetTags: [tag],
        pinnedWriterEpoch: 0,
      }],
    });
    const tagNamespace = (env as unknown as { TAG: DurableObjectNamespace }).TAG;
    const allocatorNamespace = (env as unknown as { ALLOCATOR: DurableObjectNamespace }).ALLOCATOR;
    const allocatorDo = allocatorNamespace.get(scopeIdFor(allocatorNamespace, {
      serviceId,
      doClass: "allocator",
      identity: "allocator",
    }));
    let inspectStatus = 503;
    const forwardingTag = {
      idFromName(name: string): DurableObjectId {
        return tagNamespace.idFromName(name);
      },
      get(id: DurableObjectId): DurableObjectStub {
        const realStub = tagNamespace.get(id);
        return {
          async fetch(request: Request): Promise<Response> {
            const url = new URL(request.url);
            if (url.pathname === "/__internal/g77/inspect-target") {
              return new Response(JSON.stringify({ error: "unavailable", code: "tag_sql_unavailable" }), {
                status: inspectStatus,
              });
            }
            if (url.pathname === "/cancel") {
              return new Response(JSON.stringify({ error: "blocked for test" }), { status: 409 });
            }
            return realStub.fetch(request);
          },
        } as unknown as DurableObjectStub;
      },
    } as unknown as DurableObjectNamespace;
    await runInDurableObject(allocatorDo, async (_instance, state) => {
      await reconcileIssuanceBatch(state.storage, { TAG: forwardingTag }, serviceId, async (evidence) => {
        await state.storage.transaction(async (txn) => {
          await applyTargetResolution(txn, evidence);
        });
        return true;
      });
      let target = await state.storage.get<{ status: string }>(`issuance:target:${attemptId}:0:${tag}`);
      expect(target?.status).toBe("pending");
      inspectStatus = 409;
      await reconcileIssuanceBatch(state.storage, { TAG: forwardingTag }, serviceId, async (evidence) => {
        await state.storage.transaction(async (txn) => {
          await applyTargetResolution(txn, evidence);
        });
        return true;
      });
      target = await state.storage.get<{ status: string }>(`issuance:target:${attemptId}:0:${tag}`);
      expect(target?.status).toBe("pending");
    });
  });

  it("G77 mutant oracle: multi-tag candidate stays unresolved until every target terminal", async () => {
    const serviceId = `g77-multi-oracle-${crypto.randomUUID()}`;
    const tagA = "room:g77:multi-a";
    const tagB = "room:g77:multi-b";
    const attemptId = newAttempt();
    const allocate = await allocateG77(serviceId, {
      attemptId,
      serviceId,
      candidates: [{
        candidateIndex: 0,
        eventId: `${attemptId}-event`,
        targetTags: [tagA, tagB],
        pinnedWriterEpoch: 0,
      }],
    });
    expect(allocate.status).toBe(201);
    const tagNamespace = (env as unknown as { TAG: DurableObjectNamespace }).TAG;
    const allocatorNamespace = (env as unknown as { ALLOCATOR: DurableObjectNamespace }).ALLOCATOR;
    const allocatorDo = allocatorNamespace.get(scopeIdFor(allocatorNamespace, {
      serviceId,
      doClass: "allocator",
      identity: "allocator",
    }));
    const envelope = await runInDurableObject(allocatorDo, async (_instance, state) =>
      state.storage.get<{
        serviceId: string;
        allocatorLineageId: string;
        suid: string;
        identityDigest: string;
        pinnedWriterEpoch: number;
      }>(`issuance:envelope:${attemptId}:0`));
    expect(envelope).toBeTruthy();
    const tagStub = tagNamespace.get(scopeIdFor(tagNamespace, { serviceId, doClass: "tag", identity: tagA }));
    await tagStub.fetch(new Request(`https://tag.test/acquire?__serviceId=${encodeURIComponent(serviceId)}&__tag=${encodeURIComponent(tagA)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attemptId, epoch: 0, eventTags: [tagA], consistencyTags: [] }),
    }));
    await tagStub.fetch(new Request(`https://tag.test/cancel?__serviceId=${encodeURIComponent(serviceId)}&__tag=${encodeURIComponent(tagA)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attemptId, epoch: 0, forceTombstone: true }),
    }));
    const inspect = await tagStub.fetch(new Request(`https://tag.test/__internal/g77/inspect-target?__serviceId=${encodeURIComponent(serviceId)}&__tag=${encodeURIComponent(tagA)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        eventId: `${attemptId}-event`,
        suid: envelope!.suid,
        attemptId,
        pinnedWriterEpoch: 0,
      }),
    }));
    expect(inspect.status).toBe(200);
    const observation = await responseJson<{
      terminalStatus: "installed-and-covered" | "absent-and-irrevocably-fenced";
      tombstoneEpoch?: number;
      obligationDigest?: string;
    }>(inspect);
    const resolve = await namedAllocatorRequest(serviceId, "/__internal/g77/resolve-target", {
      serviceId: envelope!.serviceId,
      allocatorLineageId: envelope!.allocatorLineageId,
      attemptId,
      candidateIndex: 0,
      suid: envelope!.suid,
      tag: tagA,
      identityDigest: envelope!.identityDigest,
      pinnedWriterEpoch: envelope!.pinnedWriterEpoch,
      tagObservation: observation.terminalStatus === "installed-and-covered"
        ? {
            terminalStatus: "installed-and-covered",
            obligationDigest: observation.obligationDigest!,
          }
        : {
            terminalStatus: "absent-and-irrevocably-fenced",
            tombstoneEpoch: observation.tombstoneEpoch!,
          },
    });
    expect(resolve.status).toBe(200);
    expect(await responseJson<{ candidateResolved: boolean; duplicate: boolean }>(resolve)).toEqual({
      candidateResolved: false,
      duplicate: false,
    });
    const certificate = await responseJson<ClosedPrefixCertificate>(
      await namedAllocatorRequest(serviceId, `/__internal/g77/certificate?serviceId=${encodeURIComponent(serviceId)}`),
    );
    expect(certificate.unresolvedCount).toBe(1);
  });

  it("G77 rejects forged tag observation without live Tag verification", async () => {
    const serviceId = `g77-forged-oracle-${crypto.randomUUID()}`;
    const attemptId = newAttempt();
    const tag = "room:g77:forged-oracle";
    await allocateG77(serviceId, {
      attemptId,
      serviceId,
      candidates: [{
        candidateIndex: 0,
        eventId: `${attemptId}-event`,
        targetTags: [tag],
        pinnedWriterEpoch: 0,
      }],
    });
    const namespace = (env as unknown as { ALLOCATOR: DurableObjectNamespace }).ALLOCATOR;
    const envelope = await runInDurableObject(
      namespace.get(scopeIdFor(namespace, { serviceId, doClass: "allocator", identity: "allocator" })),
      async (_instance, state) => state.storage.get<{
        serviceId: string;
        allocatorLineageId: string;
        suid: string;
        identityDigest: string;
        pinnedWriterEpoch: number;
      }>(`issuance:envelope:${attemptId}:0`),
    );
    expect(envelope).toBeTruthy();
    for (const tagObservation of [
      { terminalStatus: "absent-and-irrevocably-fenced" as const, tombstoneEpoch: 0 },
      { terminalStatus: "installed-and-covered" as const, obligationDigest: "totally-made-up" },
    ]) {
      const response = await namedAllocatorRequest(serviceId, "/__internal/g77/resolve-target", {
        serviceId: envelope!.serviceId,
        allocatorLineageId: envelope!.allocatorLineageId,
        attemptId,
        candidateIndex: 0,
        suid: envelope!.suid,
        tag,
        identityDigest: envelope!.identityDigest,
        pinnedWriterEpoch: envelope!.pinnedWriterEpoch,
        tagObservation,
      });
      expect(response.status).toBe(409);
    }
    const target = await runInDurableObject(
      namespace.get(scopeIdFor(namespace, { serviceId, doClass: "allocator", identity: "allocator" })),
      async (_instance, state) => state.storage.get<{ status: string }>(`issuance:target:${attemptId}:0:${tag}`),
    );
    expect(target?.status).toBe("pending");
    const certificate = await responseJson<ClosedPrefixCertificate>(
      await namedAllocatorRequest(serviceId, `/__internal/g77/certificate?serviceId=${encodeURIComponent(serviceId)}`),
    );
    expect(certificate.unresolvedCount).toBe(1);
  });

  it("G77 never-contacted target fences via bounded reconciliation", async () => {
    const serviceId = `g77-never-contacted-${crypto.randomUUID()}`;
    const attemptId = newAttempt();
    const tag = "room:g77:never-contacted";
    const allocate = await namedAllocatorRequest(serviceId, "/allocate", {
      attemptId,
      serviceId,
      candidates: [{
        candidateIndex: 0,
        eventId: `${attemptId}-event`,
        targetTags: [tag],
        pinnedWriterEpoch: 0,
      }],
    });
    expect(allocate.status).toBe(201);
    const namespace = (env as unknown as { ALLOCATOR: DurableObjectNamespace }).ALLOCATOR;
    const envelope = await runInDurableObject(
      namespace.get(scopeIdFor(namespace, { serviceId, doClass: "allocator", identity: "allocator" })),
      async (_instance, state) => state.storage.get<{
        eventId: string;
        suid: string;
      }>(`issuance:envelope:${attemptId}:0`),
    );
    expect(envelope).toBeTruthy();
    for (let index = 0; index < 5; index += 1) {
      const reconcile = await namedAllocatorRequest(serviceId, "/__internal/g77/reconcile-now", {});
      expect(reconcile.status).toBe(200);
    }
    const tagNamespace = (env as unknown as { TAG: DurableObjectNamespace }).TAG;
    const target = await runInDurableObject(
      namespace.get(scopeIdFor(namespace, { serviceId, doClass: "allocator", identity: "allocator" })),
      async (_instance, state) => state.storage.get<{ status: string }>(`issuance:target:${attemptId}:0:${tag}`),
    );
    expect(target?.status).toBe("absent-and-irrevocably-fenced");
    const tagStub = tagNamespace.get(scopeIdFor(tagNamespace, { serviceId, doClass: "tag", identity: tag }));
    const inspect = await tagStub.fetch(new Request(`https://tag.test/__internal/g77/inspect-target?__serviceId=${encodeURIComponent(serviceId)}&__tag=${encodeURIComponent(tag)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        eventId: envelope!.eventId,
        suid: envelope!.suid,
        attemptId,
        pinnedWriterEpoch: 0,
      }),
    }));
    expect(inspect.status).toBe(200);
    const certificate = await responseJson<ClosedPrefixCertificate>(
      await namedAllocatorRequest(serviceId, `/__internal/g77/certificate?serviceId=${encodeURIComponent(serviceId)}`),
    );
    expect(certificate.unresolvedCount).toBe(0);
  });

  it("G77 force-tombstoned target refuses append at pinned and higher writer epochs", async () => {
    const serviceId = `g77-f12-irrevocable-${crypto.randomUUID()}`;
    const attemptId = newAttempt();
    const eventId = g32EventId(`g77-f12:${attemptId}`);
    const tag = "room:g77:f12-irrevocable";
    const allocate = await namedAllocatorRequest(serviceId, "/allocate", {
      attemptId,
      serviceId,
      candidates: [{
        candidateIndex: 0,
        eventId,
        targetTags: [tag],
        pinnedWriterEpoch: 0,
      }],
    });
    expect(allocate.status).toBe(201);
    const namespace = (env as unknown as { ALLOCATOR: DurableObjectNamespace }).ALLOCATOR;
    const tagNamespace = (env as unknown as { TAG: DurableObjectNamespace }).TAG;
    const allocatorDo = namespace.get(scopeIdFor(namespace, { serviceId, doClass: "allocator", identity: "allocator" }));
    const envelope = await runInDurableObject(allocatorDo, async (_instance, state) => state.storage.get<{
      eventId: string;
      suid: string;
    }>(`issuance:envelope:${attemptId}:0`));
    expect(envelope).toBeTruthy();
    for (let index = 0; index < 5; index += 1) {
      const reconcile = await namedAllocatorRequest(serviceId, "/__internal/g77/reconcile-now", {});
      expect(reconcile.status).toBe(200);
    }
    const target = await runInDurableObject(allocatorDo, async (_instance, state) =>
      state.storage.get<{ status: string }>(`issuance:target:${attemptId}:0:${tag}`));
    expect(target?.status).toBe("absent-and-irrevocably-fenced");
    const certificate = await responseJson<ClosedPrefixCertificate>(
      await namedAllocatorRequest(serviceId, `/__internal/g77/certificate?serviceId=${encodeURIComponent(serviceId)}`),
    );
    expect(certificate.unresolvedCount).toBe(0);
    expect(certificate.status).toBe("ready");
    const tagStub = tagNamespace.get(scopeIdFor(tagNamespace, { serviceId, doClass: "tag", identity: tag }));
    const tombstoneFacts = await runInDurableObject(tagStub, async (_instance, state) => ({
      tombstone: state.storage.sql.exec("SELECT epoch FROM tag_tombstone WHERE attempt_id = ?", attemptId).toArray(),
      epoch: state.storage.sql.exec("SELECT highest_epoch, sealed_epoch FROM tag_epoch WHERE attempt_id = ?", attemptId).toArray(),
    }));
    expect(tombstoneFacts.tombstone).toEqual([{ epoch: 0 }]);
    expect(tombstoneFacts.epoch[0]).toMatchObject({ highest_epoch: 0, sealed_epoch: 9007199254740991 });
    const candidate = {
      eventId: envelope!.eventId,
      suid: envelope!.suid,
      payload: JSON.stringify({ fixture: "g77-f12" }),
      eventTags: [tag],
      eventType: "G77F12Event",
      provenance: "g32",
      allocatorLineageId: "g77-f12-lineage",
      timestamp: G32_FIXTURE_TIMESTAMP,
    };
    for (const epoch of [0, 1, 5] as const) {
      const append = await tagStub.fetch(new Request(`https://tag.test/append?__serviceId=${encodeURIComponent(serviceId)}&__tag=${encodeURIComponent(tag)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attemptId, epoch, candidates: [candidate] }),
      }));
      expect(append.status).toBe(409);
      const body = await responseJson<{ reason: string }>(append);
      expect(["tombstoned_epoch", "sealed_epoch"]).toContain(body.reason);
      const acquire = await tagStub.fetch(new Request(`https://tag.test/acquire?__serviceId=${encodeURIComponent(serviceId)}&__tag=${encodeURIComponent(tag)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attemptId, epoch, eventTags: [tag], consistencyTags: [] }),
      }));
      expect(acquire.status).toBe(409);
    }
    const inspect = await tagStub.fetch(new Request(`https://tag.test/__internal/g77/inspect-target?__serviceId=${encodeURIComponent(serviceId)}&__tag=${encodeURIComponent(tag)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        eventId: envelope!.eventId,
        suid: envelope!.suid,
        attemptId,
        pinnedWriterEpoch: 0,
      }),
    }));
    expect(inspect.status).toBe(200);
    expect(await responseJson<{ terminalStatus: string }>(inspect)).toMatchObject({
      terminalStatus: "absent-and-irrevocably-fenced",
    });
    const eventCount = await runInDurableObject(tagStub, async (_instance, state) =>
      state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM tag_event WHERE attempt_id = ?", attemptId).one().count);
    expect(eventCount).toBe(0);
    const obligationCount = await runInDurableObject(tagStub, async (_instance, state) =>
      state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM tag_outbox_obligation WHERE event_id = ?",
        envelope!.eventId,
      ).one().count);
    expect(obligationCount).toBe(0);
  });

  it("G77 in-flight target stays pending while never-contacted target can fence", async () => {
    const serviceId = `g77-inflight-vs-never-${crypto.randomUUID()}`;
    const neverTag = "room:g77:inflight-never";
    const inflightTag = "room:g77:inflight-active";
    const neverAttempt = newAttempt();
    const inflightAttempt = newAttempt();
    await namedAllocatorRequest(serviceId, "/allocate", {
      attemptId: neverAttempt,
      serviceId,
      candidates: [{
        candidateIndex: 0,
        eventId: `${neverAttempt}-event`,
        targetTags: [neverTag],
        pinnedWriterEpoch: 0,
      }],
    });
    await namedAllocatorRequest(serviceId, "/allocate", {
      attemptId: inflightAttempt,
      serviceId,
      candidates: [{
        candidateIndex: 0,
        eventId: `${inflightAttempt}-event`,
        targetTags: [inflightTag],
        pinnedWriterEpoch: 0,
      }],
    });
    const tagNamespace = (env as unknown as { TAG: DurableObjectNamespace }).TAG;
    const allocatorNamespace = (env as unknown as { ALLOCATOR: DurableObjectNamespace }).ALLOCATOR;
    const inflightEnvelope = await runInDurableObject(
      allocatorNamespace.get(scopeIdFor(allocatorNamespace, { serviceId, doClass: "allocator", identity: "allocator" })),
      async (_instance, state) => state.storage.get<{ eventId: string; suid: string }>(
        `issuance:envelope:${inflightAttempt}:0`,
      ),
    );
    expect(inflightEnvelope).toBeTruthy();
    const inflightStub = tagNamespace.get(scopeIdFor(tagNamespace, { serviceId, doClass: "tag", identity: inflightTag }));
    const initialized = await inflightStub.fetch(new Request(`https://tag.test/acquire?__serviceId=${encodeURIComponent(serviceId)}&__tag=${encodeURIComponent(inflightTag)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attemptId: `g77-inflight-init:${crypto.randomUUID()}`, epoch: 0, eventTags: [inflightTag], consistencyTags: [] }),
    }));
    expect(initialized.status).toBe(200);
    await runInDurableObject(inflightStub, async (_instance, state) => {
      const timestamp = new Date().toISOString();
      state.storage.sql.exec(
        `INSERT INTO tag_event (
          service_id, event_id, attempt_id, suid, payload, event_tags_json,
          allocator_lineage_id, event_type, provenance, timestamp, event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        serviceId,
        inflightEnvelope!.eventId,
        inflightAttempt,
        inflightEnvelope!.suid,
        "",
        JSON.stringify([inflightTag]),
        "g77-inflight-lineage",
        "G77InflightEvent",
        "g32",
        timestamp,
        "{}",
      );
    });
    const preInspect = await inflightStub.fetch(new Request(`https://tag.test/__internal/g77/inspect-target?__serviceId=${encodeURIComponent(serviceId)}&__tag=${encodeURIComponent(inflightTag)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        eventId: inflightEnvelope!.eventId,
        suid: inflightEnvelope!.suid,
        attemptId: inflightAttempt,
        pinnedWriterEpoch: 0,
      }),
    }));
    expect(preInspect.status).toBe(409);
    for (let index = 0; index < 5; index += 1) {
      await namedAllocatorRequest(serviceId, "/__internal/g77/reconcile-now", {});
    }
    const allocatorDo = allocatorNamespace.get(scopeIdFor(allocatorNamespace, {
      serviceId,
      doClass: "allocator",
      identity: "allocator",
    }));
    const targets = await runInDurableObject(allocatorDo, async (_instance, state) => ({
      never: await state.storage.get<{ status: string }>(`issuance:target:${neverAttempt}:0:${neverTag}`),
      inflight: await state.storage.get<{ status: string }>(`issuance:target:${inflightAttempt}:0:${inflightTag}`),
    }));
    expect(targets.never?.status).toBe("absent-and-irrevocably-fenced");
    expect(targets.inflight?.status).toBe("pending");
  });

  it("G77 rejects resolution with mismatched pinned writer epoch", async () => {
    const serviceId = `g77-epoch-oracle-${crypto.randomUUID()}`;
    const attemptId = newAttempt();
    const tag = "room:g77:epoch-oracle";
    await allocateG77(serviceId, {
      attemptId,
      serviceId,
      candidates: [{
        candidateIndex: 0,
        eventId: `${attemptId}-event`,
        targetTags: [tag],
        pinnedWriterEpoch: 0,
      }],
    });
    const namespace = (env as unknown as { ALLOCATOR: DurableObjectNamespace }).ALLOCATOR;
    const allocatorDo = namespace.get(scopeIdFor(namespace, { serviceId, doClass: "allocator", identity: "allocator" }));
    const envelope = await runInDurableObject(allocatorDo, async (_instance, state) => state.storage.get<{
      serviceId: string;
      allocatorLineageId: string;
      suid: string;
      identityDigest: string;
      pinnedWriterEpoch: number;
      eventId: string;
    }>(`issuance:envelope:${attemptId}:0`));
    expect(envelope).toBeTruthy();
    const tagNamespace = (env as unknown as { TAG: DurableObjectNamespace }).TAG;
    const tagStub = tagNamespace.get(scopeIdFor(tagNamespace, { serviceId, doClass: "tag", identity: tag }));
    await tagStub.fetch(new Request(`https://tag.test/acquire?__serviceId=${encodeURIComponent(serviceId)}&__tag=${encodeURIComponent(tag)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attemptId, epoch: 0, eventTags: [tag], consistencyTags: [] }),
    }));
    await tagStub.fetch(new Request(`https://tag.test/cancel?__serviceId=${encodeURIComponent(serviceId)}&__tag=${encodeURIComponent(tag)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attemptId, epoch: 0, forceTombstone: true }),
    }));
    const inspect = await tagStub.fetch(new Request(`https://tag.test/__internal/g77/inspect-target?__serviceId=${encodeURIComponent(serviceId)}&__tag=${encodeURIComponent(tag)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        eventId: envelope!.eventId,
        suid: envelope!.suid,
        attemptId,
        pinnedWriterEpoch: envelope!.pinnedWriterEpoch,
      }),
    }));
    expect(inspect.status).toBe(200);
    const observation = await responseJson<{
      terminalStatus: "absent-and-irrevocably-fenced";
      tombstoneEpoch: number;
    }>(inspect);
    const response = await namedAllocatorRequest(serviceId, "/__internal/g77/resolve-target", {
      serviceId: envelope!.serviceId,
      allocatorLineageId: envelope!.allocatorLineageId,
      attemptId,
      candidateIndex: 0,
      suid: envelope!.suid,
      tag,
      identityDigest: envelope!.identityDigest,
      pinnedWriterEpoch: envelope!.pinnedWriterEpoch + 1,
      tagObservation: {
        terminalStatus: "absent-and-irrevocably-fenced",
        tombstoneEpoch: observation.tombstoneEpoch,
      },
    });
    expect(response.status).toBe(409);
    const target = await runInDurableObject(allocatorDo, async (_instance, state) =>
      state.storage.get<{ status: string }>(`issuance:target:${attemptId}:0:${tag}`));
    expect(target?.status).toBe("pending");
  });

  it("G77 fenced absence resolves a pending target without accepting expiry alone", async () => {
    const serviceId = `g77-fence-oracle-${crypto.randomUUID()}`;
    const attemptId = newAttempt();
    const tag = "room:g77:fence-oracle";
    const allocate = await namedAllocatorRequest(serviceId, "/allocate", {
      attemptId,
      serviceId,
      candidates: [{
        candidateIndex: 0,
        eventId: `${attemptId}-event`,
        targetTags: [tag],
        pinnedWriterEpoch: 0,
      }],
    });
    expect(allocate.status).toBe(201);
    const namespace = (env as unknown as { TAG: DurableObjectNamespace }).TAG;
    const tagStub = namespace.get(scopeIdFor(namespace, { serviceId, doClass: "tag", identity: tag }));
    await tagStub.fetch(new Request(`https://tag.test/acquire?__serviceId=${encodeURIComponent(serviceId)}&__tag=${encodeURIComponent(tag)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attemptId, epoch: 0, eventTags: [tag], consistencyTags: [] }),
    }));
    await tagStub.fetch(new Request(`https://tag.test/cancel?__serviceId=${encodeURIComponent(serviceId)}&__tag=${encodeURIComponent(tag)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attemptId, epoch: 0, forceTombstone: true }),
    }));
    const reconcile = await namedAllocatorRequest(serviceId, "/__internal/g77/reconcile-now", {});
    expect(reconcile.status).toBe(200);
    const certificate = await responseJson<ClosedPrefixCertificate>(
      await namedAllocatorRequest(serviceId, `/__internal/g77/certificate?serviceId=${encodeURIComponent(serviceId)}`),
    );
    expect(certificate.unresolvedCount).toBe(0);
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
