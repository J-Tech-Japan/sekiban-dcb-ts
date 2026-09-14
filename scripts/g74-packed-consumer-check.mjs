#!/usr/bin/env node
/**
 * Release-shaped consumer proof for SDT-G74.  It installs the three packed
 * public packages into a clean directory, compiles them under Node16 and
 * Bundler resolution, and separately checks the declaration graph without
 * skipLibCheck.  A labelled expected-errors fixture proves read-lane, result
 * exhaustiveness and literal-inference boundaries, declaration mutants on the
 * installed artifacts prove that fixture is not vacuous, and a deep-import file
 * proves the exports map.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

// Every rejected construct carries its own labelled @ts-expect-error.  The file
// must compile as written (an unused directive is TS2578), and the same file with
// the directives blanked must fail on exactly the labelled lines with the
// diagnostic each label names.  One shared diagnostic can no longer satisfy
// several rejections, and a directive cannot be satisfied by an unrelated error.
const expectations = new Map([
  ["readState-rejects-consistency", /TS2353: .*'consistency' does not exist in type 'ReadOptions'/],
  ["exists-rejects-consistency", /TS2353: .*'consistency' does not exist in type 'ReadOptions'/],
  ["query-rejects-consistency", /TS2353: .*'consistency' does not exist in type 'ReadOptions'/],
  ["facade-kind-is-not-bare-string", /TS2322: Type 'true' is not assignable to type 'false'/],
  ["executor-result-kind-is-not-bare-string", /TS2322: Type 'true' is not assignable to type 'false'/],
  ["facade-switch-missing-invalid-is-not-exhaustive", /TS2322: Type 'ExecuteInvalid' is not assignable to type 'never'/],
  ["executor-result-switch-missing-partial-is-not-exhaustive", /TS2322: Type 'ExecutePartial' is not assignable to type 'never'/],
  ["tagFamily-does-not-widen-family", /TS2322: Type 'true' is not assignable to type 'false'/],
  ["tag-does-not-widen-family", /TS2322: Type 'true' is not assignable to type 'false'/],
  ["event-does-not-widen-name", /TS2322: Type 'true' is not assignable to type 'false'/],
  ["tag-families-do-not-mix", /TS2322: Type 'Tag<"room">' is not assignable to type 'Tag<"user">'/],
]);

const expectedErrors = `
import type { ExecuteResult, ListQueryRequest, SekibanExecutor } from "@sekiban/dcb-client";
import { event, tagFamily, type Tag, type TagFamily } from "@sekiban/dcb-domain";
import { z } from "zod";

// Identity, not mutual assignability: this form distinguishes any, unions and variance.
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

declare const executor: SekibanExecutor;
declare const request: ListQueryRequest;

// listQuery owns the consistency lane; both values are accepted there.
await executor.listQuery(request, { consistency: "safe" });
await executor.listQuery(request, { consistency: "unsafe" });
await executor.readState({} as never, {} as never, {});
await executor.exists({} as never, {});
await executor.query({ queryType: "x", queryParamsJson: "{}" }, {});
// @ts-expect-error [readState-rejects-consistency]
await executor.readState({} as never, {} as never, { consistency: "safe" });
// @ts-expect-error [exists-rejects-consistency]
await executor.exists({} as never, { consistency: "unsafe" });
// @ts-expect-error [query-rejects-consistency]
await executor.query({ queryType: "x", queryParamsJson: "{}" }, { consistency: "safe" });

type Kinds = "committed" | "noop" | "rejected" | "conflict" | "partial" | "timeout" | "unavailable" | "transport" | "invalid";
type FacadeResult = Awaited<ReturnType<SekibanExecutor["execute"]>>;
const facadeKinds: Equals<FacadeResult["kind"], Kinds> = true;
const executorResultKinds: Equals<ExecuteResult["kind"], Kinds> = true;
// @ts-expect-error [facade-kind-is-not-bare-string]
const facadeKindWidened: Equals<FacadeResult["kind"], string> = true;
// @ts-expect-error [executor-result-kind-is-not-bare-string]
const executorResultKindWidened: Equals<ExecuteResult["kind"], string> = true;

export function describeFacade(result: FacadeResult): string {
  switch (result.kind) {
    case "committed": return result.head;
    case "noop": return result.reason ?? "noop";
    case "rejected": return result.error;
    case "conflict": return String(result.conflicts.length);
    case "partial": return String(result.partial);
    case "timeout": return "timeout";
    case "unavailable": return "unavailable";
    case "transport": return "transport";
    case "invalid": return "invalid";
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
}

export function describeFacadeMissingInvalid(result: FacadeResult): string {
  switch (result.kind) {
    case "committed": case "noop": case "rejected": case "conflict": case "partial":
    case "timeout": case "unavailable": case "transport":
      return result.kind;
    default: {
      // @ts-expect-error [facade-switch-missing-invalid-is-not-exhaustive]
      const unreachable: never = result;
      return unreachable;
    }
  }
}

export function describeExecuteResult(result: ExecuteResult): string {
  switch (result.kind) {
    case "committed": case "noop": case "rejected": case "conflict": case "partial":
    case "timeout": case "unavailable": case "transport": case "invalid":
      return result.kind;
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
}

export function describeExecuteResultMissingPartial(result: ExecuteResult): string {
  switch (result.kind) {
    case "committed": case "noop": case "rejected": case "conflict":
    case "timeout": case "unavailable": case "transport": case "invalid":
      return result.kind;
    default: {
      // @ts-expect-error [executor-result-switch-missing-partial-is-not-exhaustive]
      const unreachable: never = result;
      return unreachable;
    }
  }
}

const rooms = tagFamily("room");
const familyIsLiteral: Equals<typeof rooms, TagFamily<"room">> = true;
// @ts-expect-error [tagFamily-does-not-widen-family]
const familyWidened: Equals<typeof rooms, TagFamily<string>> = true;
const roomTag = rooms.of("r1");
const tagIsLiteral: Equals<typeof roomTag, Tag<"room">> = true;
// @ts-expect-error [tag-does-not-widen-family]
const tagWidened: Equals<typeof roomTag, Tag<string>> = true;
const opened = event("RoomOpened", z.object({ roomId: z.string() }), {
  tagFamily: rooms,
  tags: (input) => [rooms.of(input.roomId)],
});
const nameIsLiteral: Equals<typeof opened.name, "RoomOpened"> = true;
// @ts-expect-error [event-does-not-widen-name]
const nameWidened: Equals<typeof opened.name, string> = true;
// @ts-expect-error [tag-families-do-not-mix]
const userTag: Tag<"user"> = roomTag;

void [facadeKinds, executorResultKinds, facadeKindWidened, executorResultKindWidened, familyIsLiteral, familyWidened, tagIsLiteral, tagWidened, nameIsLiteral, nameWidened, userTag];
`;

// Control: a directive over a line that compiles must itself be an error, or the
// must-compile half of the proof above would be vacuous under this toolchain.
const unusedDirectiveControl = `
// @ts-expect-error nothing on the next line is an error
export const fine: number = 1;
`;

// Declaration mutants applied to the installed release artifacts.  Each must turn
// the must-compile expected-errors file red with a diagnostic inside that file; a
// diagnostic inside node_modules means the mutant broke the declaration itself and
// proves nothing (INVALID), and a clean compile means the tests are vacuous (MISSED).
const consumerMutants = [
  {
    label: "consistency-added-to-read-options",
    file: "@sekiban/dcb-client/dist/executor.d.ts",
    from: "export interface ReadOptions {\n    readonly signal?: AbortSignal;",
    to: "export interface ReadOptions {\n    readonly consistency?: ReadConsistency;\n    readonly signal?: AbortSignal;",
  },
  {
    label: "result-variant-added",
    file: "@sekiban/dcb-client/dist/index.d.ts",
    from: "| ExecuteTransport | ExecuteInvalid;",
    to: "| ExecuteTransport | ExecuteInvalid | { readonly kind: \"deferred\"; readonly attempts: number };",
  },
  {
    label: "result-discriminant-widened-to-string",
    file: "@sekiban/dcb-client/dist/index.d.ts",
    from: "export interface ExecuteInvalid extends ExecuteCommon {\n    readonly kind: \"invalid\";",
    to: "export interface ExecuteInvalid extends ExecuteCommon {\n    readonly kind: string;",
  },
  {
    label: "tagFamily-literal-inference-lost",
    file: "@sekiban/dcb-domain/dist/types.d.ts",
    from: "export declare function tagFamily<const Family extends string>(family: Family): TagFamily<Family>;",
    to: "export declare function tagFamily(family: string): TagFamily<string>;",
  },
  {
    label: "event-name-literal-inference-lost",
    file: "@sekiban/dcb-domain/dist/event.d.ts",
    from: "): EventDefinition<Name, Schema, TagFamilyOfDeriver<Deriver>>;",
    to: "): EventDefinition<string, Schema, TagFamilyOfDeriver<Deriver>>;",
  },
];

const DIRECTIVE = /^(\s*)\/\/ @ts-expect-error \[([A-Za-z0-9-]+)\]\s*$/;

function expectationLines(source) {
  const lines = source.split("\n");
  const targets = new Map();
  lines.forEach((line, index) => {
    const match = DIRECTIVE.exec(line);
    if (!match) return;
    if (targets.has(match[2])) throw new Error(`duplicate expectation label ${match[2]}`);
    targets.set(match[2], index + 2); // 1-based line number of the line after the directive
  });
  const declared = [...expectations.keys()].sort();
  const present = [...targets.keys()].sort();
  if (JSON.stringify(declared) !== JSON.stringify(present)) {
    throw new Error(`expectation labels drifted: declared ${declared.join(",")} present ${present.join(",")}`);
  }
  if (source.split("\n").filter((line) => line.includes("@ts-expect-error")).length !== targets.size) {
    throw new Error("every @ts-expect-error in the expected-errors fixture must carry a label");
  }
  return targets;
}

function blankDirectives(source) {
  return source.split("\n").map((line) => (DIRECTIVE.test(line) ? line.replace(/\/\/ @ts-expect-error .*/, "// directive removed") : line)).join("\n");
}

function diagnosticsByLine(output, file) {
  const byLine = new Map();
  for (const line of output.split("\n")) {
    const match = /^(.+?)\((\d+),(\d+)\): error (TS\d+: .*)$/.exec(line.trim());
    if (!match || !match[1].endsWith(file)) continue;
    const lineNumber = Number(match[2]);
    byLine.set(lineNumber, [...(byLine.get(lineNumber) ?? []), match[4]]);
  }
  return byLine;
}

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
  await writeFile(join(temp, "tsconfig.strict.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "Node16", moduleResolution: "Node16", strict: true, skipLibCheck: false, noEmit: true }, include: ["src/main.ts", "src/expected-errors.ts"] }, null, 2));
  await writeFile(join(temp, "src/main.ts"), positive);
  await writeFile(join(temp, "src/expected-errors.ts"), expectedErrors);
  await writeFile(join(temp, "compile-negative/expected-errors-blanked.ts"), blankDirectives(expectedErrors));
  await writeFile(join(temp, "compile-negative/unused-directive-control.ts"), unusedDirectiveControl);
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
  const tscArgs = ["--noEmit", "--target", "ES2022", "--module", "Node16", "--moduleResolution", "Node16", "--strict", "--skipLibCheck"];
  const targets = expectationLines(expectedErrors);
  const blanked = await run(tsc, [...tscArgs, "compile-negative/expected-errors-blanked.ts"], temp, { expectFailure: true });
  const blankedDiagnostics = diagnosticsByLine(`${blanked.stdout}\n${blanked.stderr}`, "expected-errors-blanked.ts");
  const expectedLines = new Set(targets.values());
  const stray = [...blankedDiagnostics.keys()].filter((line) => !expectedLines.has(line));
  if (stray.length > 0) throw new Error(`expected-errors fixture has diagnostics outside its labelled lines: ${stray.map((line) => `${line}: ${blankedDiagnostics.get(line).join(" | ")}`).join("; ")}`);
  const rejections = [];
  for (const [label, line] of targets) {
    const messages = blankedDiagnostics.get(line) ?? [];
    const pattern = expectations.get(label);
    if (!messages.some((message) => pattern.test(message))) {
      throw new Error(`expectation ${label} (line ${line}) did not produce ${pattern}; got ${messages.length === 0 ? "no diagnostic" : messages.join(" | ")}`);
    }
    rejections.push({ label, line, diagnostic: messages.find((message) => pattern.test(message)) });
  }
  const control = await run(tsc, [...tscArgs, "compile-negative/unused-directive-control.ts"], temp, { expectFailure: true });
  if (!/TS2578/.test(`${control.stdout}\n${control.stderr}`)) throw new Error(`unused @ts-expect-error control did not report TS2578:\n${control.stdout}\n${control.stderr}`);
  const negativeDeep = await run(tsc, [...tscArgs, "compile-negative/deep-import.ts"], temp, { expectFailure: true });
  const deepText = `${negativeDeep.stdout}\n${negativeDeep.stderr}`;
  if (!/(not exported|cannot find module|not found|exports)/i.test(deepText)) throw new Error(`deep import did not fail through exports map:\n${deepText}`);
  const mutantResults = [];
  for (const mutant of consumerMutants) {
    const file = join(temp, "node_modules", mutant.file);
    const original = await readFile(file, "utf8");
    const matches = original.split(mutant.from).length - 1;
    if (matches !== 1) throw new Error(`consumer mutant ${mutant.label} anchor matched ${matches} times in ${mutant.file}`);
    await writeFile(file, original.replace(mutant.from, mutant.to));
    try {
      const outcome = await new Promise((resolvePromise) => {
        run(tsc, [...tscArgs, "src/expected-errors.ts"]).then((result) => resolvePromise({ ...result, compiled: true }), (error) => resolvePromise({ compiled: false, output: String(error.message) }));
      });
      const output = outcome.compiled ? `${outcome.stdout}\n${outcome.stderr}` : outcome.output;
      const diagnostics = output.split("\n").map((line) => line.trim()).filter((line) => /\): error TS\d+:/.test(line));
      const inArtifact = diagnostics.filter((line) => line.startsWith("node_modules/"));
      const inFixture = diagnostics.filter((line) => line.startsWith("src/expected-errors.ts("));
      const status = outcome.compiled ? "MISSED" : inArtifact.length > 0 || inFixture.length === 0 ? "INVALID" : "RED";
      mutantResults.push({ label: mutant.label, status, firstDiagnostic: inFixture[0] ?? inArtifact[0] ?? null });
    } finally {
      await writeFile(file, original);
    }
  }
  const notRed = mutantResults.filter((result) => result.status !== "RED");
  if (notRed.length > 0) throw new Error(`consumer mutants not detected:\n${JSON.stringify(notRed, null, 2)}`);
  const restored = await run(tsc, [...tscArgs, "src/expected-errors.ts"]);
  const runtime = await run(process.execPath, ["runtime-check.mjs"]);
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    proof: "release-shaped-packed-consumer",
    packages: await Promise.all(packageRoots.map(async (packageRoot) => { const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")); return `${manifest.name}@${manifest.version}`; })),
    compile: {
      node16: { status: node16.status, signal: node16.signal },
      bundler: { status: bundler.status, signal: bundler.signal },
      strictDeclarationResolution: { status: strict.status, signal: strict.signal, skipLibCheck: false },
    },
    runtime: runtime.stdout.trim(),
    redReceipts: [
      { label: "labelled-expected-errors", compiledWithDirectives: "src/expected-errors.ts in node16, bundler and strict", blankedStatus: blanked.status, rejections },
      { label: "unused-directive-control", status: control.status, expected: "TS2578 proves @ts-expect-error is enforced" },
      { label: "exports-map-deep-import", status: negativeDeep.status, expected: "TypeScript rejects package-internal executor deep import" },
    ],
    consumerMutants: {
      note: "declaration edits applied to the installed release artifacts; each must fail src/expected-errors.ts inside that file",
      results: mutantResults,
      restoredControl: { status: restored.status, expected: "unmutated artifacts compile the fixture again" },
    },
    publication: "not performed",
  }, null, 2)}\n`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
