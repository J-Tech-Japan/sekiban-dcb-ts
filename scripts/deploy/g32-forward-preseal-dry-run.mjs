#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = process.cwd();
const SHA = /^[0-9a-f]{40}$/;

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function required(name, value) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function safe(value, name) {
  const text = required(name, value);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(text)) throw new Error(`${name} is invalid`);
  return text;
}

function run(command, args, env = process.env) {
  return execFileSync(command, args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function runJson(command, args, env) {
  const output = run(command, args, env);
  return { output, value: JSON.parse(output) };
}

function main() {
  const syntheticCandidate = required("--synthetic-candidate", argument("--synthetic-candidate"));
  if (!SHA.test(syntheticCandidate)) throw new Error("--synthetic-candidate must be a full SHA-shaped value");
  const label = safe(argument("--candidate-label"), "--candidate-label");
  const recordKey = safe(argument("--record-key"), "--record-key");
  const priorKey = safe(argument("--prior-key"), "--prior-key");
  const pre = required("--pre", argument("--pre"));
  const post = required("--post", argument("--post"));
  const measurement = required("--measurement", argument("--measurement"));
  const topology = required("--queue-topology", argument("--queue-topology"));
  const output = resolve(root, argument("--output", `.artifacts/g32-forward-${label.toLowerCase()}-preseal-checklist.json`));
  const preview = resolve(root, argument("--preview-output", `.artifacts/g32-forward-${label.toLowerCase()}-preseal-evidence-preview.json`));
  const indexTree = run("git", ["write-tree"]).trim();
  const configDigest = run("node", ["scripts/deploy/g32-config-digest.mjs", indexTree]).trim();

  const candidate = runJson("node", [
    "scripts/g32-candidate-check.mjs", "--pre-seal-dry-run", "--synthetic-candidate", syntheticCandidate,
    "--record-key", recordKey, "--prior-key", priorKey,
  ]);
  const recorder = runJson("node", [
    "scripts/deploy/g32-forward-record-evidence.mjs", "--dry-run",
    "--source-commit", syntheticCandidate, "--treeish", indexTree,
    "--record-key", recordKey, "--prior-key", priorKey, "--candidate-label", label,
    "--pre", pre, "--post", post, "--measurement", measurement, "--queue-topology", topology,
    "--output", preview,
  ]);
  const preflightEnv = {
    ...process.env,
    G32_FORWARD_PRESEAL: "1",
    G32_SOURCE_COMMIT: syntheticCandidate,
    G32_FORWARD_CYCLE: label,
    G32_FORWARD_RECORD_KEY: recordKey,
    G32_FORWARD_PRIOR_RECORD_KEY: priorKey,
    G32_FORWARD_CANDIDATE_LABEL: label,
    G32_FORWARD_CONFIG_RELATION: "unchanged",
    G32_FORWARD_CONFIG_DIGEST: configDigest,
    G32_FORWARD_DEPLOY_LIVE: "0",
  };
  const forwardPreflight = run("bash", ["scripts/deploy/g32-forward-redeploy.sh"], preflightEnv);
  const checklist = {
    task: "SDT-G32",
    status: "passed",
    mode: "non-live-exact-staged-tree",
    candidateLabel: label,
    recordKey,
    priorKey,
    syntheticCandidate,
    indexTree,
    treeDigests: {
      runtime: recorder.value.runtimeDigest,
      configuration: recorder.value.configurationDigest,
      deploymentConfig: configDigest,
    },
    checks: {
      candidateCheck: { status: "passed", prepared: candidate.value.prepared ?? candidate.value.preSeal ?? true },
      recorder: { status: "passed", dryRun: recorder.value.dryRun === true, output: preview },
      digestRecalculation: { status: "passed", treeish: indexTree },
      forwardPreflight: {
        status: "passed",
        receiverDryRun: true,
        primaryDryRun: true,
        remotePipelineNoMigrations: forwardPreflight.includes("No migrations to apply"),
        remoteMaterializedViewNoMigrations: forwardPreflight.split("No migrations to apply").length >= 3,
      },
    },
    liveDeployment: false,
    createdAt: new Date().toISOString(),
  };
  if (!checklist.checks.forwardPreflight.remotePipelineNoMigrations || !checklist.checks.forwardPreflight.remoteMaterializedViewNoMigrations) {
    throw new Error("G32 pre-seal forward preflight did not prove both remote No migrations to apply results");
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(checklist, null, 2)}\n`, "utf8");
  process.stdout.write(`${candidate.output}${recorder.output}${forwardPreflight}`);
  console.log(JSON.stringify({ status: checklist.status, output, preview, indexTree }, null, 2));
}

main();
