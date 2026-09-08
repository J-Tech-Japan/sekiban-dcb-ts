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
    compilerOptions: { target: "ES2022", module, moduleResolution, strict: true, skipLibCheck: true, outDir },
    include: ["src/**/*.ts"],
  }, null, 2);
}

const consumer = `
import { createHttpTransport, createSekibanExecutor } from "@sekiban/dcb-client";
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
equal(commit.rawBody, expectedCommitBody);
const actualBytes = Array.from(new TextEncoder().encode(commit.rawBody));
const expectedBytes = Array.from(new TextEncoder().encode(expectedCommitBody));
deepEqual(actualBytes, expectedBytes);
console.log(JSON.stringify({ status: "PASS", rawV1Body: commit.rawBody, rawV1Bytes: actualBytes }));
`;

const deepImports = [
  ["dcb-core", `import { assertJsonValue } from "@sekiban/dcb-core/dist/index.js"; console.log(assertJsonValue);`],
  ["dcb-domain", `import { command } from "@sekiban/dcb-domain/dist/index.js"; console.log(command);`],
  ["dcb-client", `import { createSekibanExecutor } from "@sekiban/dcb-client/dist/index.js"; console.log(createSekibanExecutor);`],
];
const redReceipts = [];
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
  for (const [packageName, source] of deepImports) await writeFile(join(temp, `deep-import-${packageName}.ts`), source);

  const tarballs = [];
  for (const packageRoot of packageRoots) {
    const packed = JSON.parse((await run("npm", ["pack", "--json", "--pack-destination", temp], packageRoot)).stdout);
    tarballs.push(join(temp, packed[0].filename));
  }
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarballs[0], tarballs[1], "typescript@5.9.3"], temp);
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarballs[2]], temp);
  const tsc = join(temp, "node_modules", ".bin", "tsc");
  await run(tsc, ["-p", "tsconfig.node16.json"], temp);
  await run(tsc, ["-p", "tsconfig.bundler.json"], temp);
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
    greenReceipts: ["Node16 consumer compile/runtime", "Bundler consumer compile/runtime", "esbuild consumer bundle/runtime"],
    rawV1Receipts: [node16.stdout.trim(), bundler.stdout.trim(), bundled.stdout.trim()],
    redReceipts,
  }, null, 2));
} finally {
  if (process.env.SDT_G64_KEEP_TEMP === "1") console.error(`kept consumer temp directory: ${temp}`);
  else await rm(temp, { recursive: true, force: true });
}
