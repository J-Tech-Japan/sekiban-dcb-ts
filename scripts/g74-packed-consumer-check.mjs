#!/usr/bin/env node
/**
 * Release-shaped consumer proof for SDT-G74.  It installs the packed public
 * packages into a clean directory, compiles them under Node16 and
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
const packageRoots = ["dcb-core", "dcb-domain", "dcb-client", "dcb-runtime"].map((name) => join(root, "packages", name));
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
  ["domain-status-switch-missing-conflict-is-not-exhaustive", /TS2322: Type '"conflict"' is not assignable to type 'never'/],
]);

const expectedErrors = `
import type { ExecuteResult, ListQueryRequest, SekibanExecutor } from "@sekiban/dcb-client";
import { event, tagFamily, type ExecuteCommandResult, type Tag, type TagFamily } from "@sekiban/dcb-domain";
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

type DomainStatuses = ExecuteCommandResult["status"];
type DomainStatusKinds = "accepted" | "discarded" | "unknown" | "rejected" | "conflict";
const domainStatusesMatch: Equals<DomainStatuses, DomainStatusKinds> = true;

export function describeDomainStatus(result: ExecuteCommandResult): string {
  switch (result.status) {
    case "accepted": return "accepted";
    case "discarded": return "discarded";
    case "unknown": return "unknown";
    case "rejected": return "rejected";
    case "conflict": return "conflict";
    default: {
      const unreachable: never = result.status;
      return unreachable;
    }
  }
}

export function describeDomainStatusMissingConflict(result: ExecuteCommandResult): string {
  switch (result.status) {
    case "accepted": case "discarded": case "unknown": case "rejected":
      return result.status;
    default: {
      // @ts-expect-error [domain-status-switch-missing-conflict-is-not-exhaustive]
      const unreachable: never = result.status;
      return unreachable;
    }
  }
}

void [facadeKinds, executorResultKinds, facadeKindWidened, executorResultKindWidened, familyIsLiteral, familyWidened, tagIsLiteral, tagWidened, nameIsLiteral, nameWidened, userTag, domainStatusesMatch, describeDomainStatus, describeDomainStatusMissingConflict];
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


const queryAuthoring = "import { defineListQuery, defineQuery, defineQueryView, domain, event, projector, tagFamily } from \"@sekiban/dcb-domain\";\nimport { z } from \"zod\";\n\ntype Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;\n\nconst order = tagFamily(\"order\");\nconst placed = event(\"OrderPlaced\", z.object({ orderId: z.string() }), {\n  tags: (payload) => [order.of(payload.orderId)],\n});\nconst orderProjector = projector({\n  id: \"order-projector\",\n  tag: order,\n  events: [placed],\n  initialState: { kind: \"placed\" as const },\n  handlers: { OrderPlaced: () => ({ kind: \"placed\" as const }) },\n});\nconst orders = defineQueryView({ id: \"orders\", version: 1, row: z.strictObject({ orderId: z.string() }) });\nconst params = z.strictObject({ roomId: z.string() });\nconst result = z.strictObject({ count: z.number() });\nconst item = z.strictObject({ id: z.string() });\nconst countQuery = defineQuery({\n  id: \"reservation-count\",\n  version: 1,\n  source: orders,\n  params,\n  result,\n  handleQuery: (_projection, queryParams) => ({ count: queryParams.roomId.length }),\n});\nconst listQuery = defineListQuery({\n  id: \"reservation-list\",\n  version: 2,\n  source: orders,\n  params,\n  item,\n  handleFilter: (projection) => projection.rows.map((row) => ({ id: row.value.orderId })),\n  handleSort: (items) => items,\n});\nconst idMatch: Equals<typeof countQuery.id, \"reservation-count\"> = true;\nconst versionMatch: Equals<typeof countQuery.version, 1> = true;\nconst listIdMatch: Equals<typeof listQuery.id, \"reservation-list\"> = true;\nconst listVersionMatch: Equals<typeof listQuery.version, 2> = true;\nconst paramsMatch: Equals<Parameters<typeof countQuery.handleQuery>[1], Readonly<{ roomId: string }>> = true;\nconst resultMatch: Equals<ReturnType<typeof countQuery.handleQuery>, { count: number }> = true;\nconst itemMatch: Equals<ReturnType<typeof listQuery.handleFilter>[number], Readonly<{ id: string }>> = true;\nconst authored = domain({\n  events: [placed],\n  projectors: [orderProjector],\n  views: [{ id: \"orders\", source: orderProjector.id }],\n  queries: [countQuery, listQuery],\n});\nconst queriesMatch: Equals<typeof authored.queries, readonly [typeof countQuery, typeof listQuery]> = true;\nvoid [idMatch, versionMatch, listIdMatch, listVersionMatch, paramsMatch, resultMatch, itemMatch, queriesMatch];\n\ndefineQuery({\n  id: \"mutate-row\",\n  version: 1,\n  source: orders,\n  params,\n  result,\n  handleQuery: (projection, queryParams, context) => {\n    // @ts-expect-error [query-row-array-readonly]\n    projection.rows.push(projection.rows[0]);\n    const row = projection.rows[0];\n    if (row !== undefined) {\n      // @ts-expect-error [query-row-value-readonly]\n      row.value.orderId = \"mutated\";\n    }\n    // @ts-expect-error [query-params-readonly]\n    queryParams.roomId = \"mutated\";\n    // @ts-expect-error [query-context-readonly]\n    context.readHead = \"mutated\";\n    return { count: queryParams.roomId.length };\n  },\n});\nconst filtered = listQuery.handleFilter({ rows: [] }, { roomId: \"r\" }, {});\n// @ts-expect-error [query-filter-result-readonly]\nfiltered[0].id = \"mutated\";\n// @ts-expect-error [query-filter-array-readonly]\nfiltered.push({ id: \"extra\" });\nconst sortedItems = listQuery.handleSort(filtered, { roomId: \"r\" }, {});\n// @ts-expect-error [query-sort-result-array-readonly]\nsortedItems.splice(0, 1);\ndefineListQuery({\n  id: \"mutate-sort\",\n  version: 1,\n  source: orders,\n  params,\n  item,\n  handleFilter: () => [{ id: \"a\" }],\n  handleSort: (items) => {\n    // @ts-expect-error [query-sort-input-readonly]\n    items[0].id = \"mutated\";\n    // @ts-expect-error [query-sort-input-array-readonly]\n    items.pop();\n    const sorted = items.slice();\n    // @ts-expect-error [query-sort-result-readonly]\n    sorted[0].id = \"mutated\";\n    return sorted;\n  },\n});\ndefineQuery({\n  id: \"promise-query\",\n  version: 1,\n  source: orders,\n  params,\n  result,\n  // @ts-expect-error [query-handler-sync]\n  handleQuery: async () => ({ count: 1 }),\n});\ndefineListQuery({\n  id: \"promise-list\",\n  version: 1,\n  source: orders,\n  params,\n  item,\n  // @ts-expect-error [query-filter-sync]\n  handleFilter: async () => [{ id: \"a\" }],\n  handleSort: (items) => items,\n});\ndefineQuery({\n  id: \"wrong-result\",\n  version: 1,\n  source: orders,\n  params,\n  result,\n  // @ts-expect-error [query-result-matches-schema]\n  handleQuery: () => ({ count: \"nope\" }),\n});\ndefineListQuery({\n  id: \"wrong-item\",\n  version: 1,\n  source: orders,\n  params,\n  item,\n  // @ts-expect-error [query-item-matches-schema]\n  handleFilter: () => [{ id: 1 }],\n  handleSort: (items) => items,\n});\ndefineQuery({\n  id: \"generic-handler\",\n  version: 1,\n  source: orders,\n  params,\n  result,\n  handleQuery: () => ({ count: 1 }),\n  // @ts-expect-error [query-no-generic-handler]\n  handler: () => ({ count: 1 }),\n});\n// @ts-expect-error [query-contract-hides-handler]\ncountQuery.contract.handleQuery({ rows: [] }, { roomId: \"r\" }, {});\ndefineQuery({\n  id: \"reserved-PageNumber\",\n  version: 1,\n  source: orders,\n  // @ts-expect-error [query-reserved-PageNumber]\n  params: z.strictObject({ PageNumber: z.number() }),\n  result,\n  handleQuery: () => ({ count: 1 }),\n});\ndefineQuery({\n  id: \"reserved-PageSize\",\n  version: 1,\n  source: orders,\n  // @ts-expect-error [query-reserved-PageSize]\n  params: z.strictObject({ PageSize: z.number() }),\n  result,\n  handleQuery: () => ({ count: 1 }),\n});\ndefineQuery({\n  id: \"reserved-NewestFirst\",\n  version: 1,\n  source: orders,\n  // @ts-expect-error [query-reserved-NewestFirst]\n  params: z.strictObject({ NewestFirst: z.boolean() }),\n  result,\n  handleQuery: () => ({ count: 1 }),\n});\ndefineQuery({\n  id: \"reserved-consistency\",\n  version: 1,\n  source: orders,\n  // @ts-expect-error [query-reserved-consistency]\n  params: z.strictObject({ consistency: z.string() }),\n  result,\n  handleQuery: () => ({ count: 1 }),\n});\ndefineQuery({\n  id: \"reserved-pageNumber\",\n  version: 1,\n  source: orders,\n  // @ts-expect-error [query-reserved-pageNumber]\n  params: z.strictObject({ pageNumber: z.number() }),\n  result,\n  handleQuery: () => ({ count: 1 }),\n});\ndefineQuery({\n  id: \"reserved-pageSize\",\n  version: 1,\n  source: orders,\n  // @ts-expect-error [query-reserved-pageSize]\n  params: z.strictObject({ pageSize: z.number() }),\n  result,\n  handleQuery: () => ({ count: 1 }),\n});\ndefineQuery({\n  id: \"reserved-newestFirst\",\n  version: 1,\n  source: orders,\n  // @ts-expect-error [query-reserved-newestFirst]\n  params: z.strictObject({ newestFirst: z.boolean() }),\n  result,\n  handleQuery: () => ({ count: 1 }),\n});\ndefineQuery({\n  id: \"reserved-descending\",\n  version: 1,\n  source: orders,\n  // @ts-expect-error [query-reserved-descending]\n  params: z.strictObject({ descending: z.boolean() }),\n  result,\n  handleQuery: () => ({ count: 1 }),\n});\ndefineQuery({\n  id: \"reserved-waitForSortableUniqueId\",\n  version: 1,\n  source: orders,\n  // @ts-expect-error [query-reserved-waitForSortableUniqueId]\n  params: z.strictObject({ waitForSortableUniqueId: z.string() }),\n  result,\n  handleQuery: () => ({ count: 1 }),\n});\ndefineQuery({\n  id: \"reserved-signal\",\n  version: 1,\n  source: orders,\n  // @ts-expect-error [query-reserved-signal]\n  params: z.strictObject({ signal: z.string() }),\n  result,\n  handleQuery: () => ({ count: 1 }),\n});\n";

const queryExpectations = new Map([
  ["query-row-array-readonly", /TS2339: Property 'push' does not exist/],
  ["query-row-value-readonly", /TS2540: Cannot assign to 'orderId'/],
  ["query-params-readonly", /TS2540: Cannot assign to 'roomId'/],
  ["query-context-readonly", /TS2540: Cannot assign to 'readHead'/],
  ["query-filter-result-readonly", /TS2540: Cannot assign to 'id'/],
  ["query-sort-input-readonly", /TS2540: Cannot assign to 'id'/],
  ["query-filter-array-readonly", /TS2339: Property 'push' does not exist/],
  ["query-sort-input-array-readonly", /TS2339: Property 'pop' does not exist/],
  ["query-sort-result-array-readonly", /TS2551: Property 'splice' does not exist/],
  ["query-sort-result-readonly", /TS2540: Cannot assign to 'id'/],
  ["query-handler-sync", /TS2741: Property 'count' is missing in type 'Promise/],
  ["query-filter-sync", /TS2740: Type 'Promise/],
  ["query-result-matches-schema", /TS2322: Type 'string' is not assignable to type 'number'/],
  ["query-item-matches-schema", /TS2322: Type 'number' is not assignable to type 'string'/],
  ["query-no-generic-handler", /TS2353: Object literal may only specify known properties, and 'handler' does not exist/],
  ["query-contract-hides-handler", /TS2339: Property 'handleQuery' does not exist/],
  ["query-reserved-PageNumber", /TS2322: .*not assignable to type 'never'/],
  ["query-reserved-PageSize", /TS2322: .*not assignable to type 'never'/],
  ["query-reserved-NewestFirst", /TS2322: .*not assignable to type 'never'/],
  ["query-reserved-consistency", /TS2322: .*not assignable to type 'never'/],
  ["query-reserved-pageNumber", /TS2322: .*not assignable to type 'never'/],
  ["query-reserved-pageSize", /TS2322: .*not assignable to type 'never'/],
  ["query-reserved-newestFirst", /TS2322: .*not assignable to type 'never'/],
  ["query-reserved-descending", /TS2322: .*not assignable to type 'never'/],
  ["query-reserved-waitForSortableUniqueId", /TS2322: .*not assignable to type 'never'/],
  ["query-reserved-signal", /TS2322: .*not assignable to type 'never'/],
]);

const queryDirective = /^(\s*)\/\/ @ts-expect-error \[([A-Za-z0-9-]+)\]\s*$/;

function blankQueryDirectives(source) {
  return source.split("\n").map((line) => (queryDirective.test(line) ? line.replace(/\/\/ @ts-expect-error .*/, "// directive removed") : line)).join("\n");
}

function queryTargets(source, expectations) {
  const targets = new Map();
  source.split("\n").forEach((line, index) => {
    const match = queryDirective.exec(line);
    if (!match) return;
    if (targets.has(match[2])) throw new Error(`duplicate expectation label ${match[2]}`);
    targets.set(match[2], index + 2);
  });
  const declared = [...expectations.keys()].sort();
  const present = [...targets.keys()].sort();
  if (JSON.stringify(declared) !== JSON.stringify(present)) {
    throw new Error(`expectation labels drifted: declared ${declared.join(",")} present ${present.join(",")}`);
  }
  if (source.split("\n").filter((line) => line.includes("@ts-expect-error")).length !== targets.size) {
    throw new Error("every @ts-expect-error in the query fixture must carry a label");
  }
  return targets;
}

function queryDiagnostics(output, file) {
  const byLine = new Map();
  for (const line of output.split("\n")) {
    const match = /^(.+?)\((\d+),(\d+)\): error (TS\d+: .*)$/.exec(line.trim());
    if (!match || !match[1].endsWith(file)) continue;
    const lineNumber = Number(match[2]);
    byLine.set(lineNumber, [...(byLine.get(lineNumber) ?? []), match[4]]);
  }
  return byLine;
}

async function proveQueryFixture({ tsc, cwd, source, blankedPath, fileName, expectations }) {
  const targets = queryTargets(source, expectations);
  const rejections = [];
  for (const [label, moduleName, moduleResolution] of [["Node16", "Node16", "Node16"], ["Bundler", "ESNext", "Bundler"]]) {
    const blanked = await run(tsc, ["--noEmit", "--target", "ES2022", "--module", moduleName, "--moduleResolution", moduleResolution, "--strict", "--skipLibCheck", blankedPath], cwd, { expectFailure: true });
    const diagnostics = queryDiagnostics(`${blanked.stdout}\n${blanked.stderr}`, fileName);
    const expectedLines = new Set(targets.values());
    const stray = [...diagnostics.keys()].filter((line) => !expectedLines.has(line));
    if (stray.length > 0) throw new Error(`${label} ${fileName} has diagnostics outside labelled lines: ${stray.map((line) => `${line}: ${diagnostics.get(line).join(" | ")}`).join("; ")}`);
    for (const [name, line] of targets) {
      const messages = diagnostics.get(line) ?? [];
      const pattern = expectations.get(name);
      if (!messages.some((message) => pattern.test(message))) {
        throw new Error(`${label} expectation ${name} (line ${line}) did not produce ${pattern}; got ${messages.length === 0 ? "no diagnostic" : messages.join(" | ")}`);
      }
    }
    rejections.push({ resolution: label, status: blanked.status, file: fileName, labels: targets.size });
  }
  return rejections;
}

async function assertInstalledQueryContracts(cwd) {
  const source = await readFile(join(cwd, "node_modules", "@sekiban", "dcb-core", "dist", "index.d.ts"), "utf8");
  if (!source.includes("export interface QueryContract") || !source.includes("export interface ListQueryContract") || !source.includes("export interface QueryPage")) {
    throw new Error("installed @sekiban/dcb-core is missing the local query contracts");
  }
}

const futureQueryClient = "import type { ListQueryContract, QueryContract, QueryPage } from \"@sekiban/dcb-core\";\n\ndeclare function futureQuery<P, R>(contract: QueryContract<P, R>, params: P): Promise<R>;\ndeclare function futureListQuery<P, I>(contract: ListQueryContract<P, I>, params: P): Promise<QueryPage<I>>;\n\ndeclare const count: QueryContract<{ readonly roomId: string }, { readonly count: number }>;\ndeclare const list: ListQueryContract<{ readonly roomId: string }, { readonly id: string }>;\n\nexport async function readCount(): Promise<{ readonly count: number }> {\n  return futureQuery(count, { roomId: \"room-1\" });\n}\n\nexport async function readPage(): Promise<QueryPage<{ readonly id: string }>> {\n  return futureListQuery(list, { roomId: \"room-1\" });\n}\n";
const futureQueryNegative = "import type { ListQueryContract, QueryContract, QueryPage } from \"@sekiban/dcb-core\";\n\ndeclare function futureQuery<P, R>(contract: QueryContract<P, R>, params: P): Promise<R>;\ndeclare function futureListQuery<P, I>(contract: ListQueryContract<P, I>, params: P): Promise<QueryPage<I>>;\n\ndeclare const count: QueryContract<{ roomId: string }, { count: number }>;\ndeclare const list: ListQueryContract<{ roomId: string }, { id: string }>;\n\nconst countResult: Promise<{ count: number }> = futureQuery(count, { roomId: \"r\" });\nconst page: Promise<QueryPage<{ id: string }>> = futureListQuery(list, { roomId: \"r\" });\n// @ts-expect-error [future-query-param-type]\nfutureQuery(count, { roomId: 1 });\n// @ts-expect-error [future-query-result-type]\nconst wrongResult: Promise<{ total: number }> = futureQuery(count, { roomId: \"r\" });\n// @ts-expect-error [future-list-rejects-scalar-contract]\nfutureListQuery(count, { roomId: \"r\" });\n// @ts-expect-error [future-list-param-keys]\nfutureListQuery(list, { missing: true });\n// @ts-expect-error [future-list-item-type]\nconst wrongPage: Promise<QueryPage<{ name: string }>> = futureListQuery(list, { roomId: \"r\" });\nvoid [countResult, page, wrongResult, wrongPage];\n";
const futureExpectations = new Map([
  ["future-query-param-type", /TS2322: Type 'number' is not assignable to type 'string'/],
  ["future-query-result-type", /TS2322: Type 'Promise<{ count: number; }>' is not assignable to type 'Promise<{ total: number; }>'/],
  ["future-list-rejects-scalar-contract", /TS2345: Argument of type 'QueryContract</],
  ["future-list-param-keys", /TS2353: Object literal may only specify known properties, and 'missing' does not exist/],
  ["future-list-item-type", /TS2322: Type 'Promise<QueryPage<{ id: string; }>>' is not assignable to type 'Promise<QueryPage<{ name: string; }>>'/],
]);
if (/\bzod\b|@sekiban\/dcb-domain|handleQuery|handleFilter|handleSort/.test(futureQueryClient)) {
  throw new Error("future-query-client.ts must import only structural contracts from @sekiban/dcb-core");
}
const deepImport = `import { createSekibanExecutor } from "@sekiban/dcb-client/dist/executor.js"; console.log(createSekibanExecutor);\n`;
const runtimeScan = `
import type { RuntimeWorkerConfig } from "@sekiban/dcb-runtime";

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Scan = RuntimeWorkerConfig["maxScanRows"];
const scanIsNumber: Equals<Scan, number | undefined> = true;
void scanIsNumber;
`;

const runtimeScanMutant = {
  label: "runtime-max-scan-rows-narrowed",
  file: "@sekiban/dcb-runtime/dist/composition.d.ts",
  from: "readonly maxScanRows?: number;",
  to: "readonly maxScanRows?: 1 | 10000;",
};

const runtimeCheck = `
import { register } from "node:module";
await register(new URL("./host-stub-loader.mjs", import.meta.url));
const expected = {
  "@sekiban/dcb-core": ["assertJsonValue", "canonicalEventKey", "defineCommand", "defineEvent", "defineProjector", "defineTag", "done", "noop", "reject"],
  "@sekiban/dcb-domain": ["command", "defineListQuery", "defineQuery", "defineQueryView", "domain", "event", "eventUnion", "none", "projector", "read", "readExists", "readSet", "tagFamily", "toRuntimeDomain"],
  "@sekiban/dcb-domain/testing": ["evolve", "evolveTable", "given"],
  "@sekiban/dcb-client": ["ClientError", "ClaimLedger", "ClaimLedgerExecutor", "SerializedDcbClient", "createClaimLedgerExecutor", "createHttpTransport", "createInProcessTransport", "createSekibanExecutor", "createSerializedDcbClient", "preflightCommit"],
  "@sekiban/dcb-runtime": ["composeRuntime", "createRuntimeWorker"],
  "@sekiban/dcb-runtime/cosmos": ["CosmosEventStore", "createCosmosStoreProvider"],
  "@sekiban/dcb-runtime/d1": ["D1EventStore", "createD1StoreProvider"],
  "@sekiban/dcb-runtime/d1-mv": ["createD1MaterializedViewStore"],
  "@sekiban/dcb-runtime/cloudflare": ["createCloudflareOnlyRuntimeWorker"],
  "@sekiban/dcb-runtime/mv": ["MaterializedViewRuntime"],
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
  await mkdir(join(temp, "runtime-types"), { recursive: true });
  await mkdir(join(temp, "compile-negative"), { recursive: true });
  await writeFile(join(temp, "tsconfig.node16.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "Node16", moduleResolution: "Node16", strict: true, skipLibCheck: true, outDir: "dist-node16" }, include: ["src/**/*.ts"] }, null, 2));
  await writeFile(join(temp, "tsconfig.bundler.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true, outDir: "dist-bundler" }, include: ["src/**/*.ts"] }, null, 2));
  await writeFile(join(temp, "tsconfig.strict.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "Node16", moduleResolution: "Node16", strict: true, skipLibCheck: false, noEmit: true }, include: ["src/main.ts", "src/expected-errors.ts"] }, null, 2));
  await writeFile(join(temp, "runtime-types/runtime-scan.ts"), runtimeScan);
  await writeFile(join(temp, "postgres-stub.mjs"), "export default function postgres() { return {}; }\n");
  await writeFile(join(temp, "cloudflare-workers-stub.mjs"), "export const tracing = {};\n");
  await writeFile(join(temp, "host-stub-loader.mjs"), `const stubs = new Map([
  ["postgres", new URL("./postgres-stub.mjs", import.meta.url).href],
  ["cloudflare:workers", new URL("./cloudflare-workers-stub.mjs", import.meta.url).href],
]);
export async function resolve(specifier, context, nextResolve) {
  const stub = stubs.get(specifier);
  if (stub !== undefined) return { url: stub, shortCircuit: true };
  return nextResolve(specifier, context);
}
`);
  await writeFile(join(temp, "src/main.ts"), positive);
  await writeFile(join(temp, "src/future-query-client.ts"), futureQueryClient);
  await writeFile(join(temp, "src/future-query-negative.ts"), futureQueryNegative);
  await writeFile(join(temp, "src/query-authoring.ts"), queryAuthoring);
  await writeFile(join(temp, "src/expected-errors.ts"), expectedErrors);
  await writeFile(join(temp, "compile-negative/future-query-negative-blanked.ts"), blankQueryDirectives(futureQueryNegative));
  await writeFile(join(temp, "compile-negative/query-authoring-blanked.ts"), blankQueryDirectives(queryAuthoring));
  await writeFile(join(temp, "compile-negative/expected-errors-blanked.ts"), blankDirectives(expectedErrors));
  await writeFile(join(temp, "compile-negative/unused-directive-control.ts"), unusedDirectiveControl);
  await writeFile(join(temp, "compile-negative/deep-import.ts"), deepImport);
  await writeFile(join(temp, "runtime-check.mjs"), runtimeCheck);

  const tarballs = [];
  for (const packageRoot of packageRoots) {
    const packed = JSON.parse((await run("npm", ["pack", "--json", "--pack-destination", temp], packageRoot)).stdout);
    tarballs.push(join(temp, packed[0].filename));
  }
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", ...tarballs, "typescript@5.9.3"]);
  await assertInstalledQueryContracts(temp);
  const installedFutureClient = await readFile(join(temp, "src/future-query-client.ts"), "utf8");
  if (installedFutureClient !== futureQueryClient) throw new Error("future-query-client.ts was not written unchanged");
  if (/\bzod\b|@sekiban\/dcb-domain|handleQuery|handleFilter|handleSort/.test(installedFutureClient)) {
    throw new Error("future-query-client.ts must import only structural contracts from @sekiban/dcb-core");
  }

  const tsc = join(temp, "node_modules/.bin/tsc");
  const node16 = await run(tsc, ["-p", "tsconfig.node16.json"]);
  const bundler = await run(tsc, ["-p", "tsconfig.bundler.json"]);
  const queryRejections = await proveQueryFixture({
    tsc,
    cwd: temp,
    source: queryAuthoring,
    blankedPath: "compile-negative/query-authoring-blanked.ts",
    fileName: "query-authoring-blanked.ts",
    expectations: queryExpectations,
  });
  const futureRejections = await proveQueryFixture({
    tsc,
    cwd: temp,
    source: futureQueryNegative,
    blankedPath: "compile-negative/future-query-negative-blanked.ts",
    fileName: "future-query-negative-blanked.ts",
    expectations: futureExpectations,
  });
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
  const runtimeScanArgs = ["--noEmit", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--strict", "--skipLibCheck", "runtime-types/runtime-scan.ts"];
  const runtimeScanCompile = await run(tsc, runtimeScanArgs);
  const scanFile = join(temp, "node_modules", runtimeScanMutant.file);
  const scanOriginal = await readFile(scanFile, "utf8");
  const scanMatches = scanOriginal.split(runtimeScanMutant.from).length - 1;
  if (scanMatches !== 1) throw new Error(`consumer mutant ${runtimeScanMutant.label} anchor matched ${scanMatches} times`);
  await writeFile(scanFile, scanOriginal.replace(runtimeScanMutant.from, runtimeScanMutant.to));
  let runtimeScanMutantResult;
  try {
    const outcome = await new Promise((resolvePromise) => {
      run(tsc, runtimeScanArgs).then((result) => resolvePromise({ ...result, compiled: true }), (error) => resolvePromise({ compiled: false, output: String(error.message) }));
    });
    const output = outcome.compiled ? `${outcome.stdout}\n${outcome.stderr}` : outcome.output;
    const diagnostics = output.split("\n").map((line) => line.trim()).filter((line) => /\): error TS\d+:/.test(line));
    const inArtifact = diagnostics.filter((line) => line.startsWith("node_modules/"));
    const inFixture = diagnostics.filter((line) => line.includes("runtime-scan.ts("));
    const status = outcome.compiled ? "MISSED" : inArtifact.length > 0 || inFixture.length === 0 ? "INVALID" : "RED";
    runtimeScanMutantResult = { label: runtimeScanMutant.label, status, firstDiagnostic: inFixture[0] ?? inArtifact[0] ?? null };
  } finally {
    await writeFile(scanFile, scanOriginal);
  }
  if (runtimeScanMutantResult.status !== "RED") throw new Error(`runtime scan mutant not detected:\n${JSON.stringify(runtimeScanMutantResult, null, 2)}`);
  mutantResults.push(runtimeScanMutantResult);
  const restoredScan = await run(tsc, runtimeScanArgs);
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
      runtimeScan: { status: runtimeScanCompile.status, signal: runtimeScanCompile.signal, moduleResolution: "Bundler" },
    },
    runtime: runtime.stdout.trim(),
    redReceipts: [
      { label: "labelled-expected-errors", compiledWithDirectives: "src/expected-errors.ts in node16, bundler and strict", blankedStatus: blanked.status, rejections },
      { label: "query-authoring", compiledWithDirectives: "src/query-authoring.ts in node16 and bundler", rejections: queryRejections },
      { label: "future-query-client", compiledWithDirectives: "src/future-query-client.ts and src/future-query-negative.ts in node16 and bundler", rejections: futureRejections },
      { label: "unused-directive-control", status: control.status, expected: "TS2578 proves @ts-expect-error is enforced" },
      { label: "exports-map-deep-import", status: negativeDeep.status, expected: "TypeScript rejects package-internal executor deep import" },
    ],
    consumerMutants: {
      note: "declaration edits applied to the installed release artifacts; each must fail src/expected-errors.ts inside that file",
      results: mutantResults,
      restoredControl: { status: restored.status, runtimeScan: restoredScan.status, expected: "unmutated artifacts compile the fixture again" },
    },
    publication: "not performed",
  }, null, 2)}\n`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
