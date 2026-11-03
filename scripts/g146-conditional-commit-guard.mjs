#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : process.cwd());
const read = (path) => readFileSync(resolve(root, path), "utf8");

const core = read("packages/dcb-core/src/conditionalCommit.ts");
const worker = read("packages/dcb-runtime/src/commit/ConditionalCommitWorker.ts");
const ordinary = read("packages/dcb-runtime/src/index.ts");
const cloudflare = read("packages/dcb-runtime/src/cloudflare.ts");
const compose = read("packages/dcb-cloudflare/src/compose.ts");
const deploy = read("packages/create-dcb/template/scripts/deploy-check.mjs");
const client = read("packages/dcb-client/src/index.ts");
const executor = read("packages/dcb-client/src/executor.ts");
const conditional = read("packages/dcb-client/src/conditionalCommit.ts");
const e2e = read("test/conditional-commit-e2e.spec.ts");
const postgres = read("test/conditional-commit-postgres.spec.ts");
const packed = read("scripts/g74-packed-consumer-check.mjs");
const matched = read("scripts/dcb-matched-set-consumer-check.mjs");
const diff = read("contracts/g74-diff-items.json");
const routed = read("contracts/g74-routed-items.json");
const baseline = read("contracts/g74-surface-baseline.json");
const architecture = read("docs/architecture.md");
const writePath = read("docs/write-path.md");
const facade = read("docs/executor-facade.md");
const cloudflareReadme = read("packages/dcb-cloudflare/README.md");

function slice(source, start, end) {
  const from = source.indexOf(start);
  const to = from < 0 ? -1 : source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) return "";
  return source.slice(from, to);
}

function quotedPaths(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) return [];
  const end = source.indexOf("]", start);
  return [...source.slice(start, end).matchAll(/"(\/[^"]+)"/g)].map((match) => match[1]);
}

function conditionalBranch(source) {
  const marker = 'if (url.pathname === "/api/sekiban/serialized/conditional-commit")';
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const end = source.indexOf("\n      if (", start + marker.length);
  return end < 0 ? source.slice(start) : source.slice(start, end);
}

const failures = [];
function check(name, ok) {
  if (!ok) failures.push(name);
}

const composed = quotedPaths(compose, "export const SERIALIZED_PATHS");
const deployed = quotedPaths(deploy, "const serializedRoutePaths");
const member = slice(client, "async conditionalCommit(", "private async readResponse");
const transportMember = slice(executor, "conditionalCommit: (request:", "query:");
const commitFn = slice(executor, "const commitPrepared:", "const readStateWith");
const forbidden = [
  "Dormant conditional-commit",
  "Built-in transports do not send this protocol",
  "No public route calls the conditional method",
];

check("dormant-header", !forbidden.some((phrase) => core.includes(phrase) || worker.includes(phrase)));
check("ordinary-public-branch", conditionalBranch(ordinary).includes("conditionalExecutor.handleConditionalCommit("));
check("d1-public-branch", conditionalBranch(cloudflare).includes("conditionalExecutor.handleConditionalCommit("));
check("exact-path-prefix", ordinary.includes('url.pathname === "/api/sekiban/serialized/conditional-commit"')
  && cloudflare.includes('url.pathname === "/api/sekiban/serialized/conditional-commit"')
  && !ordinary.includes('pathname.startsWith("/api/sekiban/serialized/conditional-commit"')
  && !cloudflare.includes('pathname.startsWith("/api/sekiban/serialized/conditional-commit"'));
check("v1-routing", [ordinary, cloudflare].every((source) => {
  const branch = conditionalBranch(source);
  return branch.includes("handleConditionalCommit(") && !branch.includes("handleSerializedCommit(");
}));
check("private-path-exposure", composed.every((path) => !path.includes("__internal")));
check("six-path-agreement", composed.length === 6
  && composed.join("\n") === deployed.join("\n")
  && composed.includes("/api/sekiban/serialized/conditional-commit"));
check("missing-builtin-member", member.startsWith("async conditionalCommit(") && transportMember.includes("conditionalCommit:"));
check("wrong-path", member.includes("/api/sekiban/serialized/conditional-commit`")
  && transportMember.includes('"/api/sekiban/serialized/conditional-commit"'));
check("wrong-method", member.includes('method: "POST"'));
check("broad-404", conditional.includes("if (result.status !== 404) return result;"));
check("parser-owned-by-dispatcher", conditional.split("parseConditionalCommitHttpResult(").length - 1 === 2
  && !client.includes("parseConditionalCommitHttpResult")
  && !executor.includes("parseConditionalCommitHttpResult"));
check("facade-signatures", executor.includes("prepareConditionalCommit<T extends JsonValue>(")
  && executor.includes("commitPreparedConditionally("));
check("prepared-rebuild", commitFn.includes("return commitPreparedConditionallyThroughTransport(")
  && !commitFn.includes("prepareConditionalCommit("));
check("automatic-retry", commitFn.length > 0 && !commitFn.includes("for (") && !commitFn.includes("while ("));
check("v1-fallback", commitFn.length > 0 && !commitFn.includes("transport.commit"));
check("missing-scope-check", commitFn.includes("assertScope()"));
check("duplicate-visibility", e2e.includes('expect(globalEvents, "one global event").toHaveLength(1);')
  && postgres.includes('expect(stored, "one postgres event").toHaveLength(1);'));
check("non-uuidv7", e2e.includes("isUuidV7(winnerId)"));
check("missing-export-evidence", diff.includes('"id": "@sekiban/dcb-client::SerializedDcbTransport"')
  && routed.includes('"key": "conditional-commit-activation-members"')
  && packed.includes("executor.commitPreparedConditionally")
  && matched.includes("executor.commitPreparedConditionally")
  && packed.includes("createHttpTransport")
  && packed.includes("createInProcessTransport")
  && matched.includes("createHttpTransport")
  && matched.includes("createInProcessTransport")
  && baseline.includes("commitPreparedConditionally"));
check("compensating-event-runbook", [architecture, writePath, facade].every((text) => text.includes("Append a new ordinary compensating event with an explicit causal link.")));
check("six-path-readme", cloudflareReadme.includes("six serialized paths")
  && cloudflareReadme.includes("six-path default")
  && (cloudflareReadme.match(/POST \/api\/sekiban\/serialized\/conditional-commit/g) ?? []).length >= 2);

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log("g146 conditional commit guard passed");
