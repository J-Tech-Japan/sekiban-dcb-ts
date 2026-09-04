#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const STRIPPED_NAMES = [
  "CLOUDFLARE_API_TOKEN",
  "CF_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CF_API_KEY",
  "WRANGLER_API_TOKEN",
];

function option(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function required(name) {
  const value = option(name);
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

const separator = process.argv.indexOf("--");
if (separator === -1) throw new Error("Wrangler arguments must follow --");
const command = process.argv.slice(separator + 1);
if (command.length === 0) throw new Error("Wrangler command is required");

const reportPath = resolve(required("--report"));
const wrangler = resolve(required("--wrangler"));
const stdinFile = option("--stdin-file", null);
const startedAt = new Date().toISOString();
const originalEnvironment = process.env;
const cleanedEnvironment = { ...originalEnvironment };
const tokenEnvironment = {};
for (const name of STRIPPED_NAMES) {
  tokenEnvironment[name] = Object.prototype.hasOwnProperty.call(originalEnvironment, name) ? "SET" : "UNSET";
  delete cleanedEnvironment[name];
}

const result = spawnSync(wrangler, command, {
  cwd: process.cwd(),
  env: cleanedEnvironment,
  encoding: "utf8",
  input: stdinFile === null ? undefined : readFileSync(resolve(stdinFile)),
});

const report = {
  schema: "sdt-g60-w159-wrangler-receipt/v1",
  label: option("--label", command.join(" ")),
  wrangler,
  tokenEnvironment,
  noKeepVars: !command.includes("--keep-vars"),
  command,
  stdinFile,
  startedAt,
  finishedAt: new Date().toISOString(),
  exitCode: result.status,
  signal: result.signal ?? null,
  spawnError: result.error?.message ?? null,
  stdout: result.stdout ?? "",
  stderr: result.stderr ?? "",
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(JSON.stringify({ label: report.label, exitCode: report.exitCode, report: reportPath }) + "\n");
if (result.status !== 0) process.exitCode = result.status ?? 1;
