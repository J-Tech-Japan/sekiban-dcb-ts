#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import postgres from "postgres";

const PIN = "855feaa93564fef54defec76e9ccff969d4ee01a";
const root = process.cwd();
const project = resolve(root, "tools/sekiban-live/SekibanLive.csproj");
const manifestPath = resolve(root, "contracts/event-store-ddl.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const ddlDigest = createHash("sha256").update(readFileSync(manifestPath)).digest("hex");

function fail(message) {
  throw new Error(`g33-live-cross: ${message}`);
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`${command} exited ${code}: ${stderr}`));
      else resolvePromise({ stdout, stderr });
    });
  });
}

export function assertPin(actual) {
  if (actual !== PIN) fail(`pinned Sekiban SHA mismatch: expected ${PIN}, received ${actual}`);
  if (manifest.authority?.commit !== PIN) fail("DDL manifest pin does not match runner pin");
}

export function assertExpectation(envelope) {
  if (envelope?.semanticGeneration !== "post-SDT-G36") fail("semantic-generation");
  if (envelope?.ddlDigest !== ddlDigest) fail("ddl-digest");
}

export function assertNoDerivedMembership(rows) {
  for (const row of rows) {
    if (row.committedMembership !== undefined || row.provenance !== undefined || row.allocatorLineageId !== undefined) {
      fail("invented-field");
    }
  }
}

async function loadAllocator() {
  mkdirSync(resolve(root, ".artifacts"), { recursive: true });
  const bundle = resolve(root, ".artifacts/g33-allocator.mjs");
  await run(resolve(root, "node_modules/.bin/esbuild"), [
    "scripts/g33-allocator-host.ts",
    "--bundle",
    "--format=esm",
    "--platform=node",
    `--outfile=${bundle}`,
  ]);
  return import(`${pathToFileURL(bundle).href}?${Date.now()}`);
}

async function allocatorPost(allocator, path, body) {
  const response = await allocator.fetch(new Request(`https://allocator.g33${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() };
}

async function proveAllocator(storeMax) {
  const { openAllocator } = await loadAllocator();
  const allocator = openAllocator();
  const probes = [];
  const early = await allocatorPost(allocator, "/allocate", {
    attemptId: `before-${randomUUID()}`,
    requiresImportSeed: true,
    candidates: [{ candidateIndex: 0, eventId: randomUUID() }],
  });
  probes.push(early.status === 409 && early.body.code === "allocator_seed_required" ? "seed-required" : "seed-required-miss");
  const below = await allocatorPost(allocator, "/seed-after", {
    importId: "g33",
    leaseEpoch: 1,
    highWatermark: "0".repeat(30),
    storeMaximum: storeMax,
  });
  probes.push(below.status === 409 && below.body.code === "allocator_seed_below_store_max" ? "seed-below-max" : "seed-below-max-miss");
  const seed = { importId: "g33", leaseEpoch: 1, highWatermark: storeMax, storeMaximum: storeMax };
  const seeded = await allocatorPost(allocator, "/seed-after", seed);
  const idempotent = await allocatorPost(allocator, "/seed-after", seed);
  const rejected = await allocatorPost(allocator, "/seed-after", { ...seed, importId: "g33-other" });
  probes.push(rejected.status === 409 && rejected.body.code === "allocator_seed_rejected" ? "seed-rejected" : "seed-rejected-miss");
  if (seeded.status !== 201 || idempotent.status !== 200 || probes.join() !== "seed-required,seed-below-max,seed-rejected") {
    fail(`allocator seed ${seeded.status}/${idempotent.status} ${probes.join()}`);
  }
  const allocated = await allocatorPost(allocator, "/allocate", {
    attemptId: `after-${randomUUID()}`,
    requiresImportSeed: true,
    candidates: [{ candidateIndex: 0, eventId: randomUUID() }],
  });
  const next = allocated.body?.candidates?.[0]?.suid;
  if (allocated.status !== 201 || typeof next !== "string" || !(next > storeMax)) fail("suid-not-greater");
  return { probes, next };
}

const writers = new Set();

export function reserveWriter(child) {
  for (const current of writers) {
    if (current.exitCode === null && current.signalCode === null) fail("writer-still-alive");
  }
  writers.add(child);
  return child;
}

function releaseWriter(child) {
  writers.delete(child);
}

function providerMatches(actual, expected) {
  const fields = ["serviceId", "id", "sortableUniqueId", "eventType", "payload", "tags", "causationId", "correlationId", "executedUser"];
  for (const key of Object.keys(actual)) {
    if (!fields.includes(key)) fail(`invented-field:${key}`);
  }
  for (const field of fields) {
    if (field === "payload") {
      if (JSON.stringify(JSON.parse(actual.payload)) !== JSON.stringify(JSON.parse(expected.payload))) fail("provider-payload");
      continue;
    }
    if (field === "tags") {
      if (JSON.stringify(actual.tags) !== JSON.stringify(expected.tags)) fail("provider-tags");
      continue;
    }
    if (actual[field] !== expected[field]) fail(`provider-${field}`);
  }
}

function logicalEqual(actual, expected) {
  const fields = manifest.logicalRecord.fields.map((field) => field.id);
  if (Object.keys(actual).sort().join() !== [...fields].sort().join()) fail("logical-field-set");
  for (const field of fields) {
    if (field === "timestamp") {
      if (Date.parse(actual.timestamp) !== Date.parse(expected.timestamp)) fail("timestamp");
      continue;
    }
    if (field === "payload") {
      if (JSON.stringify(JSON.parse(actual.payload)) !== JSON.stringify(JSON.parse(expected.payload))) fail("payload");
      continue;
    }
    if (field === "tags") {
      if (JSON.stringify(actual.tags) !== JSON.stringify(expected.tags)) fail("tags");
      continue;
    }
    if (actual[field] !== expected[field]) fail(field);
  }
}

function sourceDirectory() {
  return resolve(process.env.SEKIBAN_SOURCE_DIR ?? resolve(root, ".artifacts/g33-sekiban-source"));
}

async function pinOf(source) {
  const { stdout } = await run("git", ["-C", source, "rev-parse", "HEAD"]);
  return stdout.trim();
}

function npgsqlConnectionString(databaseUrl) {
  const url = new URL(databaseUrl);
  const database = url.pathname.replace(/^\//, "");
  const port = url.port.length === 0 ? "5432" : url.port;
  return `Host=${url.hostname};Port=${port};Username=${decodeURIComponent(url.username)};Password=${decodeURIComponent(url.password)};Database=${database}`;
}

function adminUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

async function createDatabase(databaseUrl) {
  const name = `sdt_g33_${randomBytes(4).toString("hex")}`;
  const sql = postgres(adminUrl(databaseUrl), { max: 1, fetch_types: false });
  try {
    await sql.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await sql.end({ timeout: 1 });
  }
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return { name, url: url.toString() };
}

async function dropDatabase(databaseUrl, name) {
  const sql = postgres(adminUrl(databaseUrl), { max: 1, fetch_types: false });
  try {
    await sql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await sql.end({ timeout: 1 });
  }
}

async function dotnet(source, args) {
  return run("dotnet", [
    "run",
    "--no-build",
    "--project",
    project,
    `-p:SekibanSourceRoot=${source}`,
    "--",
    ...args,
  ]);
}

function spawnLive(source, command, connection, serviceId) {
  const token = { exitCode: null, signalCode: null };
  reserveWriter(token);
  const child = spawn("dotnet", [
    "run",
    "--no-build",
    "--project",
    project,
    `-p:SekibanSourceRoot=${source}`,
    "--",
    command,
    connection,
    serviceId,
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  releaseWriter(token);
  writers.add(child);
  child.on("close", () => releaseWriter(child));
  return child;
}

async function runSelfTest() {
  assertPin(PIN);
  let pinFailed = false;
  try { assertPin("0".repeat(40)); } catch (error) { pinFailed = String(error.message).includes("SHA mismatch"); }
  if (!pinFailed) fail("pin mismatch did not fail");
  let untagged = false;
  try { assertExpectation({ ddlDigest }); } catch (error) { untagged = String(error.message).includes("semantic-generation"); }
  if (!untagged) fail("untagged expectation did not fail");
  assertExpectation({ semanticGeneration: "post-SDT-G36", ddlDigest });
  let derived = false;
  try { assertNoDerivedMembership([{ committedMembership: ["room:g33"] }]); } catch (error) { derived = String(error.message).includes("invented-field"); }
  if (!derived) fail("derived membership did not fail");
  assertNoDerivedMembership([{ serviceId: "g33" }]);
  const proved = await proveAllocator("1".repeat(30));
  if (!(proved.next > "1".repeat(30))) fail("next suid");
  const busy = { exitCode: null, signalCode: null };
  reserveWriter(busy);
  let refused = false;
  try { reserveWriter({ exitCode: null, signalCode: null }); } catch (error) { refused = String(error.message).includes("writer-still-alive"); }
  releaseWriter(busy);
  if (!refused) fail("overlapping writer was accepted");
  process.stdout.write(`${JSON.stringify({ result: "g33-live-cross-self-test-passed", semanticGeneration: "post-SDT-G36", ddlDigest })}\n`);
}

async function check() {
  const databaseUrl = process.env.POSTGRES_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/serialized_dcb";
  const source = sourceDirectory();
  assertPin(await pinOf(source));
  let database;
  try {
    database = await createDatabase(databaseUrl);
  } catch (error) {
    fail(`missing database: ${error.message}`);
  }
  const serviceId = `g33${randomBytes(4).toString("hex")}`;
  try {
    await run("dotnet", ["build", project, "--nologo", `-p:SekibanSourceRoot=${source}`, "-p:GeneratePackageOnBuild=false", "-p:TreatWarningsAsErrors=false"]);
    const csharp = npgsqlConnectionString(database.url);
    const wrote = JSON.parse((await dotnet(source, ["write", csharp, serviceId])).stdout);
    if (wrote.generator !== "process-shared") fail("write generator");
    mkdirSync(resolve(root, ".artifacts"), { recursive: true });
    const bundle = resolve(root, ".artifacts/g33-provider.mjs");
    await run(resolve(root, "node_modules/.bin/esbuild"), [
      "packages/dcb-runtime/src/store/PostgresEventStore.ts",
      "--bundle",
      "--format=esm",
      "--platform=node",
      "--external:postgres",
      `--outfile=${bundle}`,
    ]);
    const { PostgresEventStore } = await import(`${pathToFileURL(bundle).href}?${Date.now()}`);
    const store = new PostgresEventStore(database.url);
    await store.initialize();
    const imported = await store.readLogicalEvents(serviceId);
    assertNoDerivedMembership(imported);
    if (imported.length !== 1) fail(`expected one C# row, received ${imported.length}`);
    logicalEqual(imported[0], wrote.event);
    const storeMax = imported[0].sortableUniqueId;
    const proved = await proveAllocator(storeMax);
    const next = proved.next;
    const tsEvent = {
      ...imported[0],
      id: randomUUID(),
      sortableUniqueId: next,
      timestamp: new Date().toISOString(),
    };
    await store.appendLogicalEvent(tsEvent);
    const hold = spawnLive(source, "hold", csharp, `${serviceId}h`);
    let refused = false;
    try { spawnLive(source, "write", csharp, `${serviceId}x`); } catch (error) { refused = String(error.message).includes("writer-still-alive"); }
    hold.kill("SIGTERM");
    await new Promise((resolvePromise) => hold.on("close", resolvePromise));
    if (!refused) fail("live overlap");
    const read = JSON.parse((await dotnet(source, ["read", csharp, serviceId])).stdout);
    if (read.pid === wrote.pid) fail("reused C# process");
    if (read.generator !== "process-shared") fail("read generator");
    const stored = await store.readLogicalEvents(serviceId);
    if (read.events.length !== stored.length) fail("provider-count");
    read.events.forEach((event, index) => providerMatches(event, stored[index]));
    if (read.events.map((row) => row.sortableUniqueId).join() !== [imported[0].sortableUniqueId, next].join()) fail("order");
    assertExpectation({ semanticGeneration: "post-SDT-G36", ddlDigest });
    await store.close();
    const result = {
      result: "g33-live-cross-passed",
      semanticGeneration: "post-SDT-G36",
      ddlDigest,
      generator: wrote.generator,
      writePid: wrote.pid,
      readPid: read.pid,
      imported: imported.length,
      probes: proved.probes,
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await dropDatabase(databaseUrl, database.name);
  }
}

const entry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (entry) {
  const mode = process.argv.includes("--self-test") ? "self-test" : process.argv.includes("--check") ? "check" : "";
  const task = mode === "self-test" ? Promise.resolve(runSelfTest()) : mode === "check" ? check() : Promise.reject(new Error("usage: --self-test | --check"));
  task.catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
