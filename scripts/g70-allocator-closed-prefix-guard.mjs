#!/usr/bin/env node
/**
 * SDT-G70 source and acceptance guard.
 *
 * The Vitest suite is the public CommitWorker oracle. This companion guard
 * checks that the production seams used by that oracle remain present and
 * that removing any safety obligation makes the guard red. It is deliberately
 * supplementary: it does not replace the public-path tests.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();

const files = Object.freeze({
  allocator: "packages/dcb-runtime/src/allocator/AllocatorDurableObject.ts",
  allocatorTypes: "packages/dcb-runtime/src/allocator/types.ts",
  commit: "packages/dcb-runtime/src/commit/CommitWorker.ts",
  tag: "packages/dcb-runtime/src/tag/TagDurableObject.ts",
  live: "packages/dcb-runtime/src/projection/LiveProjectionWorker.ts",
  projection: "packages/dcb-runtime/src/projection/ProjectionRuntime.ts",
  mv: "packages/dcb-runtime/src/mv/MaterializedViewCatchUp.ts",
  sample: "samples/meeting-room/src/worker.cloudflare-only.ts",
  sampleMv: "samples/meeting-room/src/d1-mv.ts",
  test: "test/g70-allocator-closed-prefix.spec.ts",
});

function sourceMap(overrides = new Map()) {
  return new Map(Object.values(files).map((file) => [
    file,
    overrides.has(file) ? overrides.get(file) : readFileSync(resolve(root, file), "utf8"),
  ]));
}

function fail(message) {
  throw new Error(`SDT-G70 closed-prefix guard failed: ${message}`);
}

export function checkG70Sources(sources = sourceMap()) {
  const failures = [];
  const requireFile = (file, expected, label) => {
    const source = sources.get(file) ?? "";
    for (const value of expected) {
      if (!source.includes(value)) failures.push(`${label}: missing ${file}: ${value}`);
    }
  };

  requireFile(files.allocator, [
    "await txn.put(attemptKey(input.attemptId), vector);",
    "await txn.put(identityKey, obligation);",
    "await txn.put(OBLIGATION_INDEX_KEY, obligationIndex!);",
    "await this.ctx.storage.setAlarm(Date.now() + RECOVERY_RETRY_MS);",
    "private async readRecoveryDispositions(",
    "while (nextIndex.closedSequence < nextIndex.nextSequence)",
    "const resolved = obligation.targetTags.every((tag) => installedTags.includes(tag) || fencedTags.includes(tag));",
    "const closed = firstUnresolved < 0 ? ordered : ordered.slice(0, firstUnresolved);",
    "if (input.disposition === \"fenced\" && input.fenceConfirmed !== true)",
    "value.historyComplete !== true",
    "state.allocatedWatermark !== input.completeThroughSuid",
    "lastAllocationPersistenceMs",
    "durableWriteCostMs: durableWriteCostMs ?? state.lastAllocationPersistenceMs",
    "reconciliation_empty_history",
    "reconciliation_omits_durable_history",
    "const allocationSnapshot = await this.ctx.storage.list<AllocationVector>({ prefix: ATTEMPT_KEY_PREFIX });",
  ], "allocator authority");
  requireFile(files.allocatorTypes, [
    "export interface ClosedPrefixIndex",
    "export interface IssuanceRecoveryRecord",
    'authority: "allocator-transaction";',
    "acquisitionCostMs?: number;",
    "durableWriteCostMs?: number;",
  ], "allocator durable index types");
  requireFile(files.commit, [
    "body?.fenceConfirmed === true",
    "new Set(cancellation.confirmedTags)",
    "scheduleIssuanceResolution(",
    "cancel-never-reaches-tag",
    "confirmedTags: [],",
  ], "CommitWorker fence/recovery handoff");
  requireFile(files.tag, [
    "if (identity === undefined && input.forceTombstone === true && input.createMissingTombstone === true)",
    "fenceConfirmed: true",
  ], "Tag durable fence confirmation");
  requireFile(files.live, [
    "closedPrefixCertificate?: ClosedPrefixCertificate;",
    "if (env.ALLOCATOR !== undefined && options.closedPrefixCertificate?.status !== \"ready\")",
    "throw new Error(\"ordering_certificate_unavailable\");",
    "validatedClosedPrefixSuid(options)",
    "ordering_certificate_unavailable",
  ], "safe-poll certificate enforcement");
  requireFile(files.projection, [
    'certificate.authority !== "allocator-transaction"',
    "validatedClosedPrefixSuid(options)",
    "certifiedClosedPrefixSuid === null",
    "certifiedClosedPrefixSuid !== undefined && compareSuid(event.suid, certifiedClosedPrefixSuid) > 0",
  ], "ProjectionRuntime certificate authority");
  requireFile(files.mv, [
    "certifiedClosedPrefixSuid === null",
    "certifiedClosedPrefixSuid !== undefined && compareSuid(event.suid, certifiedClosedPrefixSuid) > 0",
  ], "materialized-view dual gate");
  requireFile(files.sample, [
    "closedPrefixCertificate?.status === \"ready\"",
    "closedPrefixSuid,",
  ], "meeting-room safe-lane certificate propagation");
  requireFile(files.sampleMv, [
    "closedPrefixCertificate?: ClosedPrefixCertificate;",
    "closedPrefixCertificate: options.closedPrefixCertificate,",
  ], "meeting-room catch-up certificate propagation");
  requireFile(files.test, [
    "public serialized CommitWorker creates and resolves",
    "public allocation crash resolves only after every source Tag is durably fenced",
    "recovers a lost fence acknowledgement from durable Tag state after the request returns",
    "public CommitWorker matrix keeps multi-Tag and partial/lost handoffs behind the closed-prefix gate",
    "AC2: an uncontacted cancellation cannot close issuance",
    "AC6: reconciliation refuses empty",
    "AC5: a public higher commit cannot pass",
    "AC7: reports bounded certificate and durable allocation costs",
    "expect(response.status).toBe(504)",
    "fencedTags: [tag]",
    "expect(closedWhileRecoveryPending.closedPrefixSuid).not.toBe",
  ], "public acceptance matrix");
  return failures;
}

function assertGreen(sources, label) {
  const failures = checkG70Sources(sources);
  if (failures.length > 0) throw new Error(`${label} failed:\n${failures.join("\n")}`);
}

function assertRed(sources, label) {
  if (checkG70Sources(sources).length === 0) throw new Error(`${label} unexpectedly passed`);
}

export function runSelfTest() {
  const original = sourceMap();
  assertGreen(original, "G70 guard baseline");
  const mutations = [
    {
      id: "omit-atomic-obligation-write",
      file: files.allocator,
      from: "await txn.put(identityKey, obligation);",
      to: "void obligation;",
    },
    {
      id: "advance-prefix-past-unresolved",
      file: files.allocator,
      from: "while (nextIndex.closedSequence < nextIndex.nextSequence)",
      to: "while (false)",
    },
    {
      id: "resolve-without-every-participant",
      file: files.allocator,
      from: "const resolved = obligation.targetTags.every((tag) => installedTags.includes(tag) || fencedTags.includes(tag));",
      to: "const resolved = true;",
    },
    {
      id: "accept-expired-or-aborted-writer",
      file: files.allocator,
      from: "if (input.disposition === \"fenced\" && input.fenceConfirmed !== true)",
      to: "if (false)",
    },
    {
      id: "substitute-allocated-watermark-for-closed-prefix",
      file: files.allocator,
      from: "const closed = firstUnresolved < 0 ? ordered : ordered.slice(0, firstUnresolved);",
      to: "const closed = ordered;",
    },
    {
      id: "remove-durable-recovery-alarm",
      file: files.allocator,
      from: "await this.ctx.storage.setAlarm(Date.now() + RECOVERY_RETRY_MS);",
      to: "void RECOVERY_RETRY_MS;",
    },
    {
      id: "trust-incomplete-reconcile-cut",
      file: files.allocator,
      from: "reconciliation_omits_durable_history",
      to: "reconciliation_history_not_checked",
    },
    {
      id: "allow-unvalidated-safe-poll",
      file: files.live,
      from: "if (env.ALLOCATOR !== undefined && options.closedPrefixCertificate?.status !== \"ready\")",
      to: "if (false)",
    },
    {
      id: "certify-uncontacted-cancellation",
      file: files.commit,
      from: "confirmedTags: [],",
      to: "confirmedTags: [...tags],",
    },
    {
      id: "omit-first-write-fence-creation",
      file: files.tag,
      from: "input.createMissingTombstone === true",
      to: "input.createMissingTombstone === false",
    },
  ];
  const results = mutations.map((mutation) => {
    const source = original.get(mutation.file);
    if (source === undefined || !source.includes(mutation.from)) fail(`${mutation.id} anchor missing`);
    const mutated = mutation.id === "accept-expired-or-aborted-writer" || mutation.from === "reconciliation_omits_durable_history"
      ? source.replaceAll(mutation.from, mutation.to)
      : source.replace(mutation.from, mutation.to);
    const next = new Map(original);
    next.set(mutation.file, mutated);
    assertRed(next, mutation.id);
    return { id: mutation.id, result: "red" };
  });
  process.stdout.write(`${JSON.stringify({ guard: "g70-allocator-closed-prefix", mutants: results, result: "all-g70-mutants-red" })}\n`);
}

if (process.argv.includes("--self-test")) {
  runSelfTest();
} else {
  assertGreen(sourceMap(), "G70 guard");
  process.stdout.write(`${JSON.stringify({ guard: "g70-allocator-closed-prefix", result: "pass" })}\n`);
}
