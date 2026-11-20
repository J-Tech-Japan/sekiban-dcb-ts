#!/usr/bin/env node
// SDT-G151 mutation runner. Each mutant edits an owned scratch copy at an
// anchor that must match exactly once, then expects the guard to fail with
// the mutant's own named check. `--self-test` verifies anchors only.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guard = join(root, "scripts/g151-mv-actions-guard.mjs");
const files = {
  ordinary: "packages/dcb-runtime/src/index.ts",
  cloudflare: "packages/dcb-runtime/src/cloudflare.ts",
  actions: "packages/dcb-runtime/src/mv/MaterializedViewActions.ts",
  catchUp: "packages/dcb-runtime/src/mv/MaterializedViewCatchUp.ts",
  compose: "packages/dcb-cloudflare/src/compose.ts",
  spec: "test/g151-mv-actions.spec.ts",
};

const branch = `      if (isMaterializedViewActionPath(url.pathname)) {
        // Authenticated before any view/body parsing, identity, or store work.
        return handleMaterializedViewAction(request, {`;
const auth = `  const denied = await authenticateOperatorRepair(request, dependencies.operatorToken);
  if (denied !== undefined) return denied;
`;

const mutants = [
  { name: "ordinary-branch", edits: [{ file: "ordinary", from: branch, to: "      if (false) {\n        return handleMaterializedViewAction(request, {" }] },
  { name: "cloudflare-branch", edits: [{ file: "cloudflare", from: branch, to: "      if (false) {\n        return handleMaterializedViewAction(request, {" }] },
  { name: "auth-first", edits: [{ file: "actions", from: auth, to: "" }] },
  {
    name: "auth-first",
    label: "auth-after-parsing",
    edits: [
      { file: "actions", from: auth, to: "" },
      {
        file: "actions",
        from: "  let serviceId: string;\n  try {\n    serviceId = dependencies.resolveServiceId();",
        to: `${auth}  let serviceId: string;\n  try {\n    serviceId = dependencies.resolveServiceId();`,
      },
    ],
  },
  {
    name: "definition-version-guard",
    edits: [{
      file: "catchUp",
      from: "    if (materializer.version !== active.definitionVersion) {\n      throw new MaterializedViewDefinitionVersionMismatchError();\n    }\n",
      to: "",
    }],
  },
  {
    name: "registry-lookup",
    edits: [{
      file: "actions",
      from: "const materializer = dependencies.registry.lookup(viewId);",
      to: "const registered = dependencies.registry.lookup(viewId);\n  const materializer = registered === undefined ? undefined : { ...registered, version: Number(url.searchParams.get(\"version\")) };",
    }],
  },
  { name: "ensure-idempotent", edits: [{ file: "actions", from: "  if (existing !== undefined) return null;\n", to: "" }] },
  {
    name: "prepare-no-cutover",
    edits: [{
      file: "actions",
      from: "        result = await runtime.rebuild(serviceId, materializer, nowMs, input.rebuildId);\n",
      to: "        result = await runtime.rebuild(serviceId, materializer, nowMs, input.rebuildId);\n        await runtime.promote(serviceId, materializer, (result as { candidateGeneration: number }).candidateGeneration, nowMs);\n",
    }],
  },
  {
    name: "expected-active-pass-through",
    edits: [{
      file: "catchUp",
      from: "      expectedActiveGeneration: options.expectedActiveGeneration !== undefined\n        ? options.expectedActiveGeneration\n        : active?.generation ?? null,",
      to: "      expectedActiveGeneration: active?.generation ?? null,",
    }],
  },
  {
    name: "cas-conflict-409",
    edits: [{
      file: "actions",
      from: 'return errorResponse(409, "materialized_view_switch_conflict"',
      to: 'return errorResponse(200, "materialized_view_switch_conflict"',
    }],
  },
  {
    name: "received-unique-source",
    edits: [{
      file: "actions",
      from: 'if (lookup.kind !== "stored" || state.activeGeneration === undefined) return json(200, false);',
      to: 'if (state.activeGeneration === undefined) return json(200, false);',
    }],
  },
  {
    name: "received-incident-gate",
    edits: [{ file: "actions", from: '  if (lookup.kind === "unavailable") return unavailable();\n', to: "" }],
  },
  {
    name: "received-checkpoint-gate",
    edits: [{
      file: "actions",
      from: "if (state.checkpointAhead || state.rebuildRequired || state.poison) return unavailable();",
      to: "if (state.rebuildRequired || state.poison) return unavailable();",
    }],
  },
  {
    name: "received-rebuild-gate",
    edits: [{
      file: "actions",
      from: "if (state.checkpointAhead || state.rebuildRequired || state.poison) return unavailable();",
      to: "if (state.checkpointAhead || state.poison) return unavailable();",
    }],
  },
  {
    name: "received-poison-gate",
    edits: [{
      file: "actions",
      from: "if (state.checkpointAhead || state.rebuildRequired || state.poison) return unavailable();",
      to: "if (state.checkpointAhead || state.rebuildRequired) return unavailable();",
    }],
  },
  {
    name: "get-no-catch-up",
    edits: [{
      file: "actions",
      from: "    return json(200, await readMaterializedViewRuntimeStatus(source, target, serviceId, materializer, nowMs));",
      to: "    await new MaterializedViewCatchUpRuntime(source, target).follow(serviceId, materializer, nowMs);\n    return json(200, await readMaterializedViewRuntimeStatus(source, target, serviceId, materializer, nowMs));",
    }],
  },
  {
    name: "get-no-catch-up",
    label: "get-publication",
    edits: [{
      file: "actions",
      from: "  if (lookup.kind === \"unavailable\") return unavailable();\n",
      to: "  if (lookup.kind === \"unavailable\") return unavailable();\n  await (source as { upsertProjectionStatusHeartbeat?: (...args: never[]) => unknown }).upsertProjectionStatusHeartbeat?.();\n",
    }],
  },
  {
    name: "serialized-paths",
    edits: [{
      file: "compose",
      from: '  "/api/sekiban/serialized/projection-status",\n',
      to: '  "/api/sekiban/serialized/projection-status",\n  "/operator/materialized-views",\n',
    }],
  },
];

function count(source, anchor) {
  return source.split(anchor).length - 1;
}

function verifyAnchors() {
  const problems = [];
  for (const mutant of mutants) {
    let sources = Object.fromEntries(Object.entries(files).map(([key, relative]) => [key, readFileSync(join(root, relative), "utf8")]));
    for (const edit of mutant.edits) {
      const matches = count(sources[edit.file], edit.from);
      if (matches !== 1) problems.push(`anchor ${mutant.label ?? mutant.name} matched ${matches} times in ${files[edit.file]}`);
      else sources = { ...sources, [edit.file]: sources[edit.file].replace(edit.from, edit.to) };
    }
  }
  return problems;
}

function copyTree(target) {
  for (const relative of Object.values(files)) {
    const destination = join(target, relative);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(join(root, relative)));
  }
}

function runGuard(target) {
  return spawnSync(process.execPath, [guard, "--root", target], { encoding: "utf8" });
}

const anchorProblems = verifyAnchors();
if (anchorProblems.length > 0) {
  for (const problem of anchorProblems) console.error(problem);
  process.exit(1);
}
if (process.argv.includes("--self-test")) {
  console.log(`g151 mutation anchors passed (${mutants.length} mutants)`);
  process.exit(0);
}

const owned = [];
const scratch = (prefix) => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  owned.push(directory);
  return directory;
};
let exitCode = 0;
try {
  const clean = scratch("g151-clean-");
  copyTree(clean);
  const baseline = runGuard(clean);
  if (baseline.status !== 0) {
    console.error(baseline.stdout);
    console.error(baseline.stderr);
    throw new Error("guard failed on the unmodified sources");
  }
  for (const mutant of mutants) {
    const directory = scratch("g151-mutant-");
    copyTree(directory);
    for (const edit of mutant.edits) {
      const path = join(directory, files[edit.file]);
      const source = readFileSync(path, "utf8");
      if (count(source, edit.from) !== 1) throw new Error(`anchor vanished for ${mutant.label ?? mutant.name}`);
      writeFileSync(path, source.replace(edit.from, edit.to));
    }
    const result = runGuard(directory);
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes(`FAIL ${mutant.name}\n`) && !output.endsWith(`FAIL ${mutant.name}`)) {
      console.error(output);
      throw new Error(`mutant ${mutant.label ?? mutant.name} did not fail ${mutant.name}`);
    }
    console.log(`killed ${mutant.label ?? mutant.name}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  exitCode = 1;
} finally {
  for (const directory of owned) rmSync(directory, { recursive: true, force: true });
}
if (exitCode !== 0) process.exit(exitCode);
console.log("g151 materialized-view actions mutation runner passed");
