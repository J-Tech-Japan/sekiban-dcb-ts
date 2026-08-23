#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const PIN = "855feaa93564fef54defec76e9ccff969d4ee01a";
const root = process.cwd();
const project = resolve(root, "tools/sekiban-parity/SekibanParity.csproj");
const manifest = JSON.parse(readFileSync(resolve(root, "contracts/event-store-ddl.json"), "utf8"));

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function fail(message) {
  throw new Error(`sekiban-parity: ${message}`);
}

function sourceDirectory() {
  const positional = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  const source = positional ?? process.env.SEKIBAN_SOURCE_DIR;
  if (typeof source === "string" && source.length > 0) return { path: resolve(source), temporary: false };
  const parent = mkdtempSync(`${tmpdir()}/sekiban-source-`);
  const path = resolve(parent, "Sekiban");
  try {
    run("git", ["clone", "--filter=blob:none", "https://github.com/J-Tech-Japan/Sekiban.git", path]);
    run("git", ["-C", path, "checkout", "--detach", PIN]);
  } catch (error) {
    rmSync(parent, { recursive: true, force: true });
    throw error;
  }
  return { path, temporary: true, parent };
}

function assertPin(source) {
  const resolved = run("git", ["-C", source, "rev-parse", "HEAD"]).trim();
  if (resolved !== PIN) fail(`pinned Sekiban SHA mismatch: expected ${PIN}, received ${resolved}`);
}

function csharpArguments(source, command, ...args) {
  return [
    "run",
    "--no-build",
    "--project",
    project,
    `-p:SekibanSourceRoot=${source}`,
    "--",
    command,
    ...args,
  ];
}

function buildCsharpRunner(source) {
  // The pinned Sekiban projects can emit compiler warnings.  Build them once
  // outside the JSON transport, then run the parity program without rebuilding
  // so C# -> TS has a single, machine-readable stdout artifact.
  run("dotnet", [
    "build",
    project,
    "--nologo",
    `-p:SekibanSourceRoot=${source}`,
  ]);
}

function csharpArtifact(source) {
  const parsed = JSON.parse(run("dotnet", csharpArguments(source, "produce")));
  if (
    typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
    typeof parsed.postgres !== "object" || parsed.postgres === null || Array.isArray(parsed.postgres) ||
    typeof parsed.cosmos !== "object" || parsed.cosmos === null || Array.isArray(parsed.cosmos) ||
    typeof parsed.serializable !== "object" || parsed.serializable === null || Array.isArray(parsed.serializable)
  ) {
    fail("actual C# serializer/provider artifact had an invalid shape");
  }
  return parsed;
}

function actualTsProviderRows(artifact) {
  const encodedArtifact = Buffer.from(JSON.stringify(artifact)).toString("base64");
  const output = run("npx", [
    "vitest",
    "run",
    "--config",
    "vitest.config.ts",
    "test/g32-csharp-runtime.spec.ts",
    "--reporter=verbose",
  ], {
    env: { ...process.env, G32_PARITY_ARTIFACT_B64: encodedArtifact },
  });
  const markers = [...output.matchAll(/G32_PARITY_TS_PROVIDER_ROWS=([A-Za-z0-9+/=]+)/g)];
  if (markers.length !== 1) fail(`real TS provider fixture emitted ${markers.length} parity row markers`);
  const decoded = JSON.parse(Buffer.from(markers[0][1], "base64").toString("utf8"));
  if (
    typeof decoded !== "object" || decoded === null || Array.isArray(decoded) ||
    typeof decoded.postgres !== "object" || decoded.postgres === null || Array.isArray(decoded.postgres) ||
    typeof decoded.cosmos !== "object" || decoded.cosmos === null || Array.isArray(decoded.cosmos)
  ) {
    fail("real TS import/replay/list-query fixture emitted invalid provider rows");
  }
  return decoded;
}

function main() {
  if (manifest.authority?.commit !== PIN) fail("DDL manifest pin does not match runner pin");
  const source = sourceDirectory();
  const temporary = mkdtempSync(`${tmpdir()}/sekiban-parity-`);
  try {
    assertPin(source.path);
    buildCsharpRunner(source.path);
    // C# -> TS begins with the actual pinned serializer, DbEvent.FromEvent,
    // and CosmosEvent.FromEvent. The dedicated Worker fixture then performs
    // real TS D1 import/replay/list-query and writes actual D1/Cosmos rows.
    const artifact = csharpArtifact(source.path);
    const rows = actualTsProviderRows(artifact);

    // TS -> C# consumes those actual provider rows through the pinned model
    // methods, never through JsonDocument or a parallel logical record.
    const postgresPath = resolve(temporary, "actual-ts-postgres-row.json");
    const cosmosPath = resolve(temporary, "actual-ts-cosmos-row.json");
    writeFileSync(postgresPath, JSON.stringify(rows.postgres));
    writeFileSync(cosmosPath, JSON.stringify(rows.cosmos));
    run("dotnet", csharpArguments(source.path, "consume-postgres", postgresPath));
    run("dotnet", csharpArguments(source.path, "consume-cosmos", cosmosPath));

    process.stdout.write(`${JSON.stringify({
      pin: PIN,
      directions: ["csharp-serialization-provider-to-ts-import-replay-list-query", "ts-provider-row-to-csharp-provider-model"],
      manifestAuthority: manifest.authority.commit,
      providers: ["DbEvent", "CosmosEvent"],
    })}\n`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    if (source.temporary && source.parent !== undefined && existsSync(source.parent)) {
      rmSync(source.parent, { recursive: true, force: true });
    }
  }
}

main();
