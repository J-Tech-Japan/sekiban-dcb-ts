#!/usr/bin/env node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guard = join(root, "scripts/g146-conditional-commit-guard.mjs");
const files = {
  core: "packages/dcb-core/src/conditionalCommit.ts",
  worker: "packages/dcb-runtime/src/commit/ConditionalCommitWorker.ts",
  ordinary: "packages/dcb-runtime/src/index.ts",
  cloudflare: "packages/dcb-runtime/src/cloudflare.ts",
  compose: "packages/dcb-cloudflare/src/compose.ts",
  deploy: "packages/create-dcb/template/scripts/deploy-check.mjs",
  client: "packages/dcb-client/src/index.ts",
  executor: "packages/dcb-client/src/executor.ts",
  conditional: "packages/dcb-client/src/conditionalCommit.ts",
  e2e: "test/conditional-commit-e2e.spec.ts",
  postgres: "test/conditional-commit-postgres.spec.ts",
  packed: "scripts/g74-packed-consumer-check.mjs",
  matched: "scripts/dcb-matched-set-consumer-check.mjs",
  diff: "contracts/g74-diff-items.json",
  routed: "contracts/g74-routed-items.json",
  baseline: "contracts/g74-surface-baseline.json",
  architecture: "docs/architecture.md",
  writePath: "docs/write-path.md",
  facade: "docs/executor-facade.md",
  readme: "packages/dcb-cloudflare/README.md",
};

const branch = `      if (url.pathname === "/api/sekiban/serialized/conditional-commit") {
        return conditionalExecutor.handleConditionalCommit(request, env, {
          registeredEventParsers: registeredEventParsers(options.domain),
          serviceIdentityProvider: serviceIdentity,
        });
      }`;

const mutants = [
  {
    name: "dormant-header",
    file: "core",
    from: `/**
 * Conditional-commit wire values and deterministic helpers for the public
 * versioned conditional-commit route.
 */`,
    to: `/**
 * Dormant conditional-commit wire values.
 */`,
  },
  {
    name: "dormant-header",
    file: "worker",
    from: `/**
 * Conditional-commit write executor for the public versioned route.
 * Provider capability remains a composition fact.
 */`,
    to: `/**
 * No public route calls the conditional method.
 */`,
  },
  { name: "ordinary-public-branch", file: "ordinary", from: branch, to: "" },
  { name: "d1-public-branch", file: "cloudflare", from: branch, to: "" },
  {
    name: "exact-path-prefix",
    file: "ordinary",
    from: 'url.pathname === "/api/sekiban/serialized/conditional-commit"',
    to: 'url.pathname.startsWith("/api/sekiban/serialized/conditional-commit")',
  },
  {
    name: "v1-routing",
    file: "ordinary",
    from: "return conditionalExecutor.handleConditionalCommit(request, env, {",
    to: "return conditionalExecutor.handleSerializedCommit(request, env, {",
  },
  {
    name: "private-path-exposure",
    file: "compose",
    from: '"/api/sekiban/serialized/conditional-commit",',
    to: '"/api/sekiban/serialized/conditional-commit",\n  "/__internal/conditional/append",',
  },
  {
    name: "missing-builtin-member",
    file: "client",
    from: "async conditionalCommit(",
    to: "async conditionalCommitDisabled(",
  },
  {
    name: "wrong-path",
    file: "client",
    from: '`${this.baseUrl}/api/sekiban/serialized/conditional-commit`',
    to: '`${this.baseUrl}/api/sekiban/serialized/conditional-commit-disabled`',
  },
  {
    name: "wrong-method",
    file: "client",
    from: '`${this.baseUrl}/api/sekiban/serialized/conditional-commit`, {\n      method: "POST",',
    to: '`${this.baseUrl}/api/sekiban/serialized/conditional-commit`, {\n      method: "PUT",',
  },
  {
    name: "broad-404",
    file: "conditional",
    from: "if (result.status !== 404) return result;",
    to: "if (result.status < 400) return result;",
  },
  {
    name: "prepared-rebuild",
    file: "executor",
    from: "    assertScope();\n    return commitPreparedConditionallyThroughTransport(transport, request, conditionalOptions);",
    to: "    assertScope();\n    prepareConditionalCommit(request as never);\n    return commitPreparedConditionallyThroughTransport(transport, request, conditionalOptions);",
  },
  {
    name: "automatic-retry",
    file: "executor",
    from: "    assertScope();\n    return commitPreparedConditionallyThroughTransport(transport, request, conditionalOptions);",
    to: "    assertScope();\n    for (let attempt = 0; attempt < 2; attempt += 1) {\n      return commitPreparedConditionallyThroughTransport(transport, request, conditionalOptions);\n    }\n    return commitPreparedConditionallyThroughTransport(transport, request, conditionalOptions);",
  },
  {
    name: "v1-fallback",
    file: "executor",
    from: "    assertScope();\n    return commitPreparedConditionallyThroughTransport(transport, request, conditionalOptions);",
    to: "    assertScope();\n    await transport.commit({ candidates: [], consistency: [] });\n    return commitPreparedConditionallyThroughTransport(transport, request, conditionalOptions);",
  },
  {
    name: "missing-scope-check",
    file: "executor",
    from: "  const commitPrepared: SekibanExecutor[\"commitPreparedConditionally\"] = async (request, conditionalOptions) => {\n    assertScope();\n    return commitPreparedConditionallyThroughTransport(transport, request, conditionalOptions);\n  };",
    to: "  const commitPrepared: SekibanExecutor[\"commitPreparedConditionally\"] = async (request, conditionalOptions) => {\n    return commitPreparedConditionallyThroughTransport(transport, request, conditionalOptions);\n  };",
  },
  {
    name: "duplicate-visibility",
    file: "e2e",
    from: 'expect(globalEvents, "one global event").toHaveLength(1);',
    to: 'expect(globalEvents, "one global event").toHaveLength(2);',
  },
  {
    name: "non-uuidv7",
    file: "e2e",
    from: "isUuidV7(winnerId)",
    to: 'typeof winnerId === "string"',
  },
  {
    name: "missing-export-evidence",
    file: "packed",
    from: "await executor.commitPreparedConditionally(held);",
    to: "await Promise.resolve(held);",
  },
  {
    name: "compensating-event-runbook",
    file: "architecture",
    from: "Append a new ordinary compensating event with an explicit causal link.",
    to: "Record the contradiction and close the incident.",
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
  console.log("g146 mutation anchors passed");
  process.exit(0);
}

const clean = mkdtempSync(join(tmpdir(), "g146-clean-"));
try {
  copyTree(clean);
  const baseline = runGuard(clean);
  if (baseline.status !== 0) {
    console.error(baseline.stdout);
    console.error(baseline.stderr);
    throw new Error("guard failed on the unmodified sources");
  }
  for (const mutant of mutants) {
    const directory = mkdtempSync(join(tmpdir(), "g146-mutant-"));
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
console.log("g146 conditional commit mutation runner passed");
