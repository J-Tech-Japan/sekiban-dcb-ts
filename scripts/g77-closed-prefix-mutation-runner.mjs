#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = {
  allocator: path.join(root, "packages/dcb-runtime/src/allocator/AllocatorDurableObject.ts"),
  ledger: path.join(root, "packages/dcb-runtime/src/allocator/IssuanceLedger.ts"),
};
const sources = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, readFileSync(file, "utf8")]));

const mutants = [
  {
    name: "registration-removed",
    file: "allocator",
    from: "await registerIssuanceInTransaction(txn, {",
    to: "void ({ // mutant: registration removed",
  },
  {
    name: "single-tag-resolved-early",
    file: "ledger",
    from: "if (!resolved) return { candidateResolved: false, duplicate: false };",
    to: "if (!resolved) return { candidateResolved: true, duplicate: false };",
  },
  {
    name: "expired-writer-accepted",
    file: "ledger",
    from: 'if (target.status !== "pending") {',
    to: 'if (target.status !== "pending" || evidence.terminalStatus === "absent-and-irrevocably-fenced") {',
  },
  {
    name: "wrong-prefix-watermark",
    file: "ledger",
    from: "return { closedPrefixSuid: allocatedWatermark, unresolvedCount: 0, status: \"ready\" };",
    to: "return { closedPrefixSuid: allocatedWatermark, unresolvedCount: 0, status: \"ready\" }; // mutant anchor",
  },
];

function restore() {
  for (const [key, file] of Object.entries(files)) {
    writeFileSync(file, sources[key], "utf8");
  }
}

if (process.argv.includes("--self-test")) {
  for (const mutant of mutants) {
    if (!sources[mutant.file].includes(mutant.from)) {
      console.error(`self-test failed: anchor missing for ${mutant.name}`);
      process.exit(1);
    }
  }
  console.log("g77-closed-prefix-mutation-runner self-test ok");
  process.exit(0);
}

const results = [];
for (const mutant of mutants) {
  const file = files[mutant.file];
  const original = sources[mutant.file];
  if (!original.includes(mutant.from)) {
    results.push({ mutant: mutant.name, status: "skipped", reason: "anchor not found" });
    continue;
  }
  writeFileSync(file, original.replace(mutant.from, mutant.to), "utf8");
  spawnSync("npx", ["esbuild", "src/cloudflare.ts", "--bundle", "--format=esm", "--platform=neutral", "--external:cloudflare:workers", "--outfile=dist/cloudflare.js"], {
    cwd: path.join(root, "packages/dcb-runtime"),
    encoding: "utf8",
  });
  spawnSync("npx", ["esbuild", "src/index.ts", "--bundle", "--format=esm", "--platform=neutral", "--external:postgres", "--external:cloudflare:workers", "--outfile=dist/index.js"], {
    cwd: path.join(root, "packages/dcb-runtime"),
    encoding: "utf8",
  });
  const run = spawnSync("npx", ["vitest", "run", "--config", "vitest.config.ts", "test/allocator.spec.ts", "-t", "G77"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` },
  });
  restore();
  results.push({
    mutant: mutant.name,
    status: run.status === 0 ? "unexpected-green" : "red",
    exitCode: run.status,
  });
}

console.log(JSON.stringify({ mutants: results }, null, 2));
const unexpected = results.filter((entry) => entry.status === "unexpected-green");
process.exit(unexpected.length === 0 ? 0 : 1);
