#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_CONFIG = ".artifacts/wrangler.g65-w155-c.jsonc";
const ARM = "sekiban-dcb-g60-w155-c";
const PIPELINE_ID = "REPLACE_WITH_G65_W155_C_PIPELINE_D1_ID";
const MV_ID = "REPLACE_WITH_G65_W155_C_MV_D1_ID";
const QUEUE = "sekiban-dcb-g60-w155-c-outbox";
const DLQ = "sekiban-dcb-g60-w155-c-outbox-dlq";
const ENTRYPOINT = "MeetingRoomDownstreamDoorbell";

function parseJsonc(text) {
  return JSON.parse(
    text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s+|,)\/\/.*$/gm, "$1")
  );
}

function expectedFailures(config) {
  const failures = [];
  const vars = config?.vars ?? {};
  if (config?.name !== ARM) failures.push(`name must be ${ARM}`);
  if (vars.DIRECT_DOORBELL !== "true") failures.push("DIRECT_DOORBELL must remain true");
  if (vars.DIRECT_DOORBELL_RECEIVER_MODE !== "self") failures.push("receiver mode must be self");
  if (vars.DIRECT_DOORBELL_SELF_BINDING_PROOF !== "true") failures.push("self-binding proof must be true");
  if (vars.DIRECT_DOORBELL_DEGRADATION !== "queued-degraded") failures.push("degradation must be queued-degraded");
  if (vars.DIRECT_DOORBELL_MAX_INVOCATIONS !== "32") failures.push("max invocations must be 32");
  if (vars.SDT_SERVICE_ID !== ARM) failures.push(`SDT_SERVICE_ID must be ${ARM}`);

  const service = config?.services?.find((entry) => entry?.binding === "DOWNSTREAM_DOORBELL");
  if (!service) failures.push("DOWNSTREAM_DOORBELL service binding is missing");
  else {
    if (service.service !== ARM) failures.push(`DOWNSTREAM_DOORBELL service must be ${ARM}`);
    if (service.entrypoint !== ENTRYPOINT) failures.push(`DOWNSTREAM_DOORBELL entrypoint must be ${ENTRYPOINT}`);
  }

  const d1 = new Map((config?.d1_databases ?? []).map((entry) => [entry.binding, entry]));
  if (d1.get("D1")?.database_id !== PIPELINE_ID) failures.push("W155-C pipeline D1 id changed");
  if (d1.get("D1_MV")?.database_id !== MV_ID) failures.push("W155-C MV D1 id changed");
  const queues = config?.queues ?? {};
  if (queues.producers?.find((entry) => entry.binding === "DOWNSTREAM_QUEUE")?.queue !== QUEUE) {
    failures.push("DOWNSTREAM_QUEUE producer changed");
  }
  const consumer = queues.consumers?.find((entry) => entry.queue === QUEUE);
  if (!consumer) failures.push("W155-C Queue consumer is missing");
  else if (consumer.dead_letter_queue !== DLQ) failures.push("W155-C DLQ changed");
  return failures;
}

function readConfig(configPath = DEFAULT_CONFIG) {
  return parseJsonc(fs.readFileSync(configPath, "utf8"));
}

function assertGreen(config, label) {
  const failures = expectedFailures(config);
  if (failures.length) throw new Error(`${label} failed:\n- ${failures.join("\n- ")}`);
  return { label, status: "passed" };
}

function assertRed(config, label) {
  const failures = expectedFailures(config);
  if (!failures.length) throw new Error(`${label} unexpectedly passed`);
  return { label, status: "red-as-expected", failures };
}

const args = process.argv.slice(2);
const selfTest = args.includes("--self-test");
const configArg = args.find((arg) => arg.startsWith("--config="));
const configPath = configArg ? configArg.slice("--config=".length) : DEFAULT_CONFIG;

const green = assertGreen(readConfig(configPath), `W155-C self config ${path.normalize(configPath)}`);
const result = [green];
if (selfTest) {
  const mutant = readConfig(configPath);
  mutant.vars.DIRECT_DOORBELL_RECEIVER_MODE = "separate";
  mutant.services.find((entry) => entry.binding === "DOWNSTREAM_DOORBELL").service = "sekiban-dcb-meeting-room-doorbell";
  result.push(assertRed(mutant, "self-binding/service mutant"));
}
console.log(JSON.stringify({ status: "passed", config: path.normalize(configPath), checks: result }, null, 2));
