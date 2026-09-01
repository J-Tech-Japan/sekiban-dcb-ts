#!/usr/bin/env node
/** Validate the committed raw SDT-G49 W46 window receipt without contacting Cloudflare. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const schema = "sdt-g49-pr98-w46-window-receipt/v1";
const normalWorker = "sekiban-dcb-meeting-room-cloudflare-only";
const normalUrl = "https://sekiban-dcb-meeting-room-cloudflare-only.ttakaoka.workers.dev";
const pipelineDatabase = "sekiban-dcb-meeting-room-cloudflare-pipeline";
const materializedViewDatabase = "sekiban-dcb-meeting-room-cloudflare-mv";

function fail(message) {
  throw new Error(`g49-w46-receipt-check: ${message}`);
}

function required(argv, index, option) {
  const value = argv[index];
  if (value === undefined || value.length === 0) fail(`${option} requires a value`);
  return value;
}

function parseArgs(argv) {
  const options = { receipt: undefined, phase: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--receipt") options.receipt = required(argv, ++index, argument);
    else if (argument === "--phase") options.phase = required(argv, ++index, argument);
    else fail(`unknown argument ${JSON.stringify(argument)}`);
  }
  if (!options.receipt) fail("--receipt is required");
  if (!new Set(["sanity", "complete"]).has(options.phase)) fail("--phase must be sanity or complete");
  return options;
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function string(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function json(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    fail(`${label} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readReceipt(path) {
  const document = json(readFileSync(resolve(root, path), "utf8"), "receipt");
  if (document.schema !== schema) fail("receipt schema is not recognized");
  const operations = array(document.operations, "receipt.operations");
  if (operations.length === 0) fail("receipt has no operations");
  const byOperation = new Map();
  for (const entry of operations) {
    const operation = string(object(entry, "receipt operation").operation, "receipt operation.operation");
    if (byOperation.has(operation)) fail(`receipt repeats operation ${operation}`);
    byOperation.set(operation, entry);
  }
  return { document, operations, byOperation };
}

function operation(receipt, name) {
  const value = receipt.byOperation.get(name);
  if (value === undefined) fail(`receipt lacks ${name}`);
  return value;
}

function sequence(value) {
  const number = object(value, "operation").sequence;
  if (!Number.isInteger(number) || number < 1) fail("operation sequence is invalid");
  return number;
}

function precedes(receipt, earlier, later) {
  if (sequence(operation(receipt, earlier)) >= sequence(operation(receipt, later))) {
    fail(`${earlier} does not precede ${later}`);
  }
}

function fileJson(receipt, name) {
  const entry = operation(receipt, name);
  if (entry.kind !== "file") fail(`${name} is not a file receipt`);
  return json(string(object(entry.file, `${name}.file`).content, `${name}.file.content`), name);
}

function d1Rows(receipt, name) {
  const entry = operation(receipt, name);
  if (entry.kind !== "wrangler") fail(`${name} is not a Wrangler receipt`);
  const payload = object(entry.result, `${name}.result`).json;
  const results = array(payload, `${name}.result.json`);
  const rows = [];
  for (const result of results) {
    const parsed = object(result, `${name}.result item`);
    if (parsed.success !== true) fail(`${name} did not report success`);
    for (const row of array(parsed.results ?? [], `${name}.result rows`)) rows.push(object(row, `${name}.row`));
  }
  return rows;
}

function d1Count(receipt, name, field) {
  const rows = d1Rows(receipt, name);
  if (rows.length !== 1 || !Number.isFinite(rows[0][field])) fail(`${name} does not return numeric ${field}`);
  return rows[0][field];
}

function command(receipt, name) {
  const entry = operation(receipt, name);
  if (entry.kind !== "wrangler") fail(`${name} is not a Wrangler receipt`);
  return array(object(entry.command, `${name}.command`).arguments, `${name}.command.arguments`);
}

function assertConfig(receipt) {
  const config = fileJson(receipt, "normal-config");
  if (config.name !== normalWorker) fail("normal config worker name changed");
  const databases = array(config.d1_databases, "normal config d1_databases");
  const pipeline = databases.find((entry) => entry?.binding === "D1");
  const mv = databases.find((entry) => entry?.binding === "D1_MV");
  if (pipeline?.database_name !== pipelineDatabase || typeof pipeline.database_id !== "string" || pipeline.database_id.length === 0 || pipeline.migrations_dir !== "../../migrations/d1/g32") {
    fail("normal config does not retain the exclusive G32 pipeline lineage");
  }
  if (mv?.database_name !== materializedViewDatabase || typeof mv.database_id !== "string" || mv.database_id.length === 0 || mv.migrations_dir !== "../../migrations/mv") {
    fail("normal config does not retain the MV lineage");
  }
  const queue = config?.queues?.consumers?.[0];
  if (config?.queues?.producers?.[0]?.queue !== "sekiban-dcb-meeting-room-cloudflare-outbox"
      || queue?.queue !== "sekiban-dcb-meeting-room-cloudflare-outbox"
      || queue?.dead_letter_queue !== "sekiban-dcb-meeting-room-cloudflare-outbox-dlq") {
    fail("normal config queue/DLQ identity changed");
  }
}

function assertPipelineCatalog(receipt, name) {
  const names = new Set(d1Rows(receipt, name).map((row) => row.name));
  for (const expected of ["dcb_events", "dcb_event_ops"]) {
    if (!names.has(expected)) fail(`${name} lacks ${expected}`);
  }
  if (![...names].some((entry) => entry.startsWith("serialized_dcb_"))) fail(`${name} lacks G32 serialized_* tables`);
}

function assertMvLedger(receipt, name) {
  const entries = d1Rows(receipt, name).map((row) => JSON.stringify(row));
  for (const migration of [
    "0001_materialized_views.sql",
    "0002_unsafe_window_materialized_views.sql",
    "0003_checkpoint_ahead_hardening.sql",
    "0004_unsafe_window_failure_findings.sql",
    "0005_g31_wait_receipts.sql",
    "0006_g31_wait_target_poison.sql",
  ]) {
    if (!entries.some((entry) => entry.includes(migration))) fail(`${name} lacks ${migration}`);
  }
}

function assertNoQueueMutation(receipt) {
  for (const entry of receipt.operations) {
    if (entry.kind !== "wrangler") continue;
    const argumentsList = array(entry.command?.arguments, "Wrangler command arguments");
    const normalized = argumentsList.map((value) => String(value).toLowerCase());
    if (normalized.some((value) => value.includes("replay"))) fail("receipt contains a replay command");
    if (normalized[0] !== "queues") continue;
    const readOnly = normalized[1] === "list"
      || (normalized[1] === "consumer" && normalized[2] === "worker" && normalized[3] === "list");
    if (!readOnly) fail(`receipt contains a queue mutation command: ${argumentsList.join(" ")}`);
  }
}

function assertSanity(receipt) {
  const requiredOperations = [
    "whoami",
    "normal-config",
    "branch-config-head",
    "d1-list-pre-purge",
    "pipeline-g32-catalog-pre-purge",
    "pipeline-lag-before-purge",
    "pipeline-completeness-pre-purge",
    "mv-instances-pre-purge",
    "mv-ledger-pre-purge",
    "mv-rows-before-purge",
    "queue-before",
    "queue-consumers-before",
    "versions-before-deploy",
    "deploy-normal-config",
    "versions-after-deploy",
    "pipeline-lag-purge",
    "pipeline-lag-after-purge",
    "two-cron-wait-start",
    "two-cron-wait-end",
    "sanity-create-room",
    "sanity-wake-wait-start",
    "sanity-wake-wait-end",
    "mv-instances-after-sanity",
    "mv-rows-after-sanity",
  ];
  for (const name of requiredOperations) operation(receipt, name);
  assertConfig(receipt);
  const head = object(operation(receipt, "branch-config-head").head, "branch-config-head.head");
  if (!/^[0-9a-f]{40}$/.test(string(head.commit, "branch-config-head.head.commit"))) fail("branch config head is not a full SHA");
  const config = fileJson(receipt, "normal-config");
  const pipelineId = config.d1_databases.find((entry) => entry?.binding === "D1").database_id;
  const d1List = object(operation(receipt, "d1-list-pre-purge").result, "d1-list-pre-purge.result");
  if (!string(d1List.stdout, "d1-list-pre-purge.result.stdout").includes(pipelineDatabase)
      || !d1List.stdout.includes(pipelineId)) {
    fail("pre-purge D1 list does not identify the configured pipeline database UUID/name");
  }
  const deployArguments = command(receipt, "deploy-normal-config");
  if (deployArguments[0] !== "deploy" || deployArguments[deployArguments.indexOf("--config") + 1] !== "samples/meeting-room/wrangler.cloudflare-only.jsonc"
      || !String(deployArguments[deployArguments.indexOf("--message") + 1]).includes(head.commit)) {
    fail("deploy receipt does not bind the normal config to the recorded branch head");
  }
  assertPipelineCatalog(receipt, "pipeline-g32-catalog-pre-purge");
  assertMvLedger(receipt, "mv-ledger-pre-purge");
  if (d1Rows(receipt, "pipeline-lag-before-purge").length === 0) fail("lag-before receipt does not prove pollution was present");
  if (d1Rows(receipt, "pipeline-lag-after-purge").length !== 0) fail("lag-after receipt still has lag estimates");
  const purgeArguments = command(receipt, "pipeline-lag-purge");
  const purgeSql = purgeArguments[purgeArguments.indexOf("--command") + 1];
  if (purgeSql !== "DELETE FROM serialized_dcb_lag_estimates") fail("receipt does not prove the exact all-row lag purge");
  const sanity = fileJson(receipt, "sanity-create-room");
  if (sanity?.mode !== "sanity-create-room" || sanity?.baseUrl !== normalUrl || sanity?.exactlyOneCreateRoomCommand !== true || sanity?.create?.status !== 200 || typeof sanity?.create?.suid !== "string") {
    fail("sanity receipt is not one successful normal-url create-room commit");
  }
  if (d1Count(receipt, "mv-rows-after-sanity", "mvRows") <= 0) fail("safe projector did not produce mv_rows after sanity commit");
  const instances = d1Rows(receipt, "mv-instances-after-sanity");
  if (instances.length < 2) fail("sanity receipt does not retain both mv_instances");
  assertNoQueueMutation(receipt);
  for (const [earlier, later] of [
    ["whoami", "d1-list-pre-purge"],
    ["d1-list-pre-purge", "pipeline-lag-purge"],
    ["versions-before-deploy", "deploy-normal-config"],
    ["deploy-normal-config", "versions-after-deploy"],
    ["pipeline-lag-purge", "pipeline-lag-after-purge"],
    ["pipeline-lag-after-purge", "two-cron-wait-start"],
    ["two-cron-wait-start", "two-cron-wait-end"],
    ["two-cron-wait-end", "sanity-create-room"],
    ["sanity-create-room", "mv-rows-after-sanity"],
  ]) precedes(receipt, earlier, later);
  return { configHead: head.commit, mvRowsAfterSanity: d1Count(receipt, "mv-rows-after-sanity", "mvRows") };
}

function assertComplete(receipt) {
  const sanity = assertSanity(receipt);
  for (const name of [
    "ac5-external-trace",
    "g15-report",
    "g16-report",
    "pipeline-g32-catalog-after-e2e",
    "mv-ledger-after-e2e",
    "mv-rows-after-e2e",
    "queue-after",
    "queue-consumers-after",
  ]) operation(receipt, name);
  const trace = fileJson(receipt, "ac5-external-trace");
  if (trace?.mode !== "external-app-layer-trace" || trace?.baseUrl !== normalUrl
      || trace?.room?.readState?.status !== "created" || typeof trace?.room?.readHead !== "string"
      || trace?.reservation?.readState?.status !== "reserved" || typeof trace?.reservation?.readHead !== "string") {
    fail("external AC5 trace does not retain created/reserved states and their read heads");
  }
  const g15 = fileJson(receipt, "g15-report");
  const g16 = fileJson(receipt, "g16-report");
  if (g15?.probe !== "SDT-G15" || g15?.baseUrl !== normalUrl || g16?.probe !== "SDT-G16" || g16?.baseUrl !== normalUrl) {
    fail("G15/G16 reports do not target the normal deployed URL");
  }
  if (g16?.queryViews?.reservationList?.readHead !== null) fail("G16 list readHead is not honestly null");
  if (g15?.commands?.create?.status !== 200 || g15?.commands?.reserve?.status !== 200 || g16?.commands?.create?.status !== 200 || g16?.commands?.reserve?.status !== 200) {
    fail("G15/G16 reports lack successful create and reserve commands");
  }
  assertPipelineCatalog(receipt, "pipeline-g32-catalog-after-e2e");
  assertMvLedger(receipt, "mv-ledger-after-e2e");
  if (d1Count(receipt, "mv-rows-after-e2e", "mvRows") <= 0) fail("post-E2E receipt has no mv_rows");
  assertNoQueueMutation(receipt);
  for (const [earlier, later] of [
    ["mv-rows-after-sanity", "ac5-external-trace"],
    ["ac5-external-trace", "g15-report"],
    ["g15-report", "g16-report"],
    ["g16-report", "pipeline-g32-catalog-after-e2e"],
  ]) precedes(receipt, earlier, later);
  return { ...sanity, g15RunId: g15.runId, g16RunId: g16.runId, mvRowsAfterE2e: d1Count(receipt, "mv-rows-after-e2e", "mvRows") };
}

try {
  const options = parseArgs(process.argv.slice(2));
  const receipt = readReceipt(options.receipt);
  const result = options.phase === "sanity" ? assertSanity(receipt) : assertComplete(receipt);
  process.stdout.write(`${JSON.stringify({ result: "g49-w46-receipt-valid", phase: options.phase, ...result }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
