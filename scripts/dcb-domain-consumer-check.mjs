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
  await writeFile(join(temp, "src", "main.ts"), consumer);
  await writeFile(join(temp, "deep-import.ts"), shippedDeepImport);
  await writeFile(join(temp, "shipped-deep-import.ts"), shippedDeepImport);

  const packed = JSON.parse((await run("npm", ["pack", "--json", "--pack-destination", temp], packageRoot)).stdout);
  const tarball = join(temp, packed[0].filename);
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarball, "typescript@5.9.3"], temp);

  await run(join(temp, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.node16.json"], temp);
  await run(join(temp, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.bundler.json"], temp);
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
      "esbuild bundle runtime",
      "Node16 and Bundler shipped dist deep-import rejection",
    ],
    redReceipts,
  }));
} finally {
  await rm(temp, { recursive: true, force: true });
}
