import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(root, "packages", "dcb-domain");
const packGuard = join(root, "scripts", "dcb-domain-pack-check.mjs");

function run(command, args, cwd, { expectFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
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

const tsconfig = (module, moduleResolution, outDir, noEmit = false) => JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module,
    moduleResolution,
    strict: true,
    skipLibCheck: true,
    noEmit,
    ...(noEmit ? {} : { outDir }),
  },
  include: ["src/**/*.ts"],
}, null, 2);

const consumer = `
import { command, done, domain, event, none, projector, read, readExists, readSet, reject, Session, tagFamily, toRuntimeDomain } from "@sekiban/dcb-domain";
import type { PortableSnapshot } from "@sekiban/dcb-domain";
import { given, evolveTable } from "@sekiban/dcb-domain/testing";
import { z } from "zod";

const rooms = tagFamily("room");
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
  handle: async (_input, context) => { void context; return done({ accepted: true }); },
});
const authored = domain({ events: [opened], projectors: [roomProjector], commands: [open] });
toRuntimeDomain(authored);
const tag = rooms.of("consumer");
const portableSnapshot: PortableSnapshot = { projectorId: roomProjector.id, tag, head: "head-1", state: { status: "empty" }, exists: false };
const reader = {
  read: () => portableSnapshot,
  exists: () => false,
  head: () => null,
};
const session = new Session({
  now: 1,
  readSet: readSet(read(roomProjector, tag), readExists(tag)),
  snapshots: reader,
});
await session.preload();
if (session.status !== "OPEN") throw new Error("Session did not remain open");
const decisions = [done(), done({ accepted: true }), none("no-op"), reject("validation", "invalid")];
if (decisions.length !== 4) throw new Error("Decision surface check failed");
await given(roomProjector).when(open, { roomId: "consumer" }).expect("done");
evolveTable(roomProjector, [{
  name: "opened",
  state: { status: "empty" },
  event: { eventType: "RoomOpened", eventName: "RoomOpened", payload: { roomId: "consumer" }, tags: [tag], ordinal: "0001" },
  expected: { status: "open" },
}]);
console.log("PASS clean consumer runtime");
`;


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
const shippedDeepImport = `import { command } from "@sekiban/dcb-domain/dist/index.js";\nconsole.log(command);\n`;

async function expectedPackGuardFailure(label, mutate) {
  const result = await mutate();
  const output = `${result.stdout}\n${result.stderr}`;
  if (!/SDT-G59 pack guard:/.test(output)) {
    throw new Error(`${label} did not produce the pack-guard failure receipt:\n${output}`);
  }
  const reasonLine = output.split(/\r?\n/).find((line) => /Error: SDT-G59 pack guard:/.test(line));
  return {
    label,
    status: result.status,
    reason: reasonLine?.replace(/^.*Error: /, "") ?? "pack guard rejected as expected",
  };
}

const redReceipts = [];
const packageManifestPath = join(packageRoot, "package.json");
const packageManifest = await readFile(packageManifestPath, "utf8");
const strayPath = join(packageRoot, ".g59-stray-file-probe");

try {
  await writeFile(strayPath, "intentional C-12 red probe\n");
  redReceipts.push(await expectedPackGuardFailure("stray-file", () => run(process.execPath, [packGuard], root, { expectFailure: true })));
} finally {
  await unlink(strayPath).catch(() => {});
}

try {
  await writeFile(packageManifestPath, packageManifest.replace('"private": false', '"private": true'));
  redReceipts.push(await expectedPackGuardFailure("pre-change-private-manifest", () => run(process.execPath, [packGuard], root, { expectFailure: true })));
} finally {
  await writeFile(packageManifestPath, packageManifest);
}

const temp = await mkdtemp(join(tmpdir(), "sdt-g59-consumer-"));
try {
  await writeFile(join(temp, "package.json"), JSON.stringify({ private: true, type: "module" }, null, 2));
  await mkdir(join(temp, "src"), { recursive: true });
  await writeFile(join(temp, "tsconfig.node16.json"), tsconfig("Node16", "Node16", "dist-node16"));
  await writeFile(join(temp, "tsconfig.bundler.json"), tsconfig("ESNext", "Bundler", "dist-bundler"));
  await mkdir(join(temp, "compile-negative"), { recursive: true });
  await writeFile(join(temp, "src", "main.ts"), consumer);
  await writeFile(join(temp, "src", "query-authoring.ts"), queryAuthoring);
  await writeFile(join(temp, "compile-negative", "query-authoring-blanked.ts"), blankQueryDirectives(queryAuthoring));
  await writeFile(join(temp, "deep-import.ts"), shippedDeepImport);
  await writeFile(join(temp, "shipped-deep-import.ts"), shippedDeepImport);

  const coreRoot = join(root, "packages", "dcb-core");
  const packedCore = JSON.parse((await run("npm", ["pack", "--json", "--pack-destination", temp], coreRoot)).stdout);
  const coreTarball = join(temp, packedCore[0].filename);
  const packed = JSON.parse((await run("npm", ["pack", "--json", "--pack-destination", temp], packageRoot)).stdout);
  const tarball = join(temp, packed[0].filename);
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", coreTarball, tarball, "typescript@5.9.3"], temp);
  await assertInstalledQueryContracts(temp);

  const domainTsc = join(temp, "node_modules", ".bin", "tsc");
  await run(domainTsc, ["-p", "tsconfig.node16.json"], temp);
  await run(domainTsc, ["-p", "tsconfig.bundler.json"], temp);
  const queryRejections = await proveQueryFixture({
    tsc: domainTsc,
    cwd: temp,
    source: queryAuthoring,
    blankedPath: "compile-negative/query-authoring-blanked.ts",
    fileName: "query-authoring-blanked.ts",
    expectations: queryExpectations,
  });
  await run("node", ["dist-node16/main.js"], temp);
  await run("node", ["dist-bundler/main.js"], temp);
  await run(join(root, "node_modules", ".bin", "esbuild"), ["src/main.ts", "--bundle", "--format=esm", "--platform=node", "--outfile=dist-bundler/bundle.js"], temp);
  await run("node", ["dist-bundler/bundle.js"], temp);

  const deepNode16 = await run(join(temp, "node_modules", ".bin", "tsc"), ["--noEmit", "--target", "ES2022", "--module", "Node16", "--moduleResolution", "Node16", "--strict", "--skipLibCheck", "deep-import.ts"], temp, { expectFailure: true });
  const deepBundler = await run(join(temp, "node_modules", ".bin", "tsc"), ["--noEmit", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--strict", "--skipLibCheck", "shipped-deep-import.ts"], temp, { expectFailure: true });
  for (const [label, result] of [["Node16", deepNode16], ["Bundler", deepBundler]]) {
    const output = `${result.stdout}\n${result.stderr}`;
    if (!/(not exported|cannot find module|not found|exports)/i.test(output)) {
      throw new Error(`${label} shipped deep import failed for an unexpected reason:\n${output}`);
    }
  }
  redReceipts.push({
    label: "shipped-dist-deep-import-node16-and-bundler",
    status: 1,
    reason: "package exports rejected @sekiban/dcb-domain/dist/index.js in both resolutions",
  });
  console.log(JSON.stringify({
    status: "PASS",
    greenReceipts: [
      "Node16 emitted consumer compile/runtime",
      "Bundler emitted consumer compile/runtime",
      "local core tarball supplies QueryContract",
      "Node16 and Bundler query authoring positives and labelled negatives",
      "esbuild bundle runtime",
      "Node16 and Bundler shipped dist deep-import rejection",
    ],
    redReceipts,
    queryRejections,
  }));
} finally {
  await rm(temp, { recursive: true, force: true });
}
