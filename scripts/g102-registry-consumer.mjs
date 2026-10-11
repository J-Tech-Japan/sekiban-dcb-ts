import { spawnSync } from "node:child_process";
import { realpathSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const liveWorker = "sekiban-dcb-meeting-room-cloudflare-only";
const published = [
  "@sekiban/dcb-core",
  "@sekiban/dcb-domain",
  "@sekiban/dcb-client",
  "@sekiban/dcb-runtime",
];
const forbiddenSource = [
  "meeting-room",
  liveWorker,
  "sekiban-dcb-meeting-room-cloudflare-pipeline",
  "sekiban-dcb-meeting-room-cloudflare-mv",
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
  if (result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    fail(`${command} ${args.join(" ")} failed`);
  }
  return result;
}

function compareVersions(left, right) {
  const parse = (value) => String(value).split(".").map((part) => Number.parseInt(part, 10));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

function publishedVersions(name) {
  const result = spawnSync("npm", ["view", name, "versions", "--json", "--registry", "https://registry.npmjs.org"], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
  });
  if (result.status !== 0) fail(`could not read published versions for ${name}: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function resolvePublishedMatchedVersion() {
  const sets = published.map((name) => new Set(publishedVersions(name)));
  const common = [...sets[0]].filter((version) => sets.every((set) => set.has(version)));
  common.sort(compareVersions);
  if (common.length === 0) fail("matched packages have no common published version");
  return common.at(-1);
}

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

async function request(handler, path, init = {}) {
  return handler(new Request(`https://caller.example${path}`, init), {}, {});
}

async function helperProbes() {
  const lib = await import(pathToFileURL(join(root, "packages/dcb-cloudflare/dist/compose.js")).href);
  const cli = await import(pathToFileURL(join(root, "packages/dcb-cloudflare/dist/cli.js")).href);
  const { composeFetch, composeHandlers } = lib;
  const { executeCloudflareCli, planCloudflareCommands } = cli;
  const probes = {};
  const application = async () => new Response("app");
  const seen = [];
  const sekibanFetch = async (request) => {
    seen.push({
      path: new URL(request.url).pathname,
      search: new URL(request.url).search,
      method: request.method,
      header: request.headers.get("x-test"),
      body: await request.text(),
    });
    return new Response("sekiban");
  };
  const mounted = composeFetch({
    application,
    sekiban: { prefix: "/sekiban", fetch: sekibanFetch, authorize: () => true },
  });
  const outside = await request(mounted, "/sekiban-x");
  probes["segment-boundary"] = await outside.text();
  const forwarded = await request(mounted, "/sekiban/api/sekiban/serialized/commit?x=1", {
    method: "POST",
    headers: { "x-test": "kept", "content-type": "text/plain" },
    body: "payload",
  });
  probes["rewritten"] = {
    status: forwarded.status,
    response: await forwarded.text(),
    request: seen[0],
  };
  const blocked = await request(mounted, "/sekiban/operator/repair");
  probes["operator-not-forwarded"] = { status: blocked.status, calls: seen.length };
  const listed = composeFetch({
    application,
    sekiban: { prefix: "/sekiban", fetch: sekibanFetch, authorize: () => true, extraPaths: ["/operator/repair"] },
  });
  const allowedOperator = await request(listed, "/sekiban/operator/repair");
  probes["extra-path"] = { status: allowedOperator.status, calls: seen.length };
  let authorizeThrew = false;
  try {
    composeFetch({ application, sekiban: { prefix: "/sekiban", fetch: sekibanFetch } });
  } catch {
    authorizeThrew = true;
  }
  probes["authorize-required"] = authorizeThrew;
  let called = false;
  const denied = composeFetch({
    application,
    sekiban: {
      prefix: "/sekiban",
      fetch: async () => {
        called = true;
        return new Response("nope");
      },
      authorize: () => new Response("denied", { status: 401 }),
    },
  });
  const denial = await request(denied, "/sekiban/api/sekiban/serialized/query");
  probes["authorize-denial"] = { status: denial.status, body: await denial.text(), called };
  const plain = composeFetch({ application });
  probes["no-mount"] = await (await request(plain, "/sekiban/api/sekiban/serialized/commit")).text();
  let swallowed = false;
  try {
    composeFetch({ application, sekiban: { prefix: "/", fetch: sekibanFetch, authorize: () => true } });
  } catch {
    swallowed = true;
  }
  probes["prefix-root-refused"] = swallowed;
  let emptyPrefix = false;
  try {
    composeFetch({ application, sekiban: { prefix: "", fetch: sekibanFetch, authorize: () => true } });
  } catch {
    emptyPrefix = true;
  }
  probes["prefix-empty-refused"] = emptyPrefix;
  const order = [];
  const handlers = composeHandlers({
    application: {
      fetch: application,
      queue: async () => { order.push("app-queue"); },
      scheduled: async () => { order.push("app-scheduled"); },
    },
    sekiban: {
      prefix: "/sekiban",
      fetch: sekibanFetch,
      authorize: () => true,
      queue: async () => { order.push("runtime-queue"); },
      scheduled: async () => { order.push("runtime-scheduled"); },
    },
  });
  await handlers.queue({}, {}, {});
  await handlers.scheduled({}, {}, {});
  let runtimeFailed = false;
  let appAfterFailure = false;
  const failing = composeHandlers({
    application: { fetch: application, queue: async () => { appAfterFailure = true; } },
    sekiban: {
      prefix: "/sekiban",
      fetch: sekibanFetch,
      authorize: () => true,
      queue: async () => { throw new Error("runtime-queue"); },
    },
  });
  try {
    await failing.queue({}, {}, {});
  } catch {
    runtimeFailed = true;
  }
  probes["queue-scheduled"] = { order, runtimeFailed, appAfterFailure };
  const config = JSON.stringify({
    d1_databases: [
      { binding: "D1", database_name: "caller-pipeline" },
      { binding: "D1_MV", database_name: "caller-mv" },
    ],
  });
  const spawned = [];
  const missing = await executeCloudflareCli(["migrate"], {
    readText: () => { throw new Error("should-not-read"); },
    spawn: async (request) => { spawned.push(request); return 0; },
  });
  const remote = planCloudflareCommands(["migrate", "--config", "caller.jsonc"], config);
  const deployed = planCloudflareCommands(["deploy", "--config", "caller.jsonc", "--env", "staging"], config);
  let deployLocal = false;
  try {
    planCloudflareCommands(["deploy", "--config", "caller.jsonc", "--local"], config);
  } catch (error) {
    deployLocal = error instanceof Error && error.message === "deploy-local";
  }
  const kept = planCloudflareCommands(["deploy", "--config", "caller.jsonc", "--keep-vars"], config);
  const passed = planCloudflareCommands(["deploy", "--config", "caller.jsonc", "--", "--strict"], config);
  probes["cli"] = {
    missingConfig: missing.exitCode,
    spawned: spawned.length,
    remote,
    deployed,
    deployLocal,
    keepVars: kept.at(-1),
    extra: passed.at(-1),
  };
  const helperManifest = JSON.parse(readFileSync(join(root, "packages/dcb-cloudflare/package.json"), "utf8"));
  const source = walk(join(root, "packages/dcb-cloudflare/src")).map((path) => readFileSync(path, "utf8")).join("\n");
  probes["package"] = {
    name: helperManifest.name,
    private: helperManifest.private,
    license: helperManifest.license,
    dependency: helperManifest.dependencies["@sekiban/dcb-runtime"],
    fileDeps: JSON.stringify(helperManifest).includes("file:") || JSON.stringify(helperManifest).includes("workspace:"),
    forbidden: forbiddenSource.filter((needle) => source.includes(needle)),
  };
  const matched = readFileSync(join(root, "scripts/dcb-matched-set-release-check.mjs"), "utf8");
  probes["matched-set"] = !matched.includes("@sekiban/dcb-cloudflare") && !matched.includes("\"dcb-cloudflare\"");
  return probes;
}

async function registryProof() {
  if (process.env.G32_DEPLOY_LIVE === "1") fail("refusing while G32_DEPLOY_LIVE=1");
  const fixtureDir = join(root, "scripts/fixtures/g102-registry-consumer");
  const workerSource = await readFile(join(fixtureDir, "worker.ts"), "utf8");
  const wranglerText = await readFile(join(fixtureDir, "wrangler.jsonc"), "utf8");
  if (workerSource.includes("@sekiban/dcb-cloudflare")) fail("fixture is matched-set only and must not import the optional helper");
  if (wranglerText.includes(liveWorker)) fail("fixture must not name the live worker");
  if (!workerSource.includes('pathname === "/app"')) fail("fixture is missing its own /app route");
  const dir = await mkdtemp(join(tmpdir(), "sdt-g102-"));
  const commonVersion = resolvePublishedMatchedVersion();
  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({
      name: "sdt-g102-registry-consumer",
      private: true,
      dependencies: Object.fromEntries(published.map((name) => [name, commonVersion])),
    }));
    run("npm", ["install", "--no-package-lock", "--ignore-scripts", "--registry", "https://registry.npmjs.org"], { cwd: dir });
    const listed = JSON.parse(run("npm", ["ls", "--json", "--prefix", dir], { cwd: dir }).stdout);
    const packagesRoot = realpathSync(join(root, "packages"));
    const resolved = {};
    for (const name of published) {
      const fromRegistry = listed.dependencies?.[name]?.resolved ?? "";
      const manifestPath = realpathSync(join(dir, "node_modules", name, "package.json"));
      if (!fromRegistry.startsWith("https://registry.npmjs.org/") || fromRegistry.startsWith("file:")) {
        fail(`${name} did not resolve from the registry: ${fromRegistry}`);
      }
      if (manifestPath.startsWith(packagesRoot) || !manifestPath.startsWith(realpathSync(dir))) {
        fail(`${name} resolved inside the repo: ${manifestPath}`);
      }
      const installedVersion = JSON.parse(readFileSync(manifestPath, "utf8")).version;
      if (installedVersion !== commonVersion) fail(`${name} installed at ${installedVersion}, expected the common published version ${commonVersion}`);
      resolved[name] = fromRegistry;
    }
    await writeFile(join(dir, "worker.ts"), workerSource);
    await writeFile(join(dir, "wrangler.jsonc"), wranglerText);
    const outdir = join(dir, "out");
    await mkdir(outdir);
    const args = ["deploy", "--config", join(dir, "wrangler.jsonc"), "--dry-run", "--outdir", outdir, "--outfile", join(outdir, "worker.js")];
    if (!args.includes("--dry-run") || args.includes(liveWorker)) fail("dry-run command is not safe");
    const env = { ...process.env, CI: "true" };
    delete env.CLOUDFLARE_API_TOKEN;
    delete env.G32_DEPLOY_LIVE;
    const wrangler = join(root, "node_modules/wrangler/bin/wrangler.js");
    if (!existsSync(wrangler)) fail("wrangler is not installed");
    const deployed = spawnSync(process.execPath, [wrangler, ...args], { cwd: dir, env, encoding: "utf8" });
    if (deployed.status !== 0) {
      process.stderr.write(deployed.stdout ?? "");
      process.stderr.write(deployed.stderr ?? "");
      fail("registry dry-run failed");
    }
    const bundle = await readFile(join(outdir, "worker.js"), "utf8");
    if (!bundle.includes("g102-app-marker")) fail("dry-run bundle is missing the fixture route marker");
    return { version: commonVersion, resolved, marker: "g102-app-marker", worker: "sdt-g102-registry-consumer" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (!process.argv.includes("--check")) fail("usage: node scripts/g102-registry-consumer.mjs --check");
run("npm", ["run", "build", "-w", "@sekiban/dcb-runtime"]);
run("npm", ["run", "build", "-w", "@sekiban/dcb-cloudflare"]);
const probes = await helperProbes();
const registry = await registryProof();
const migrateScript = readFileSync(join(root, "samples/meeting-room/scripts/migrate-remote.sh"), "utf8");
const g99 = readFileSync(join(root, "scripts/deploy/npm-consumer-deploy.sh"), "utf8");
const transport = readFileSync(join(root, "samples/meeting-room/src/transport.ts"), "utf8");
if (!transport.includes('case "create-room"')) fail("sample command route moved");
const deployScript = readFileSync(join(root, "samples/meeting-room/scripts/deploy.sh"), "utf8");
const g20 = readFileSync(join(root, "scripts/deploy/cloudflare-only-deploy.sh"), "utf8");
const sampleCallsHelper = [migrateScript, deployScript, g20].every((script) => script.includes("packages/dcb-cloudflare/dist/cli.js") && script.includes("wrangler.cloudflare-only.jsonc"));
if (!sampleCallsHelper) fail("sample migrate/deploy does not call the helper");
console.log(JSON.stringify({
  result: "g102-published-consumer-check-passed",
  probes,
  registry,
  sampleCallsHelper,
  g99PacksWorktree: g99.includes("npm pack"),
  sampleRouteRemains: true,
}));
