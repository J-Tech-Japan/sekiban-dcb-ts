#!/usr/bin/env node
/**
 * Release-shaped consumer proof for SDT-G74.  It installs the three packed
 * public packages into a clean directory, compiles them under Node16 and
 * Bundler resolution, and separately checks the declaration graph without
 * skipLibCheck.  Negative files prove exports-map and read-lane boundaries.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageRoots = ["dcb-core", "dcb-domain", "dcb-client"].map((name) => join(root, "packages", name));
const temp = await mkdtemp(join(tmpdir(), "sdt-g74-consumer-"));
const npmCache = process.env.NPM_CONFIG_CACHE ?? join(temp, ".npm-cache");

function run(command, args, cwd = temp, { expectFailure = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NPM_CONFIG_CACHE: npmCache },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      const result = { status, signal, stdout, stderr };
      const success = status === 0 && signal === null;
      if (success === !expectFailure) resolvePromise(result);
      else reject(new Error(`${command} ${args.join(" ")} exited ${status ?? signal}\n${stdout}\n${stderr}`));
    });
  });
}

const positive = `
import {
  assertJsonValue, canonicalEventKey, defineCommand, defineEvent, defineProjector,
  defineTag, done as coreDone, noop, reject,
} from "@sekiban/dcb-core";
import {
  command, domain, done as domainDone, event, eventUnion, none, projector, read, readExists, readSet,
  tagFamily, toRuntimeDomain,
} from "@sekiban/dcb-domain";
import { evolveTable, given } from "@sekiban/dcb-domain/testing";
import {
  createHttpTransport, createInProcessTransport, createSekibanExecutor,
  type ExecuteCommandOptions, type ListQueryOptions, type ReadOptions,
  type RuntimeBindings, type SerializedDcbTransport, type SekibanExecutor,
} from "@sekiban/dcb-client";
import type { JsonValue, CommandDefinition as CoreCommandDefinition, EventDefinition as CoreEventDefinition } from "@sekiban/dcb-core";
import type { PortableSnapshot, Tag } from "@sekiban/dcb-domain";
import { z } from "zod";

const rooms = tagFamily("room");
const opened = event("RoomOpened", z.object({ roomId: z.string() }), {
  tagFamily: rooms,
  tags: (input) => [rooms.of(input.roomId)],
});
const union = eventUnion([opened] as const);
const roomProjector = projector({
  id: "room",
  tag: rooms,
  events: [opened],
  initialState: { status: "empty" as "empty" | "open" },
  handlers: { RoomOpened: (state) => ({ ...state, status: "open" }) },
});
const open = command({
  id: "open",
  input: z.object({ roomId: z.string() }),
  reads: (input) => readSet(read(roomProjector, rooms.of(input.roomId)), readExists(rooms.of(input.roomId))),
  handle: async () => domainDone({ accepted: true }),
});
const authored = domain({ events: [opened], projectors: [roomProjector], commands: [open] });
toRuntimeDomain(authored);
const coreTag = defineTag("room", "one");
const coreEvent = defineEvent("Opened", (value) => value as { readonly roomId: string });
const coreProjector = defineProjector({ id: "core", events: [coreEvent], initialState: {}, handlers: { Opened: (state) => state } });
const coreCommand = defineCommand({ id: "core", input: (value) => value, handler: (_input, context) => context.done() });
const input: JsonValue = assertJsonValue({ ok: true });
const decisions = [coreDone(input), noop("noop"), reject("reject")];
const key = canonicalEventKey("RoomOpened");
const tag: Tag = rooms.of("consumer");
const snapshot: PortableSnapshot = { projectorId: roomProjector.id, tag, head: "head-1", state: {}, exists: false };
const readOptions: ReadOptions = {};
const listOptions: ListQueryOptions = { consistency: "safe" };
const commandOptions: ExecuteCommandOptions = { readMode: "snapshot-only", maxConflictRetries: 1 };
const bindings: RuntimeBindings = {};
const transport: SerializedDcbTransport = {
  readTagState: async () => ({ payload: {}, version: 0, lastSortedUniqueId: "", tagGroup: "room", tagContent: "one", tagProjector: "room" }),
  readTagLatestSortable: async () => ({ exists: false, lastSortableUniqueId: "" }),
  commit: async () => ({ status: 201 }),
  query: async () => ({ resultJson: "{}" }),
  listQuery: async () => ({ itemsJson: "[]", totalCount: 0, totalPages: 0, currentPage: 1, pageSize: 20, readHead: "" }),
};
const executor: SekibanExecutor = createSekibanExecutor(transport);
void [union, coreProjector, coreCommand, decisions, key, snapshot, readOptions, listOptions, commandOptions, bindings, executor, createHttpTransport, createInProcessTransport, input, coreEvent satisfies CoreEventDefinition, coreCommand satisfies CoreCommandDefinition];
console.log("PASS packed consumer surface and inference");
`;

const unsupportedModes = `
import type { ListQueryRequest } from "@sekiban/dcb-client";
import type { SekibanExecutor } from "@sekiban/dcb-client";
declare const executor: SekibanExecutor;
declare const request: ListQueryRequest;
// listQuery owns the consistency lane and these two calls are valid.
await executor.listQuery(request, { consistency: "safe" });
await executor.listQuery(request, { consistency: "unsafe" });
// These are intentionally rejected: only listQuery accepts consistency.
await executor.readState({} as never, {} as never, { consistency: "safe" });
await executor.exists({} as never, { consistency: "unsafe" });
await executor.query({ queryType: "x", queryParamsJson: "{}" }, { consistency: "safe" });
`;

const deepImport = `import { createSekibanExecutor } from "@sekiban/dcb-client/dist/executor.js"; console.log(createSekibanExecutor);\n`;
const runtimeCheck = `
const expected = {
  "@sekiban/dcb-core": ["assertJsonValue", "canonicalEventKey", "defineCommand", "defineEvent", "defineProjector", "defineTag", "done", "noop", "reject"],
  "@sekiban/dcb-domain": ["command", "domain", "event", "eventUnion", "none", "projector", "read", "readExists", "readSet", "tagFamily", "toRuntimeDomain"],
  "@sekiban/dcb-domain/testing": ["evolve", "evolveTable", "given"],
  "@sekiban/dcb-client": ["ClientError", "ClaimLedger", "ClaimLedgerExecutor", "SerializedDcbClient", "createClaimLedgerExecutor", "createHttpTransport", "createInProcessTransport", "createSekibanExecutor", "createSerializedDcbClient", "preflightCommit"],
};
for (const [specifier, names] of Object.entries(expected)) {
  const module = await import(specifier);
  for (const name of names) if (!(name in module)) throw new Error(specifier + " missing runtime export " + name);
}
console.log("PASS packed runtime namespaces");
`;

try {
  await writeFile(join(temp, "package.json"), JSON.stringify({ private: true, type: "module" }, null, 2));
  await mkdir(join(temp, "src"), { recursive: true });
  await mkdir(join(temp, "compile-negative"), { recursive: true });
  await writeFile(join(temp, "tsconfig.node16.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "Node16", moduleResolution: "Node16", strict: true, skipLibCheck: true, outDir: "dist-node16" }, include: ["src/**/*.ts"] }, null, 2));
  await writeFile(join(temp, "tsconfig.bundler.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true, outDir: "dist-bundler" }, include: ["src/**/*.ts"] }, null, 2));
  await writeFile(join(temp, "tsconfig.strict.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "Node16", moduleResolution: "Node16", strict: true, skipLibCheck: false, noEmit: true }, include: ["src/main.ts"] }, null, 2));
  await writeFile(join(temp, "src/main.ts"), positive);
  await writeFile(join(temp, "compile-negative/unsupported-modes.ts"), unsupportedModes);
  await writeFile(join(temp, "compile-negative/deep-import.ts"), deepImport);
  await writeFile(join(temp, "runtime-check.mjs"), runtimeCheck);

  const tarballs = [];
  for (const packageRoot of packageRoots) {
    const packed = JSON.parse((await run("npm", ["pack", "--json", "--pack-destination", temp], packageRoot)).stdout);
    tarballs.push(join(temp, packed[0].filename));
  }
  for (const tarball of tarballs) await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarball]);
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "typescript@5.9.3"]);

  const tsc = join(temp, "node_modules/.bin/tsc");
  const node16 = await run(tsc, ["-p", "tsconfig.node16.json"]);
  const bundler = await run(tsc, ["-p", "tsconfig.bundler.json"]);
  const strict = await run(tsc, ["-p", "tsconfig.strict.json"]);
  const negativeModes = await run(tsc, ["--noEmit", "--target", "ES2022", "--module", "Node16", "--moduleResolution", "Node16", "--strict", "--skipLibCheck", "compile-negative/unsupported-modes.ts"], temp, { expectFailure: true });
  const negativeDeep = await run(tsc, ["--noEmit", "--target", "ES2022", "--module", "Node16", "--moduleResolution", "Node16", "--strict", "--skipLibCheck", "compile-negative/deep-import.ts"], temp, { expectFailure: true });
  const modeText = `${negativeModes.stdout}\n${negativeModes.stderr}`;
  if (!/consistency/.test(modeText)) throw new Error(`unsupported consistency mode did not produce a consistency diagnostic:\n${modeText}`);
  const deepText = `${negativeDeep.stdout}\n${negativeDeep.stderr}`;
  if (!/(not exported|cannot find module|not found|exports)/i.test(deepText)) throw new Error(`deep import did not fail through exports map:\n${deepText}`);
  const runtime = await run(process.execPath, ["runtime-check.mjs"]);
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    proof: "release-shaped-packed-consumer",
    packages: ["@sekiban/dcb-core@0.2.0", "@sekiban/dcb-domain@0.2.0", "@sekiban/dcb-client@0.2.0"],
    compile: {
      node16: { status: node16.status, signal: node16.signal },
      bundler: { status: bundler.status, signal: bundler.signal },
      strictDeclarationResolution: { status: strict.status, signal: strict.signal, skipLibCheck: false },
    },
    runtime: runtime.stdout.trim(),
    redReceipts: [
      { label: "unsupported-consistency-outside-listQuery", status: negativeModes.status, expected: "TypeScript rejects consistency on readState/exists/query" },
      { label: "exports-map-deep-import", status: negativeDeep.status, expected: "TypeScript rejects package-internal executor deep import" },
    ],
    publication: "not performed",
  }, null, 2)}\n`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
