#!/usr/bin/env node
import { readFileSync } from "node:fs";

const PRIMARY_OFF = "samples/meeting-room/wrangler.g30-primary-off.jsonc";
const PRIMARY_ON = "samples/meeting-room/wrangler.g30-primary-on.jsonc";
const RECEIVER_OFF = "samples/meeting-room/wrangler.g30-receiver-off.jsonc";
const WITNESS_ENTRYPOINT = "samples/meeting-room/src/worker.cloudflare-only.ts";
const RUNBOOK = "scripts/deploy/g30-b0-deploy.sh";
const WORKER_RUNTIME_MARKERS = Object.freeze([
  "G30_SOURCE_COMMIT",
  "G30_CONFIG_DIGEST",
  "G30_TRACE_PHASE",
  "G30_TRACE_SAMPLE_RATE",
  "/conformance/v1/g30-config",
]);

function readConfig(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function comparable(config) {
  const copy = structuredClone(config);
  delete copy.observability?.traces?.head_sampling_rate;
  return copy;
}

export function assertG30Config(primaryOff, primaryOn, receiverOff) {
  for (const [name, config, sample] of [["primary-off", primaryOff, 0], ["primary-on", primaryOn, 1], ["receiver-off", receiverOff, 0]]) {
    if (
      config?.observability?.enabled !== true ||
      config?.observability?.traces?.enabled !== true ||
      config?.observability?.traces?.persist !== true ||
      config?.observability?.traces?.head_sampling_rate !== sample ||
      config?.observability?.logs?.enabled !== true ||
      config?.observability?.logs?.persist !== true ||
      config?.observability?.logs?.invocation_logs !== true ||
      config?.observability?.logs?.head_sampling_rate !== 1 ||
      config?.version_metadata?.binding !== "WORKER_VERSION"
    ) {
      throw new Error(`G30 ${name} must persist sdt.observe logs, bind WORKER_VERSION, and enable trace sampling ${sample}`);
    }
    if (Object.hasOwn(config, "placement") || JSON.stringify(config).includes("locationHint")) throw new Error(`G30 ${name} must not enable placement or locationHint`);
  }
  if (!same(comparable(primaryOff), comparable(primaryOn))) throw new Error("G30 primary A/B config differs outside trace sampling");
  if (receiverOff?.queues?.consumers !== undefined) throw new Error("G30 receiver must remain service-binding-only without a Queue consumer");
  const receiverPublicSurface = assertReceiverPublicSurface(receiverOff);
  return { primarySampling: [primaryOff.observability.traces.head_sampling_rate, primaryOn.observability.traces.head_sampling_rate], receiverSampling: receiverOff.observability.traces.head_sampling_rate, placement: "off", receiverPublicSurface };
}

/**
 * G30 retains and redeploys the existing receiver, so it must carry forward
 * the G38 Phase M public-surface mitigation rather than relying on Wrangler's
 * defaults.  An omitted setting defaults to enabled during a fresh deploy.
 */
export function assertReceiverPublicSurface(receiverOff) {
  if (receiverOff?.workers_dev !== false || receiverOff?.preview_urls !== false) {
    throw new Error("G30 receiver must explicitly preserve G38 Phase M workers_dev=false and preview_urls=false");
  }
  return { workersDev: false, previewUrls: false };
}

/**
 * Phase belongs to the external A/B/A-prime evidence ledger.  Passing a
 * phase label or a duplicate sample label through the deployed Worker would
 * make an otherwise sampling-only experiment mutate runtime configuration.
 */
export function assertPhaseRuntimeIsolation(workerSource, runbookSource) {
  if (typeof workerSource !== "string" || typeof runbookSource !== "string") {
    throw new Error("G30 worker entrypoint or B0 runbook source is unavailable for protocol-isolation verification");
  }
  const marker = WORKER_RUNTIME_MARKERS.find((candidate) => workerSource.includes(candidate));
  if (marker !== undefined) {
    throw new Error(`G30 Worker must not add a runtime diagnostic protocol surface (${marker})`);
  }
  if (/--var\s+"G30_[^"]+:/.test(runbookSource)) {
    throw new Error("G30 B0 runbook must not inject a G30 runtime variable into a deployed Worker");
  }
  return { phaseAuthority: "external-evidence-ledger", runtimePhaseConfig: false };
}

/**
 * The remote migration preflight must address D1 by durable database name.
 * Passing a Worker binding label happens to reach a different Wrangler API
 * path and cannot prove the production databases have no pending migration.
 */
export function assertRemoteMigrationPreflight(primaryOff, runbookSource) {
  if (!Array.isArray(primaryOff?.d1_databases)) throw new Error("G30 primary config must declare D1 databases");
  if (typeof runbookSource !== "string") throw new Error("G30 B0 runbook source is unavailable for migration-preflight verification");
  const databases = ["D1", "D1_MV"].map((binding) => {
    const entry = primaryOff.d1_databases.find((candidate) => candidate?.binding === binding);
    if (typeof entry?.database_name !== "string" || entry.database_name.length === 0) throw new Error(`G30 primary config lacks durable database name for ${binding}`);
    return entry.database_name;
  });
  if (!/d1 migrations list "\$\{database\}"/.test(runbookSource)) {
    throw new Error("G30 remote migration preflight must pass the durable database name to Wrangler");
  }
  if (/d1 migrations list "\$\{binding\}"/.test(runbookSource)) {
    throw new Error("G30 remote migration preflight must not pass a Worker binding label to Wrangler");
  }
  for (const database of databases) {
    if (!runbookSource.includes(`"${database}"`)) throw new Error(`G30 remote migration preflight omits configured database ${database}`);
  }
  return { migrationDatabases: databases };
}

/**
 * With `set -u`, Bash does not make a value assigned in the same `local`
 * declaration visible to a later assignment in that declaration.  Keep the
 * witness output path scoped in ordered declarations so B0 cannot stop after
 * deploying A but before producing its deployment witness.
 */
export function assertWitnessCaptureShellSafety(runbookSource) {
  if (typeof runbookSource !== "string") throw new Error("G30 B0 runbook source is unavailable for witness-capture verification");
  const functionBody = /capture_primary_witness\(\) \{([\s\S]*?)\n\}/.exec(runbookSource)?.[1] ?? "";
  if (!/^\s*local phase="\$1"\n\s*local output="\$2"\n\s*local prior="\$\{output\}\.prior\.versions\.json"\n\s*local versions="\$\{output\}\.versions\.json"/m.test(functionBody)) {
    throw new Error("G30 witness capture must declare phase, output, and derived prior/current versions in separate ordered locals");
  }
  if (/local phase="\$1"\s+output="\$2"\s+versions=/m.test(functionBody)) {
    throw new Error("G30 witness capture must not derive versions from an unbound same-declaration local");
  }
  return { witnessCaptureLocals: "ordered" };
}

/** A rerun must bind its witness to the one version created after its snapshot. */
export function assertWitnessReplaySnapshotSafety(runbookSource) {
  if (typeof runbookSource !== "string") throw new Error("G30 B0 runbook source is unavailable for replay-safe witness verification");
  const capture = /capture_primary_witness\(\) \{([\s\S]*?)\n\}/.exec(runbookSource)?.[1] ?? "";
  const snapshot = /capture_primary_predeploy_versions\(\) \{([\s\S]*?)\n\}/.exec(runbookSource)?.[1] ?? "";
  if (!/^\s*local output="\$1"\n\s*local prior="\$\{output\}\.prior\.versions\.json"/m.test(snapshot) || !snapshot.includes('versions list --name "${PRIMARY_WORKER_NAME}" --json > "${prior}"')) {
    throw new Error("G30 witness replay must capture a pre-deploy primary version snapshot");
  }
  if (!capture.includes('--prior-versions "${prior}"')) {
    throw new Error("G30 witness replay must pass its pre-deploy snapshot to the version selector");
  }
  for (const [phase, config, output] of [
    ["A", "${PRIMARY_OFF_CONFIG}", "${A_WITNESS_FILE}"],
    ["B", "${PRIMARY_ON_CONFIG}", "${B_WITNESS_FILE}"],
    ["A-prime", "${PRIMARY_OFF_CONFIG}", "${APRIME_WITNESS_FILE}"],
  ]) {
    const required = `capture_primary_predeploy_versions "${output}"\ndeploy_phase ${phase} "${config}"\ncapture_primary_witness ${phase} "${output}"`;
    if (!runbookSource.includes(required)) throw new Error(`G30 witness replay must snapshot immediately before ${phase} primary deployment`);
  }
  return { witnessReplaySnapshot: "pre-deploy" };
}

export function selfTest() {
  const off = readConfig(PRIMARY_OFF); const on = readConfig(PRIMARY_ON); const receiver = readConfig(RECEIVER_OFF);
  const result = assertG30Config(off, on, receiver);
  const runbook = readFileSync(RUNBOOK, "utf8");
  const isolation = assertPhaseRuntimeIsolation(readFileSync(WITNESS_ENTRYPOINT, "utf8"), runbook);
  const migration = assertRemoteMigrationPreflight(off, runbook);
  const witnessCapture = assertWitnessCaptureShellSafety(runbook);
  const witnessReplay = assertWitnessReplaySnapshotSafety(runbook);
  let samplingRed = false;
  try { const altered = structuredClone(on); altered.observability.traces.head_sampling_rate = 0; assertG30Config(off, altered, receiver); } catch (error) { samplingRed = String(error).includes("sampling 1"); }
  if (!samplingRed) throw new Error("G30 sampling mutation unexpectedly passed");
  let placementRed = false;
  try { const altered = structuredClone(off); altered.placement = { mode: "smart" }; assertG30Config(altered, on, receiver); } catch (error) { placementRed = String(error).includes("placement"); }
  if (!placementRed) throw new Error("G30 placement mutation unexpectedly passed");
  let extraDeltaRed = false;
  try { const altered = structuredClone(on); altered.vars.AUTO_DRAIN_OUTBOX = "false"; assertG30Config(off, altered, receiver); } catch (error) { extraDeltaRed = String(error).includes("outside trace sampling"); }
  if (!extraDeltaRed) throw new Error("G30 configuration delta mutation unexpectedly passed");
  let logsRed = false;
  try { const altered = structuredClone(on); altered.observability.logs.persist = false; assertG30Config(off, altered, receiver); } catch (error) { logsRed = String(error).includes("persist sdt.observe logs"); }
  if (!logsRed) throw new Error("G30 observation-log persistence mutation unexpectedly passed");
  let versionBindingRed = false;
  try { const altered = structuredClone(on); altered.version_metadata.binding = "WRONG_VERSION"; assertG30Config(off, altered, receiver); } catch (error) { versionBindingRed = String(error).includes("WORKER_VERSION"); }
  if (!versionBindingRed) throw new Error("G30 version metadata binding mutation unexpectedly passed");
  let phaseRuntimeRed = false;
  try { assertPhaseRuntimeIsolation("const phase = G30_TRACE_PHASE;", "clean runbook"); } catch (error) { phaseRuntimeRed = String(error).includes("runtime diagnostic protocol surface"); }
  if (!phaseRuntimeRed) throw new Error("G30 phase runtime mutation unexpectedly passed");
  let bindingRed = false;
  try { assertRemoteMigrationPreflight(off, runbook.replace('migrations list "${database}"', 'migrations list "${binding}"')); } catch { bindingRed = true; }
  if (!bindingRed) throw new Error("G30 migration binding mutation unexpectedly passed");
  let receiverSurfaceRed = false;
  try { const altered = structuredClone(receiver); altered.workers_dev = true; assertG30Config(off, on, altered); } catch (error) { receiverSurfaceRed = String(error).includes("G38 Phase M"); }
  if (!receiverSurfaceRed) throw new Error("G30 receiver public-surface mutation unexpectedly passed");
  let witnessCaptureRed = false;
  try {
    assertWitnessCaptureShellSafety(runbook.replace(
      '  local phase="$1"\n  local output="$2"\n  local prior="${output}.prior.versions.json"\n  local versions="${output}.versions.json"',
      '  local phase="$1" output="$2" prior="${output}.prior.versions.json" versions="${output}.versions.json"',
    ));
  } catch (error) { witnessCaptureRed = String(error).includes("separate ordered locals"); }
  if (!witnessCaptureRed) throw new Error("G30 witness-capture local-scope mutation unexpectedly passed");
  let witnessReplayRed = false;
  try { assertWitnessReplaySnapshotSafety(runbook.replace('--prior-versions "${prior}"', '--without-prior-versions "${prior}"')); } catch (error) { witnessReplayRed = String(error).includes("pre-deploy snapshot"); }
  if (!witnessReplayRed) throw new Error("G30 witness-replay snapshot mutation unexpectedly passed");
  return { ...result, ...isolation, ...migration, ...witnessCapture, ...witnessReplay, mutations: ["sampling", "placement", "extra-config-delta", "observation-log-persistence", "version-metadata-binding", "phase-runtime-config", "remote-migration-binding", "receiver-public-surface", "witness-capture-local-scope", "witness-replay-snapshot"] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.env.SDT_G30_CONFIG_FORCE_FAILURE === "1") throw new Error("SDT-G30 config forced failure");
  const config = assertG30Config(readConfig(PRIMARY_OFF), readConfig(PRIMARY_ON), readConfig(RECEIVER_OFF));
  const runbook = readFileSync(RUNBOOK, "utf8");
  const isolation = assertPhaseRuntimeIsolation(readFileSync(WITNESS_ENTRYPOINT, "utf8"), runbook);
  const migration = assertRemoteMigrationPreflight(readConfig(PRIMARY_OFF), runbook);
  const witnessCapture = assertWitnessCaptureShellSafety(runbook);
  const witnessReplay = assertWitnessReplaySnapshotSafety(runbook);
  console.log(JSON.stringify(process.argv.includes("--self-test") ? selfTest() : { ...config, ...isolation, ...migration, ...witnessCapture, ...witnessReplay }, null, 2));
}
