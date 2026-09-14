#!/usr/bin/env node
/**
 * Keep AC3's classification table source-derived.  A new client error/result
 * code must acquire a documented row instead of silently falling through.
 *
 * SDT-G86: every derived code must also have a result kind in the shared
 * classification module both executors use, and that kind must be one its
 * class allows.  The module is imported from the built package.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const sourceRoot = resolve(root, "packages/dcb-client/src");
const evidencePath = resolve(root, "docs/SDT-G78-evidence.md");
const classificationModulePath = resolve(root, "packages/dcb-client/dist/classification.js");

const classifications = Object.freeze({
  aborted: { class: "caller-abort", action: "stop automatic work; reconcile if dispatch may have happened" },
  authority_unavailable: { class: "malformed-or-unknown", action: "do not infer absence; inspect or reconcile the unavailable authority" },
  assert_empty_failed: { class: "definite-refusal", action: "fix the input/state assertion" },
  claim_not_in_candidate_tags: { class: "definite-refusal", action: "fix the command consistency claim" },
  command_rejected: { class: "definite-refusal", action: "act on the command rejection" },
  consistency_conflict: { class: "definite-refusal", action: "reread and recompute the conflict" },
  domain_authoring_error: { class: "definite-refusal", action: "fix the command or domain authoring; nothing was sent" },
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

/** SDT-G86: the result kinds each SDT-G78 class may map to. */
const allowedKinds = Object.freeze({
  "caller-abort": Object.freeze(["timeout"]),
  "deadline-or-unknown": Object.freeze(["timeout", "unavailable"]),
  "definite-refusal": Object.freeze(["invalid", "rejected", "conflict", "partial"]),
  "malformed-or-unknown": Object.freeze(["transport"]),
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

function checkKinds(codes, kinds) {
  const result = {};
  for (const code of codes) {
    const kind = Object.prototype.hasOwnProperty.call(kinds, code) ? kinds[code] : undefined;
    assert(typeof kind === "string", `source code ${code} has no result kind in the shared classification module`);
    const codeClass = classifications[code]?.class;
    assert(codeClass !== undefined, `source code ${code} has no classification row`);
    assert(allowedKinds[codeClass].includes(kind), `source code ${code} maps to kind ${kind}, outside its ${codeClass} class (${allowedKinds[codeClass].join(", ")})`);
    result[code] = kind;
  }
  return result;
}

async function loadKinds() {
  assert(existsSync(classificationModulePath), "packages/dcb-client/dist/classification.js is missing; run npm run build:packages first");
  const module = await import(pathToFileURL(classificationModulePath).href);
  assert(typeof module.FAILURE_KINDS === "object" && module.FAILURE_KINDS !== null, "built classification module does not export FAILURE_KINDS");
  return module.FAILURE_KINDS;
}

const sourceMap = await sources();
const evidence = await readFile(evidencePath, "utf8");
const result = check(sourceMap, evidence);
const kinds = await loadKinds();
result.kinds = checkKinds(result.codes, kinds);
if (process.argv.includes("--self-test")) {
  const rejects = (label, action) => {
    let red = false;
    try { action(); } catch { red = true; }
    assert(red, `${label} mutant was accepted`);
    return `${label}-red`;
  };
  const mutant = { ...sourceMap, "g78-self-test.ts": `${sourceMap["executor.ts"]}\nthrow new Error(new ClientError("unclassified_future_code", "mutant"));\n` };
  const withoutKind = { ...kinds };
  delete withoutKind.transport;
  result.selfTest = [
    rejects("unclassified-code", () => check(mutant, evidence)),
    rejects("injected-code-without-kind", () => checkKinds([...result.codes, "unclassified_future_code"], kinds)),
    rejects("deleted-kind", () => checkKinds(result.codes, withoutKind)),
    rejects("kind-outside-class", () => checkKinds(result.codes, { ...kinds, aborted: "invalid" })),
  ];
}
process.stdout.write(`${JSON.stringify({ status: "g78-error-classification-valid", ...result }, null, 2)}\n`);
