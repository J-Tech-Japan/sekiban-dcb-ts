#!/usr/bin/env node
/**
 * SDT-G70 source guard.  The runtime tests exercise the durable allocator and
 * public CommitWorker; this companion guard makes the four acceptance escapes
 * red without changing a production test fixture to make it pass.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();

export const G70_GUARDS = Object.freeze([
  {
    id: "obligation-atomic-registration",
    files: ["packages/dcb-runtime/src/allocator/AllocatorDurableObject.ts"],
    required: [
      "await txn.put(attemptKey(input.attemptId), vector);",
      "await txn.put(ISSUANCE_OBLIGATIONS_KEY, obligations);",
      "if (closedPrefixMeta !== undefined) await txn.put(CLOSED_PREFIX_META_KEY, closedPrefixMeta);",
    ],
  },
  {
    id: "closed-prefix-stops-at-first-unresolved",
    files: ["packages/dcb-runtime/src/allocator/AllocatorDurableObject.ts"],
    required: [
      "const firstUnresolved = ordered.findIndex((obligation) => obligation.status !== \"resolved\");",
      "closedPrefixSuid: closed.length === 0 ? null : closed[closed.length - 1]!.suid,",
    ],
  },
  {
    id: "resolution-requires-every-participant",
    files: ["packages/dcb-runtime/src/allocator/AllocatorDurableObject.ts"],
    required: [
      "const resolved = obligation.targetTags.every((tag) => installedTags.includes(tag) || fencedTags.includes(tag));",
    ],
  },
  {
    id: "safe-view-dual-gate",
    files: [
      "packages/dcb-runtime/src/mv/MaterializedViewCatchUp.ts",
      "packages/dcb-runtime/src/projection/ProjectionRuntime.ts",
      "samples/meeting-room/src/worker.cloudflare-only.ts",
    ],
    requiredByFile: [
      { file: "packages/dcb-runtime/src/mv/MaterializedViewCatchUp.ts", required: ["options.closedPrefixSuid === null"] },
      { file: "packages/dcb-runtime/src/projection/ProjectionRuntime.ts", required: ["options.closedPrefixSuid === null"] },
      { file: "samples/meeting-room/src/worker.cloudflare-only.ts", required: ["closedPrefixSuid,"] },
    ],
  },
]);

function sourceMap(overrides = new Map()) {
  return new Map(G70_GUARDS.flatMap((guard) => guard.files).map((file) => [
    file,
    overrides.has(file) ? overrides.get(file) : readFileSync(resolve(root, file), "utf8"),
  ]));
}

export function checkG70Sources(sources = sourceMap()) {
  const failures = [];
  for (const guard of G70_GUARDS) {
    for (const required of guard.required ?? []) {
      const present = guard.files.some((file) => sources.get(file)?.includes(required));
      if (!present) failures.push(`${guard.id}: missing ${required}`);
    }
    for (const entry of guard.requiredByFile ?? []) {
      for (const required of entry.required) {
        if (!sources.get(entry.file)?.includes(required)) failures.push(`${guard.id}: missing ${entry.file}: ${required}`);
      }
    }
  }
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
  assertGreen(sourceMap(), "G70 guard baseline");
  const mutants = [
    {
      id: "remove-obligation-write",
      file: "packages/dcb-runtime/src/allocator/AllocatorDurableObject.ts",
      from: "await txn.put(ISSUANCE_OBLIGATIONS_KEY, obligations);",
      to: "void obligations;",
    },
    {
      id: "skip-unresolved-prefix",
      file: "packages/dcb-runtime/src/allocator/AllocatorDurableObject.ts",
      from: "const firstUnresolved = ordered.findIndex((obligation) => obligation.status !== \"resolved\");",
      to: "const firstUnresolved = -1;",
    },
    {
      id: "resolve-without-all-participants",
      file: "packages/dcb-runtime/src/allocator/AllocatorDurableObject.ts",
      from: "const resolved = obligation.targetTags.every((tag) => installedTags.includes(tag) || fencedTags.includes(tag));",
      to: "const resolved = true;",
    },
    {
      id: "remove-safe-dual-gate",
      file: "packages/dcb-runtime/src/mv/MaterializedViewCatchUp.ts",
      from: "options.closedPrefixSuid === null",
      to: "false",
    },
  ];
  const results = mutants.map((mutant) => {
    const original = sourceMap().get(mutant.file);
    if (original === undefined || !original.includes(mutant.from)) throw new Error(`${mutant.id} anchor missing`);
    const mutated = original.replace(mutant.from, mutant.to);
    const sources = sourceMap(new Map([[mutant.file, mutated]]));
    assertRed(sources, mutant.id);
    return { id: mutant.id, result: "red" };
  });
  process.stdout.write(`${JSON.stringify({ guard: "g70-allocator-closed-prefix", mutants: results, result: "all-g70-mutants-red" })}\n`);
}

if (process.argv.includes("--self-test")) {
  runSelfTest();
} else {
  assertGreen(sourceMap(), "G70 guard");
  process.stdout.write(`${JSON.stringify({ guard: "g70-allocator-closed-prefix", result: "pass" })}\n`);
}
