#!/usr/bin/env node
/**
 * Prove the current-graph coverage rules with an in-memory mutation table.
 * No mutation is written to the repository or to a temporary checkout.
 */
import { buildCurrentGraph, cloneSnapshot, loadSnapshot } from "./g40-ci-step-inventory.mjs";
import { evaluateCoverage } from "./g40-ci-coverage-check.mjs";

const SCHEMA = "sdt-g40-ci-mutation-proof/v4";
const CI_WORKFLOW = ".github/workflows/ci.yml";
const FULL_WORKFLOW = ".github/workflows/ci-full.yml";

function fail(message) {
  throw new Error(`g40-ci-mutation-proof:${message}`);
}

function workflow(snapshot, path) {
  const result = snapshot.workflows.find((entry) => entry.path === path);
  if (result === undefined) fail(`fixture is missing workflow ${path}`);
  return result;
}

function job(snapshot, workflowPath, jobName) {
  const result = workflow(snapshot, workflowPath).document.jobs?.[jobName];
  if (result === undefined) fail(`fixture is missing job ${workflowPath}/${jobName}`);
  return result;
}

function dispatchStep(snapshot, workflowPath, jobName) {
  const steps = job(snapshot, workflowPath, jobName).steps;
  const index = steps.findIndex((step) => typeof step?.run === "string" && step.run.includes("scripts/ci-local.mjs"));
  if (index < 0) fail(`fixture is missing ci-local dispatch ${workflowPath}/${jobName}`);
  return steps[index];
}

function lane(snapshot, name) {
  const result = snapshot.manifest.lanes.find((entry) => entry.name === name);
  if (result === undefined) fail(`fixture is missing lane ${name}`);
  return result;
}

function command(laneValue, id) {
  const result = laneValue.commands.find((entry) => entry.id === id);
  if (result === undefined) fail(`fixture is missing command ${laneValue.name}/${id}`);
  return result;
}

function mutation(id, expected, apply) {
  return { id, expected, apply };
}

export const MUTATIONS = [
  mutation("ci-full-lane-dispatch-removed", "lane-not-in-full", (snapshot) => {
    const full = job(snapshot, FULL_WORKFLOW, "full");
    full.steps = full.steps.filter((step) => !(typeof step?.run === "string" && step.run.includes("scripts/ci-local.mjs")));
  }),
  mutation("ci-full-full-replaced-by-pr", "command-unreached", (snapshot) => {
    dispatchStep(snapshot, FULL_WORKFLOW, "full").run = "node scripts/ci-local.mjs --tier pr";
  }),
  mutation("cheap-lane-dispatch-removed", "pr-command-unverified", (snapshot) => {
    const cheapJob = job(snapshot, CI_WORKFLOW, "ci-pr-cheap");
    cheapJob.steps = cheapJob.steps.filter((step) => !(typeof step?.run === "string" && step.run.includes("scripts/ci-local.mjs")));
  }),
  mutation("verify-needs-cheap-removed", "pr-command-unverified", (snapshot) => {
    job(snapshot, CI_WORKFLOW, "verify").needs = ["ci-foundation"];
  }),
  mutation("verify-needs-env-removed", "workflow-shape", (snapshot) => {
    delete job(snapshot, CI_WORKFLOW, "verify").env;
  }),
  mutation("workflow-undefined-npm-script", "undefined-npm-script", (snapshot) => {
    job(snapshot, CI_WORKFLOW, "ci-foundation").steps.push({ name: "synthetic undefined npm script", run: "npm run g108-undefined-script" });
  }),
  mutation("lane-undefined-npm-script", "undefined-npm-script", (snapshot) => {
    command(lane(snapshot, "cheap"), "g40-coverage").command = "npm run g108-undefined-script";
  }),
  mutation("npm-script-cycle", "npm-script-cycle", (snapshot) => {
    snapshot.rootPackage.scripts["g108-cycle-a"] = "npm run g108-cycle-b";
    snapshot.rootPackage.scripts["g108-cycle-b"] = "npm run g108-cycle-a";
  }),
  mutation("duplicate-command-id", "duplicate-command-id", (snapshot) => {
    command(lane(snapshot, "foundation"), "foundation-lint").id = "commit-trace-seal";
  }),
  mutation("duplicate-lane-name", "manifest-shape", (snapshot) => {
    const original = lane(snapshot, "g43");
    const duplicate = structuredClone(original);
    duplicate.commands = duplicate.commands.map((entry, index) => ({ ...entry, id: `${entry.id}-duplicate-${index}` }));
    snapshot.manifest.lanes.push(duplicate);
  }),
  mutation("empty-lane", "empty-lane", (snapshot) => {
    lane(snapshot, "g43").commands = [];
  }),
  mutation("invalid-expect", "invalid-expect", (snapshot) => {
    command(lane(snapshot, "foundation"), "foundation-lint").expect = "unexpected";
  }),
  mutation("unknown-lane", "unknown-lane-or-tier", (snapshot) => {
    dispatchStep(snapshot, CI_WORKFLOW, "ci-foundation").run = "node scripts/ci-local.mjs --lane foundation,g108-unknown --ci";
  }),
  mutation("unknown-tier", "unknown-lane-or-tier", (snapshot) => {
    dispatchStep(snapshot, CI_WORKFLOW, "ci-pr-cheap").run = "node scripts/ci-local.mjs --lane cheap --tier g108-unknown --ci";
  }),
  mutation("ci-local-affected-argument", "ci-local-argument", (snapshot) => {
    dispatchStep(snapshot, CI_WORKFLOW, "ci-pr-cheap").run += " --affected package.json";
  }),
  mutation("ci-local-shell-operator", "ci-local-argument", (snapshot) => {
    dispatchStep(snapshot, CI_WORKFLOW, "ci-pr-cheap").run += " || true";
  }),
  mutation("cheap-dispatch-commented-out", "pr-command-unverified", (snapshot) => {
    dispatchStep(snapshot, CI_WORKFLOW, "ci-pr-cheap").run = "# node scripts/ci-local.mjs --lane cheap --ci\necho skipped";
  }),
  mutation("cheap-dispatch-echoed", "pr-command-unverified", (snapshot) => {
    dispatchStep(snapshot, CI_WORKFLOW, "ci-pr-cheap").run = "echo node scripts/ci-local.mjs --lane cheap --ci";
  }),
  mutation("dispatch-after-or", "ci-local-argument", (snapshot) => {
    dispatchStep(snapshot, CI_WORKFLOW, "ci-pr-cheap").run = "true || node scripts/ci-local.mjs --lane cheap --ci";
  }),
  mutation("dispatch-prelude-command", "ci-local-argument", (snapshot) => {
    const step = dispatchStep(snapshot, CI_WORKFLOW, "ci-pr-cheap");
    step.run = `exit 0\n${step.run}`;
  }),
  mutation("npm-wrapped-workflow-dispatch", "ci-local-argument", (snapshot) => {
    dispatchStep(snapshot, CI_WORKFLOW, "ci-pr-cheap").run = "npm run ci:local -- --lane cheap --ci";
  }),
  mutation("dispatch-step-continue-on-error", "dispatch-conditional", (snapshot) => {
    dispatchStep(snapshot, CI_WORKFLOW, "ci-pr-cheap")["continue-on-error"] = true;
  }),
  mutation("dispatch-job-if", "dispatch-conditional", (snapshot) => {
    job(snapshot, CI_WORKFLOW, "ci-foundation").if = "false";
  }),
  mutation("lane-missing-script-path", "missing-path", (snapshot) => {
    command(lane(snapshot, "foundation"), "foundation-lint").command = "node scripts/g108-missing-script.mjs";
  }),
  mutation("workspace-lifecycle-undefined-script", "undefined-npm-script", (snapshot) => {
    command(lane(snapshot, "cheap"), "g40-coverage").command = "npm test --workspace @sekiban/dcb-core";
  }),
  mutation("workspace-option-before-subcommand-undefined-script", "undefined-npm-script", (snapshot) => {
    command(lane(snapshot, "cheap"), "g40-coverage").command = "npm --workspace @sekiban/dcb-core run g108-missing";
  }),
  mutation("required-lanes-differ", "required-lanes-mismatch", (snapshot) => {
    snapshot.manifest.requiredLanes = snapshot.manifest.requiredLanes.filter((name) => name !== "g46");
  }),
  mutation("affected-path-matches-nothing", "affected-path-unmatched", (snapshot) => {
    lane(snapshot, "g43").affectedPaths.push("scripts/g108-no-match.mjs");
  }),
  mutation("g30-commit-trace-patterns-removed", "local-path-uncovered", (snapshot) => {
    lane(snapshot, "g30").affectedPaths = lane(snapshot, "g30").affectedPaths.filter((pattern) => pattern !== "scripts/commit-trace-*.mjs");
  }),
  mutation("seal-root-epoch-pattern-moved", "seal-roots-uncovered", (snapshot) => {
    lane(snapshot, "g30").affectedPaths = lane(snapshot, "g30").affectedPaths.filter((pattern) => pattern !== "contracts/epoch-*.json");
    lane(snapshot, "g43").affectedPaths.push("contracts/epoch-*.json");
  }),
  mutation("seal-command-removed", "seal-command", (snapshot) => {
    const cheap = lane(snapshot, "cheap");
    cheap.commands = cheap.commands.slice(1);
  }),
  mutation("seal-command-moved", "seal-command", (snapshot) => {
    const cheap = lane(snapshot, "cheap");
    [cheap.commands[0], cheap.commands[1]] = [cheap.commands[1], cheap.commands[0]];
  }),
  mutation("seal-command-expect", "seal-command", (snapshot) => {
    command(lane(snapshot, "cheap"), "commit-trace-seal").expect = "red";
  }),
  mutation("seal-command-newline-split", "seal-command", (snapshot) => {
    command(lane(snapshot, "cheap"), "commit-trace-seal").command = "node scripts/commit-trace-contract.mjs\n--check";
  }),
  mutation("manifest-paths-ignore-only", "paths-ignore-mismatch", (snapshot) => {
    snapshot.manifest.pathsIgnore = ["docs/neutral-self-test.md"];
  }),
  mutation("workflow-paths-ignore-only", "paths-ignore-mismatch", (snapshot) => {
    for (const event of ["push", "pull_request"]) {
      const workflowDocument = snapshot.workflows.find((entry) => entry.path === CI_WORKFLOW).document;
      workflowDocument.on[event] ??= {};
      workflowDocument.on[event]["paths-ignore"] = ["docs/neutral-self-test.md"];
    }
  }),
];

function semanticSnapshot(snapshot) {
  return JSON.stringify({
    manifest: snapshot.manifest,
    workflows: snapshot.workflows.map((entry) => ({ path: entry.path, document: entry.document })),
    packages: snapshot.packages.map((entry) => ({ path: entry.relativePath, document: entry.document })),
  });
}

function proveNpmWrappedWorkflowDispatch(baseSnapshot) {
  const snapshot = cloneSnapshot(baseSnapshot);
  snapshot.rootPackage.scripts["ci:local"] = "exit 0\nnode scripts/ci-local.mjs";
  dispatchStep(snapshot, CI_WORKFLOW, "ci-pr-cheap").run = "npm run ci:local -- --lane cheap --ci";
  const graph = buildCurrentGraph(snapshot);
  const result = evaluateCoverage(graph);
  const dispatch = graph.resolution.dispatches.find((entry) => entry.origin === "workflow" && entry.jobName === "ci-pr-cheap");
  if (!result.reasonCodes.includes("ci-local-argument") || dispatch === undefined || !dispatch.invalidArgument || dispatch.selectedLanes.includes("cheap") || dispatch.unknownNames.length > 0) {
    fail(`npm-wrapped workflow dispatch was not rejected fail-closed: ${result.reasonCodes.join(",")}`);
  }
  return { command: dispatch.command, selectedLanes: dispatch.selectedLanes, invalidArgument: dispatch.invalidArgument, reportedReasonCodes: result.reasonCodes };
}

function proveFocusedShellAndNpmFixtures(baseSnapshot) {
  const continuation = cloneSnapshot(baseSnapshot);
  dispatchStep(continuation, CI_WORKFLOW, "ci-pr-cheap").run = "node scripts/ci-local.mjs \\\n   --lane cheap --ci";
  const continuationResult = evaluateCoverage(buildCurrentGraph(continuation));
  const continuationDispatch = buildCurrentGraph(continuation).resolution.dispatches.find((entry) => entry.origin === "workflow" && entry.jobName === "ci-pr-cheap");
  if (continuationResult.failures.length > 0 || continuationDispatch?.invalidArgument || !continuationDispatch?.selectedLanes.includes("cheap")) {
    fail(`backslash-newline dispatch fixture was not accepted: ${continuationResult.reasonCodes.join(",")}`);
  }

  const setPrelude = cloneSnapshot(baseSnapshot);
  const setPreludeStep = dispatchStep(setPrelude, CI_WORKFLOW, "ci-pr-cheap");
  setPreludeStep.run = `set -euo pipefail\n${setPreludeStep.run}`;
  const setPreludeGraph = buildCurrentGraph(setPrelude);
  const setPreludeResult = evaluateCoverage(setPreludeGraph);
  const setPreludeDispatch = setPreludeGraph.resolution.dispatches.find((entry) => entry.origin === "workflow" && entry.jobName === "ci-pr-cheap");
  if (setPreludeResult.failures.length > 0 || setPreludeDispatch?.invalidArgument || !setPreludeDispatch?.selectedLanes.includes("cheap")) {
    fail(`set-line dispatch fixture was not accepted: ${setPreludeResult.reasonCodes.join(",")}`);
  }

  const echoed = cloneSnapshot(baseSnapshot);
  command(lane(echoed, "cheap"), "g40-coverage").command = "echo npm run g108-missing";
  const echoedResult = evaluateCoverage(buildCurrentGraph(echoed));
  if (echoedResult.failures.length > 0) fail(`echoed npm fixture was not accepted: ${echoedResult.reasonCodes.join(",")}`);

  const beforeSubcommand = cloneSnapshot(baseSnapshot);
  command(lane(beforeSubcommand, "cheap"), "g40-coverage").command = "npm --workspace @sekiban/dcb-core run g108-missing";
  const beforeResult = evaluateCoverage(buildCurrentGraph(beforeSubcommand));
  if (!beforeResult.reasonCodes.includes("undefined-npm-script")) {
    fail(`workspace option before subcommand fixture did not report undefined-npm-script: ${beforeResult.reasonCodes.join(",")}`);
  }

  const quotedWorkspaceWords = [
    'npm --workspace="@sekiban/dcb-core" run build',
    "npm --workspace='@sekiban/dcb-core' run build",
    'npm -w "@sekiban/dcb-core" run build',
    'npm run build --workspace="@sekiban/dcb-core"',
    "npm run build --workspace='@sekiban/dcb-core'",
    'npm run build -w "@sekiban/dcb-core"',
  ];
  for (const fixture of quotedWorkspaceWords) {
    const quoted = cloneSnapshot(baseSnapshot);
    command(lane(quoted, "cheap"), "g40-coverage").command = fixture;
    const quotedResult = evaluateCoverage(buildCurrentGraph(quoted));
    if (quotedResult.failures.length > 0) {
      fail(`quoted workspace fixture was not accepted (${fixture}): ${quotedResult.reasonCodes.join(",")}`);
    }
  }
}

function runProof(root = process.cwd()) {
  const baseSnapshot = loadSnapshot(root);
  const baseResult = evaluateCoverage(buildCurrentGraph(baseSnapshot));
  if (baseResult.failures.length > 0) fail(`unmutated graph is not green: ${baseResult.reasonCodes.join(",")}`);
  const npmWrappedWorkflowDispatch = proveNpmWrappedWorkflowDispatch(baseSnapshot);
  proveFocusedShellAndNpmFixtures(baseSnapshot);
  const results = [];
  for (const entry of MUTATIONS) {
    const snapshot = cloneSnapshot(baseSnapshot);
    const before = semanticSnapshot(snapshot);
    entry.apply(snapshot);
    const after = semanticSnapshot(snapshot);
    if (before === after) fail(`${entry.id} did not change the graph`);
    const result = evaluateCoverage(buildCurrentGraph(snapshot));
    if (result.failures.length === 0) fail(`${entry.id} unexpectedly passed`);
    if (!result.reasonCodes.includes(entry.expected)) fail(`${entry.id} did not report ${entry.expected}; got ${result.reasonCodes.join(",")}`);
    results.push({ id: entry.id, expectedReasonCode: entry.expected, reportedReasonCodes: result.reasonCodes });
  }
  return { schema: SCHEMA, unmutated: { result: "passed", reasonCodes: [] }, npmWrappedWorkflowDispatch, mutations: results };
}

function main() {
  const result = runProof(process.cwd());
  process.stdout.write(`${JSON.stringify({ ...result, selfTest: process.argv.includes("--self-test") }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
