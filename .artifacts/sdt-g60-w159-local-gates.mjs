#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const commands = [
  ["npm run test:g15", ["npm", "run", "test:g15"]],
  ["npm run test:g16", ["npm", "run", "test:g16"]],
  ["npm run test:g60:direct", ["npm", "run", "test:g60:direct"]],
  ["npm run test:g60:queue", ["npm", "run", "test:g60:queue"]],
  ["npm run test:g60:unsafe-writer", ["npm", "run", "test:g60:unsafe-writer"]],
  ["node scripts/g60-durable-hop-guard.mjs --self-test && node scripts/g60-durable-hop-guard.mjs", ["node", "scripts/g60-durable-hop-guard.mjs", "--self-test"]],
  ["node scripts/g60-post-admission-guard.mjs --self-test && node scripts/g60-post-admission-guard.mjs", ["node", "scripts/g60-post-admission-guard.mjs", "--self-test"]],
  ["npm run test:g26", ["npm", "run", "test:g26"]],
  ["npm run test:g41", ["npm", "run", "test:g41"]],
  ["npm run test:g44", ["npm", "run", "test:g44"]],
  ["npm run test:g49", ["npm", "run", "test:g49"]],
  ["npm run test:g51", ["npm", "run", "test:g51"]],
  ["npm run test:g52", ["npm", "run", "test:g52"]],
  ["npm run test:g53", ["npm", "run", "test:g53"]],
  ["npm run test:g54", ["npm", "run", "test:g54"]],
  ["npm run test:g55", ["npm", "run", "test:g55"]],
  ["npm run test:g58", ["npm", "run", "test:g58"]],
  ["npm run test:g61", ["npm", "run", "test:g61"]],
  ["npm run test:g62", ["npm", "run", "test:g62"]],
  ["npm run test:d1", ["npm", "run", "test:d1"]],
  ["npm run typecheck", ["npm", "run", "typecheck"]],
  ["npm run lint", ["npm", "run", "lint"]],
  ["git diff --check", ["git", "diff", "--check"]],
];
const stripped = ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_KEY", "WRANGLER_API_TOKEN"];
const env = { ...process.env };
const tokenEnvironment = Object.fromEntries(stripped.map((name) => [name, Object.prototype.hasOwnProperty.call(env, name) ? "SET" : "UNSET"]));
for (const name of stripped) delete env[name];
const results = [];
for (const [label, args] of commands) {
  const startedAt = new Date().toISOString();
  const executable = args[0] === "npm" ? "npm" : args[0] === "node" ? process.execPath : "git";
  const result = spawnSync(executable, args.slice(1), {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });
  const receipt = {
    label,
    command: args[0] === "npm" ? args : args[0] === "node" ? [process.execPath, ...args.slice(1)] : args,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: result.status,
    signal: result.signal ?? null,
    spawnError: result.error?.message ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
  results.push(receipt);
  writeFileSync(".artifacts/sdt-g60-w159-local-gates.json", `${JSON.stringify({ schema: "sdt-g60-w159-local-gates/v1", tokenEnvironment, results }, null, 2)}\n`, "utf8");
}
const failed = results.filter((result) => result.exitCode !== 0);
console.log(JSON.stringify({ report: ".artifacts/sdt-g60-w159-local-gates.json", total: results.length, failed: failed.map((result) => ({ label: result.label, exitCode: result.exitCode })) }, null, 2));
if (failed.length > 0) process.exitCode = 1;
