#!/usr/bin/env node
// SDT-G152 mutation runner. Each mutant edits an owned scratch copy at an
// anchor that must match exactly once, then expects the guard to fail with
// the mutant's own named check. `--self-test` verifies anchors only.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guard = join(root, "scripts/g152-mv-force-reverse-guard.mjs");
const files = {
  store: "packages/dcb-runtime/src/mv/MaterializedViewStore.ts",
  catchUp: "packages/dcb-runtime/src/mv/MaterializedViewCatchUp.ts",
  actions: "packages/dcb-runtime/src/mv/MaterializedViewActions.ts",
  migration: "migrations/mv/0010_g152_force_reverse_audit.sql",
  template: "packages/create-dcb/template/migrations/mv/0010_g152_force_reverse_audit.sql",
  compose: "packages/dcb-cloudflare/src/compose.ts",
  spec: "test/g152-mv-force-reverse.spec.ts",
};

const historyClause = `              AND NOT EXISTS (
                SELECT 1 FROM mv_ordering_quarantines retained_history
                 WHERE retained_history.service_id = retained.service_id
                   AND retained_history.view_id = retained.view_id
                   AND retained_history.generation = retained.generation
              )
`;
const retireStatement = `      this.database.prepare(
        \`UPDATE mv_instances SET status = 'retired', updated_at = ?
          WHERE service_id = ? AND view_id = ? AND generation = ? AND status = 'active'\`,
      ).bind(input.updatedAt, input.serviceId, input.viewId, input.expectedActiveGeneration),
`;
const activateBind = "      ).bind(input.serviceId, input.viewId, input.retainedGeneration),\n";

const mutants = [
  {
    name: "reverse-only",
    edits: [{
      file: "store",
      from: "    if (input.retainedGeneration >= input.expectedActiveGeneration) {\n      throw new MaterializedViewStoreError(\"force-reverse\", \"MV_GENERATION_INVALID\", \"Materialized-view force-reverse must target an older retained generation\");\n    }\n",
      to: "",
    }],
  },
  {
    name: "retired-only",
    label: "accept-candidate-retained",
    edits: [
      { file: "store", from: 'if (retained === undefined || retained.status !== "retired") {', to: 'if (retained === undefined || retained.status === "active") {' },
      { file: "store", from: "AND retained.generation = ? AND retained.status = 'retired'", to: "AND retained.generation = ? AND retained.status IN ('retired', 'candidate')" },
    ],
  },
  {
    name: "reverse-cas-not-promote",
    label: "call-promote-instead",
    edits: [{
      file: "catchUp",
      from: "    const reversed = await this.materializedViews.forceReverseGeneration({",
      to: "    const reversed = await this.materializedViews.promoteGeneration({",
    }],
  },
  {
    name: "reason-validation",
    label: "skip-reason-validation",
    edits: [{ file: "store", from: "const reason = normalizeMaterializedViewForceReverseReason(input.reason);", to: "const reason = input.reason as string | undefined;" }],
  },
  {
    name: "quarantine-history",
    label: "ignore-quarantine-history",
    edits: [
      { file: "store", from: historyClause, to: "" },
      { file: "store", from: "if (history !== null && history !== undefined) {", to: "if (history === undefined && history !== undefined) {" },
    ],
  },
  {
    name: "quarantine-history",
    label: "ignore-resolved-history",
    edits: [{
      file: "store",
      from: "                   AND retained_history.generation = retained.generation\n",
      to: "                   AND retained_history.generation = retained.generation\n                   AND retained_history.status = 'open'\n",
    }],
  },
  {
    name: "quarantine-untouched",
    label: "clear-quarantine-in-batch",
    edits: [{
      file: "store",
      from: "      this.database.prepare(\"DELETE FROM mv_atomic_guards WHERE operation_id = ?\").bind(operation),\n    ];\n    try {\n      await this.database.batch(statements);\n    } catch (error) {\n      if (isCasFailure(error)) throw new MaterializedViewForceReverseCasError();",
      to: "      this.database.prepare(\"UPDATE mv_ordering_quarantines SET status = 'resolved' WHERE service_id = ? AND view_id = ?\").bind(input.serviceId, input.viewId),\n      this.database.prepare(\"DELETE FROM mv_atomic_guards WHERE operation_id = ?\").bind(operation),\n    ];\n    try {\n      await this.database.batch(statements);\n    } catch (error) {\n      if (isCasFailure(error)) throw new MaterializedViewForceReverseCasError();",
    }],
  },
  {
    name: "forced-audit",
    label: "pointer-writes-ordinary",
    edits: [{ file: "store", from: "switch_kind = 'forced', switch_reason = ?", to: "switch_kind = 'ordinary', switch_reason = ?" }],
  },
  {
    name: "forced-audit",
    label: "heartbeat-writes-ordinary",
    edits: [{ file: "catchUp", from: 'switch: { kind: "forced", reason: reason.trim() },', to: 'switch: { kind: "ordinary", reason: null },' }],
  },
  {
    name: "pointer-fence",
    label: "weaken-pointer-fence",
    edits: [{ file: "store", from: "AND pointer.generation = ? AND current.status = 'active'", to: "AND current.status = 'active'" }],
  },
  {
    name: "non-null-expectation",
    label: "allow-null-expectation-store",
    edits: [{
      file: "store",
      from: "  readonly expectedActiveGeneration: number;\n  /** Operator reason;",
      to: "  readonly expectedActiveGeneration: number | null;\n  /** Operator reason;",
    }],
  },
  {
    name: "non-null-expectation",
    label: "allow-null-expectation-http",
    edits: [{
      file: "actions",
      from: "if (!isGeneration(retainedGeneration) || !isGeneration(expectedActiveGeneration)) throw new InvalidActionRequest();",
      to: "if (!isGeneration(retainedGeneration) || (expectedActiveGeneration !== null && !isGeneration(expectedActiveGeneration))) throw new InvalidActionRequest();",
    }],
  },
  {
    name: "initialize-probe",
    label: "skip-initialize-probe",
    edits: [{
      file: "store",
      from: "    await this.database.prepare(\n      \"SELECT 1 FROM mv_active_generations WHERE switch_kind IS NOT NULL OR switch_reason IS NOT NULL OR switched_at IS NOT NULL LIMIT 1\",\n    ).all();\n",
      to: "",
    }],
  },
  {
    name: "legacy-default",
    label: "default-ordinary",
    edits: [{ file: "migration", from: "NOT NULL DEFAULT 'legacy'", to: "NOT NULL DEFAULT 'ordinary'" }],
  },
  {
    name: "legacy-default",
    label: "template-drift",
    edits: [{ file: "template", from: "NOT NULL DEFAULT 'legacy'", to: "NOT NULL DEFAULT 'ordinary'" }],
  },
  {
    name: "legacy-read",
    label: "legacy-read-as-forced",
    edits: [{ file: "store", from: "      switchKind: switchKind ?? null,\n", to: "      switchKind: switchKind === \"legacy\" ? \"forced\" : switchKind ?? null,\n" }],
  },
  {
    name: "retire-before-activate",
    label: "activate-before-retire",
    edits: [
      { file: "store", from: retireStatement, to: "" },
      { file: "store", from: activateBind, to: `${activateBind}${retireStatement}` },
    ],
  },
  {
    name: "route-registration",
    edits: [{ file: "actions", from: '  "force-reverse": "POST",\n', to: "" }],
  },
  {
    name: "error-mapping",
    edits: [{ file: "actions", from: 'return errorResponse(409, "materialized_view_force_reverse_conflict"', to: 'return errorResponse(503, "materialized_view_force_reverse_conflict"' }],
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
  console.log(`g152 mutation anchors passed (${mutants.length} mutants)`);
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
  const clean = scratch("g152-clean-");
  copyTree(clean);
  const baseline = runGuard(clean);
  if (baseline.status !== 0) {
    console.error(baseline.stdout);
    console.error(baseline.stderr);
    throw new Error("guard failed on the unmodified sources");
  }
  for (const mutant of mutants) {
    const directory = scratch("g152-mutant-");
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
console.log("g152 materialized-view force-reverse mutation runner passed");
