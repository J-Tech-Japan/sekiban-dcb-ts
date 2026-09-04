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

function option(name, required = true) {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    if (required) throw new Error(`${name} is required`);
    return undefined;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const separator = process.argv.indexOf("--");
if (separator < 0 || separator === process.argv.length - 1) throw new Error("a Wrangler command is required after --");

const reportPath = resolve(option("--report"));
const label = option("--label");
const wrangler = resolve(option("--wrangler"));
const stdinFile = option("--stdin-file", false);
const args = process.argv.slice(separator + 1);
const strippedEnv = { ...process.env };
for (const name of STRIPPED_NAMES) delete strippedEnv[name];

const entry = {
  schema: "sdt-g60-w156-wrangler-receipt/v1",
  label,
  wrangler,
  tokenEnvironment: Object.fromEntries(STRIPPED_NAMES.map((name) => [name, strippedEnv[name] === undefined ? "UNSET" : "SET"])),
  noKeepVars: !args.includes("--keep-vars"),
  command: args,
  stdinFile: stdinFile ? resolve(stdinFile) : null,
  startedAt: new Date().toISOString(),
};

const input = stdinFile ? readFileSync(resolve(stdinFile)) : undefined;
const result = spawnSync(wrangler, args, {
  encoding: "utf8",
  env: strippedEnv,
  input,
});

entry.finishedAt = new Date().toISOString();
entry.exitCode = result.status;
entry.signal = result.signal ?? null;
entry.spawnError = result.error?.message ?? null;
entry.stdout = result.stdout ?? "";
entry.stderr = result.stderr ?? "";

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ label, exitCode: entry.exitCode, receipt: reportPath })}\n`);
if (entry.exitCode !== 0 || entry.spawnError) process.exitCode = entry.exitCode || 1;
