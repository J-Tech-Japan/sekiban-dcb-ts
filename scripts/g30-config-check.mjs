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
    if (config?.observability?.enabled !== true || config?.observability?.traces?.enabled !== true || config?.observability?.traces?.persist !== true || config?.observability?.traces?.head_sampling_rate !== sample) {
      throw new Error(`G30 ${name} observability must be enabled with sampling ${sample}`);
    }
    if (Object.hasOwn(config, "placement") || JSON.stringify(config).includes("locationHint")) throw new Error(`G30 ${name} must not enable placement or locationHint`);
  }
  if (!same(comparable(primaryOff), comparable(primaryOn))) throw new Error("G30 primary A/B config differs outside trace sampling");
  if (receiverOff?.queues?.consumers !== undefined) throw new Error("G30 receiver must remain service-binding-only without a Queue consumer");
  return { primarySampling: [primaryOff.observability.traces.head_sampling_rate, primaryOn.observability.traces.head_sampling_rate], receiverSampling: receiverOff.observability.traces.head_sampling_rate, placement: "off" };
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

export function selfTest() {
  const off = readConfig(PRIMARY_OFF); const on = readConfig(PRIMARY_ON); const receiver = readConfig(RECEIVER_OFF);
  const result = assertG30Config(off, on, receiver);
  const isolation = assertPhaseRuntimeIsolation(readFileSync(WITNESS_ENTRYPOINT, "utf8"), readFileSync(RUNBOOK, "utf8"));
  let samplingRed = false;
  try { const altered = structuredClone(on); altered.observability.traces.head_sampling_rate = 0; assertG30Config(off, altered, receiver); } catch (error) { samplingRed = String(error).includes("sampling 1"); }
  if (!samplingRed) throw new Error("G30 sampling mutation unexpectedly passed");
  let placementRed = false;
  try { const altered = structuredClone(off); altered.placement = { mode: "smart" }; assertG30Config(altered, on, receiver); } catch (error) { placementRed = String(error).includes("placement"); }
  if (!placementRed) throw new Error("G30 placement mutation unexpectedly passed");
  let extraDeltaRed = false;
  try { const altered = structuredClone(on); altered.vars.AUTO_DRAIN_OUTBOX = "false"; assertG30Config(off, altered, receiver); } catch (error) { extraDeltaRed = String(error).includes("outside trace sampling"); }
  if (!extraDeltaRed) throw new Error("G30 configuration delta mutation unexpectedly passed");
  let phaseRuntimeRed = false;
  try { assertPhaseRuntimeIsolation("const phase = G30_TRACE_PHASE;", "clean runbook"); } catch (error) { phaseRuntimeRed = String(error).includes("runtime diagnostic protocol surface"); }
  if (!phaseRuntimeRed) throw new Error("G30 phase runtime mutation unexpectedly passed");
  return { ...result, ...isolation, mutations: ["sampling", "placement", "extra-config-delta", "phase-runtime-config"] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.env.SDT_G30_CONFIG_FORCE_FAILURE === "1") throw new Error("SDT-G30 config forced failure");
  const config = assertG30Config(readConfig(PRIMARY_OFF), readConfig(PRIMARY_ON), readConfig(RECEIVER_OFF));
  const isolation = assertPhaseRuntimeIsolation(readFileSync(WITNESS_ENTRYPOINT, "utf8"), readFileSync(RUNBOOK, "utf8"));
  console.log(JSON.stringify(process.argv.includes("--self-test") ? selfTest() : { ...config, ...isolation }, null, 2));
}
