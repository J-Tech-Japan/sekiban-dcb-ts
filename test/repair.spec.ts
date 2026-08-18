import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { handleOperatorRepair, type OperatorRepairEnv } from "../packages/dcb-runtime/src/cli/OperatorRepairCli";
import type { Env as WorkerEnv } from "../packages/dcb-runtime/src/index";
import type { JournalRecord } from "../packages/dcb-runtime/src/journal/types";
import type { RepairScopeItem, TagRecord } from "../packages/dcb-runtime/src/tag/types";

const SERVICE_ID = "serialized-dcb-v1";
const OPERATOR_TOKEN = "test-repair-operator-token";
const SUID = "suid-00000000000000000000000000000001";

interface RepairFactsResponse {
  head: string;
  version: number;
  fences: Array<{ reason: string; attemptId: string; epoch: number }>;
  repairOwner: string | null;
  repairLeaseUntil: number | null;
  highestRepairEpoch: number;
  repairScope: RepairScopeItem[];
  repairScopeVersion: number;
  facts: {
    resolutions: Array<{ attemptId: string; eventId: string; suid: string; branch: string; owner: string; epoch: number }>;
    audits: Array<{ attemptId: string; eventId: string; suid: string; branch: string; actor: string }>;
  };
}

interface OperatorResult {
  dryRun: boolean;
  checkpoint: string | null;
  rolledForward: number;
  excludedAudited: number;
  cleared: number;
  interrupted?: string;
}

async function responseJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function tag(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function tagPost(target: string, path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://repair.test/tags/${encodeURIComponent(SERVICE_ID)}/${encodeURIComponent(target)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function tagState(target: string): Promise<TagRecord> {
  const response = await SELF.fetch(
    `https://repair.test/tags/${encodeURIComponent(SERVICE_ID)}/${encodeURIComponent(target)}/state`,
  );
  expect(response.status).toBe(200);
  return responseJson<TagRecord>(response);
}

async function tagFacts(target: string): Promise<RepairFactsResponse> {
  const response = await SELF.fetch(
    `https://repair.test/tags/${encodeURIComponent(SERVICE_ID)}/${encodeURIComponent(target)}/repair/facts`,
  );
  expect(response.status).toBe(200);
  return responseJson<RepairFactsResponse>(response);
}

async function journalState(attemptId: string): Promise<JournalRecord> {
  const response = await SELF.fetch(`https://repair.test/journals/${encodeURIComponent(attemptId)}/state`);
  expect(response.status).toBe(200);
  return responseJson<JournalRecord>(response);
}

async function journalPost(attemptId: string, path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://repair.test/journals/${encodeURIComponent(attemptId)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function operator(
  body: unknown,
  options: { fault?: string; envOverride?: OperatorRepairEnv } = {},
): Promise<Response> {
  const request = new Request("https://repair.test/operator/repair", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPERATOR_TOKEN}`,
      ...(options.fault === undefined ? {} : { "x-sdt-g6-test-fault": options.fault }),
    },
    body: JSON.stringify(body),
  });
  const base = env as unknown as Pick<WorkerEnv, "JOURNAL" | "TAG">;
  return handleOperatorRepair(request, options.envOverride ?? {
    ...base,
    REPAIR_OPERATOR_TOKEN: OPERATOR_TOKEN,
  });
}

async function partialAttempt(prefix: string, options: { headAhead?: boolean; candidateCount?: number } = {}): Promise<{
  attemptId: string;
  missingTag: string;
  writtenTag: string;
}> {
  const attemptId = crypto.randomUUID();
  const writtenTag = tag(`${prefix}-written`);
  const missingTag = tag(`${prefix}-missing`);
  if (options.headAhead === true) {
    const seeded = await tagPost(missingTag, "/append", {
      attemptId: "seed-head-ahead",
      epoch: 0,
      candidates: [{
        eventId: "seed-head-ahead-event",
        suid: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
        payload: "c2VlZA==",
        eventTags: [missingTag],
      }],
    });
    expect(seeded.status).toBe(201);
  }
  const response = await SELF.fetch("https://commit.test/api/sekiban/serialized/commit", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sdt-g4-test-fault": "tag-append-last",
      "x-sdt-g4-test-attempt-id": attemptId,
    },
    body: JSON.stringify({
      version: 1,
      eventCandidates: Array.from({ length: options.candidateCount ?? 1 }, (_, index) => ({
        payload: index === 0 ? "cGFydGlhbA==" : "cGFydGlhbC0y",
        eventPayloadName: `RepairPartial${index}`,
        tags: [writtenTag, missingTag],
      })),
      consistencyTags: [
        { tag: writtenTag, lastSortableUniqueId: "" },
        { tag: missingTag, lastSortableUniqueId: options.headAhead === true ? "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" : "" },
      ],
    }),
  });
  expect(response.status).toBe(500);
  const body = await responseJson<{ code: string; partial: { missingTags: string[] } }>(response);
  expect(body.code).toBe("partial_write");
  expect(body.partial.missingTags).toEqual([missingTag]);
  return { attemptId, missingTag, writtenTag };
}

function item(attemptId: string, target: string, eventId = `${attemptId}-event`, suid = SUID, payload = "cGFydGlhbA=="): RepairScopeItem {
  return { attemptId, eventId, suid, payload, eventTags: [target] };
}

async function installPartial(target: string, attemptId: string, epoch = 1): Promise<void> {
  expect((await tagPost(target, "/fence/install", {
    reason: "partial_write",
    attemptId,
    epoch,
  })).status).toBe(201);
}

describe("SDT-G6 operator repair vertical slice", () => {
  it("uses a lease fencing token, rejects stale/takeover operations, unions F3 only after refusal, and never bypasses rotation", async () => {
    const target = tag("lease");
    const firstAttempt = "repair-first";
    const lateAttempt = "repair-f3";
    const first = item(firstAttempt, target);
    const late = item(lateAttempt, target, "late-event", "suid-00000000000000000000000000000002");
    await installPartial(target, firstAttempt);
    await installPartial(target, lateAttempt);

    const acquired = await tagPost(target, "/repair/acquire", { owner: "owner-a", scope: [first] });
    expect(acquired.status).toBe(201);
    const lease = await responseJson<{ epoch: number; leaseUntil: number }>(acquired);
    expect(lease.epoch).toBe(1);
    expect((await tagPost(target, "/repair/acquire", { owner: "owner-b", scope: [first] })).status).toBe(409);
    expect((await tagPost(target, "/repair/renew", { owner: "owner-a", epoch: lease.epoch })).status).toBe(200);
    expect((await tagFacts(target)).highestRepairEpoch).toBe(lease.epoch);

    const outOfScope = await tagPost(target, "/repair/apply", { owner: "owner-a", epoch: lease.epoch, item: late });
    expect(outOfScope.status).toBe(409);
    expect((await responseJson<{ reason: string }>(outOfScope)).reason).toBe("repair_scope_required");
    expect((await tagFacts(target)).facts.resolutions).toEqual([]);
    expect((await tagPost(target, "/repair/scope-union", { owner: "owner-a", epoch: lease.epoch, scope: [late] })).status).toBe(200);
    expect((await tagFacts(target)).repairScope.map((entry) => entry.suid)).toEqual([first.suid, late.suid]);

    const beforeExpiry = await tagState(target);
    expect((await tagPost(target, "/debug/clock", { nowMs: beforeExpiry.repairLeaseUntil! })).status).toBe(200);
    expect((await tagPost(target, "/repair/renew", { owner: "owner-a", epoch: lease.epoch })).status).toBe(409);
    const takeover = await tagPost(target, "/repair/acquire", { owner: "owner-b", scope: [first, late] });
    expect(takeover.status).toBe(201);
    const newLease = await responseJson<{ epoch: number }>(takeover);
    expect(newLease.epoch).toBe(lease.epoch + 1);
    for (const path of ["/repair/apply", "/repair/audit", "/repair/clear"] as const) {
      const body = path === "/repair/clear"
        ? { owner: "owner-a", epoch: lease.epoch, attemptId: firstAttempt, scopeVersion: 2 }
        : { owner: "owner-a", epoch: lease.epoch, item: first, ...(path === "/repair/audit" ? { actor: "old" } : {}) };
      expect((await tagPost(target, path, body)).status).toBe(409);
    }

    const rotated = tag("rotation");
    expect((await tagPost(rotated, "/fence/install", {
      reason: "segment_rotation", attemptId: "rotation-owner", epoch: 1,
    })).status).toBe(201);
    const blocked = await tagPost(rotated, "/repair/acquire", { owner: "owner", scope: [item("rotation-repair", rotated)] });
    expect(blocked.status).toBe(409);
    expect((await responseJson<{ reason: string }>(blocked)).reason).toBe("segment_rotation_fence_held");
  });

  it("rejects a stale stable-snapshot clear without removing either partial-write fence", async () => {
    const target = tag("stable-snapshot");
    const firstAttempt = "stable-snapshot-first";
    const secondAttempt = "stable-snapshot-second";
    const first = item(firstAttempt, target, "stable-snapshot-first-event");
    const second = item(secondAttempt, target, "stable-snapshot-second-event", "suid-00000000000000000000000000000002");
    await installPartial(target, firstAttempt);
    await installPartial(target, secondAttempt);

    const acquired = await tagPost(target, "/repair/acquire", { owner: "snapshot-owner", scope: [first] });
    expect(acquired.status).toBe(201);
    const lease = await responseJson<{ epoch: number }>(acquired);
    const applied = await tagPost(target, "/repair/apply", { owner: "snapshot-owner", epoch: lease.epoch, item: first });
    expect(applied.status).toBe(200);
    expect((await responseJson<{ status: string }>(applied)).status).toBe("ROLLED_FORWARD");
    expect((await tagPost(target, "/repair/audit", {
      owner: "snapshot-owner", epoch: lease.epoch, item: first, actor: "snapshot-auditor",
    })).status).toBe(200);

    const stableScopeVersion = (await tagFacts(target)).repairScopeVersion;
    expect((await tagPost(target, "/repair/scope-union", {
      owner: "snapshot-owner", epoch: lease.epoch, scope: [second],
    })).status).toBe(200);
    expect((await tagFacts(target)).repairScopeVersion).toBeGreaterThan(stableScopeVersion);

    const staleClear = await tagPost(target, "/repair/clear", {
      owner: "snapshot-owner", epoch: lease.epoch, attemptId: firstAttempt, scopeVersion: stableScopeVersion,
    });
    expect(staleClear.status).toBe(409);
    expect(await responseJson<{ reason: string }>(staleClear)).toMatchObject({ reason: "repair_scope_snapshot_changed" });
    const afterStaleClear = await tagFacts(target);
    expect(afterStaleClear.fences).toContainEqual(
      expect.objectContaining({ reason: "partial_write", attemptId: firstAttempt }),
    );
    expect(afterStaleClear.fences).toContainEqual(
      expect.objectContaining({ reason: "partial_write", attemptId: secondAttempt }),
    );
  });

  it("makes Branch A a durable outbox repair, preserves PARTIAL, and keeps dry-run mutation-free", async () => {
    const prepared = await partialAttempt("branch-a");
    const unrelatedAttempt = "unrelated-partial-fence";
    await installPartial(prepared.missingTag, unrelatedAttempt);
    const before = await tagState(prepared.missingTag);
    const journalBefore = await journalState(prepared.attemptId);
    expect((await SELF.fetch("https://repair.test/operator/repair", { method: "POST" })).status).toBe(401);
    const base = env as unknown as Pick<WorkerEnv, "JOURNAL" | "TAG">;
    const unauthenticated = await handleOperatorRepair(new Request("https://repair.test/operator/repair", { method: "POST" }), {
      ...base,
      REPAIR_OPERATOR_TOKEN: OPERATOR_TOKEN,
    });
    expect(unauthenticated.status).toBe(401);

    const request = { attemptIds: [prepared.attemptId], tags: [prepared.missingTag], actor: "on-call", mode: "dry-run" };
    const plan = await operator(request);
    expect(plan.status).toBe(200);
    expect((await responseJson<OperatorResult>(plan)).dryRun).toBe(true);
    expect(await tagState(prepared.missingTag)).toEqual(before);
    expect(await journalState(prepared.attemptId)).toEqual(journalBefore);

    const repaired = await operator({ ...request, mode: "execute" });
    expect(repaired.status).toBe(200);
    expect(await responseJson<OperatorResult>(repaired)).toMatchObject({ rolledForward: 1, excludedAudited: 0, cleared: 1 });
    const after = await tagState(prepared.missingTag);
    expect(after.events).toHaveLength(1);
    expect(after.outbox).toHaveLength(1);
    expect(after.fences).not.toContainEqual(expect.objectContaining({ reason: "partial_write", attemptId: prepared.attemptId }));
    expect(after.fences).toContainEqual(expect.objectContaining({ reason: "partial_write", attemptId: unrelatedAttempt }));
    expect((await tagFacts(prepared.missingTag)).facts.audits).toContainEqual(
      expect.objectContaining({ attemptId: prepared.attemptId, actor: "on-call", branch: "ROLLED_FORWARD" }),
    );
    const journal = await journalState(prepared.attemptId);
    expect(journal.state).toBe("PARTIAL");
    expect(journal.repairObservations.map((entry) => entry.phase)).toEqual(expect.arrayContaining(["PREPARED", "VERIFIED", "CLEARED"]));
    const idempotent = await operator({ ...request, mode: "execute" });
    expect(idempotent.status).toBe(200);
    expect(await responseJson<OperatorResult>(idempotent)).toMatchObject({ rolledForward: 0, excludedAudited: 0, cleared: 0 });
    expect((await tagState(prepared.missingTag)).events).toHaveLength(1);
  });

  it("re-queries Tag facts across all six crash/race boundaries and converges without a Response.error TypeError", async () => {
    for (const fault of [
      "after-lease-before-prepare",
      "after-prepare-before-apply",
      "after-apply-before-observation",
      "after-verify-before-audit",
      "after-audit-before-clear",
      "after-clear-before-final-observation",
    ] as const) {
      const prepared = await partialAttempt(`crash-${fault}`);
      const input = { attemptIds: [prepared.attemptId], tags: [prepared.missingTag], actor: "on-call", mode: "execute" };
      const interrupted = await operator(input, { fault });
      expect(interrupted.status).toBe(202);
      expect((await responseJson<OperatorResult>(interrupted)).interrupted).toBe(fault);
      const converged = await operator(input);
      expect(converged.status).toBe(200);
      const facts = await tagFacts(prepared.missingTag);
      expect(facts.fences).not.toContainEqual(expect.objectContaining({ reason: "partial_write", attemptId: prepared.attemptId }));
      const journal = await journalState(prepared.attemptId);
      expect(journal.state).toBe("PARTIAL");
      expect(journal.repairObservations.map((entry) => entry.phase)).toContain("CLEARED");
    }
  });

  it("uses a bounded scan checkpoint and clears only after the resumed durable scope is complete", async () => {
    const prepared = await partialAttempt("checkpoint", { candidateCount: 2 });
    const request = { attemptIds: [prepared.attemptId], tags: [prepared.missingTag], actor: "on-call", mode: "execute", maxItems: 1 };
    const first = await operator(request);
    expect(first.status).toBe(200);
    const firstResult = await responseJson<OperatorResult>(first);
    expect(firstResult.rolledForward).toBe(1);
    expect(firstResult.cleared).toBe(0);
    expect(firstResult.checkpoint).not.toBeNull();
    expect((await tagFacts(prepared.missingTag)).fences).toContainEqual(
      expect.objectContaining({ reason: "partial_write", attemptId: prepared.attemptId }),
    );
    const resumed = await operator({ ...request, checkpoint: firstResult.checkpoint });
    expect(resumed.status).toBe(200);
    expect(await responseJson<OperatorResult>(resumed)).toMatchObject({ rolledForward: 1, cleared: 1 });
    expect((await tagFacts(prepared.missingTag)).fences).not.toContainEqual(
      expect.objectContaining({ reason: "partial_write", attemptId: prepared.attemptId }),
    );
  });

  it("keeps late low-epoch Journal observations non-authoritative for clear and completion", async () => {
    const prepared = await partialAttempt("late-observation");
    const workset = await SELF.fetch(`https://repair.test/journals/${encodeURIComponent(prepared.attemptId)}/repair/workset`);
    expect(workset.status).toBe(200);
    const candidate = (await responseJson<{ candidates: Array<{ eventId: string; suid: string }> }>(workset)).candidates[0]!;
    const late = await journalPost(prepared.attemptId, "/repair/observation", {
      owner: "stale-owner",
      epoch: 0,
      tag: prepared.missingTag,
      attemptId: prepared.attemptId,
      eventId: candidate.eventId,
      suid: candidate.suid,
      phase: "VERIFIED",
      branch: "ROLLED_FORWARD",
    });
    expect(late.status).toBe(200);
    expect((await tagFacts(prepared.missingTag)).fences).toContainEqual(
      expect.objectContaining({ reason: "partial_write", attemptId: prepared.attemptId }),
    );
    expect((await journalState(prepared.attemptId)).state).toBe("PARTIAL");
    const plan = await operator({
      attemptIds: [prepared.attemptId], tags: [prepared.missingTag], actor: "on-call", mode: "dry-run",
    });
    expect(plan.status).toBe(200);
    expect((await responseJson<OperatorResult>(plan)).cleared).toBe(0);
  });

  it("takes Branch B without advancing Tag head/version and reaches the provider-internal exclusion binding", async () => {
    const prepared = await partialAttempt("branch-b", { headAhead: true });
    const before = await tagFacts(prepared.missingTag);
    const detector: unknown[] = [];
    const fakeBinding = {
      async fetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        detector.push(JSON.parse(init?.body as string));
        return new Response(null, { status: 204 });
      },
    } as Fetcher;
    const base = env as unknown as Pick<WorkerEnv, "JOURNAL" | "TAG">;
    const repairEnv: OperatorRepairEnv = {
      ...base,
      REPAIR_OPERATOR_TOKEN: OPERATOR_TOKEN,
      REPAIR_EXCLUSION_LOOKUP: fakeBinding,
    };
    const response = await operator({
      attemptIds: [prepared.attemptId], tags: [prepared.missingTag], actor: "audit-operator", mode: "execute",
    }, { envOverride: repairEnv });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await responseJson<OperatorResult>(response)).toMatchObject({ rolledForward: 0, excludedAudited: 1, cleared: 1 });
    expect(detector).toHaveLength(1);
    expect(detector[0]).toMatchObject({ attemptId: prepared.attemptId, tag: prepared.missingTag, actor: "audit-operator" });
    const after = await tagFacts(prepared.missingTag);
    expect(after.head).toBe(before.head);
    const resolution = after.facts.resolutions.find((entry) => entry.attemptId === prepared.attemptId)!;
    expect(resolution.branch).toBe("EXCLUDED_AUDITED");
    expect((await journalState(prepared.attemptId)).state).toBe("PARTIAL");
  });

  it("records a head-ahead exclusion without advancing the Tag head or version", async () => {
    const target = tag("head-ahead-direct");
    const attemptId = "head-ahead-direct-attempt";
    const repairItem = item(attemptId, target, "excluded-event", "aaaa", "payload");
    expect((await tagPost(target, "/append", {
      attemptId: "seed", epoch: 0,
      candidates: [{ eventId: "later", suid: "zzzz", payload: "seed", eventTags: [target] }],
    })).status).toBe(201);
    await installPartial(target, attemptId);
    const lease = await responseJson<{ epoch: number }>(await tagPost(target, "/repair/acquire", {
      owner: "owner", scope: [repairItem],
    }));
    const before = await tagFacts(target);
    const applied = await tagPost(target, "/repair/apply", { owner: "owner", epoch: lease.epoch, item: repairItem });
    expect(applied.status).toBe(200);
    expect((await responseJson<{ status: string }>(applied)).status).toBe("EXCLUDED_AUDITED");
    const after = await tagFacts(target);
    expect(after.head).toBe(before.head);
    expect(after.version).toBe(before.version);
  });

  it("fails closed when an equal EventId has unequal durable payload", async () => {
    const target = tag("unequal");
    const attemptId = "unequal-attempt";
    const repairItem = item(attemptId, target, "same-event", SUID, "expected-payload");
    expect((await tagPost(target, "/append", {
      attemptId: "seed", epoch: 0,
      candidates: [{ ...repairItem, payload: "different-payload" }],
    })).status).toBe(201);
    await installPartial(target, attemptId);
    const lease = await responseJson<{ epoch: number }>(await tagPost(target, "/repair/acquire", { owner: "owner", scope: [repairItem] }));
    const applied = await tagPost(target, "/repair/apply", { owner: "owner", epoch: lease.epoch, item: repairItem });
    expect(applied.status).toBe(200);
    expect((await responseJson<{ status: string }>(applied)).status).toBe("FAILED_CLOSED");
    const clear = await tagPost(target, "/repair/clear", {
      owner: "owner", epoch: lease.epoch, attemptId, scopeVersion: (await tagFacts(target)).repairScopeVersion,
    });
    expect(clear.status).toBe(409);
    expect((await tagFacts(target)).fences).toContainEqual(expect.objectContaining({ reason: "partial_write", attemptId }));
  });
});
