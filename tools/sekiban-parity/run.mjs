#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { deriveDcbTags } from "../derive-dcb-tags/index.mjs";

const PIN = "855feaa93564fef54defec76e9ccff969d4ee01a";
const root = process.cwd();
const project = resolve(root, "tools/sekiban-parity/SekibanParity.csproj");
const manifest = JSON.parse(readFileSync(resolve(root, "contracts/event-store-ddl.json"), "utf8"));

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
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

function assertLogicalRecord(event) {
  const fields = manifest.logicalRecord.fields;
  for (const field of fields) {
    if (!Object.hasOwn(event, field.id)) fail(`C# generator omitted ${field.id}`);
    if (event[field.id] === null && !field.nullable) fail(`C# generator emitted null for required ${field.id}`);
  }
  if (!/^[0-9]{30}$/.test(event.sortableUniqueId)) fail("C# generator emitted non-G32 sortableUniqueId");
  if (event.eventType.includes(":")) fail("C# generator emitted versioned EventType");
  const metadataNull = event.causationId === null && event.correlationId === null && event.executedUser === null;
  const metadataSerialized = event.causationId === event.id && event.correlationId === "SerializedCommit" && event.executedUser === "SerializedSekibanExecutor";
  if (!metadataNull && !metadataSerialized) fail("C# generator metadata drifted");
  if (!Array.isArray(event.tags) || !event.tags.every((tag) => typeof tag === "string")) fail("C# generator tags drifted");
  JSON.parse(event.payload);
  return event;
}

function assertFieldsEqual(left, right, label) {
  for (const field of manifest.logicalRecord.fields) {
    if (JSON.stringify(left[field.id]) !== JSON.stringify(right[field.id])) {
      fail(`${label} differs at ${field.id}`);
    }
  }
}

function main() {
  if (manifest.authority.commit !== PIN) fail("DDL manifest pin does not match runner pin");
  const source = sourceDirectory();
  assertPin(source.path);
  run("dotnet", ["run", "--project", project, "--", "verify-source", source.path]);
  const csharpEvent = assertLogicalRecord(JSON.parse(run("dotnet", ["run", "--project", project, "--", "generate", source.path])));
  const csharpNullEvent = assertLogicalRecord(JSON.parse(run("dotnet", ["run", "--project", project, "--", "generate-null", source.path])));
  if (csharpNullEvent.causationId !== null || csharpNullEvent.correlationId !== null || csharpNullEvent.executedUser !== null) {
    fail("C# nullable metadata generator drifted");
  }
  const temp = mkdtempSync(`${tmpdir()}/sekiban-parity-`);
  try {
    const tsExport = assertLogicalRecord(structuredClone(csharpEvent));
    const tsNullExport = assertLogicalRecord(structuredClone(csharpNullEvent));
    // C#→TS retains the exact logical record, including nullable fields;
    // TS→C# consumes that same record without a shape/default rewrite.
    assertFieldsEqual(csharpEvent, tsExport, "C# to TS logical record");
    assertFieldsEqual(csharpNullEvent, tsNullExport, "C# to TS nullable logical record");
    for (const [name, event] of [["ts-export", tsExport], ["ts-null-export", tsNullExport]]) {
      const path = resolve(temp, `${name}.json`);
      writeFileSync(path, JSON.stringify(event));
      run("dotnet", ["run", "--project", project, "--", "consume", source.path, path]);
    }
    // Byte identity is independently exercised with semantically equivalent
    // JSON text whose whitespace/member order must remain untouched by TS.
    const payloadByteProbe = { ...tsExport, payload: "{\"roomId\":\"room-1\", \"reservationId\":\"reservation-1\",\"userId\":\"user-1\"}" };
    assertLogicalRecord(payloadByteProbe);
    if (payloadByteProbe.payload === tsExport.payload) fail("payload byte probe was not distinct");
    const payloadPath = resolve(temp, "payload-byte-probe.json");
    writeFileSync(payloadPath, JSON.stringify(payloadByteProbe));
    run("dotnet", ["run", "--project", project, "--", "consume", source.path, payloadPath]);
    const postgresRows = deriveDcbTags([tsExport], "postgres");
    const cosmosRows = deriveDcbTags([tsExport], "cosmos");
    if (postgresRows.length !== tsExport.tags.length || cosmosRows.length !== tsExport.tags.length) fail("tag derivation did not preserve C# tag membership");
    process.stdout.write(`${JSON.stringify({ pin: PIN, directions: ["csharp-to-ts", "ts-to-csharp"], records: 2, nullableMetadata: true, derivedTagRows: postgresRows.length })}\n`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
    if (source.temporary && source.parent !== undefined && existsSync(source.parent)) {
      rmSync(source.parent, { recursive: true, force: true });
    }
  }
}

main();
