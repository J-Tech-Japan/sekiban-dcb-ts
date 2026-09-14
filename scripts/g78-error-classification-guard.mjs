#!/usr/bin/env node
/**
 * Keep AC3's classification table source-derived.  A new client error/result
 * code must acquire a documented row instead of silently falling through.
 */
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const sourceRoot = resolve(root, "packages/dcb-client/src");
const evidencePath = resolve(root, "docs/SDT-G78-evidence.md");

const classifications = Object.freeze({
  aborted: { class: "caller-abort", action: "stop automatic work; reconcile if dispatch may have happened" },
  authority_unavailable: { class: "malformed-or-unknown", action: "do not infer absence; inspect or reconcile the unavailable authority" },
  assert_empty_failed: { class: "definite-refusal", action: "fix the input/state assertion" },
  claim_not_in_candidate_tags: { class: "definite-refusal", action: "fix the command consistency claim" },
  command_rejected: { class: "definite-refusal", action: "act on the command rejection" },
  consistency_conflict: { class: "definite-refusal", action: "reread and recompute the conflict" },
  "credential.rejected": { class: "definite-refusal", action: "fix credentials; never expose the credential response" },
  duplicate_consistency_entry: { class: "definite-refusal", action: "fix duplicate consistency input" },
  incoherent_read_snapshot: { class: "malformed-or-unknown", action: "do not infer absence or blindly retry" },
  invalid_command_input: { class: "definite-refusal", action: "fix the command input" },
  invalid_command_result: { class: "malformed-or-unknown", action: "do not trust the command result" },
  invalid_consistency: { class: "definite-refusal", action: "fix list-query consistency input" },
  invalid_execute_options: { class: "definite-refusal", action: "fix the executor options before dispatch" },
  invalid_query_request: { class: "definite-refusal", action: "fix the query request" },
  invalid_query_response: { class: "malformed-or-unknown", action: "do not trust or blindly retry the response" },
  invalid_read_snapshot: { class: "malformed-or-unknown", action: "do not trust or blindly retry the snapshot" },
  http_error: { class: "malformed-or-unknown", action: "inspect the typed status/code; never infer definiteness from 5xx" },
  partial_write: { class: "definite-refusal", action: "reconcile the committed/failed facts; never blindly retry" },
  projection_unavailable: { class: "deadline-or-unknown", action: "renew the read budget before retrying projection work" },
  read_unavailable: { class: "deadline-or-unknown", action: "retry a read only under a renewed budget" },
  "scope.mismatch": { class: "definite-refusal", action: "fix the executor/transport service scope" },
  timeout: { class: "deadline-or-unknown", action: "reconcile a command; retry a read only under a renewed budget" },
  transport: { class: "malformed-or-unknown", action: "inspect/reconcile; do not infer definiteness from the transport class" },
  unknown_outcome: { class: "deadline-or-unknown", action: "reconcile the logical operation; never blindly reissue" },
  unsupported_capability: { class: "definite-refusal", action: "fix configuration or use a transport with the capability" },
  unsupported_consistency_mode: { class: "definite-refusal", action: "move consistency to listQuery or remove it" },
});

function fail(message) { throw new Error(`G78 error-classification guard: ${message}`); }
function assert(condition, message) { if (!condition) fail(message); }

async function sources() {
  const names = (await readdir(sourceRoot)).filter((name) => name.endsWith(".ts")).sort();
  return Object.fromEntries(await Promise.all(names.map(async (name) => [name, await readFile(resolve(sourceRoot, name), "utf8")] )));
}

function derive(sourceMap) {
  const found = new Map();
  for (const [name, source] of Object.entries(sourceMap)) {
    const safeMessages = source.match(/const SAFE_MESSAGES[\s\S]*?\n\}\);/m)?.[0];
    for (const match of safeMessages?.matchAll(/^\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_.]*))\s*:/gm) ?? []) {
      found.set(match[1] ?? match[2], `${name}:documented safe code`);
    }
    for (const match of source.matchAll(/new ClientError\(\s*["']([^"']+)/g)) found.set(match[1], `${name}:new ClientError`);
    for (const match of source.matchAll(/\bcode:\s*["']([^"']+)/g)) found.set(match[1], `${name}:result code`);
    for (const match of source.matchAll(/(?:const|let)\s+code\s*=.*?\?\s*[^:]+:\s*["']([^"']+)/g)) found.set(match[1], `${name}:default code`);
    if (source.includes('"http_error"')) found.set("http_error", `${name}:HTTP default`);
    if (source.includes('"unknown_outcome"')) found.set("unknown_outcome", `${name}:unknown outcome`);
  }
  return found;
}

function check(sourceMap, evidence) {
  const found = derive(sourceMap);
  const expected = new Set(Object.keys(classifications));
  for (const code of found.keys()) assert(expected.has(code), `source code ${code} has no classification row`);
  for (const code of expected) assert(found.has(code), `classification row ${code} is not derived from client source`);
  assert(evidence.includes("## AC3/AC4 error classification"), "evidence classification section is missing");
  for (const code of expected) assert(evidence.includes(`| \`${code}\` |`), `evidence row ${code} is missing`);
  return { codes: [...found.keys()].sort(), sourceLocations: Object.fromEntries(found) };
}

const sourceMap = await sources();
const evidence = await readFile(evidencePath, "utf8");
const result = check(sourceMap, evidence);
if (process.argv.includes("--self-test")) {
  const mutant = { ...sourceMap, "g78-self-test.ts": `${sourceMap["executor.ts"]}\nthrow new Error(new ClientError("unclassified_future_code", "mutant"));\n` };
  let red = false;
  try { check(mutant, evidence); } catch { red = true; }
  assert(red, "unclassified source-code mutant was accepted");
  result.selfTest = "unclassified-code-red";
}
process.stdout.write(`${JSON.stringify({ status: "g78-error-classification-valid", ...result }, null, 2)}\n`);
