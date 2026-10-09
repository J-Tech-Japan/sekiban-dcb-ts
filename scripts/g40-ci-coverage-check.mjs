#!/usr/bin/env node
/**
 * Check coverage of the current workflow, lane and npm-script graph.
 *
 * The checker reports all findings in one pass. Each finding has a stable
 * reason code so mutation proofs and reviewers can distinguish independent
 * coverage failures.
 */
import { buildCurrentGraph, loadSnapshot, matchesCiGlob, normalizeCommand } from "./g40-ci-step-inventory.mjs";

const SCHEMA = "sdt-g40-ci-coverage-check/v3";
const CI_WORKFLOW = ".github/workflows/ci.yml";
const FULL_WORKFLOW = ".github/workflows/ci-full.yml";

function fail(message) {
  throw new Error(`g40-ci-coverage-check:${message}`);
}

function asObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function addWorkingDirectoryShapeCheck(issues, label, value) {
  if (value !== undefined && typeof value !== "string") {
    issues.add("workflow-shape", `${label} working-directory must be a string`);
  }
}

function triggerDocument(workflow) {
  return workflow?.document?.on ?? workflow?.document?.[true] ?? {};
}

function triggerNames(workflow) {
  const value = triggerDocument(workflow);
  if (Array.isArray(value)) return new Set(value);
  if (typeof value === "string") return new Set([value]);
  return new Set(Object.keys(asObject(value)));
}

function workflowByPath(graph, path) {
  return asArray(graph?.snapshot?.workflows).find((workflow) => workflow?.path === path);
}

function jobByName(workflow, name) {
  return asObject(workflow?.document?.jobs)?.[name];
}

function jobNeeds(job) {
  if (Array.isArray(job?.needs)) return job.needs.map(String);
  if (typeof job?.needs === "string") return [job.needs];
  return [];
}

function runForDispatch(graph, dispatch) {
  const workflow = workflowByPath(graph, dispatch.workflowPath);
  const jobs = asObject(workflow?.document?.jobs);
  const steps = asArray(asObject(jobs[dispatch.jobName]).steps);
  return steps[dispatch.stepIndex];
}

function workflowRunDispatches(graph, path) {
  return asArray(graph?.resolution?.dispatches).filter((dispatch) => dispatch?.origin === "workflow" && dispatch.workflowPath === path);
}

function commandRecords(manifest) {
  const records = [];
  for (const lane of asArray(manifest?.lanes)) {
    for (const command of asArray(lane?.commands)) {
      records.push({ lane, command, laneName: lane?.name, tier: lane?.tier, id: command?.id });
    }
  }
  return records;
}

function issueCollector() {
  const failures = [];
  const keys = new Set();
  return {
    add(code, message, details = undefined) {
      const key = `${code}:${message}`;
      if (keys.has(key)) return;
      keys.add(key);
      failures.push({ code, message, ...(details === undefined ? {} : { details }) });
    },
    get failures() {
      return failures;
    },
  };
}

function pathsForWorkflow(workflow, event) {
  const trigger = asObject(triggerDocument(workflow))[event];
  if (trigger === null || trigger === undefined) return [];
  if (typeof trigger === "string") return [];
  return Array.isArray(trigger?.["paths-ignore"]) ? trigger["paths-ignore"] : [];
}

function setEquals(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function addWorkflowCollectionShapeChecks(graph, issues) {
  const workflows = graph?.snapshot?.workflows;
  if (!Array.isArray(workflows)) {
    issues.add("workflow-shape", "tracked workflow collection must be an array");
    return;
  }
  for (const workflow of workflows) {
    if (!isObject(workflow)) {
      issues.add("workflow-shape", "workflow entry must be an object");
      continue;
    }
    const document = workflow.document;
    if (!isObject(document)) {
      issues.add("workflow-shape", `${workflow.path ?? "workflow"} document must be an object`);
      continue;
    }
    const trigger = document.on ?? document[true];
    if (trigger !== undefined && !Array.isArray(trigger) && typeof trigger !== "string" && !isObject(trigger)) {
      issues.add("workflow-shape", `${workflow.path ?? "workflow"} trigger must be a mapping, list or string`);
    }
    if (!isObject(document.jobs)) {
      issues.add("workflow-shape", `${workflow.path ?? "workflow"} jobs must be an object`);
      continue;
    }
    const workflowDefaultsRun = asObject(asObject(document.defaults).run);
    addWorkingDirectoryShapeCheck(issues, `${workflow.path ?? "workflow"} defaults`, workflowDefaultsRun["working-directory"]);
    for (const [jobName, job] of Object.entries(document.jobs)) {
      if (!isObject(job)) {
        issues.add("workflow-shape", `${workflow.path ?? "workflow"}/${jobName} job must be an object`);
        continue;
      }
      const jobDefaultsRun = asObject(asObject(job.defaults).run);
      addWorkingDirectoryShapeCheck(issues, `${workflow.path ?? "workflow"}/${jobName} defaults`, jobDefaultsRun["working-directory"]);
      if (job.steps !== undefined && !Array.isArray(job.steps)) {
        issues.add("workflow-shape", `${workflow.path ?? "workflow"}/${jobName} steps must be an array`);
        continue;
      }
      for (const [stepIndex, step] of asArray(job.steps).entries()) {
        if (!isObject(step)) issues.add("workflow-shape", `${workflow.path ?? "workflow"}/${jobName} step ${stepIndex + 1} must be an object`);
        else addWorkingDirectoryShapeCheck(issues, `${workflow.path ?? "workflow"}/${jobName} step ${stepIndex + 1}`, step["working-directory"]);
      }
    }
    for (const event of ["push", "pull_request"]) {
      const eventValue = asObject(trigger)[event];
      if (eventValue !== undefined && eventValue !== null && !isObject(eventValue) && typeof eventValue !== "string") {
        issues.add("workflow-shape", `${workflow.path ?? "workflow"} ${event} trigger must be an object or string`);
      }
      if (isObject(eventValue) && eventValue["paths-ignore"] !== undefined && !Array.isArray(eventValue["paths-ignore"])) {
        issues.add("workflow-shape", `${workflow.path ?? "workflow"} ${event} paths-ignore must be an array`);
      }
    }
  }
}

function addWorkflowShapeChecks(graph, issues) {
  const ci = workflowByPath(graph, CI_WORKFLOW);
  const full = workflowByPath(graph, FULL_WORKFLOW);
  if (ci === undefined) issues.add("workflow-shape", `${CI_WORKFLOW} is missing`);
  const ciDocument = asObject(ci?.document);
  const ciTriggers = triggerNames(ci);
  if (!ciTriggers.has("pull_request")) issues.add("workflow-shape", "ci.yml must retain a pull_request trigger");
  if (!ciTriggers.has("push")) issues.add("workflow-shape", "ci.yml must retain a push trigger");
  const push = asObject(asObject(triggerDocument(ci)).push);
  if (!Array.isArray(push.branches) || !push.branches.includes("main")) issues.add("workflow-shape", "ci.yml push trigger must target main");
  if (ciTriggers.has("schedule")) issues.add("workflow-shape", "ci.yml must not be scheduled");
  const concurrency = asObject(ciDocument.concurrency);
  if (typeof concurrency.group !== "string" || concurrency.group.length === 0) issues.add("workflow-shape", "ci.yml must define a concurrency group");
  if (concurrency["cancel-in-progress"] !== true) issues.add("workflow-shape", "ci.yml concurrency must cancel superseded runs");

  const jobs = asObject(ciDocument.jobs);
  const expectedPrJobs = ["ci-foundation", "ci-pr-cheap", "ci-cosmos-emulator"];
  const ciDispatches = workflowRunDispatches(graph, CI_WORKFLOW);
  const manifestLanes = Array.isArray(graph.snapshot.manifest?.lanes) ? graph.snapshot.manifest.lanes : [];
  const prLaneNames = new Set(manifestLanes.filter((lane) => lane?.tier === "pr").map((lane) => lane.name));
  for (const laneName of prLaneNames) {
    if (!ciDispatches.some((dispatch) => asArray(dispatch.selectedLanes).includes(laneName))) {
      issues.add("workflow-shape", `ci.yml does not dispatch PR lane ${laneName}`);
    }
  }
  if (ciDispatches.some((dispatch) => asArray(dispatch.selectedLanes).some((name) => manifestLanes.find((lane) => lane?.name === name)?.tier === "local"))) {
    issues.add("workflow-shape", "ci.yml must not dispatch local lanes");
  }
  for (const jobName of expectedPrJobs) {
    if (jobs[jobName] === undefined) issues.add("workflow-shape", `ci.yml is missing PR job ${jobName}`);
    const checkout = (Array.isArray(asObject(jobs[jobName]).steps) ? asObject(jobs[jobName]).steps : [])
      .find((step) => String(step?.uses ?? "").startsWith("actions/checkout@"));
    if (checkout?.with?.["fetch-depth"] !== 0) issues.add("workflow-shape", `${jobName} must keep fetch-depth 0`);
  }

  const verify = asObject(jobs.verify);
  if (jobs.verify === undefined) {
    issues.add("workflow-shape", "ci.yml aggregate job verify is missing");
  } else {
    if (String(verify.if ?? "").replaceAll(" ", "") !== "${{always()}}") issues.add("workflow-shape", "verify must use always()");
    const actualNeeds = new Set(jobNeeds(verify));
    if (!setEquals(actualNeeds, new Set(expectedPrJobs))) issues.add("workflow-shape", "verify needs must equal the PR jobs");
    const verifyRuns = (Array.isArray(verify.steps) ? verify.steps : [])
      .some((step) => typeof step?.run === "string" && step.run.includes("node scripts/g40-verify-needs.mjs"));
    if (!verifyRuns) issues.add("workflow-shape", "verify must run g40-verify-needs.mjs");
    const needsJson = String(verify.env?.G40_VERIFY_NEEDS_JSON ?? "").replace(/\s+/g, "");
    if (needsJson !== "${{toJson(needs)}}") issues.add("workflow-shape", "verify must pass G40_VERIFY_NEEDS_JSON as toJson(needs)");
  }

  if (full === undefined) {
    issues.add("workflow-shape", `${FULL_WORKFLOW} is missing`);
  } else {
    const fullTriggers = triggerNames(full);
    if (!fullTriggers.has("workflow_dispatch") || !fullTriggers.has("schedule")) issues.add("workflow-shape", "ci-full.yml must retain workflow_dispatch and schedule");
    const fullJobs = asObject(full.document?.jobs);
    if (fullJobs.full === undefined) issues.add("workflow-shape", "ci-full.yml full job is missing");
    const fullConcurrency = asObject(full.document.concurrency);
    if (fullConcurrency.group !== "ci-full-main" || fullConcurrency["cancel-in-progress"] !== false) issues.add("workflow-shape", "ci-full.yml concurrency shape changed");
    const fullDispatches = workflowRunDispatches(graph, FULL_WORKFLOW);
    if (fullDispatches.length === 0) issues.add("workflow-shape", "ci-full.yml must dispatch a manifest tier");
  }

  for (const dispatch of asArray(graph?.resolution?.dispatches).filter((entry) => entry?.origin === "workflow")) {
    const workflow = workflowByPath(graph, dispatch.workflowPath);
    const job = jobByName(workflow, dispatch.jobName);
    const step = runForDispatch(graph, dispatch);
    if (job?.if !== undefined || job?.["continue-on-error"] !== undefined || step?.if !== undefined || step?.["continue-on-error"] !== undefined) {
      issues.add("dispatch-conditional", `ci-local dispatch is conditional in ${dispatch.workflowPath}/${dispatch.jobName}`);
    }
  }
}

function addManifestShapeChecks(graph, issues) {
  const manifest = graph.snapshot.manifest;
  if (!isObject(manifest)) issues.add("manifest-shape", "lane manifest must be an object");
  if (manifest?.schema !== "sdt-ci-lanes/v1") issues.add("manifest-shape", "manifest schema must be sdt-ci-lanes/v1");
  const tiers = manifest?.tiers;
  if (!isObject(tiers)) issues.add("manifest-shape", "manifest tiers must be an object");
  for (const tier of ["pr", "local", "full"]) {
    if (tiers?.[tier] === undefined || tiers[tier] === null || typeof tiers[tier] !== "object" || Array.isArray(tiers[tier])) {
      issues.add("manifest-shape", `manifest tier ${tier} is missing`);
    }
  }
  if (!Array.isArray(tiers?.full?.includes) || !tiers.full.includes.includes("pr") || !tiers.full.includes.includes("local")) {
    issues.add("manifest-shape", "full tier must include pr and local");
  }
  if (!Array.isArray(manifest?.pathsIgnore)) issues.add("manifest-shape", "pathsIgnore must be an array");
  else if (manifest.pathsIgnore.some((path) => typeof path !== "string")) issues.add("manifest-shape", "pathsIgnore entries must be strings");
  if (!Array.isArray(manifest?.requiredLanes)) issues.add("manifest-shape", "requiredLanes must be an array");
  else if (manifest.requiredLanes.some((name) => typeof name !== "string")) issues.add("manifest-shape", "requiredLanes entries must be strings");
  const lanes = asArray(manifest?.lanes);
  if (!Array.isArray(manifest?.lanes)) issues.add("manifest-shape", "manifest lanes must be an array");
  if (lanes.length === 0) {
    issues.add("manifest-shape", "manifest lanes must be non-empty");
  }
  const laneNames = new Set();
  const commandTexts = new Map();
  for (const lane of lanes) {
    if (!isObject(lane)) {
      issues.add("manifest-shape", "every lane must be an object");
      continue;
    }
    if (typeof lane?.name !== "string" || lane.name.length === 0) issues.add("manifest-shape", "every lane needs a name");
    if (laneNames.has(lane?.name)) issues.add("manifest-shape", `duplicate lane ${lane?.name}`);
    laneNames.add(lane?.name);
    if (!Array.isArray(lane?.affectedPaths)) issues.add("manifest-shape", `lane ${lane?.name} affectedPaths must be an array`);
    else if (lane.affectedPaths.some((pattern) => typeof pattern !== "string")) issues.add("manifest-shape", `lane ${lane?.name} affectedPaths entries must be strings`);
    if (!Array.isArray(lane?.commands)) {
      issues.add("manifest-shape", `lane ${lane?.name} commands must be an array`);
      issues.add("empty-lane", `lane ${lane?.name} has no commands`);
      continue;
    }
    if (lane.commands.length === 0) issues.add("empty-lane", `lane ${lane?.name} has no commands`);
    if (!["pr", "local"].includes(lane?.tier)) issues.add("manifest-shape", `lane ${lane?.name} has an invalid tier`);
    for (const command of lane.commands) {
      if (!isObject(command)) {
        issues.add("manifest-shape", `lane ${lane?.name} command entry must be an object`);
        continue;
      }
      if (typeof command?.command !== "string" || command.command.trim().length === 0) issues.add("manifest-shape", `lane ${lane?.name} has an empty command`);
      const text = normalizeCommand(command?.command ?? "");
      if (text.length > 0) {
        const prior = commandTexts.get(text);
        if (prior !== undefined && prior !== lane?.tier) issues.add("manifest-shape", `command text is assigned to both ${prior} and ${lane?.tier}`);
        commandTexts.set(text, lane?.tier);
      }
    }
  }
  const required = Array.isArray(manifest?.requiredLanes) ? new Set(manifest.requiredLanes) : new Set();
  if (!setEquals(required, laneNames)) issues.add("required-lanes-mismatch", "requiredLanes must equal the lane names");
}

function addCommandShapeChecks(graph, issues) {
  const records = commandRecords(graph.snapshot.manifest);
  const commandIds = new Set();
  for (const record of records) {
    if (typeof record.id !== "string" || record.id.length === 0) issues.add("manifest-shape", `lane ${record.laneName} has a command without an id`);
    if (commandIds.has(record.id)) issues.add("duplicate-command-id", `command id ${record.id} occurs more than once`);
    commandIds.add(record.id);
    if (record.command?.expect !== undefined && record.command.expect !== "red") issues.add("invalid-expect", `${record.laneName}/${record.id} has invalid expect`);
  }
}

function addResolutionChecks(graph, issues) {
  for (const error of asArray(graph?.resolution?.errors)) {
    if (isObject(error)) issues.add(error.code, error.message, error.source);
  }
  for (const missing of asArray(graph?.resolution?.missingPaths)) {
    if (isObject(missing)) issues.add("missing-path", `resolved command names missing path ${missing.token}`, missing.source);
  }
}

function addWorkflowArgumentChecks(graph, issues) {
  for (const dispatch of asArray(graph?.resolution?.dispatches)) {
    if (!isObject(dispatch)) continue;
    if (dispatch.origin === "workflow" && dispatch.invalidArgument) {
      issues.add("ci-local-argument", `workflow ci-local invocation uses unsupported arguments: ${asArray(dispatch.args).join(" ")}`, dispatch.source);
    }
    for (const name of asArray(dispatch.unknownNames)) issues.add("unknown-lane-or-tier", `ci-local names unknown lane or tier ${name}`, dispatch.source);
  }
}

function addReachabilityChecks(graph, issues) {
  const manifest = graph.snapshot.manifest;
  const records = commandRecords(manifest);
  const reachedIds = new Set();
  for (const dispatch of asArray(graph?.resolution?.dispatches)) {
    if (!isObject(dispatch)) continue;
    if (dispatch.origin !== "workflow") continue;
    for (const record of records) if (asArray(dispatch.selectedLanes).includes(record.laneName)) reachedIds.add(record.id);
  }
  for (const record of records) {
    if (!reachedIds.has(record.id)) issues.add("command-unreached", `manifest command ${record.laneName}/${record.id} is not reached by a workflow dispatch`);
  }

  const fullDispatches = workflowRunDispatches(graph, FULL_WORKFLOW);
  const fullLanes = new Set(fullDispatches.flatMap((dispatch) => asArray(dispatch.selectedLanes)));
  for (const lane of asArray(manifest?.lanes)) {
    if (!fullLanes.has(lane?.name)) issues.add("lane-not-in-full", `lane ${lane?.name} is not reached by ci-full.yml`);
  }

  const ci = workflowByPath(graph, CI_WORKFLOW);
  const verify = jobByName(ci, "verify");
  const verifyNeeds = new Set(jobNeeds(verify));
  const prDispatches = workflowRunDispatches(graph, CI_WORKFLOW).filter((dispatch) => dispatch.source?.triggers?.includes("pull_request") && verifyNeeds.has(dispatch.jobName));
  for (const record of records.filter((entry) => entry.tier === "pr")) {
    if (!prDispatches.some((dispatch) => asArray(dispatch.selectedLanes).includes(record.laneName))) {
      issues.add("pr-command-unverified", `PR command ${record.laneName}/${record.id} is not reached from a verify dependency`);
    }
  }
}

function addAffectedPathChecks(graph, issues) {
  const manifest = graph.snapshot.manifest;
  const files = asArray(graph?.snapshot?.files);
  const lanes = asArray(manifest?.lanes);
  for (const lane of lanes) {
    for (const pattern of Array.isArray(lane?.affectedPaths) ? lane.affectedPaths : []) {
      if (typeof pattern !== "string" || !files.some((file) => matchesCiGlob(file, pattern))) {
        issues.add("affected-path-unmatched", `lane ${lane?.name} affectedPaths pattern matches no tracked file: ${pattern}`);
      }
    }
  }
  for (const lane of lanes.filter((entry) => entry?.tier === "local")) {
    const closure = graph?.resolution?.closureByLane instanceof Map ? graph.resolution.closureByLane.get(lane.name) : undefined;
    const patterns = asArray(lane.affectedPaths).filter((pattern) => typeof pattern === "string");
    for (const file of [...(closure?.files ?? [])].filter((entry) => /^(?:scripts|test)\//.test(entry) && files.includes(entry)).sort()) {
      if (!patterns.some((pattern) => matchesCiGlob(file, pattern))) {
        issues.add("local-path-uncovered", `local lane ${lane.name} does not select ${file}`, { lane: lane.name, path: file });
      }
    }
  }
}

function addSealRootChecks(graph, issues) {
  const manifest = graph.snapshot.manifest;
  const bundle = graph.snapshot.commitTraceBundle;
  const authorityFiles = Array.isArray(bundle?.authorityFiles) ? bundle.authorityFiles : [];
  const roots = ["contracts/commit-trace-bundle.json", "contracts/commit-trace-pin.json", ...authorityFiles.map((entry) => entry?.path)]
    .filter((path) => typeof path === "string" && path.length > 0);
  const lanes = asArray(manifest?.lanes);
  const g30 = lanes.find((lane) => lane?.name === "commit-tracing");
  const local = lanes.filter((lane) => lane?.tier === "local" && lane?.name !== "commit-tracing");
  for (const path of roots) {
    const g30Matches = asArray(g30?.affectedPaths).some((pattern) => typeof pattern === "string" && matchesCiGlob(path, pattern));
    const otherMatches = local.some((lane) => asArray(lane?.affectedPaths).some((pattern) => typeof pattern === "string" && matchesCiGlob(path, pattern)));
    if (!g30Matches && otherMatches) issues.add("seal-roots-uncovered", `commit-trace seal root ${path} selects another local lane but not g30`, { path });
  }
}

function addPathsIgnoreChecks(graph, issues) {
  const manifest = graph.snapshot.manifest;
  const expected = new Set(Array.isArray(manifest?.pathsIgnore) ? manifest.pathsIgnore : []);
  const ci = workflowByPath(graph, CI_WORKFLOW);
  for (const event of ["push", "pull_request"]) {
    const actual = new Set(pathsForWorkflow(ci, event));
    if (!setEquals(actual, expected)) issues.add("paths-ignore-mismatch", `ci.yml ${event} paths-ignore differs from manifest.pathsIgnore`);
  }
}

function addSealCommandCheck(graph, issues) {
  const cheap = asArray(graph.snapshot.manifest?.lanes)
    .find((lane) => lane?.name === "cheap");
  const first = asArray(cheap?.commands)[0];
  if (cheap?.tier !== "pr" || first?.id !== "commit-trace-seal" || first?.command !== "node scripts/commit-trace-contract.mjs --check" || first?.expect !== undefined) {
    issues.add("seal-command", "cheap lane must start with the exact commit-trace-seal command without expect");
  }
}

export function evaluateCoverage(graph) {
  const issues = issueCollector();
  addWorkflowCollectionShapeChecks(graph, issues);
  addWorkflowShapeChecks(graph, issues);
  addManifestShapeChecks(graph, issues);
  addCommandShapeChecks(graph, issues);
  addResolutionChecks(graph, issues);
  addWorkflowArgumentChecks(graph, issues);
  addReachabilityChecks(graph, issues);
  addAffectedPathChecks(graph, issues);
  addSealRootChecks(graph, issues);
  addPathsIgnoreChecks(graph, issues);
  addSealCommandCheck(graph, issues);
  const failures = issues.failures;
  return {
    schema: SCHEMA,
    result: failures.length === 0 ? "passed" : "failed",
    reasonCodes: [...new Set(failures.map((failure) => failure.code))],
    failures,
    summary: {
      workflowCount: asArray(graph?.workflows).length,
      workflowRunCount: asArray(graph?.workflowRuns).length,
      packageCount: asArray(graph?.packages).length,
      scriptCount: asArray(graph?.resolution?.scripts).length,
      manifestLaneCount: asArray(graph?.snapshot?.manifest?.lanes).length,
      manifestCommandCount: commandRecords(graph.snapshot.manifest).length,
      terminalCommandCount: asArray(graph?.terminalCommands).length,
    },
  };
}

export function checkCurrentTree({ root = process.cwd() } = {}) {
  const snapshot = loadSnapshot(root);
  const graph = buildCurrentGraph(snapshot);
  return { graph, result: evaluateCoverage(graph) };
}

function coverageSelfTestFixture() {
  const manifest = {
    schema: "sdt-ci-lanes/v1",
    tiers: { pr: {}, local: {}, full: { includes: ["pr", "local"] } },
    pathsIgnore: [],
    requiredLanes: ["foundation", "cheap", "cosmos"],
    lanes: [
      { name: "foundation", tier: "pr", affectedPaths: ["package.json"], commands: [{ id: "foundation-check", command: "node scripts/foundation-check.mjs" }] },
      { name: "cheap", tier: "pr", affectedPaths: ["package.json"], commands: [{ id: "commit-trace-seal", command: "node scripts/commit-trace-contract.mjs --check" }] },
      { name: "cosmos", tier: "pr", affectedPaths: ["scripts/ci-local.mjs"], commands: [{ id: "cosmos-contract", command: "node scripts/ci-local.mjs --self-test" }] },
    ],
  };
  const ciPath = CI_WORKFLOW;
  const fullPath = FULL_WORKFLOW;
  const ci = {
    path: ciPath,
    document: {
      on: { push: { branches: ["main"] }, pull_request: {} },
      concurrency: { group: "ci-${{ github.ref }}", "cancel-in-progress": true },
      jobs: {
        "ci-foundation": {
          steps: [{ uses: "actions/checkout@v5", with: { "fetch-depth": 0 } }, { run: "node scripts/ci-local.mjs --lane foundation --ci" }],
        },
        "ci-pr-cheap": {
          steps: [{ uses: "actions/checkout@v5", with: { "fetch-depth": 0 } }, { run: "node scripts/ci-local.mjs --lane cheap --ci" }],
        },
        "ci-cosmos-emulator": {
          steps: [{ uses: "actions/checkout@v5", with: { "fetch-depth": 0 } }, { run: "node scripts/ci-local.mjs --lane cosmos" }],
        },
        verify: {
          if: "${{ always() }}",
          needs: ["ci-foundation", "ci-pr-cheap", "ci-cosmos-emulator"],
          env: { G40_VERIFY_NEEDS_JSON: "${{ toJson(needs) }}" },
          steps: [{ run: "node scripts/g40-verify-needs.mjs" }],
        },
      },
    },
    text: "",
  };
  const full = {
    path: fullPath,
    document: {
      on: { schedule: [], workflow_dispatch: {} },
      concurrency: { group: "ci-full-main", "cancel-in-progress": false },
      jobs: { full: { steps: [{ run: "node scripts/ci-local.mjs --full" }] } },
    },
    text: "",
  };
  const workflows = [ci, full];
  const dispatches = [
    { origin: "workflow", workflowPath: ciPath, jobName: "ci-foundation", stepIndex: 1, selectedLanes: ["foundation"], unknownNames: [], invalidArgument: false, source: { triggers: ["pull_request", "push"] } },
    { origin: "workflow", workflowPath: ciPath, jobName: "ci-pr-cheap", stepIndex: 1, selectedLanes: ["cheap"], unknownNames: [], invalidArgument: false, source: { triggers: ["pull_request", "push"] } },
    { origin: "workflow", workflowPath: ciPath, jobName: "ci-cosmos-emulator", stepIndex: 1, selectedLanes: ["cosmos"], unknownNames: [], invalidArgument: false, source: { triggers: ["pull_request", "push"] } },
    { origin: "workflow", workflowPath: fullPath, jobName: "full", stepIndex: 0, selectedLanes: ["foundation", "cheap", "cosmos"], unknownNames: [], invalidArgument: false, source: { triggers: ["schedule", "workflow_dispatch"] } },
  ];
  const snapshot = {
    root: process.cwd(),
    files: ["package.json", "ci/lanes.json", "scripts/ci-local.mjs"],
    loadErrors: [],
    rootPackage: { relativePath: "package.json", directory: "", name: "fixture", document: {}, scripts: {} },
    packages: [{ relativePath: "package.json", directory: "", name: "fixture", document: {}, scripts: {} }],
    packageByPath: new Map(),
    configuredWorkspaces: [],
    manifest,
    commitTraceBundle: null,
    workflows,
  };
  return {
    schema: "fixture",
    snapshot,
    workflows: workflows.map((workflow) => ({ path: workflow.path, triggers: [...triggerNames(workflow)].sort(), jobs: Object.keys(workflow.document.jobs) })),
    workflowRuns: [],
    packages: [{ path: "package.json", name: "fixture", scripts: [] }],
    manifest: { schema: manifest.schema, tiers: manifest.tiers, lanes: manifest.lanes.map((lane) => ({ name: lane.name, tier: lane.tier, commandCount: lane.commands.length, affectedPaths: lane.affectedPaths })) },
    resolution: {
      errors: [],
      scripts: [],
      terminals: [],
      dispatches,
      missingPaths: [],
      closureByLane: new Map([["foundation", { files: new Set() }], ["cheap", { files: new Set() }], ["cosmos", { files: new Set() }]]),
    },
    terminalCommands: [],
    dispatches,
  };
}

function selfTestFailure(graph, label, expectedCode) {
  const result = evaluateCoverage(graph);
  if (result.result !== "failed" || !result.reasonCodes.includes(expectedCode)) {
    fail(`self-test ${label} expected ${expectedCode}, got ${result.reasonCodes.join(",")}`);
  }
  return { label, reportedReasonCodes: result.reasonCodes };
}

export function runSelfTest() {
  const passing = coverageSelfTestFixture();
  const passResult = evaluateCoverage(passing);
  if (passResult.result !== "passed") fail(`self-test pass fixture failed: ${passResult.reasonCodes.join(",")}`);

  const missingVerifyEnv = structuredClone(passing);
  delete missingVerifyEnv.snapshot.workflows[0].document.jobs.verify.env;
  const missingCosmosHostedJob = structuredClone(passing);
  delete missingCosmosHostedJob.snapshot.workflows[0].document.jobs["ci-cosmos-emulator"];
  missingCosmosHostedJob.snapshot.workflows[0].document.jobs.verify.needs = ["ci-foundation", "ci-pr-cheap"];
  const duplicateLane = structuredClone(passing);
  const duplicate = structuredClone(duplicateLane.snapshot.manifest.lanes[0]);
  duplicate.commands = duplicate.commands.map((command) => ({ ...command, id: `${command.id}-duplicate` }));
  duplicateLane.snapshot.manifest.lanes.push(duplicate);
  const missingFull = structuredClone(passing);
  missingFull.snapshot.workflows = missingFull.snapshot.workflows.filter((entry) => entry.path !== FULL_WORKFLOW);
  const malformedCollectionsSnapshot = structuredClone(passing.snapshot);
  malformedCollectionsSnapshot.manifest.lanes.find((lane) => lane.name === "cheap").commands = {};
  malformedCollectionsSnapshot.workflows = malformedCollectionsSnapshot.workflows.filter((entry) => entry.path !== FULL_WORKFLOW);
  const malformedCollections = buildCurrentGraph(malformedCollectionsSnapshot);
  const numericWorkingDirectorySnapshot = structuredClone(passing.snapshot);
  numericWorkingDirectorySnapshot.workflows[0].document.jobs["ci-pr-cheap"].steps[1]["working-directory"] = 5;
  const numericWorkingDirectory = buildCurrentGraph(numericWorkingDirectorySnapshot);
  const numericWorkingDirectoryResult = evaluateCoverage(numericWorkingDirectory);
  if (numericWorkingDirectoryResult.result !== "failed" || !numericWorkingDirectoryResult.reasonCodes.includes("workflow-shape")) {
    fail(`self-test numeric working-directory expected workflow-shape, got ${numericWorkingDirectoryResult.reasonCodes.join(",")}`);
  }
  const oneTokenNodeSnapshot = structuredClone(passing.snapshot);
  oneTokenNodeSnapshot.files.push("scripts/ci-local.mjs", "scripts/foundation-check.mjs", "scripts/g40-verify-needs.mjs");
  oneTokenNodeSnapshot.manifest.lanes.find((lane) => lane.name === "cheap").commands[0].command = "node";
  oneTokenNodeSnapshot.workflows = oneTokenNodeSnapshot.workflows.filter((entry) => entry.path !== FULL_WORKFLOW);
  const oneTokenNodeGraph = buildCurrentGraph(oneTokenNodeSnapshot);
  const oneTokenNodeResult = evaluateCoverage(oneTokenNodeGraph);
  if (!oneTokenNodeGraph.terminalCommands.some((entry) => entry.command === "node")
    || oneTokenNodeResult.result !== "failed"
    || !oneTokenNodeResult.reasonCodes.includes("workflow-shape")
    || !oneTokenNodeResult.reasonCodes.includes("lane-not-in-full")
    || !oneTokenNodeResult.reasonCodes.includes("seal-command")) {
    fail(`self-test one-token node terminal expected terminal retention and continued rules, got ${oneTokenNodeResult.reasonCodes.join(",")}`);
  }
  const undefinedScript = structuredClone(passing);
  undefinedScript.resolution.errors.push({ code: "undefined-npm-script", message: "fixture undefined script" });
  const combinedResult = evaluateCoverage(malformedCollections);
  if (combinedResult.result !== "failed" || !combinedResult.reasonCodes.includes("manifest-shape") || !combinedResult.reasonCodes.includes("workflow-shape")) {
    fail(`self-test malformed collections expected manifest-shape and workflow-shape, got ${combinedResult.reasonCodes.join(",")}`);
  }

  return {
    schema: "sdt-g40-ci-coverage-self-test/v1",
    pass: { result: "passed", reasonCodes: passResult.reasonCodes },
    failures: [
      selfTestFailure(missingVerifyEnv, "verify-needs-env", "workflow-shape"),
      selfTestFailure(missingCosmosHostedJob, "missing-cosmos-hosted-job", "workflow-shape"),
      selfTestFailure(duplicateLane, "duplicate-lane", "manifest-shape"),
      selfTestFailure(missingFull, "missing-full-workflow", "workflow-shape"),
      { label: "malformed-collections", reportedReasonCodes: combinedResult.reasonCodes },
      { label: "one-token-node-terminal", reportedReasonCodes: oneTokenNodeResult.reasonCodes },
      selfTestFailure(undefinedScript, "undefined-npm-script", "undefined-npm-script"),
    ],
  };
}

function parseArguments(argv) {
  const options = { root: process.cwd(), selfTest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") options.root = argv[++index];
    else if (argument === "--self-test") options.selfTest = true;
    else fail(`unknown argument ${argument}`);
  }
  if (options.root === "") fail("empty option value");
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.selfTest) {
    process.stdout.write(`${JSON.stringify(runSelfTest(), null, 2)}\n`);
    return;
  }
  const checked = checkCurrentTree(options);
  const output = {
    ...checked.result,
    selfTest: false,
    graph: {
      workflows: checked.graph.workflows,
      packages: checked.graph.packages,
      lanes: checked.graph.manifest.lanes,
    },
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (checked.result.failures.length > 0) process.exitCode = 1;
}

try {
  if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
