#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const REQUIRED_ENTRYPOINTS = Object.freeze([
  "commit-http",
  "queue-consumer",
  "tag-do-outbox-alarm",
  "cron",
  "bootstrap-import-dump-restore",
  "mv-apply",
  "doorbell-receiver",
]);
const REQUIRED_COMPONENTS = Object.freeze(["primary", "receiver"]);

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function required(name, value) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function tokenFingerprint(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function requestJson(baseUrl, path, token, init = {}) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "cache-control": "no-cache", ...(init.headers ?? {}) },
    cache: "no-store",
  });
  const raw = await response.text();
  let body;
  try { body = raw.length === 0 ? {} : JSON.parse(raw); } catch { body = { raw }; }
  return { status: response.status, body };
}

export function assertBridgeAck(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("G32 bridge acknowledgement body is invalid");
  const body = value;
  if (
    body.task !== "SDT-G32" || body.phase !== "bridge-freeze" || body.freezeActive !== true || body.oldFormatOnly !== true ||
    body.sourceCommit !== expected.sourceCommit || body.configDigest !== expected.configDigest || body.tokenFingerprint !== expected.tokenFingerprint ||
    body.component !== expected.component
  ) throw new Error(`G32 bridge acknowledgement does not match the sealed ${expected.component} identity`);
  if (!Array.isArray(body.writerEntrypoints) || !body.writerEntrypoints.every((entry) => typeof entry === "string")) {
    throw new Error("G32 bridge acknowledgement writer entrypoints are invalid");
  }
  return Object.freeze({
    component: body.component,
    writerEntrypoints: [...body.writerEntrypoints].sort(),
  });
}

export function aggregateBridgeAcks(acks) {
  if (!Array.isArray(acks) || acks.length !== REQUIRED_COMPONENTS.length) throw new Error("G32 bridge expected component acknowledgements are incomplete");
  const components = acks.map((ack) => ack.component).sort();
  if (JSON.stringify(components) !== JSON.stringify([...REQUIRED_COMPONENTS].sort())) throw new Error("G32 bridge component acknowledgement set is invalid");
  const entrypoints = [...new Set(acks.flatMap((ack) => ack.writerEntrypoints))].sort();
  if (JSON.stringify(entrypoints) !== JSON.stringify([...REQUIRED_ENTRYPOINTS].sort())) throw new Error("G32 bridge writer coverage acknowledgement is incomplete");
  return Object.freeze({ components, entrypoints });
}

export function runSelfTest() {
  const expected = { sourceCommit: "a".repeat(40), configDigest: "b".repeat(64), tokenFingerprint: "c".repeat(64) };
  const primary = assertBridgeAck({ task: "SDT-G32", phase: "bridge-freeze", freezeActive: true, oldFormatOnly: true, ...expected, component: "primary", writerEntrypoints: REQUIRED_ENTRYPOINTS.slice(0, 6) }, { ...expected, component: "primary" });
  const receiver = assertBridgeAck({ task: "SDT-G32", phase: "bridge-freeze", freezeActive: true, oldFormatOnly: true, ...expected, component: "receiver", writerEntrypoints: ["doorbell-receiver"] }, { ...expected, component: "receiver" });
  const baseline = aggregateBridgeAcks([primary, receiver]);
  let missingRed = false;
  try { aggregateBridgeAcks([primary, { ...receiver, writerEntrypoints: [] }]); } catch (error) { missingRed = String(error).includes("coverage"); }
  if (!missingRed) throw new Error("G32 bridge acknowledgement coverage mutation unexpectedly passed");
  let tokenRed = false;
  try { assertBridgeAck({ task: "SDT-G32", phase: "bridge-freeze", freezeActive: true, oldFormatOnly: true, ...expected, tokenFingerprint: "d".repeat(64), component: "primary", writerEntrypoints: REQUIRED_ENTRYPOINTS.slice(0, 6) }, { ...expected, component: "primary" }); } catch (error) { tokenRed = String(error).includes("sealed primary identity"); }
  if (!tokenRed) throw new Error("G32 bridge token identity mutation unexpectedly passed");
  return { ...baseline, mutations: ["writer-entry-missing", "freeze-token-fingerprint"] };
}

async function main() {
  if (process.argv.includes("--self-test")) {
    console.log(JSON.stringify(runSelfTest(), null, 2));
    return;
  }
  const token = readFileSync(required("--token-file", argument("--token-file", process.env.G32_FREEZE_TOKEN_FILE)), "utf8").trim();
  if (token.length === 0) throw new Error("G32 bridge freeze token file is empty");
  const expected = {
    sourceCommit: required("--source-commit", argument("--source-commit", process.env.G32_BRIDGE_SOURCE_COMMIT)),
    configDigest: required("--config-digest", argument("--config-digest", process.env.G32_BRIDGE_CONFIG_DIGEST)),
    tokenFingerprint: tokenFingerprint(token),
  };
  const primaryBaseUrl = required("--primary-base-url", argument("--primary-base-url", process.env.G32_PRIMARY_BASE_URL));
  const receiverBaseUrl = required("--receiver-base-url", argument("--receiver-base-url", process.env.G32_RECEIVER_BASE_URL));
  const [primaryResponse, receiverResponse] = await Promise.all([
    requestJson(primaryBaseUrl, "/conformance/v1/g32-bridge", token),
    requestJson(receiverBaseUrl, "/conformance/v1/g32-bridge", token),
  ]);
  if (primaryResponse.status !== 200 || receiverResponse.status !== 200) {
    throw new Error(`G32 bridge acknowledgement failed: primary=${primaryResponse.status} receiver=${receiverResponse.status}`);
  }
  const primary = assertBridgeAck(primaryResponse.body, { ...expected, component: "primary" });
  const receiver = assertBridgeAck(receiverResponse.body, { ...expected, component: "receiver" });
  const union = aggregateBridgeAcks([primary, receiver]);
  const settle = await requestJson(primaryBaseUrl, "/conformance/v1/g32-bridge/settle", token, { method: "POST" });
  if (settle.status !== 200 || settle.body?.phase !== "bridge-freeze" || settle.body?.queueDisposition === undefined) {
    throw new Error(`G32 bridge explicit disposition settlement failed: HTTP ${settle.status}`);
  }
  const evidence = {
    task: "SDT-G32",
    phase: "bridge-freeze",
    capturedAt: new Date().toISOString(),
    sourceCommit: expected.sourceCommit,
    configDigest: expected.configDigest,
    tokenFingerprint: expected.tokenFingerprint,
    acknowledgements: [primary, receiver],
    coverage: union,
    settlement: settle.body,
    secrets: "redacted",
  };
  const output = argument("--output", ".artifacts/g32-bridge-witness.json");
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ phase: evidence.phase, sourceCommit: evidence.sourceCommit, components: union.components, entrypoints: union.entrypoints.length }, null, 2));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
