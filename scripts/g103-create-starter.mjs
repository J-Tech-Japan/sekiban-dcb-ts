#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registry = "https://registry.npmjs.org";
const expectedHelperVersion = packageJson(join(root, "packages/dcb-cloudflare/package.json")).version;
const liveWorker = "sekiban-dcb-meeting-room-cloudflare-only";
// Keep the forbidden-resource check independent of the literal IDs. The
// values are intentionally represented only by digests so the guard cannot
// reintroduce private resource identifiers into this public tree.
const liveDatabaseIdDigests = new Set([
  "7288bf125a1f49e88b8bfd1c76fa3ab24294845454b968bad94dd4ed28722442",
  "b5f348694a36c5c3aa9475374d6852a3a28d1633ec4e620abd97c255a378186e",
  "06c3a6da88a09bf01c2e4d6130b57880b4a920bdf3d6fac41d968c983ec36d89",
  "f595955dabe1d23dd6c505629633d17a066e320681ca8dece81bf089493c3b6a",
]);
const matchedSet = [
  "@sekiban/dcb-core",
  "@sekiban/dcb-domain",
  "@sekiban/dcb-client",
  "@sekiban/dcb-runtime",
];
const requiredFiles = [
  "README.md",
  "REPLACE.md",
  "AGENTS.md",
  "cloudflare.config.ts",
  "package.json",
  "wrangler.jsonc",
  "src/worker.ts",
  "src/booking-domain.ts",
  "src/booking-transport.ts",
  "src/booking-mv.ts",
  "src/booking-routes.ts",
  "public/index.html",
  "public/app.js",
  "public/styles.css",
  "public/.assetsignore",
  "scripts/migrate.sh",
  "scripts/deploy.sh",
];
const removableDemoFiles = [
  "src/booking-domain.ts",
  "src/booking-transport.ts",
  "src/booking-mv.ts",
  "src/booking-routes.ts",
  "public/index.html",
  "public/app.js",
  "public/styles.css",
];
const forbiddenFileFragments = [
  "worker.cloudflare-only",
  "worker.g32-bridge",
  "worker.g38",
  "generated/provider-composition",
  "g32-bridge",
  "mapping-observation",
  "ingress-observation",
  "raw-diagnostics",
  "receiver",
  "tombstone",
  "component-guard",
];
const forbiddenWorkerSource = [
  "provider-composition",
  "rejectUnlessPrimaryComponent",
  "assertFinalCutoverFenceIfConfigured",
  "G32_",
  "ingress-observation",
  "mapping-observation",
  "raw-diagnostics",
  "worker.g38",
  "generated/",
];

function fail(message) {
  throw new Error(`g103-create-starter:${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function assertNoLiveDatabaseIds(text, label, forbiddenDigests = liveDatabaseIdDigests) {
  const tokenPatterns = [
    /(?=([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}))/gi,
    /(?=([0-9a-f]{32}))/gi,
  ];
  for (const tokenPattern of tokenPatterns) {
    for (const match of text.matchAll(tokenPattern)) {
      const token = match[1];
      const digest = createHash("sha256").update(token.toLowerCase()).digest("hex");
      assert(!forbiddenDigests.has(digest), `${label} contains a forbidden database identifier`);
    }
  }
}

function expectForbiddenDatabaseId(text, label, forbiddenDigests = liveDatabaseIdDigests) {
  try {
    assertNoLiveDatabaseIds(text, label, forbiddenDigests);
  } catch (error) {
    if (error instanceof Error && error.message.includes("contains a forbidden database identifier")) return;
    throw error;
  }
  fail(`${label} unexpectedly passed the forbidden database identifier check`);
}

function assertNoLiveDatabaseIdMutants() {
  const syntheticUuid = randomUUID();
  const syntheticHex = randomBytes(16).toString("hex");
  const syntheticForbiddenDigests = new Set([syntheticUuid, syntheticHex].map((token) =>
    createHash("sha256").update(token.toLowerCase()).digest("hex")));
  expectForbiddenDatabaseId(`prefix${syntheticUuid}`, "prefixed database identifier mutant", syntheticForbiddenDigests);
  expectForbiddenDatabaseId(`${syntheticUuid}suffix`, "suffixed database identifier mutant", syntheticForbiddenDigests);
  expectForbiddenDatabaseId(`before_${syntheticHex}_after`, "underscore-joined database identifier mutant", syntheticForbiddenDigests);
  expectForbiddenDatabaseId(`REPLACE_WITH_${syntheticUuid}`, "REPLACE_WITH-prefixed database identifier mutant", syntheticForbiddenDigests);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    fail(`${command} ${args.join(" ")} failed${output.length === 0 ? "" : `: ${output}`}`);
  }
  return result;
}

function walk(dir, prefix = "") {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const name = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...walk(path, name));
    else if (entry.isFile()) files.push(name);
  }
  return files.sort();
}

function parseJsonc(text) {
  return JSON.parse(text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,\s*([}\]])/g, "$1"));
}

function packageJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertInside(rootPath, childPath, label) {
  const rootReal = realpathSync(rootPath);
  const childReal = realpathSync(childPath);
  assert(childReal === rootReal || childReal.startsWith(`${rootReal}${sep}`), `${label} escaped the generated project`);
  return relative(rootReal, childReal) || ".";
}

function resourceNames(projectName) {
  return {
    worker: `${projectName}-worker`,
    service: projectName,
    pipeline: `${projectName}-pipeline`,
    mv: `${projectName}-mv`,
    queue: `${projectName}-outbox`,
    dlq: `${projectName}-outbox-dlq`,
  };
}

function assertInventory(project) {
  const files = walk(project);
  for (const file of requiredFiles) assert(files.includes(file), `required file is missing: ${file}`);
  for (const file of files) {
    for (const fragment of forbiddenFileFragments) {
      assert(!file.includes(fragment), `forbidden cutover/observation file survived: ${file}`);
    }
  }

  const sourceText = files
    .filter((file) => file.startsWith("src/") && /\.(?:ts|tsx|js|mjs)$/.test(file))
    .map((file) => readFileSync(join(project, file), "utf8"))
    .join("\n");
  for (const command of ["create-room", "reserve-room", "cancel-reservation", "release-room"]) {
    assert(sourceText.includes(command), `booking command is missing: ${command}`);
  }
  const uiText = ["public/index.html", "public/app.js"].map((file) => readFileSync(join(project, file), "utf8")).join("\n");
  assert(uiText.includes("data-command=\"create-room\"") && uiText.includes("/api/read/reservations"), "booking UI surface is incomplete");

  const worker = readFileSync(join(project, "src/worker.ts"), "utf8");
  for (const forbidden of forbiddenWorkerSource) assert(!worker.includes(forbidden), `worker imports or contains forbidden surface: ${forbidden}`);
  const readme = readFileSync(join(project, "README.md"), "utf8");
  assert(readme.includes("wrangler secret put INCIDENT_MAINTAINER_TOKEN"), "starter README omitted incident secret setup");
  assert(readme.includes("Never place") && readme.includes("vars"), "starter README omitted secret vars guidance");

  const allText = files.map((file) => readFileSync(join(project, file), "utf8")).join("\n");
  assert(!allText.includes("sekiban-dcb-meeting-room"), "meeting-room resource name leaked into generated project");
  assert(!allText.includes("meeting-room"), "meeting-room name leaked into generated project");
  assert(!allText.includes(liveWorker), "live Worker name leaked into generated project");
  assertNoLiveDatabaseIds(allText, "generated project");

  return {
    files,
    bookingCommands: ["create-room", "reserve-room", "cancel-reservation", "release-room"],
    ui: ["public/index.html", "public/app.js", "public/styles.css"],
    forbiddenFilesAbsent: true,
    forbiddenWorkerImportsAbsent: true,
  };
}

function assertConfig(project, projectName) {
  const text = readFileSync(join(project, "wrangler.jsonc"), "utf8");
  const config = parseJsonc(text);
  const names = resourceNames(projectName);
  assert(!/G32_[A-Z0-9_]+/.test(text), "wrangler config contains a G32_* variable");
  assert(!text.includes("meeting-room"), "wrangler config contains a meeting-room name");
  assertNoLiveDatabaseIds(text, "wrangler config");
  assert(config.name === names.worker, "Worker name was not derived from the slug");
  assert(config.vars?.SDT_SERVICE_ID === names.service, "service ID was not derived from the slug");
  const databases = config.d1_databases;
  assert(Array.isArray(databases) && databases.length === 2, "wrangler must declare pipeline and MV D1 databases");
  assert(databases[0].database_name === names.pipeline && databases[1].database_name === names.mv, "D1 names were not derived from the slug");
  assert(databases[0].database_id === "REPLACE_WITH_PIPELINE_D1_ID", "pipeline database_id placeholder changed");
  assert(databases[1].database_id === "REPLACE_WITH_MV_D1_ID", "MV database_id placeholder changed");
  assert(databases[0].migrations_dir === "migrations/d1/g32" && databases[1].migrations_dir === "migrations/mv", "project-local migration dirs are wrong");
  assert(config.queues?.producers?.[0]?.queue === names.queue, "Queue name was not derived from the slug");
  assert(config.queues?.consumers?.[0]?.queue === names.queue, "Queue consumer name was not derived from the slug");
  assert(config.queues?.consumers?.[0]?.dead_letter_queue === names.dlq, "DLQ name was not derived from the slug");
  const migrations = databases.map((database) => {
    const path = join(project, database.migrations_dir);
    assert(existsSync(path) && statSync(path).isDirectory(), `migration directory is missing: ${database.migrations_dir}`);
    return { path: database.migrations_dir, resolvedInsideProject: assertInside(project, path, database.migrations_dir), sqlFiles: walk(path).filter((file) => file.endsWith(".sql")).length };
  });
  assert(migrations[0].sqlFiles >= 1 && migrations[1].sqlFiles >= 1, "migration directories contain no SQL");
  return { names, migrations, placeholders: [databases[0].database_id, databases[1].database_id] };
}

function assertIncidentMigrationParity(project) {
  const rootMigration = readFileSync(join(root, "migrations/d1/g32/0021_incident_lifecycle.sql"));
  const generatedMigration = readFileSync(join(project, "migrations/d1/g32/0021_incident_lifecycle.sql"));
  assert(rootMigration.equals(generatedMigration), "generated incident lifecycle migration differs from the root migration");
  return { byteIdentical: true, path: "migrations/d1/g32/0021_incident_lifecycle.sql" };
}

function assertReplaceManifest(project) {
  const text = readFileSync(join(project, "REPLACE.md"), "utf8");
  for (const file of removableDemoFiles) assert(text.includes(`\`${file}\``), `REPLACE.md omitted ${file}`);
  for (const kept of ["wrangler.jsonc", "src/worker.ts", "migrations/d1/g32/", "migrations/mv/", "scripts/migrate.sh", "scripts/deploy.sh", "cloudflare.config.ts", "public/.assetsignore", "AGENTS.md"]) {
    assert(text.includes(`\`${kept}\``), `REPLACE.md omitted keep boundary ${kept}`);
  }
  const guard = readFileSync(join(project, "cloudflare.config.ts"), "utf8");
  assert(guard.includes("deliberate cf CLI guard") && guard.includes("not an unfinished cf migration"), "cf guard header is not explicit");
  assert(guard.includes("Do not edit, complete, or delete"), "cf guard header is not a hard keep instruction");
  const assetsIgnore = readFileSync(join(project, "public/.assetsignore"), "utf8").trim().split(/\r?\n/).sort();
  assert(JSON.stringify(assetsIgnore) === JSON.stringify(["cloudflare.config.ts", "wrangler.config.ts"]), "public/.assetsignore is not the cf config denylist");
  assert(!existsSync(join(project, ".cloudflare")) && !existsSync(join(project, ".gitignore")), "starter generated a forbidden cf or git file");
  assert(text.includes("Delete or replace") && text.includes("Keep"), "REPLACE.md is missing its two boundary sections");
  return { removableDemoFiles, keepsInfrastructure: true, cfGuard: true, assetsIgnore: true };
}

function assertPackage(project) {
  const manifest = packageJson(join(project, "package.json"));
  const dependencies = manifest.dependencies ?? {};
  for (const name of matchedSet) assert(dependencies[name] === "0.2.0", `${name} is not pinned to 0.2.0 in the starter`);
  assert(dependencies["@sekiban/dcb-cloudflare"] === "^0.1.0", "starter helper dependency is not ^0.1.0");
  assert(dependencies.wrangler === "4.125.0", "starter must pin wrangler for standalone migrate/deploy");
  assert(manifest.devDependencies?.typescript === "5.9.3", "starter must pin TypeScript 5.9.3 for standalone typecheck");
  assert(manifest.devDependencies?.["@cloudflare/workers-types"] === "5.20260820.1", "starter must pin Workers types 5.20260820.1 for standalone typecheck");
  assert(manifest.scripts?.migrate === "dcb-cloudflare migrate --config wrangler.jsonc", "migrate script is not helper-only");
  assert(manifest.scripts?.deploy === "dcb-cloudflare deploy --config wrangler.jsonc", "deploy script is not helper-only");
  assert(manifest.scripts?.typecheck === "tsc --noEmit", "typecheck script is not standalone");
  assert(!JSON.stringify(manifest).includes("file:") && !JSON.stringify(manifest).includes("workspace:"), "starter package has a monorepo runtime dependency");
  return {
    name: manifest.name,
    matchedSetVersions: Object.fromEntries(matchedSet.map((name) => [name, dependencies[name]])),
    helper: dependencies["@sekiban/dcb-cloudflare"],
    wrangler: dependencies.wrangler,
    devDependencies: manifest.devDependencies,
  };
}

function npmTree(project) {
  return JSON.parse(run("npm", ["ls", "--json", "--depth=0"], { cwd: project }).stdout);
}

function installedPackage(project, name) {
  const manifestPath = join(project, "node_modules", ...name.split("/"), "package.json");
  assert(existsSync(manifestPath), `installed package is missing: ${name}`);
  const path = realpathSync(manifestPath);
  assert(!path.startsWith(`${realpathSync(join(root, "packages"))}${sep}`), `${name} resolved inside the worktree`);
  return { version: packageJson(manifestPath).version, path: relative(project, path) };
}

async function registryAndHelperInstall(project, helperPack) {
  const generatedManifestPath = join(project, "package.json");
  const generatedManifestText = await readFile(generatedManifestPath, "utf8");
  const generatedManifest = JSON.parse(generatedManifestText);
  const registryManifest = {
    name: generatedManifest.name,
    version: generatedManifest.version,
    private: true,
    dependencies: Object.fromEntries(matchedSet.map((name) => [name, "0.2.0"])),
  };
  await writeFile(generatedManifestPath, `${JSON.stringify(registryManifest, null, 2)}\n`);
  let registryTree;
  try {
    run("npm", ["install", "--no-package-lock", "--ignore-scripts", "--no-audit", "--no-fund", "--registry", registry], { cwd: project });
    registryTree = npmTree(project);
  } finally {
    await writeFile(generatedManifestPath, generatedManifestText);
  }
  const installed = {};
  for (const name of matchedSet) {
    const resolved = registryTree.dependencies?.[name]?.resolved ?? "";
    assert(resolved.startsWith(`${registry}/`) && !resolved.startsWith("file:"), `${name} did not resolve from the npm registry: ${resolved}`);
    const packageInfo = installedPackage(project, name);
    assert(packageInfo.version === "0.2.0", `${name} resolved to ${packageInfo.version}`);
    installed[name] = { version: packageInfo.version, resolved, insideWorktree: false };
  }

  run("npm", ["install", "--no-package-lock", "--ignore-scripts", "--no-audit", "--no-fund", "--registry", registry, helperPack], { cwd: project });
  const helperTree = npmTree(project);
  const helper = helperTree.dependencies?.["@sekiban/dcb-cloudflare"];
  assert(helper !== undefined, "packed helper was not installed");
  const helperInfo = installedPackage(project, "@sekiban/dcb-cloudflare");
  assert(helperInfo.version === expectedHelperVersion, `packed helper resolved to ${helperInfo.version}; expected ${expectedHelperVersion}`);
  assert(existsSync(join(project, "node_modules", ".bin", "dcb-cloudflare")), "packed helper did not install its CLI bin");
  assert(existsSync(join(project, "node_modules", "wrangler", "bin", "wrangler.js")), "project-local wrangler was not installed");
  assert(existsSync(join(project, "node_modules", ".bin", "wrangler")), "project-local wrangler bin is missing");
  for (const name of matchedSet) {
    const resolved = helperTree.dependencies?.[name]?.resolved ?? "";
    assert(!resolved.startsWith("file:") && !resolved.includes(`${sep}packages${sep}`), `${name} changed to an unexpected local dependency after helper install`);
  }
  return {
    matchedSet: { source: registry, packages: installed },
    helper: { source: "local npm pack", version: helperInfo.version, resolved: helper.resolved ?? "local-pack", bin: "dcb-cloudflare" },
    wrangler: { source: "project dependency", version: installedPackage(project, "wrangler").version },
  };
}

async function helperPlans(project, configText, names) {
  const cliPath = join(project, "node_modules", "@sekiban", "dcb-cloudflare", "dist", "cli.js");
  assert(existsSync(cliPath), "installed helper CLI module is missing");
  const { planCloudflareCommands } = await import(`${pathToFileURL(cliPath).href}?g103=${Date.now()}`);
  const migrate = planCloudflareCommands(["migrate", "--config", "wrangler.jsonc"], configText);
  const deploy = planCloudflareCommands(["deploy", "--config", "wrangler.jsonc"], configText);
  assert(migrate.length === 2, "helper did not plan both D1 migrations");
  assert(deploy.length === 3 && deploy.at(-1)?.[1] === "deploy", "helper did not plan both migrations and deploy");
  const commands = [...migrate, ...deploy];
  assert(commands.every((command) => command.includes("--config") && !command.includes("../../migrations")), "helper plan escaped the generated project");
  assert(commands.some((command) => command.includes(names.pipeline)) && commands.some((command) => command.includes(names.mv)), "helper plan did not use derived D1 names");
  assert(commands.every((command) => !command.some((part) => part.startsWith("sekiban-dcb-meeting-room-"))), "helper plan used a live sample resource name");
  return { migrate, deploy, config: "wrangler.jsonc", derivedNames: [names.pipeline, names.mv, names.queue, names.dlq] };
}

function dryRun(project, proofRoot, config) {
  const outdir = join(proofRoot, "dry-run");
  mkdirSync(outdir, { recursive: true });
  const args = ["deploy", "--config", join(project, "wrangler.jsonc"), "--dry-run", "--outdir", outdir, "--outfile", join(outdir, "worker.js")];
  assert(!args.includes(liveWorker), "dry-run command named the live Worker");
  const env = { ...process.env, CI: "true" };
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.G32_DEPLOY_LIVE;
  const wrangler = join(project, "node_modules", "wrangler", "bin", "wrangler.js");
  assert(existsSync(wrangler), "generated project did not install wrangler");
  assert(existsSync(join(project, "node_modules", ".bin", "wrangler")), "generated project missing wrangler bin");
  run(process.execPath, [wrangler, ...args], { cwd: project, env });
  const bundlePath = join(outdir, "worker.js");
  assert(existsSync(bundlePath), "wrangler dry-run did not write a Worker bundle");
  const bundle = readFileSync(bundlePath, "utf8");
  assert(bundle.includes("create-room") && bundle.includes("reserve-room"), "dry-run bundle omitted the booking command surface");
  assert(config.name !== liveWorker, "generated config used the live Worker name");
  return {
    command: ["wrangler", "deploy", "--config", "wrangler.jsonc", "--dry-run"],
    worker: config.name,
    bundleBytes: Buffer.byteLength(bundle),
    bookingMarkers: ["create-room", "reserve-room"],
    wranglerSource: "project-local",
  };
}

function applyLocalPipelineMigration(project, proofRoot, pipelineName) {
  const wrangler = join(project, "node_modules", "wrangler", "bin", "wrangler.js");
  const persistTo = join(proofRoot, "wrangler-local-state");
  run(process.execPath, [
    wrangler,
    "d1",
    "migrations",
    "apply",
    pipelineName,
    "--local",
    "--config",
    join(project, "wrangler.jsonc"),
    "--persist-to",
    persistTo,
  ], { cwd: project, env: { ...process.env, CI: "true" } });
  return { command: ["wrangler", "d1", "migrations", "apply", pipelineName, "--local"], persistTo: "proof-local-state" };
}

async function main() {
  assert(process.argv.includes("--check") && process.argv.length === 3, "usage: node scripts/g103-create-starter.mjs --check");
  assert(process.env.G32_DEPLOY_LIVE !== "1", "refusing to run while G32_DEPLOY_LIVE=1");
  assertNoLiveDatabaseIdMutants();

  run("npm", ["run", "build", "-w", "@sekiban/dcb-runtime"]);
  run("npm", ["run", "build", "-w", "@sekiban/dcb-cloudflare"]);

  const proofRoot = await mkdtemp(join(tmpdir(), "sdt-g103-"));
  const packRoot = await mkdtemp(join(tmpdir(), "sdt-g103-pack-"));
  try {
    assert(readdirSync(proofRoot).length === 0, "proof directory was not clean");
    const projectName = "g103-starter-booking";
    const create = run(process.execPath, [join(root, "packages/create-dcb/bin/create-dcb.mjs"), "G103 Starter Booking"], { cwd: proofRoot });
    const project = join(proofRoot, projectName);
    assert(existsSync(project), "create CLI did not write the slugified project directory");
    const inventory = assertInventory(project);
    const configProof = assertConfig(project, projectName);
    const migrationParity = assertIncidentMigrationParity(project);
    const replaceProof = assertReplaceManifest(project);
    const packageProof = assertPackage(project);
    const configText = readFileSync(join(project, "wrangler.jsonc"), "utf8");

    const packOutput = run("npm", ["pack", "--pack-destination", packRoot, "--silent"], { cwd: join(root, "packages/dcb-cloudflare") });
    const helperPack = readdirSync(packRoot).find((file) => file.endsWith(".tgz"));
    assert(helperPack !== undefined, `npm pack did not produce a helper archive: ${packOutput.stdout}`);
    const installs = await registryAndHelperInstall(project, join(packRoot, helperPack));
    const plans = await helperPlans(project, configText, configProof.names);
    const localMigration = applyLocalPipelineMigration(project, proofRoot, configProof.names.pipeline);
    const dry = dryRun(project, proofRoot, parseJsonc(configText));

    process.stdout.write(`${JSON.stringify({
      result: "g103-create-starter-check-passed",
      project: projectName,
      create: { cleanTempDirectory: true, slugifiedDirectory: true, stdout: create.stdout.trim() },
      inventory,
      config: configProof,
      migrationParity,
      replace: replaceProof,
      package: packageProof,
      installs,
      helperPlans: plans,
      localMigration,
      dryRun: dry,
      safety: {
        liveWorkerRefused: true,
        liveDatabaseIdsAbsent: true,
        meetingRoomResourceNamesAbsent: true,
        g32DeployLiveUnsetForDryRun: true,
      },
    }, null, 2)}\n`);
  } finally {
    await rm(proofRoot, { recursive: true, force: true });
    await rm(packRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
