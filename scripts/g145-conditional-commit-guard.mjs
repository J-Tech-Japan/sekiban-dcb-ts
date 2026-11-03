#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : process.cwd());
const read = (path) => readFileSync(resolve(root, path), "utf8");

const worker = read("packages/dcb-runtime/src/commit/ConditionalCommitWorker.ts");
const receipt = read("packages/dcb-runtime/src/tag/TagConditionalReceipt.ts");
const tag = read("packages/dcb-runtime/src/tag/TagDurableObject.ts");
const ordinary = read("packages/dcb-runtime/src/index.ts");
const cloudflare = read("packages/dcb-runtime/src/cloudflare.ts");
const client = read("packages/dcb-client/src/index.ts");
const executor = read("packages/dcb-client/src/executor.ts");

function between(source, start, end, label) {
  const from = source.indexOf(start);
  const to = from < 0 ? -1 : source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`${label} anchor missing`);
  return source.slice(from, to);
}

const handle = between(worker, "async handleConditionalCommit(", "private capabilityAuthorizes(", "conditional handler");
const appendSql = between(tag, "private async appendSql(", "private async acquireSql(", "append transaction");
const ordinaryFactory = between(ordinary, "export function createRuntimeWorker(", "const worker = createRuntimeWorker(", "ordinary factory");
const fixedFactory = between(cloudflare, "export function createCloudflareOnlyRuntimeWorker(", "async queue(", "fixed D1 factory");
const ordinaryCapability = between(worker, "export function createOrdinaryConditionalExecutor(", "export function createFixedD1ConditionalExecutor(", "ordinary capability");

const failures = [];
function check(name, ok) {
  if (!ok) failures.push(name);
}

const order = (source, names) => names.every((name, index) => {
  const at = source.indexOf(name);
  if (at < 0) return false;
  if (index === 0) return true;
  return at > source.indexOf(names[index - 1]);
});

check("terminal-before-allocation", order(handle, [
  "this.fingerprint(",
  "this.capabilityAuthorizes()",
  "this.resolveConditionalTag(",
  "this.readBootstrapState(",
  "this.allocateConditional(",
  "this.appendConditionalTag(",
]));
check("terminal-before-append-guards", appendSql.indexOf("readConditionalTerminal(") >= 0
  && appendSql.indexOf("readConditionalTerminal(") < appendSql.indexOf("SELECT * FROM tag_reservation WHERE singleton = 1"));
check("receipt-inside-existing-transaction", order(appendSql, [
  "this.ctx.storage.transaction(",
  "this.writeCommittedSqlEvent(",
  "this.writeCommittedSqlMembership(",
  "this.writeCommittedSqlObligation(",
  "insertConditionalReceipt(sql, receiptValues)",
  "this.writeCommittedSqlReceipt(",
]));
check("receipt-key-exact", receipt.includes("PRIMARY KEY (service_id, normalized_key)"));
check("receipt-event-unique-exact", receipt.includes("UNIQUE (service_id, event_id)"));
check("schema-fail-closed", receipt.includes("throw new ConditionalReceiptUnsupported(\"conditional receipt columns\")")
  && !receipt.includes("ALTER TABLE")
  && !receipt.includes("DROP TABLE")
  && !receipt.includes("IF NOT EXISTS"));
check("import-old-tag-fail-closed", receipt.includes('marker === 0 ? { kind: "absent" } : { kind: "unsupported" }')
  && receipt.includes("if (receiptCount !== 1 || marker !== 0) return { kind: \"corrupt\" };")
  && worker.includes("if (response.status === 404) return unsupportedResponse();"));
check("no-v1-fallback", !worker.includes('"/append"'));
check("generic-internal-prefix-denied", [ordinary, cloudflare].every((source) => {
  const gate = source.indexOf('tagMatch[3]?.startsWith("/__internal/")');
  const decoded = source.indexOf("decodeURIComponent(tagMatch[1])");
  const resolved = source.indexOf("env.TAG.get(scopeIdFor(env.TAG");
  return gate >= 0 && gate < decoded && decoded < resolved;
}));
check("corruption-not-success", worker.includes("if (response.status === 500) return corruptResponse();")
  && worker.includes('code: "conditional_commit_committed_state_corrupt"')
  && !between(worker, "function corruptResponse(", "function inDoubtResponse(", "corrupt response").includes("Appended"));
check("provider-capability-not-name", !worker.includes(".name")
  && ordinaryCapability.includes("input.storeProvider === undefined")
  && !ordinaryFactory.includes("storeProvider.name")
  && !fixedFactory.includes("storeProvider.name"));
check("provider-capability-before-tag", handle.indexOf("this.capabilityAuthorizes()") >= 0
  && handle.indexOf("this.capabilityAuthorizes()") < handle.indexOf("this.resolveConditionalTag(")
  && worker.indexOf("env.TAG.get(") > worker.indexOf("private tagStub("));
check("uniqueness-escapes-transaction", receipt.includes("throw new ConditionalReceiptUniquenessFault()")
  && appendSql.indexOf("insertConditionalReceipt(") < appendSql.indexOf("instanceof ConditionalReceiptUniquenessFault")
  && !between(appendSql, "this.ctx.storage.transaction(", "return result;", "transaction callback").includes("instanceof ConditionalReceiptUniquenessFault"));
check("no-public-conditional-route", !ordinary.includes("conditional-commit") && !cloudflare.includes("conditional-commit"));
check("no-built-in-conditional-transport", !client.includes("conditional-commit")
  && !executor.includes("conditional-commit")
  && !client.includes("conditionalCommit:")
  && !executor.includes("conditionalCommit:"));
const revalidate = between(worker, "private async revalidateFacts(", "const COORDINATOR_KEYS", "stored parser");
const bootstrapRead = between(worker, "private async readBootstrapState(", "private bootstrapStub(", "bootstrap read");
const appendParser = between(receipt, "export function parseConditionalAppendBody(", "function countRows(", "append parser");
check("stored-event-parser", revalidate.includes("prepared.parsers[storedName]"));
check("bootstrap-state-fail-closed", bootstrapRead.includes("response.status >= 500")
  && worker.includes("Object.keys(value).length !== COORDINATOR_KEYS.length")
  && worker.includes('record.status === "EMPTY" && !emptyFacts(record)'));
check("append-body-closed", !appendParser.includes("fault"));

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log("g145 conditional commit guard passed");
