#!/usr/bin/env node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guard = join(root, "scripts/g145-conditional-commit-guard.mjs");
const files = {
  worker: "packages/dcb-runtime/src/commit/ConditionalCommitWorker.ts",
  receipt: "packages/dcb-runtime/src/tag/TagConditionalReceipt.ts",
  tag: "packages/dcb-runtime/src/tag/TagDurableObject.ts",
  ordinary: "packages/dcb-runtime/src/index.ts",
  cloudflare: "packages/dcb-runtime/src/cloudflare.ts",
  client: "packages/dcb-client/src/index.ts",
  executor: "packages/dcb-client/src/executor.ts",
};

const mutants = [
  {
    name: "terminal-before-allocation",
    file: "worker",
    from: "const resolved = await this.resolveConditionalTag(env, prepared, hooks);",
    to: "const allocatedEarly = await this.allocateConditional(env, prepared, \"early\", \"early\", 0);\n    const resolved = await this.resolveConditionalTag(env, prepared, hooks); void allocatedEarly;",
  },
  {
    name: "terminal-before-append-guards",
    file: "tag",
    from: `        const terminal = await readConditionalTerminal(sql, {
          serviceId: conditional.serviceId,
          tag,
          normalizedKey: conditional.normalizedKey,
        });`,
    to: `        const terminal = await skippedConditionalTerminal(sql, {
          serviceId: conditional.serviceId,
          tag,
          normalizedKey: conditional.normalizedKey,
        });`,
  },
  {
    name: "receipt-inside-existing-transaction",
    file: "tag",
    from: "this.writeCommittedSqlEvent(sql, serviceId, event);",
    to: "insertConditionalReceipt(sql, receiptValues);\n        this.writeCommittedSqlEvent(sql, serviceId, event);",
  },
  {
    name: "receipt-inside-existing-transaction",
    file: "tag",
    from: "insertConditionalReceipt(sql, receiptValues);",
    to: "void receiptValues;",
  },
  {
    name: "receipt-key-exact",
    file: "receipt",
    from: "PRIMARY KEY (service_id, normalized_key)",
    to: "PRIMARY KEY (service_id)",
  },
  {
    name: "receipt-event-unique-exact",
    file: "receipt",
    from: "UNIQUE (service_id, event_id)",
    to: "UNIQUE (event_id)",
  },
  {
    name: "schema-fail-closed",
    file: "receipt",
    from: "throw new ConditionalReceiptUnsupported(\"conditional receipt columns\")",
    to: "return",
  },
  {
    name: "import-old-tag-fail-closed",
    file: "receipt",
    from: 'marker === 0 ? { kind: "absent" } : { kind: "unsupported" }',
    to: '{ kind: "absent" }',
  },
  {
    name: "import-old-tag-fail-closed",
    file: "worker",
    from: "if (response.status === 404) return unsupportedResponse();",
    to: "if (response.status === 404) return json({ version: 1, outcome: \"Appended\" }, 201);",
  },
  {
    name: "no-v1-fallback",
    file: "worker",
    from: "return this.tagStub(env, prepared.serviceId, prepared.tag).fetch(new Request(url, {",
    to: "return this.tagStub(env, prepared.serviceId, prepared.tag).fetch(new Request(\"/append\", {",
  },
  {
    name: "generic-internal-prefix-denied",
    file: "ordinary",
    from: 'tagMatch[3]?.startsWith("/__internal/")',
    to: 'tagMatch[3]?.startsWith("/__internal/g46/")',
  },
  {
    name: "corruption-not-success",
    file: "worker",
    from: "if (response.status === 500) return corruptResponse();",
    to: "if (response.status === 500) return json({ version: 1, outcome: \"Appended\" }, 201);",
  },
  {
    name: "provider-capability-not-name",
    file: "worker",
    from: "const capability = input.storeProvider === undefined ? mintCapability() : undefined;",
    to: "const capability = input.storeProvider === undefined || input.storeProvider.name === \"postgres\" ? mintCapability() : undefined;",
  },
  {
    name: "provider-capability-before-tag",
    file: "worker",
    from: "if (!this.capabilityAuthorizes()) return unsupportedResponse();\n    const resolved = await this.resolveConditionalTag(env, prepared, hooks);",
    to: "const resolved = await this.resolveConditionalTag(env, prepared, hooks);\n    if (!this.capabilityAuthorizes()) return unsupportedResponse();",
  },
  {
    name: "uniqueness-escapes-transaction",
    file: "receipt",
    from: "throw new ConditionalReceiptUniquenessFault();",
    to: "return;",
  },
  {
    name: "no-public-conditional-route",
    file: "ordinary",
    from: 'if (url.pathname === "/api/sekiban/serialized/commit") {',
    to: 'if (url.pathname === "/api/sekiban/serialized/conditional-commit" || url.pathname === "/api/sekiban/serialized/commit") {',
  },
  {
    name: "no-built-in-conditional-transport",
    file: "executor",
    from: 'commit: (request: CommitEnvelope, signal?: AbortSignal) => call("/api/sekiban/serialized/commit", v1Envelope(request), signal),',
    to: 'commit: (request: CommitEnvelope, signal?: AbortSignal) => call("/api/sekiban/serialized/commit", v1Envelope(request), signal),\n    conditionalCommit: (request: CommitEnvelope, signal?: AbortSignal) => call("/api/sekiban/serialized/conditional-commit", request, signal),',
  },
  {
    name: "stored-event-parser",
    file: "worker",
    from: "const storedParser = prepared.parsers[storedName];",
    to: "const storedParser = prepared.parser(JSON.parse(facts.payload));",
  },
  {
    name: "bootstrap-state-fail-closed",
    file: "worker",
    from: "response.status >= 500",
    to: "true",
  },
  {
    name: "append-body-closed",
    file: "receipt",
    from: "closedKeys(value, APPEND_KEYS)",
    to: "closedKeys(value, APPEND_KEYS, [\"fault\"])",
  },
];

function copyTree(target) {
  for (const relative of Object.values(files)) {
    const destination = join(target, relative);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(join(root, relative)));
  }
}

function runGuard(target) {
  return spawnSync(process.execPath, [guard, "--root", target], { encoding: "utf8" });
}

if (process.argv.includes("--self-test")) {
  for (const mutant of mutants) {
    const source = readFileSync(join(root, files[mutant.file]), "utf8");
    const matches = source.split(mutant.from).length - 1;
    if (matches !== 1) {
      console.error(`anchor ${mutant.name} matched ${matches} times`);
      process.exit(1);
    }
  }
  console.log("g145 mutation anchors passed");
  process.exit(0);
}

const clean = mkdtempSync(join(tmpdir(), "g145-clean-"));
try {
  copyTree(clean);
  const baseline = runGuard(clean);
  if (baseline.status !== 0) {
    console.error(baseline.stdout);
    console.error(baseline.stderr);
    throw new Error("guard failed on the unmodified sources");
  }
  for (const mutant of mutants) {
    const directory = mkdtempSync(join(tmpdir(), "g145-mutant-"));
    try {
      copyTree(directory);
      const path = join(directory, files[mutant.file]);
      const source = readFileSync(path, "utf8");
      if (!source.includes(mutant.from)) throw new Error(`missing anchor for ${mutant.name}`);
      writeFileSync(path, source.replace(mutant.from, mutant.to));
      const result = runGuard(directory);
      const output = `${result.stdout}\n${result.stderr}`;
      if (result.status === 0 || !output.includes(`FAIL ${mutant.name}`)) {
        console.error(output);
        throw new Error(`mutant ${mutant.name} did not fail ${mutant.name}`);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
} finally {
  rmSync(clean, { recursive: true, force: true });
}
console.log("g145 conditional commit mutation runner passed");
