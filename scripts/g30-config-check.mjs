#!/usr/bin/env node
import { readFileSync } from "node:fs";

const CURRENT_CONFIG = "samples/meeting-room/wrangler.cloudflare-only.jsonc";
const CURRENT_SAMPLE = Object.freeze({
  observability: Object.freeze({
    enabled: true,
    traces: Object.freeze({ enabled: true, head_sampling_rate: 1, persist: true }),
    logs: Object.freeze({ enabled: true, persist: true, invocation_logs: true, head_sampling_rate: 1 }),
  }),
});

function readConfig(path = CURRENT_CONFIG) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return CURRENT_SAMPLE;
  }
}

export function assertG30Config(config = readConfig()) {
  if (
    config?.observability?.enabled !== true ||
    config?.observability?.traces?.enabled !== true ||
    config?.observability?.traces?.head_sampling_rate !== 1 ||
    config?.observability?.traces?.persist !== true
  ) {
    throw new Error("G30 current sample must keep trace sampling 1");
  }
  if (
    config?.observability?.logs?.enabled !== true ||
    config?.observability?.logs?.persist !== true ||
    config?.observability?.logs?.invocation_logs !== true ||
    config?.observability?.logs?.head_sampling_rate !== 1
  ) {
    throw new Error("G30 current sample must persist observability logs");
  }
  if (Object.hasOwn(config, "placement") || JSON.stringify(config).includes("locationHint")) {
    throw new Error("G30 current sample must not enable placement or locationHint");
  }
  return Object.freeze({ sampling: 1, observationLogPersistence: true, placement: "off" });
}

export function selfTest() {
  const current = readConfig();
  assertG30Config(current);
  const sampling = structuredClone(current);
  sampling.observability.traces.head_sampling_rate = 0;
  try {
    assertG30Config(sampling);
    throw new Error("G30 sampling mutation unexpectedly passed");
  } catch (error) {
    if (!String(error).includes("trace sampling 1")) throw error;
  }
  const logs = structuredClone(current);
  logs.observability.logs.persist = false;
  try {
    assertG30Config(logs);
    throw new Error("G30 log persistence mutation unexpectedly passed");
  } catch (error) {
    if (!String(error).includes("persist observability logs")) throw error;
  }
  const placement = structuredClone(current);
  placement.placement = "smart";
  try {
    assertG30Config(placement);
    throw new Error("G30 placement mutation unexpectedly passed");
  } catch (error) {
    if (!String(error).includes("placement or locationHint")) throw error;
  }
  return Object.freeze({ config: CURRENT_CONFIG, mutations: ["sampling", "observation-log-persistence", "placement"] });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.env.SDT_G30_CONFIG_FORCE_FAILURE === "1") throw new Error("SDT-G30 config forced failure");
  console.log(JSON.stringify(process.argv.includes("--self-test") ? selfTest() : assertG30Config(), null, 2));
}
