#!/usr/bin/env node
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoots = ["dcb-core", "dcb-domain", "dcb-client"].map((name) => join(root, "packages", name));
const packGuard = join(root, "scripts", "dcb-matched-set-pack-check.mjs");

function run(command, args, cwd, { expectFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (env.NPM_CONFIG_CACHE !== undefined) env.npm_config_cache = env.NPM_CONFIG_CACHE;
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      const result = { status, signal, stdout, stderr };
      if ((status === 0) === !expectFailure) resolve(result);
      else reject(new Error(`${command} ${args.join(" ")} exited ${status ?? signal}\n${stdout}\n${stderr}`));
    });
  });
}

function tsconfig(module, moduleResolution, outDir) {
  return JSON.stringify({
    compilerOptions: { target: "ES2022", lib: ["ES2022", "DOM"], module, moduleResolution, strict: true, skipLibCheck: true, outDir },
    include: ["src/**/*.ts"],
  }, null, 2);
}

const consumer = `
import { createHttpTransport, createSekibanExecutor } from "@sekiban/dcb-client";
import type { ListQueryOptions, ListQueryRequest, SekibanExecutor } from "@sekiban/dcb-client";
import { command, done, domain, event, projector, read, readExists, readSet, tagFamily, toRuntimeDomain } from "@sekiban/dcb-domain";
import { z } from "zod";

const rooms = tagFamily("room");
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const equal = (actual: unknown, expected: unknown) => { if (actual !== expected) throw new Error("expected " + String(expected) + ", received " + String(actual)); };
const deepEqual = (actual: unknown, expected: unknown) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("V1 envelope mismatch: " + JSON.stringify(actual) + " != " + JSON.stringify(expected)); };
const opened = event("RoomOpened", z.object({ roomId: z.string() }), { tagFamily: rooms, tags: (input) => [rooms.of(input.roomId)] });
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
  handle: async (input, context) => { context.append(opened, opened.make(input)); return done({ accepted: true }); },
});
toRuntimeDomain(domain({ events: [opened], projectors: [roomProjector], commands: [open] }));

const requests: Array<{ url: string; body: unknown; rawBody: string | undefined }> = [];
const expectedCommit = {
  version: 1,
  eventCandidates: [{ payload: "eyJyb29tSWQiOiJyb29tLTEifQ==", eventPayloadName: "RoomOpened", tags: ["room:room-1"] }],
  consistencyTags: [{ tag: "room:room-1", lastSortableUniqueId: "" }],
};
const expectedCommitBody = JSON.stringify(expectedCommit);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const rawV1Bytes = (body: string | undefined) => Array.from(new TextEncoder().encode(body));
const assertRawV1Bytes = (actual: string | undefined, expected: string) => {
  if (actual === undefined || JSON.stringify(rawV1Bytes(actual)) !== JSON.stringify(rawV1Bytes(expected))) {
    throw new Error("V1 raw-byte mismatch");
  }
};
const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const rawBody = init?.body === undefined ? undefined : String(init.body);
  const body = rawBody === undefined ? undefined : JSON.parse(rawBody);
  requests.push({ url, body, rawBody });
  if (url.endsWith("/tag-state")) return json({ payload: "eyJzdGF0dXMiOiJlbXB0eSJ9", version: 0, lastSortedUniqueId: "", tagGroup: "room", tagContent: "room-1", tagProjector: "room" });
  if (url.endsWith("/tag-latest-sortable")) return json({ exists: false, lastSortableUniqueId: "" });
  if (url.endsWith("/commit")) return json({ writtenEvents: [{ sortableUniqueIdValue: "000000000000000000000000000001" }], tagWriteResults: [], head: "000000000000000000000000000001" });
  throw new Error(\`unexpected request \${url}\`);
};

const executor = createSekibanExecutor(createHttpTransport({ baseUrl: "https://consumer.test", fetch: fakeFetch }));
const result = await executor.execute(open, { roomId: "room-1" });
equal(result.kind, "committed");
const commit = requests.find((request) => request.url.endsWith("/commit"));
assert(commit, "commit request was not observed");
deepEqual(commit.body, expectedCommit);
const capturedRawBody = commit.rawBody;
assert(capturedRawBody !== undefined, "commit raw V1 body was not captured");
equal(capturedRawBody, expectedCommitBody);
assertRawV1Bytes(capturedRawBody, expectedCommitBody);
const actualBytes = rawV1Bytes(capturedRawBody);
const expectedBytes = rawV1Bytes(expectedCommitBody);
const rawByteMutant = capturedRawBody.replace(',"eventCandidates"', ', "eventCandidates"');
assert(rawByteMutant !== capturedRawBody, "raw-byte mutation did not change serialization");
deepEqual(JSON.parse(rawByteMutant), commit.body);
let rawByteMutationRejected = false;
let rawByteMutationReason = "";
try {
  assertRawV1Bytes(rawByteMutant, expectedCommitBody);
} catch (error) {
  rawByteMutationRejected = true;
  rawByteMutationReason = String(error instanceof Error ? error.message : error);
}
assert(rawByteMutationRejected, "raw-byte mutation escaped the byte-level guard");

// Portable migration workflow: read once, then carry the returned snapshot into
// a command whose transport cannot perform another read. The commit endpoint is
// still exercised; only read methods are guarded to prove snapshot-only means
// zero read calls rather than merely a skipped assertion.
const portable = await executor.readState(roomProjector, rooms.of("room-1"));
const snapshotOnlyReads = { count: 0 };
const snapshotOnlyTransport = {
  ...executor.transport,
  readTagState: async () => { snapshotOnlyReads.count += 1; throw new Error("snapshot-only readTagState must not be called"); },
  readTagLatestSortable: async () => { snapshotOnlyReads.count += 1; throw new Error("snapshot-only readTagLatestSortable must not be called"); },
};
const snapshotOnlyExecutor = createSekibanExecutor(snapshotOnlyTransport);
const snapshotOnlyResult = await snapshotOnlyExecutor.execute(open, { roomId: "room-1" }, {
  snapshots: [portable],
  readMode: "snapshot-only",
});
equal(snapshotOnlyResult.kind, "committed");
equal(snapshotOnlyReads.count, 0);

// The public consistency lane is list-only. These two calls are type-positive
// examples; the function is intentionally not invoked by the runtime receipt.
const listRequest: ListQueryRequest = { queryType: "RoomList", queryParamsJson: "{}" };
const listOnlyTypePositive = (value: SekibanExecutor, request: ListQueryRequest): void => {
  const safe: ListQueryOptions = { consistency: "safe" };
  const unsafe: ListQueryOptions = { consistency: "unsafe" };
  void value.listQuery(request, safe);
  void value.listQuery(request, unsafe);
};
void listRequest;
void listOnlyTypePositive;

console.log(JSON.stringify({
  status: "PASS",
  rawV1Body: commit.rawBody,
  rawV1Bytes: actualBytes,
  expectedRawV1Bytes: expectedBytes,
  rawByteMutationReceipt: { status: "RED_DETECTED", parsedJsonUnchanged: true, reason: rawByteMutationReason },
  portableSnapshotOnlyReceipt: { status: "PASS", snapshotExists: portable.exists, snapshotHead: portable.head, commitKind: snapshotOnlyResult.kind, readCalls: snapshotOnlyReads.count },
  listConsistencyTypePositive: ["safe", "unsafe"],
}));
`;


const queryAuthoring = "import { defineListQuery, defineQuery, defineQueryView, domain, event, projector, tagFamily } from \"@sekiban/dcb-domain\";\nimport { z } from \"zod\";\nimport type { QueryPage } from \"@sekiban/dcb-core\";\nimport type { SekibanExecutor } from \"@sekiban/dcb-client\";\n\ntype Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;\n\nconst order = tagFamily(\"order\");\nconst placed = event(\"OrderPlaced\", z.object({ orderId: z.string() }), {\n  tags: (payload) => [order.of(payload.orderId)],\n});\nconst orderProjector = projector({\n  id: \"order-projector\",\n  tag: order,\n  events: [placed],\n  initialState: { kind: \"placed\" as const },\n  handlers: { OrderPlaced: () => ({ kind: \"placed\" as const }) },\n});\nconst orders = defineQueryView({ id: \"orders\", version: 1, row: z.strictObject({ orderId: z.string() }) });\nconst params = z.strictObject({ roomId: z.string() });\nconst result = z.strictObject({ count: z.number() });\nconst item = z.strictObject({ id: z.string() });\nconst countQuery = defineQuery({\n  id: \"reservation-count\",\n  version: 1,\n  source: orders,\n  params,\n  result,\n  handleQuery: (_projection, queryParams) => ({ count: queryParams.roomId.length }),\n});\nconst listQuery = defineListQuery({\n  id: \"reservation-list\",\n  version: 2,\n  source: orders,\n  params,\n  item,\n  handleFilter: (projection) => projection.rows.map((row) => ({ id: row.value.orderId })),\n  handleSort: (items) => items,\n});\nconst idMatch: Equals<typeof countQuery.id, \"reservation-count\"> = true;\nconst versionMatch: Equals<typeof countQuery.version, 1> = true;\nconst listIdMatch: Equals<typeof listQuery.id, \"reservation-list\"> = true;\nconst listVersionMatch: Equals<typeof listQuery.version, 2> = true;\nconst paramsMatch: Equals<Parameters<typeof countQuery.handleQuery>[1], Readonly<{ roomId: string }>> = true;\nconst resultMatch: Equals<ReturnType<typeof countQuery.handleQuery>, { count: number }> = true;\nconst itemMatch: Equals<ReturnType<typeof listQuery.handleFilter>[number], Readonly<{ id: string }>> = true;\nconst authored = domain({\n  events: [placed],\n  projectors: [orderProjector],\n  views: [{ id: \"orders\", source: orderProjector.id }],\n  queries: [countQuery, listQuery],\n});\nconst queriesMatch: Equals<typeof authored.queries, readonly [typeof countQuery, typeof listQuery]> = true;\nvoid [idMatch, versionMatch, listIdMatch, listVersionMatch, paramsMatch, resultMatch, itemMatch, queriesMatch];\n\ndefineQuery({\n  id: \"mutate-row\",\n  version: 1,\n  source: orders,\n  params,\n  result,\n  handleQuery: (projection, queryParams, context) => {\n    // @ts-expect-error [query-row-array-readonly]\n    projection.rows.push(projection.rows[0]);\n    const row = projection.rows[0];\n    if (row !== undefined) {\n      // @ts-expect-error [query-row-value-readonly]\n      row.value.orderId = \"mutated\";\n    }\n    // @ts-expect-error [query-params-readonly]\n    queryParams.roomId = \"mutated\";\n    // @ts-expect-error [query-context-readonly]\n    context.readHead = \"mutated\";\n    return { count: queryParams.roomId.length };\n  },\n});\nconst filtered = listQuery.handleFilter({ rows: [] }, { roomId: \"r\" }, {});\n// @ts-expect-error [query-filter-result-readonly]\nfiltered[0].id = \"mutated\";\n// @ts-expect-error [query-filter-array-readonly]\nfiltered.push({ id: \"extra\" });\nconst sortedItems = listQuery.handleSort(filtered, { roomId: \"r\" }, {});\n// @ts-expect-error [query-sort-result-array-readonly]\nsortedItems.splice(0, 1);\ndefineListQuery({\n  id: \"mutate-sort\",\n  version: 1,\n  source: orders,\n  params,\n  item,\n  handleFilter: () => [{ id: \"a\" }],\n  handleSort: (items) => {\n    // @ts-expect-error [query-sort-input-readonly]\n    items[0].id = \"mutated\";\n    // @ts-expect-error [query-sort-input-array-readonly]\n    items.pop();\n    const sorted = items.slice();\n    // @ts-expect-error [query-sort-result-readonly]\n    sorted[0].id = \"mutated\";\n    return sorted;\n  },\n});\ndefineQuery({\n  id: \"promise-query\",\n  version: 1,\n  source: orders,\n  params,\n  result,\n  // @ts-expect-error [query-handler-sync]\n  handleQuery: async () => ({ count: 1 }),\n});\ndefineListQuery({\n  id: \"promise-list\",\n  version: 1,\n  source: orders,\n  params,\n  item,\n  // @ts-expect-error [query-filter-sync]\n  handleFilter: async () => [{ id: \"a\" }],\n  handleSort: (items) => items,\n});\ndefineQuery({\n  id: \"wrong-result\",\n  version: 1,\n  source: orders,\n  params,\n  result,\n  // @ts-expect-error [query-result-matches-schema]\n  handleQuery: () => ({ count: \"nope\" }),\n});\ndefineListQuery({\n  id: \"wrong-item\",\n  version: 1,\n  source: orders,\n  params,\n  item,\n  // @ts-expect-error [query-item-matches-schema]\n  handleFilter: () => [{ id: 1 }],\n  handleSort: (items) => items,\n});\ndefineQuery({\n  id: \"generic-handler\",\n  version: 1,\n  source: orders,\n  params,\n  result,\n  handleQuery: () => ({ count: 1 }),\n  // @ts-expect-error [query-no-generic-handler]\n  handler: () => ({ count: 1 }),\n});\n// @ts-expect-error [query-contract-hides-handler]\ncountQuery.contract.handleQuery({ rows: [] }, { roomId: \"r\" }, {});\ndefineQuery({\n  id: \"reserved-PageNumber\",\n  version: 1,\n  source: orders,\n  // @ts-expect-error [query-reserved-PageNumber]\n  params: z.strictObject({ PageNumber: z.number() }),\n  result,\n  handleQuery: () => ({ count: 1 }),\n});\ndefineQuery({\n  id: \"reserved-PageSize\",\n  version: 1,\n  source: orders,\n  // @ts-expect-error [query-reserved-PageSize]\n  params: z.strictObject({ PageSize: z.number() }),\n  result,\n  handleQuery: () => ({ count: 1 }),\n});\ndefineQuery({\n  id: \"reserved-NewestFirst\",\n  version: 1,\n  source: orders,\n  // @ts-expect-error [query-reserved-NewestFirst]\n  params: z.strictObject({ NewestFirst: z.boolean() }),\n  result,\n  handleQuery: () => ({ count: 1 }),\n});\ndefineQuery({\n  id: \"reserved-consistency\",\n  version: 1,\n  source: orders,\n  // @ts-expect-error [query-reserved-consistency]\n  params: z.strictObject({ consistency: z.string() }),\n  result,\n  handleQuery: () => ({ count: 1 }),\n});\ndefineQuery({\n  id: \"reserved-pageNumber\",\n  version: 1,\n  source: orders,\n  // @ts-expect-error [query-reserved-pageNumber]\n  params: z.strictObject({ pageNumber: z.number() }),\n  result,\n  handleQuery: () => ({ count: 1 }),\n});\ndefineQuery({\n  id: \"reserved-pageSize\",\n  version: 1,\n  source: orders,\n  // @ts-expect-error [query-reserved-pageSize]\n  params: z.strictObject({ pageSize: z.number() }),\n  result,\n  handleQuery: () => ({ count: 1 }),\n});\ndefineQuery({\n  id: \"reserved-newestFirst\",\n  version: 1,\n  source: orders,\n  // @ts-expect-error [query-reserved-newestFirst]\n  params: z.strictObject({ newestFirst: z.boolean() }),\n  result,\n  handleQuery: () => ({ count: 1 }),\n});\ndefineQuery({\n  id: \"reserved-descending\",\n  version: 1,\n  source: orders,\n  // @ts-expect-error [query-reserved-descending]\n  params: z.strictObject({ descending: z.boolean() }),\n  result,\n  handleQuery: () => ({ count: 1 }),\n});\ndefineQuery({\n  id: \"reserved-waitForSortableUniqueId\",\n  version: 1,\n  source: orders,\n  // @ts-expect-error [query-reserved-waitForSortableUniqueId]\n  params: z.strictObject({ waitForSortableUniqueId: z.string() }),\n  result,\n  handleQuery: () => ({ count: 1 }),\n});\ndefineQuery({\n  id: \"reserved-signal\",\n  version: 1,\n  source: orders,\n  // @ts-expect-error [query-reserved-signal]\n  params: z.strictObject({ signal: z.string() }),\n  result,\n  handleQuery: () => ({ count: 1 }),\n});\ndeclare const typedExecutor: SekibanExecutor;\nconst authoredCount: Promise<{ count: number }> = typedExecutor.query(countQuery.contract, { roomId: \"room-1\" });\nconst authoredPage: Promise<QueryPage<{ id: string }>> = typedExecutor.listQuery(listQuery.contract, { roomId: \"room-1\" }, { pageNumber: 1, pageSize: 20, descending: false, consistency: \"safe\" });\n// @ts-expect-error [typed-query-rejects-authored-definition]\ntypedExecutor.query(countQuery, { roomId: \"room-1\" });\n// @ts-expect-error [typed-list-rejects-authored-definition]\ntypedExecutor.listQuery(listQuery, { roomId: \"room-1\" });\nvoid [authoredCount, authoredPage];\n";

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
  ["typed-query-rejects-authored-definition", /TS2769:[\s\S]*The types of 'params\.decode' are incompatible/],
  ["typed-list-rejects-authored-definition", /TS2769:[\s\S]*The types of 'params\.decode' are incompatible/],
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
  let current;
  for (const rawLine of output.split("\n")) {
    const match = /^(.+?)\((\d+),(\d+)\): error (TS\d+: .*)$/.exec(rawLine.trim());
    if (match && match[1].endsWith(file)) {
      const lineNumber = Number(match[2]);
      const messages = byLine.get(lineNumber) ?? [];
      messages.push(match[4]);
      byLine.set(lineNumber, messages);
      current = { lineNumber, index: messages.length - 1 };
      continue;
    }
    if (current !== undefined && rawLine.trim().length > 0 && !/^(.+?)\(\d+,\d+\): error TS\d+:/.test(rawLine.trim())) {
      const messages = byLine.get(current.lineNumber);
      messages[current.index] = `${messages[current.index]}\n${rawLine.trim()}`;
      continue;
    }
    if (rawLine.trim().length === 0) current = undefined;
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

async function assertInstalledConditionalDeclarations(cwd) {
  const core = await readFile(join(cwd, "node_modules", "@sekiban", "dcb-core", "dist", "index.d.ts"), "utf8");
  const clientIndex = await readFile(join(cwd, "node_modules", "@sekiban", "dcb-client", "dist", "index.d.ts"), "utf8");
  const client = await readFile(join(cwd, "node_modules", "@sekiban", "dcb-client", "dist", "conditionalCommit.d.ts"), "utf8");
  const signature = "export declare function prepareConditionalCommit<T extends JsonValue>(input: ConditionalCommitInput<T>): PreparedConditionalCommit;";
  const executor = await readFile(join(cwd, "node_modules", "@sekiban", "dcb-client", "dist", "executor.d.ts"), "utf8");
  if (!executor.includes("prepareConditionalCommit<T extends JsonValue>")) throw new Error("installed executor declaration is missing prepareConditionalCommit<T extends JsonValue>");
  if (!executor.includes("commitPreparedConditionally(")) throw new Error("installed executor declaration is missing commitPreparedConditionally");
  if (!client.includes(signature)) throw new Error("installed client declaration is missing prepareConditionalCommit<T extends JsonValue>");
  if (client.includes("prepareConditionalCommit<T>(")) throw new Error("installed prepareConditionalCommit must stay constrained by JsonValue");
  for (const name of ["ConditionalCommitInput", "ConditionalCommitOptions", "PreparedConditionalCommit"]) {
    if (!client.includes(name)) throw new Error(`installed client declaration is missing ${name}`);
  }
  if (!clientIndex.includes("readonly conditionalCommit?: (request: SerializedConditionalCommitRequest, signal?: AbortSignal) => Promise<CommitHttpResult>;")) {
    throw new Error("installed transport declaration is missing optional conditionalCommit");
  }
  if (!clientIndex.includes("prepareConditionalCommit")) throw new Error("installed client root does not re-export prepareConditionalCommit");
  for (const name of ["CONDITIONAL_COMMIT_VERSION", "CONDITIONAL_COMMIT_DERIVATION_VERSION", "CONDITIONAL_COMMIT_CANONICALIZATION_VERSION", "CONDITIONAL_COMMIT_DOMAIN_SEPARATOR", "ConditionalCommitProtocolError", "canonicalizeConditionalCommitPayload", "computeConditionalCommitFingerprint", "conditionalCommitFingerprintPreimage", "normalizeConditionalCommitKey", "parseSerializedConditionalCommitRequest", "parseSerializedConditionalCommitRequestBody"]) {
    if (!core.includes(name)) throw new Error(`installed core declaration is missing ${name}`);
  }
}
const queryClientFixture = `import { createSekibanExecutor, type SerializedDcbTransport } from "@sekiban/dcb-client";
import type { ListQueryContract, QueryContract, QueryPage } from "@sekiban/dcb-core";

declare const count: QueryContract<{ readonly roomId: string }, { readonly count: number }>;
declare const list: ListQueryContract<{ readonly roomId: string }, { readonly id: string }>;
declare const rawTransport: SerializedDcbTransport;

const executor = createSekibanExecutor({
  readTagState: async () => { throw new Error("unused"); },
  commit: async () => { throw new Error("unused"); },
  query: async () => ({ resultJson: "{}" }),
  listQuery: async () => ({ itemsJson: "[]", totalCount: 0, totalPages: 0, currentPage: 1, pageSize: 20 }),
});

export async function readCount(): Promise<{ readonly count: number }> {
  return executor.query(count, { roomId: "room-1" }, { waitForSortableUniqueId: "wait-1" });
}

export async function readPage(): Promise<QueryPage<{ readonly id: string }>> {
  return executor.listQuery(list, { roomId: "room-1" }, {
    pageNumber: 1,
    pageSize: 20,
    descending: false,
    consistency: "unsafe",
    waitForSortableUniqueId: "wait-2",
  });
}

void rawTransport;
`;
const queryClientNegative = `import { createSekibanExecutor, type SerializedDcbTransport } from "@sekiban/dcb-client";
import type { ListQueryContract, QueryContract, QueryPage } from "@sekiban/dcb-core";

declare const count: QueryContract<{ readonly roomId: string }, { readonly count: number }>;
declare const list: ListQueryContract<{ readonly roomId: string }, { readonly id: string }>;
declare const rawTransport: SerializedDcbTransport;
declare const handlerQuery: QueryContract<{ readonly roomId: string }, { readonly count: number }> & {
  readonly handleQuery: () => { readonly count: number };
};
declare const handlerList: ListQueryContract<{ readonly roomId: string }, { readonly id: string }> & {
  readonly handleFilter: () => readonly { readonly id: string }[];
  readonly handleSort: (items: readonly { readonly id: string }[]) => readonly { readonly id: string }[];
};

const executor = createSekibanExecutor({
  readTagState: async () => { throw new Error("unused"); },
  commit: async () => { throw new Error("unused"); },
  query: async () => ({ resultJson: "{}" }),
  listQuery: async () => ({ itemsJson: "[]", totalCount: 0, totalPages: 0, currentPage: 1, pageSize: 20 }),
});

const countResult: Promise<{ readonly count: number }> = executor.query(count, { roomId: "r" });
const page: Promise<QueryPage<{ readonly id: string }>> = executor.listQuery(list, { roomId: "r" }, { pageNumber: 1, pageSize: 20 });
// @ts-expect-error [typed-query-param-type]
executor.query(count, { roomId: 1 });
// @ts-expect-error [typed-query-result-type]
const wrongResult: Promise<{ total: number }> = executor.query(count, { roomId: "r" });
// @ts-expect-error [typed-list-rejects-scalar-contract]
executor.listQuery(count, { roomId: "r" });
// @ts-expect-error [typed-query-rejects-list-contract]
executor.query(list, { roomId: "r" });
// @ts-expect-error [typed-list-param-keys]
executor.listQuery(list, { missing: true });
// @ts-expect-error [typed-list-controls-inside-params]
executor.listQuery(list, { roomId: "r", pageNumber: 1 });
// @ts-expect-error [typed-list-page-number-type]
executor.listQuery(list, { roomId: "r" }, { pageNumber: "1" });
// @ts-expect-error [typed-list-consistency-type]
executor.listQuery(list, { roomId: "r" }, { consistency: "maybe" });
// @ts-expect-error [typed-list-item-type]
const wrongPage: Promise<QueryPage<{ name: string }>> = executor.listQuery(list, { roomId: "r" });
// @ts-expect-error [raw-transport-rejects-contract]
void rawTransport.query(count);
// @ts-expect-error [typed-query-rejects-handler]
executor.query(handlerQuery, { roomId: "r" });
// @ts-expect-error [typed-list-rejects-handler]
executor.listQuery(handlerList, { roomId: "r" });
void [countResult, page, wrongResult, wrongPage];
`;
const queryClientExpectations = new Map([
  ["typed-query-param-type", /TS2769:[\s\S]*Type 'number' is not assignable to type 'string'/],
  ["typed-query-result-type", /TS2322: Type 'Promise<\{ readonly count: number; \}>' is not assignable to type 'Promise<\{ total: number; \}>'/],
  ["typed-list-rejects-scalar-contract", /TS2769:[\s\S]*Property 'item' is missing/],
  ["typed-query-rejects-list-contract", /TS2769:[\s\S]*Property 'result' is missing/],
  ["typed-list-param-keys", /TS2769:[\s\S]*'missing' does not exist in type '\{ readonly roomId: string; \}'/],
  ["typed-list-controls-inside-params", /TS2769:[\s\S]*'pageNumber' does not exist in type '\{ readonly roomId: string; \}'/],
  ["typed-list-page-number-type", /TS2322: Type 'string' is not assignable to type 'number'/],
  ["typed-list-consistency-type", /TS2322: Type '"maybe"' is not assignable to type '"(?:safe|unsafe)" \| "(?:safe|unsafe)" \| undefined'/],
  ["typed-list-item-type", /TS2322:[\s\S]*Property 'name' is missing in type '\{ readonly id: string; \}'/],
  ["raw-transport-rejects-contract", /TS2345:[\s\S]*queryType/],
  ["typed-query-rejects-handler", /TS2769:[\s\S]*Types of property 'handleQuery' are incompatible[\s\S]*not assignable to type 'undefined'/],
  ["typed-list-rejects-handler", /TS2769:[\s\S]*Types of property 'handleFilter' are incompatible[\s\S]*not assignable to type 'undefined'/],
]);
if (/\bzod\b|@sekiban\/dcb-domain|handleQuery|handleFilter|handleSort/.test(queryClientFixture) || /\bzod\b|@sekiban\/dcb-domain/.test(queryClientNegative)) {
  throw new Error("query-client.ts must import only structural contracts from @sekiban/dcb-core");
}
const conditionalCommitFixture = `import { createHttpTransport, createInProcessTransport, createSekibanExecutor, prepareConditionalCommit, type ConditionalCommitInput, type PreparedConditionalCommit, type SerializedDcbTransport } from "@sekiban/dcb-client";
import { defineEvent, type JsonValue, type SerializedConditionalCommitRequest } from "@sekiban/dcb-core";

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const preparedSignature: Equals<typeof prepareConditionalCommit, <T extends JsonValue>(input: ConditionalCommitInput<T>) => PreparedConditionalCommit> = true;
const event = defineEvent<{ readonly roomId: string }>("RoomOpened");
const prepared = prepareConditionalCommit({
  idempotencyKey: "key",
  event,
  payload: { roomId: "room-1" },
  tag: "room:room-1",
});
const withMember: SerializedDcbTransport = {
  readTagState: async () => { throw new Error("unused"); },
  commit: async () => { throw new Error("unused"); },
  query: async () => ({ resultJson: "{}" }),
  listQuery: async () => ({ itemsJson: "[]", totalCount: 0, totalPages: 0, currentPage: 1, pageSize: 20 }),
  conditionalCommit: async (request: SerializedConditionalCommitRequest) => ({ status: 501, body: request.idempotencyKey }),
};
const withoutMember: SerializedDcbTransport = {
  readTagState: async () => { throw new Error("unused"); },
  commit: async () => { throw new Error("unused"); },
  query: async () => ({ resultJson: "{}" }),
  listQuery: async () => ({ itemsJson: "[]", totalCount: 0, totalPages: 0, currentPage: 1, pageSize: 20 }),
};
const missingMemberExecutor = createSekibanExecutor(withoutMember);
void [preparedSignature, prepared, withMember.conditionalCommit, withoutMember.conditionalCommit, missingMemberExecutor];

export async function runConditionalDispatch(): Promise<string> {
  const seen: string[] = [];
  const unsupported = {
    version: 1,
    outcome: "Unsupported" as const,
    code: "conditional_commit_unsupported",
    error: "Conditional commit is not supported by this deployment.",
    retryable: false,
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    seen.push(new URL(String(input)).pathname + " " + (init?.method ?? ""));
    return new Response(JSON.stringify(unsupported), { status: 501, headers: { "content-type": "application/json" } });
  };
  const http = createHttpTransport({ baseUrl: "https://example.test", fetch: fetchImpl });
  const inProcess = createInProcessTransport({ fetch: fetchImpl });
  const executor = createSekibanExecutor(http);
  const held = executor.prepareConditionalCommit({
    idempotencyKey: "dispatch",
    event,
    payload: { roomId: "room-1" },
    tag: "room:room-1",
  });
  const result = await executor.commitPreparedConditionally(held);
  if (result.outcome !== "Unsupported") throw new Error("facade outcome");
  await http.conditionalCommit?.(held);
  await inProcess.conditionalCommit?.(held);
  if (seen.length !== 3 || seen.some((entry) => entry !== "/api/sekiban/serialized/conditional-commit POST")) {
    throw new Error("conditional posts " + seen.join(","));
  }
  return "conditional-dispatch-ok";
}
`;
const conditionalCommitNegative = `import { createSekibanExecutor, prepareConditionalCommit, type PreparedConditionalCommit, type SerializedDcbTransport } from "@sekiban/dcb-client";
import { defineEvent, type SerializedConditionalCommitRequest } from "@sekiban/dcb-core";

const event = defineEvent<{ readonly ok: boolean }>("Evt");
const prepared = prepareConditionalCommit({
  idempotencyKey: "key",
  event,
  payload: { ok: true },
  tag: "T:1",
});
const executor = createSekibanExecutor({
  readTagState: async () => { throw new Error("unused"); },
  commit: async () => { throw new Error("unused"); },
  query: async () => ({ resultJson: "{}" }),
  listQuery: async () => ({ itemsJson: "[]", totalCount: 0, totalPages: 0, currentPage: 1, pageSize: 20 }),
});
// @ts-expect-error [conditional-version-2]
const version2: SerializedConditionalCommitRequest = { version: 2, idempotencyKey: "key", eventCandidate: prepared.eventCandidate };
// @ts-expect-error [conditional-two-tags]
const twoTags: SerializedConditionalCommitRequest = { version: 1, idempotencyKey: "key", eventCandidate: { payload: "e30=", eventPayloadName: "Evt", tags: ["A:1", "B:2"] } };
// @ts-expect-error [conditional-plain-not-prepared]
const plainPrepared: PreparedConditionalCommit = { version: 1, idempotencyKey: "key", eventCandidate: prepared.eventCandidate };
// @ts-expect-error [conditional-prepared-readonly]
prepared.idempotencyKey = "other";
const mismatched: SerializedDcbTransport = {
  readTagState: async () => { throw new Error("unused"); },
  commit: async () => { throw new Error("unused"); },
  query: async () => ({ resultJson: "{}" }),
  listQuery: async () => ({ itemsJson: "[]", totalCount: 0, totalPages: 0, currentPage: 1, pageSize: 20 }),
  // @ts-expect-error [conditional-member-request-type]
  conditionalCommit: async (_request: { readonly version: 2 }) => ({ status: 501 }),
};
void [version2, twoTags, plainPrepared, mismatched, executor];
`;
const conditionalCommitExpectations = new Map([
  ["conditional-version-2", /TS2322:[\s\S]*Type '2' is not assignable to type '1'/],
  ["conditional-two-tags", /TS2322:[\s\S]*readonly \[string\]/],
  ["conditional-plain-not-prepared", /TS2322:[\s\S]*preparedConditionalCommitBrand/],
  ["conditional-prepared-readonly", /TS2540: Cannot assign to 'idempotencyKey' because it is a read-only property/],
  ["conditional-member-request-type", /TS2322:[\s\S]*SerializedConditionalCommitRequest/],
]);
const deepImports = [
  ["dcb-core", `import { assertJsonValue } from "@sekiban/dcb-core/dist/index.js"; console.log(assertJsonValue);`],
  ["dcb-domain", `import { command } from "@sekiban/dcb-domain/dist/index.js"; console.log(command);`],
  ["dcb-client", `import { createSekibanExecutor } from "@sekiban/dcb-client/dist/index.js"; console.log(createSekibanExecutor);`],
];
const redReceipts = [];
const compileNegativeReceipts = [];
const packageManifestPath = join(root, "packages", "dcb-core", "package.json");
const originalManifest = await readFile(packageManifestPath, "utf8");
for (const packageName of ["dcb-core", "dcb-client"]) {
  const packageRoot = join(root, "packages", packageName);
  const strayPath = join(packageRoot, ".g64-stray-file-probe");
  try {
    await writeFile(strayPath, "intentional C-12 red probe\n");
    const result = await run(process.execPath, [packGuard], root, { expectFailure: true });
    if (!/SDT-G64 pack guard:/.test(`${result.stdout}\n${result.stderr}`)) throw new Error(`G64 ${packageName} stray-file red probe lacked the expected guard`);
    redReceipts.push({ label: `${packageName}-stray-file`, status: result.status, expected: "pack guard rejected unexpected package entry" });
  } finally {
    await unlink(strayPath).catch(() => {});
  }
}
try {
  await writeFile(packageManifestPath, originalManifest.replace('"private": false', '"private": true'));
  const result = await run(process.execPath, [packGuard], root, { expectFailure: true });
  if (!/SDT-G64 pack guard:/.test(`${result.stdout}\n${result.stderr}`)) throw new Error("G64 private-manifest red probe lacked the expected guard");
  redReceipts.push({ label: "pre-change-private-manifest", status: result.status, expected: "pack guard rejected private package" });
} finally {
  await writeFile(packageManifestPath, originalManifest);
}

const temp = await mkdtemp(join(tmpdir(), "sdt-g64-consumer-"));
try {
  await writeFile(join(temp, "package.json"), JSON.stringify({ private: true, type: "module" }, null, 2));
  await mkdir(join(temp, "src"), { recursive: true });
  await writeFile(join(temp, "tsconfig.node16.json"), tsconfig("Node16", "Node16", "dist-node16"));
  await writeFile(join(temp, "tsconfig.bundler.json"), tsconfig("ESNext", "Bundler", "dist-bundler"));
  await writeFile(join(temp, "src", "main.ts"), consumer);
  await writeFile(join(temp, "src", "query-authoring.ts"), queryAuthoring);
  await writeFile(join(temp, "src", "query-client.ts"), queryClientFixture);
  await writeFile(join(temp, "src", "query-client-negative.ts"), queryClientNegative);
  await writeFile(join(temp, "src", "conditional-commit.ts"), conditionalCommitFixture);
  await writeFile(join(temp, "src", "conditional-commit-negative.ts"), conditionalCommitNegative);
  await writeFile(join(temp, "src", "unsupported-modes.ts"), `
import type { ListQueryOptions, ListQueryRequest, SekibanExecutor } from "@sekiban/dcb-client";
import type { ProjectorLike, Tag } from "@sekiban/dcb-domain";
declare const executor: SekibanExecutor;
declare const projector: ProjectorLike;
declare const tag: Tag;
declare const request: ListQueryRequest;
const safe: ListQueryOptions = { consistency: "safe" };
const unsafe: ListQueryOptions = { consistency: "unsafe" };
void executor.listQuery(request, safe);
void executor.listQuery(request, unsafe);
// @ts-expect-error consistency is listQuery-only
void executor.readState(projector, tag, { consistency: "safe" });
// @ts-expect-error consistency is listQuery-only
void executor.exists(tag, { consistency: "unsafe" });
// @ts-expect-error consistency is listQuery-only
void executor.query(request, { consistency: "safe" });
`);
  await mkdir(join(temp, "compile-negative"), { recursive: true });
  await writeFile(join(temp, "compile-negative", "query-authoring-blanked.ts"), blankQueryDirectives(queryAuthoring));
  await writeFile(join(temp, "compile-negative", "query-client-negative-blanked.ts"), blankQueryDirectives(queryClientNegative));
  await writeFile(join(temp, "compile-negative", "conditional-commit-negative-blanked.ts"), blankQueryDirectives(conditionalCommitNegative));
  await writeFile(join(temp, "compile-negative", "unsupported-modes-raw.ts"), `
import type { ListQueryRequest, SekibanExecutor } from "@sekiban/dcb-client";
import type { ProjectorLike, Tag } from "@sekiban/dcb-domain";
declare const executor: SekibanExecutor;
declare const projector: ProjectorLike;
declare const tag: Tag;
declare const request: ListQueryRequest;
void executor.readState(projector, tag, { consistency: "safe" });
void executor.exists(tag, { consistency: "unsafe" });
void executor.query(request, { consistency: "safe" });
`);
  for (const [packageName, source] of deepImports) await writeFile(join(temp, `deep-import-${packageName}.ts`), source);

  const tarballs = [];
  for (const packageRoot of packageRoots) {
    const packed = JSON.parse((await run("npm", ["pack", "--json", "--pack-destination", temp], packageRoot)).stdout);
    tarballs.push(join(temp, packed[0].filename));
  }
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarballs[0], tarballs[1], "typescript@5.9.3"], temp);
  await assertInstalledQueryContracts(temp);
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarballs[2]], temp);
  await assertInstalledConditionalDeclarations(temp);
  const tsc = join(temp, "node_modules", ".bin", "tsc");
  await run(tsc, ["-p", "tsconfig.node16.json"], temp);
  await run(tsc, ["-p", "tsconfig.bundler.json"], temp);
  for (const output of ["dist-node16/conditional-commit.js", "dist-bundler/conditional-commit.js"]) {
    await run("node", ["--input-type=module", "-e", `import { runConditionalDispatch } from "./${output}"; if (await runConditionalDispatch() !== "conditional-dispatch-ok") throw new Error("conditional dispatch");`], temp);
  }
  const queryRejections = await proveQueryFixture({
    tsc,
    cwd: temp,
    source: queryAuthoring,
    blankedPath: "compile-negative/query-authoring-blanked.ts",
    fileName: "query-authoring-blanked.ts",
    expectations: queryExpectations,
  });
  const queryClientRejections = await proveQueryFixture({
    tsc,
    cwd: temp,
    source: queryClientNegative,
    blankedPath: "compile-negative/query-client-negative-blanked.ts",
    fileName: "query-client-negative-blanked.ts",
    expectations: queryClientExpectations,
  });
  const conditionalCommitRejections = await proveQueryFixture({
    tsc,
    cwd: temp,
    source: conditionalCommitNegative,
    blankedPath: "compile-negative/conditional-commit-negative-blanked.ts",
    fileName: "conditional-commit-negative-blanked.ts",
    expectations: conditionalCommitExpectations,
  });
  for (const resolution of [["Node16", "Node16", "Node16"], ["Bundler", "ESNext", "Bundler"]]) {
    const [label, module, moduleResolution] = resolution;
    await run(tsc, ["--noEmit", "--target", "ES2022", "--module", module, "--moduleResolution", moduleResolution, "--strict", "--skipLibCheck", "src/unsupported-modes.ts"], temp);
    const rawNegative = await run(tsc, ["--noEmit", "--target", "ES2022", "--module", module, "--moduleResolution", moduleResolution, "--strict", "--skipLibCheck", "compile-negative/unsupported-modes-raw.ts"], temp, { expectFailure: true });
    compileNegativeReceipts.push({ label: `unsupported-consistency-${label}`, status: rawNegative.status, expected: "tag-state/exists/query consistency options rejected", typePositive: ["listQuery safe", "listQuery unsafe"] });
  }
  const node16 = await run("node", ["dist-node16/main.js"], temp);
  const bundler = await run("node", ["dist-bundler/main.js"], temp);
  const esbuild = join(root, "node_modules", ".bin", "esbuild");
  await run(esbuild, ["src/main.ts", "--bundle", "--format=esm", "--platform=node", "--outfile=dist-bundler/bundle.js"], temp);
  const bundled = await run("node", ["dist-bundler/bundle.js"], temp);

  for (const resolution of [["Node16", "Node16", "Node16"], ["Bundler", "ESNext", "Bundler"]]) {
    const [label, module, moduleResolution] = resolution;
    for (const [packageName] of deepImports) {
      const sourceFile = `deep-import-${packageName}.ts`;
      const result = await run(tsc, ["--noEmit", "--target", "ES2022", "--module", module, "--moduleResolution", moduleResolution, "--strict", "--skipLibCheck", sourceFile], temp, { expectFailure: true });
      const output = `${result.stdout}\n${result.stderr}`;
      if (!/(not exported|cannot find module|not found|exports)/i.test(output)) throw new Error(`${label} ${packageName} shipped deep-import rejection had an unexpected diagnostic:\n${output}`);
      redReceipts.push({ label: `shipped-dist-deep-import-${packageName}-${label}`, status: result.status, expected: `package exports rejected @sekiban/${packageName}/dist/index.js` });
    }
  }
  console.log(JSON.stringify({
    status: "PASS",
    greenReceipts: ["Node16 consumer compile/runtime", "Bundler consumer compile/runtime", "esbuild consumer bundle/runtime", "portable readState-to-snapshot-only workflow", "local core query contracts", "Node16 and Bundler query authoring positives and labelled negatives", "Node16 and Bundler typed query client overloads"],
    queryRejections,
    queryClientRejections,
    conditionalCommitRejections,
    rawV1Receipts: [node16.stdout.trim(), bundler.stdout.trim(), bundled.stdout.trim()],
    redReceipts,
    compileNegativeReceipts,
  }, null, 2));
} finally {
  if (process.env.SDT_G64_KEEP_TEMP === "1") console.error(`kept consumer temp directory: ${temp}`);
  else await rm(temp, { recursive: true, force: true });
}
