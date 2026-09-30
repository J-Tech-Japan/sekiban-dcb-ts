#!/usr/bin/env node
/** Validate that W47 is one fresh G15-to-G16 deployed evidence window. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const receiptSchema = "sdt-g49-pr98-w46-window-receipt/v1";
const worker = "sekiban-dcb-meeting-room-cloudflare-only";
const workerUrl = "https://example.workers.dev";
const deployedVersion = "6dd811dd-8b3d-450b-b884-55e6b9095b1d";
const deployedHead = "7fcd2dbeb18d9841823c101badf8bcc28d3d99bf";

function fail(message) {
  throw new Error(`g49-w47-receipt-check: ${message}`);
}

function required(argv, index, option) {
  const value = argv[index];
  if (value === undefined || value.length === 0) fail(`${option} requires a value`);
  return value;
}

function parseArgs(argv) {
  const options = { w46: undefined, w47: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--w46") options.w46 = required(argv, ++index, argument);
    else if (argument === "--w47") options.w47 = required(argv, ++index, argument);
    else fail(`unknown argument ${JSON.stringify(argument)}`);
  }
  if (!options.w46 || !options.w47) fail("--w46 and --w47 are required");
  return options;
}

function json(path, label) {
  try {
    return JSON.parse(readFileSync(resolve(root, path), "utf8"));
  } catch (error) {
    fail(`${label} cannot be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function receipt(path, label) {
  const document = json(path, label);
  if (document.schema !== receiptSchema) fail(`${label} schema is not recognized`);
  const operations = array(document.operations, `${label}.operations`);
  const byName = new Map();
  for (const entry of operations) {
    const name = object(entry, `${label} operation`).operation;
    if (typeof name !== "string" || name.length === 0) fail(`${label} has an unnamed operation`);
    if (byName.has(name)) fail(`${label} repeats operation ${name}`);
    byName.set(name, entry);
  }
  return { document, operations, byName };
}

function operation(receiptDocument, name) {
  const entry = receiptDocument.byName.get(name);
  if (entry === undefined) fail(`W47 receipt lacks ${name}`);
  return entry;
}

function fileJson(receiptDocument, name) {
  const entry = operation(receiptDocument, name);
  if (entry.kind !== "file") fail(`${name} is not a file receipt`);
  const content = object(entry.file, `${name}.file`).content;
  if (typeof content !== "string") fail(`${name}.file.content is absent`);
  try {
    return JSON.parse(content);
  } catch (error) {
    fail(`${name} file content is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sequence(receiptDocument, name) {
  const value = operation(receiptDocument, name).sequence;
  if (!Number.isInteger(value)) fail(`${name} has no integer sequence`);
  return value;
}

function precedes(receiptDocument, first, second) {
  if (sequence(receiptDocument, first) >= sequence(receiptDocument, second)) fail(`${first} does not precede ${second}`);
}

function assertW46(receiptDocument) {
  const purge = operation(receiptDocument, "pipeline-lag-purge");
  const command = object(purge.command, "W46 purge command").arguments;
  if (!Array.isArray(command) || command[command.indexOf("--command") + 1] !== "DELETE FROM serialized_dcb_lag_estimates") {
    fail("W46 does not retain the exact lag-purge command");
  }
  const purgeResult = object(purge.result, "W46 purge result").json;
  if (!Array.isArray(purgeResult) || purgeResult[0]?.meta?.changes !== 6) fail("W46 purge receipt does not record six deleted rows");
  const sanityRows = operation(receiptDocument, "mv-rows-after-sanity").result?.json;
  if (!Array.isArray(sanityRows) || sanityRows[0]?.results?.[0]?.mvRows !== 14) fail("W46 does not retain the 0-to-14 mv_rows sanity proof");
  const trace = fileJson(receiptDocument, "ac5-external-trace");
  if (trace?.room?.readState?.status !== "created" || typeof trace?.room?.readHead !== "string"
      || trace?.reservation?.readState?.status !== "reserved" || typeof trace?.reservation?.readHead !== "string") {
    fail("W46 does not retain AC5 created/reserved state and read-head evidence");
  }
}

function assertW47(receiptDocument) {
  for (const name of [
    "whoami",
    "normal-config",
    "branch-config-head",
    "deployed-version-check",
    "g15-harness-source",
    "g15-report",
    "g16-launch-status",
    "g16-completion-status",
    "g16-log",
    "g16-report",
  ]) operation(receiptDocument, name);
  const config = fileJson(receiptDocument, "normal-config");
  const pipeline = config?.d1_databases?.find((entry) => entry?.binding === "D1");
  const materializedView = config?.d1_databases?.find((entry) => entry?.binding === "D1_MV");
  if (config?.name !== worker || pipeline?.migrations_dir !== "../../migrations/d1/g32" || materializedView?.migrations_dir !== "../../migrations/mv") {
    fail("W47 config receipt does not retain the exclusive G32 pipeline lineage");
  }
  const head = object(operation(receiptDocument, "branch-config-head").head, "W47 branch config head");
  if (head.commit !== deployedHead) fail("W47 did not start from preserved deployed config head 7fcd2db");
  const versions = operation(receiptDocument, "deployed-version-check").result?.json;
  if (!Array.isArray(versions) || !versions.some((version) => version?.id === deployedVersion && String(version?.annotations?.["workers/message"] ?? "").includes(deployedHead))) {
    fail("W47 deployed-version receipt does not bind version 6dd811dd to 7fcd2db");
  }
  const g15 = fileJson(receiptDocument, "g15-report");
  const g16 = fileJson(receiptDocument, "g16-report");
  if (g15?.probe !== "SDT-G15" || g16?.probe !== "SDT-G16" || g15?.baseUrl !== workerUrl || g16?.baseUrl !== workerUrl
      || typeof g15?.runId !== "string" || typeof g16?.runId !== "string" || g15.runId === g16.runId) {
    fail("W47 G15/G16 reports are not a fresh, distinct deployed pair");
  }
  if (g15?.serviceIdentity?.configuredServiceId !== worker || g16?.serviceIdentity?.configuredServiceId !== worker) {
    fail("W47 G15/G16 reports do not retain the expected service identity");
  }
  if (g15?.commands?.create?.status !== 200 || g15?.commands?.reserve?.status !== 200 || g16?.commands?.create?.status !== 200 || g16?.commands?.reserve?.status !== 200) {
    fail("W47 pair does not retain successful create/reserve commands");
  }
  if (g16?.queryViews?.reservationList?.readHead !== null) fail("W47 G16 list readHead is not honestly null");
  const launch = fileJson(receiptDocument, "g16-launch-status");
  const completion = fileJson(receiptDocument, "g16-completion-status");
  if (launch?.state !== "running" || !Number.isInteger(launch?.runnerPid) || completion?.state !== "completed"
      || completion?.exitCode !== 0 || completion?.signal !== null || completion?.reportExists !== true
      || !Array.isArray(completion?.command) || completion.command.slice(0, 3).join(" ") !== "npm run e2e:g16") {
    fail("W47 G16 detached process receipt lacks a successful single attempt");
  }
  for (const [first, second] of [
    ["whoami", "deployed-version-check"],
    ["deployed-version-check", "g15-report"],
    ["g15-report", "g16-launch-status"],
    ["g16-launch-status", "g16-completion-status"],
    ["g16-completion-status", "g16-report"],
  ]) precedes(receiptDocument, first, second);
  return { g15RunId: g15.runId, g16RunId: g16.runId, g16RunnerPid: launch.runnerPid };
}

try {
  const options = parseArgs(process.argv.slice(2));
  const w46 = receipt(options.w46, "W46 receipt");
  const w47 = receipt(options.w47, "W47 receipt");
  assertW46(w46);
  const result = assertW47(w47);
  process.stdout.write(`${JSON.stringify({ result: "g49-w47-receipts-valid", deployedVersion, deployedHead, ...result }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
