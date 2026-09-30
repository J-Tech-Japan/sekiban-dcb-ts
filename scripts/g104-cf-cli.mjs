#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registry = "https://registry.npmjs.org";
const helperPackage = "@sekiban/dcb-cloudflare";
const matchedSet = [
  "@sekiban/dcb-core",
  "@sekiban/dcb-domain",
  "@sekiban/dcb-client",
  "@sekiban/dcb-runtime",
];
const guardHeader = `/*
 * This is a deliberate cf CLI guard, not an unfinished cf migration.
 * Do not edit, complete, or delete this guard. If cf migrate asks you to
 * finish the existing migration, the answer here is to leave this guard in
 * place and keep using the Wrangler path documented by the starter.
 */`;
const guardMessagePrefix = "cf commands that load this project's config are refused";
const guardMessage = "cf commands that load this project's config are refused in the project root. Use npm run migrate and npm run deploy. Create D1 databases with npx wrangler d1 create ... or run cf resource commands from outside the project directory.";
const noWorkerMessage = "must define a Worker";
const uuidA = "11111111-1111-4111-8111-111111111111";
const uuidB = "22222222-2222-4222-8222-222222222222";

function fail(message) {
  throw new Error(`g104-cf-cli:${message}`);
}

function check(condition, message) {
  if (!condition) fail(message);
}

function outputOf(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

function excerpt(value, limit = 1200) {
  const text = String(value ?? "").replace(/\r/g, "").replace(/"deviceId":"[^"]*"/g, '"deviceId":"<redacted>"').trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function commandResult(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env,
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ...result,
    status: result.status ?? 1,
    output: outputOf(result),
    command: [command, ...args],
  };
}

function run(command, args, options = {}) {
  const result = commandResult(command, args, options);
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed: ${excerpt(result.output)}`);
  return result;
}

function safeEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.G32_DEPLOY_LIVE;
  return env;
}

function runCf(cwd, args, options = {}) {
  const env = safeEnv(options.env ?? {});
  delete env.CLOUDFLARE_API_TOKEN;
  if (options.marker === true) env.SEKIBAN_DCB_CF_HELPER = "d1-migrations";
  else delete env.SEKIBAN_DCB_CF_HELPER;
  const result = commandResult("env", ["-u", "CLOUDFLARE_API_TOKEN", "cf", ...args], {
    cwd,
    env,
    timeout: options.timeout ?? 60_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    output: result.output,
    command: result.command,
    timedOut: result.error?.code === "ETIMEDOUT",
  };
}

function parseJsonc(text) {
  return JSON.parse(text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,\s*([}\]])/g, "$1"));
}

function walkFiles(directory, prefix = "", files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === "node_modules") continue;
    const absolute = join(directory, entry.name);
    const name = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) walkFiles(absolute, name, files);
    else if (entry.isFile()) files.push({ name, absolute });
  }
  return files;
}

function manifest(directory) {
  return walkFiles(directory)
    .map(({ name, absolute }) => `${name}\t${createHash("sha256").update(readFileSync(absolute)).digest("hex")}`)
    .sort()
    .join("\n");
}

function changedPaths(before, after) {
  const left = new Map(before.split("\n").filter(Boolean).map((line) => [line.split("\t", 1)[0], line]));
  const right = new Map(after.split("\n").filter(Boolean).map((line) => [line.split("\t", 1)[0], line]));
  return [...new Set([...left.keys(), ...right.keys()])]
    .filter((name) => left.get(name) !== right.get(name))
    .sort();
}

function packageJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertGuardChild(guardPath, marker) {
  check(readFileSync(guardPath, "utf8").startsWith(`${guardHeader}\n`), "guard header changed or is not the deliberate guard header");
  const child = `import(${JSON.stringify(pathToFileURL(guardPath).href)}).then((module) => process.stdout.write(JSON.stringify({ keys: Object.keys(module.default ?? {}), worker: Boolean(module.default?.worker) })))`;
  const env = safeEnv(marker ? { SEKIBAN_DCB_CF_HELPER: "d1-migrations" } : {});
  const result = commandResult(process.execPath, ["--input-type=module", "-e", child], { env, cwd: dirname(guardPath) });
  if (!marker) {
    check(result.status !== 0, "guard without marker unexpectedly succeeded");
    check(result.output.includes(guardMessage), "guard child did not print the complete required refusal");
    return { status: result.status, refused: true, message: guardMessage };
  }
  check(result.status === 0, `guard with marker failed: ${excerpt(result.output)}`);
  const parsed = JSON.parse(result.stdout);
  check(Array.isArray(parsed.keys) && parsed.keys.length === 0 && parsed.worker === false, "marker branch defines a Worker");
  return { status: result.status, refused: false, export: parsed };
}

async function buildHelper() {
  run("npm", ["run", "build", "-w", helperPackage]);
}

async function createProject(parent, label) {
  const created = run(process.execPath, [join(root, "packages/create-dcb/bin/create-dcb.mjs"), label], { cwd: parent });
  const project = join(parent, "g104-cf-cli-project");
  check(existsSync(project), "create-dcb did not create the expected project");
  return { project, created: excerpt(created.stdout) };
}

function assertTemplateAndStarter(project) {
  const starterGuard = readFileSync(join(root, "templates/cloudflare-starter/cloudflare.config.ts"));
  const bundledGuard = readFileSync(join(root, "packages/create-dcb/template/cloudflare.config.ts"));
  assert.deepEqual(starterGuard, bundledGuard, "starter and create-dcb guards differ");
  const guard = join(project, "cloudflare.config.ts");
  check(existsSync(guard), "generated project is missing cloudflare.config.ts");
  check(!existsSync(join(project, ".cloudflare")), "generated project contains .cloudflare");
  check(!existsSync(join(project, ".gitignore")), "generated project contains .gitignore");
  const assetsIgnore = readFileSync(join(project, "public/.assetsignore"), "utf8").trim().split(/\r?\n/).sort();
  assert.deepEqual(assetsIgnore, ["cloudflare.config.ts", "wrangler.config.ts"], "generated assets ignore list changed");
  for (const required of ["AGENTS.md", "REPLACE.md", "public/.assetsignore", "cloudflare.config.ts"]) {
    check(existsSync(join(project, required)), `generated project is missing ${required}`);
  }
  const starterReadme = readFileSync(join(root, "templates/cloudflare-starter/README.md"), "utf8");
  const bundledReadme = readFileSync(join(root, "packages/create-dcb/template/README.md"), "utf8");
  assert.equal(starterReadme, bundledReadme, "starter and create-dcb README copies differ");
  assert.equal(
    readFileSync(join(root, "templates/cloudflare-starter/AGENTS.md"), "utf8"),
    readFileSync(join(root, "packages/create-dcb/template/AGENTS.md"), "utf8"),
    "starter and create-dcb AGENTS copies differ",
  );
  for (const rawText of [starterReadme, readFileSync(join(root, "templates/cloudflare-starter/AGENTS.md"), "utf8")]) {
    const text = rawText.replace(/\s+/g, " ");
    for (const phrase of [
      "npm run migrate",
      "npm run deploy",
      "cf deploy --prebuilt",
      "cf build",
      "cf dev",
      "cf init",
      "cf migrate",
      "npx wrangler d1 create",
      "outside the project directory",
      "subdirectory",
      "npm run migrate -- --cli cf",
      "Durable Object",
      "18 months",
    ]) check(text.includes(phrase), `starter guidance omitted ${phrase}`);
  }
  const replace = readFileSync(join(root, "templates/cloudflare-starter/REPLACE.md"), "utf8");
  for (const phrase of ["`cloudflare.config.ts`", "`public/.assetsignore`", "`AGENTS.md`"]) check(replace.includes(phrase), `REPLACE.md omitted ${phrase}`);
  return {
    guardByteIdentical: true,
    generatedGuard: true,
    noCloudflareDirectory: true,
    noGitignore: true,
    assetsIgnore,
    guidance: true,
  };
}

function pinnedDefaultPlans() {
  // Captured from origin/main before the G104 cli.ts change; keep these literal.
  return {
    starter: [
      ["wrangler", "d1", "migrations", "apply", "{{PIPELINE_DB}}", "--config", "wrangler.jsonc", "--remote"],
      ["wrangler", "d1", "migrations", "apply", "{{MV_DB}}", "--config", "wrangler.jsonc", "--remote"],
    ],
    sample: [
      ["wrangler", "d1", "migrations", "apply", "sekiban-dcb-meeting-room-cloudflare-pipeline", "--config", "samples/meeting-room/wrangler.cloudflare-only.jsonc", "--remote"],
      ["wrangler", "d1", "migrations", "apply", "sekiban-dcb-meeting-room-cloudflare-mv", "--config", "samples/meeting-room/wrangler.cloudflare-only.jsonc", "--remote"],
    ],
  };
}

async function checkPlansAndSpawns() {
  const cli = await import(`${pathToFileURL(join(root, "packages/dcb-cloudflare/dist/cli.js")).href}?g104=${Date.now()}`);
  const starterConfig = readFileSync(join(root, "templates/cloudflare-starter/wrangler.jsonc"), "utf8");
  const sampleConfig = readFileSync(join(root, "samples/meeting-room/wrangler.cloudflare-only.jsonc"), "utf8");
  const pinned = pinnedDefaultPlans();
  const starter = cli.planCloudflareCommands(["migrate", "--config", "wrangler.jsonc"], starterConfig);
  const sample = cli.planCloudflareCommands(["migrate", "--config", "samples/meeting-room/wrangler.cloudflare-only.jsonc"], sampleConfig);
  assert.deepEqual(starter, pinned.starter, "starter Wrangler migration plan drifted from the pinned main plan");
  assert.deepEqual(sample, pinned.sample, "meeting-room Wrangler migration plan drifted from the pinned main plan");
  // The committed sample is intentionally sealed with placeholders.  Exercise
  // the offline plan with distinct synthetic UUIDs so the production CLI keeps
  // its real-UUID validation without reintroducing a live identifier.
  const samplePlanFixture = sampleConfig
    .replace("REPLACE_WITH_CLOUDFLARE_ONLY_PIPELINE_D1_ID", uuidA)
    .replace("REPLACE_WITH_CLOUDFLARE_ONLY_MV_D1_ID", uuidB);
  check(samplePlanFixture !== sampleConfig, "sample Cloudflare plan fixture must replace sealed IDs");

  const sampleCf = cli.planCloudflareOperations(
    ["migrate", "--config", "samples/meeting-room/wrangler.cloudflare-only.jsonc", "--cli", "cf"],
    samplePlanFixture,
    { cwd: root, env: safeEnv() },
  );
  for (const plan of sampleCf) {
    const directory = plan.plannedCommand[plan.plannedCommand.indexOf("--dir") + 1];
    check(directory !== undefined && existsSync(resolve(plan.cwd, directory)), `sample cf migration directory is not reachable from planned cwd: ${directory}`);
  }

  const configDir = await mkdtemp(join(tmpdir(), "sdt-g104-plan-"));
  const configPath = join(configDir, "configs", "wrangler.jsonc");
  await mkdir(join(configDir, "configs", "migrations", "d1", "g32"), { recursive: true });
  await mkdir(join(configDir, "absolute-migrations"), { recursive: true });
  const validConfig = JSON.stringify({
    account_id: "account-g104",
    d1_databases: [
      { binding: "D1", database_name: "pipeline", database_id: uuidA, migrations_dir: "migrations/d1/g32", migrations_table: "custom_d1_migrations" },
      { binding: "D1_MV", database_name: "mv", database_id: uuidB, migrations_dir: join(configDir, "absolute-migrations") },
    ],
  });
  const fakeBinDir = join(configDir, "fake-bin");
  await mkdir(fakeBinDir, { recursive: true });
  const fakePathBin = join(fakeBinDir, "cf");
  const fakeLocalBin = join(configDir, "configs/node_modules/.bin/cf");
  const fakeOverrideBin = join(configDir, "cf-from-CF_BIN");
  await mkdir(dirname(fakeLocalBin), { recursive: true });
  for (const path of [fakePathBin, fakeLocalBin, fakeOverrideBin]) {
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o755);
  }
  const baseEnv = { ...safeEnv(), CLOUDFLARE_ACCOUNT_ID: undefined, PATH: fakeBinDir };
  const requests = [];
  const errors = [];
  const execute = (argv, env = baseEnv) => cli.executeCloudflareCli(argv, {
    cwd: configDir,
    env,
    readText: () => validConfig,
    stderr: (message) => errors.push(message),
    spawn: async (request) => { requests.push(request); return 0; },
  });
  const valid = await execute(["migrate", "--config", configPath, "--cli", "cf"], { ...baseEnv, CF_BIN: fakeOverrideBin, CLOUDFLARE_API_TOKEN: "parent-token-g104" });
  check(valid.exitCode === 0 && requests.length === 2, "valid cf execution did not spawn one request per D1");
  assert.deepEqual(valid.commands, [
    ["cf", "d1", "migrations", "apply", uuidA, "--dir", "migrations/d1/g32", "--table", "custom_d1_migrations"],
    ["cf", "d1", "migrations", "apply", uuidB, "--dir", join(configDir, "absolute-migrations")],
  ], "cf command plan is wrong");
  for (const request of requests) {
    check(request.cwd === join(configDir, "configs"), "cf child cwd is not the resolved config directory");
    check(request.command[0] === fakeOverrideBin, "CF_BIN did not win cf resolution");
    check(request.env.SEKIBAN_DCB_CF_HELPER === "d1-migrations", "cf child marker is missing");
    check(request.env.CLOUDFLARE_ACCOUNT_ID === "account-g104", "account_id was not propagated to cf child");
    check(request.env.CLOUDFLARE_API_TOKEN === "parent-token-g104", "parent CLOUDFLARE_API_TOKEN did not reach cf child unchanged");
  }
  const validRequests = requests.splice(0);
  const accountConflict = await execute(["migrate", "--config", configPath, "--cli", "cf"], { ...baseEnv, CF_BIN: fakeOverrideBin, CLOUDFLARE_ACCOUNT_ID: "different-account" });
  check(accountConflict.exitCode !== 0 && requests.length === 0 && errors.at(-1)?.includes("different pre-set"), "account conflict was not refused before spawn");

  const wranglerErrors = [];
  const wranglerRequests = [];
  const wranglerEnv = { ...baseEnv, SEKIBAN_DCB_CF_HELPER: "d1-migrations", WRANGLER_BIN: "/fake/wrangler" };
  const wrangler = await cli.executeCloudflareCli(["migrate", "--config", configPath], {
    cwd: configDir,
    env: wranglerEnv,
    readText: () => validConfig,
    stderr: (message) => wranglerErrors.push(message),
    spawn: async (request) => { wranglerRequests.push(request); return 0; },
  });
  const explicitWrangler = await cli.executeCloudflareCli(["migrate", "--config", configPath, "--cli", "wrangler"], {
    cwd: configDir,
    env: wranglerEnv,
    readText: () => validConfig,
    stderr: (message) => wranglerErrors.push(message),
    spawn: async (request) => { wranglerRequests.push(request); return 0; },
  });
  assert.deepEqual(wrangler.commands, explicitWrangler.commands, "--cli wrangler changed the default command plan");
  check(wranglerRequests.every((request) => request.env.SEKIBAN_DCB_CF_HELPER === undefined), "marker leaked to a Wrangler child");
  check(wranglerErrors.length === 0, "Wrangler parity unexpectedly emitted an error");

  const invalidConfigs = [
    ["missing database_id", JSON.stringify({ d1_databases: [{ binding: "D1", database_name: "pipeline" }] })],
    ["placeholder database_id", JSON.stringify({ d1_databases: [{ binding: "D1", database_name: "pipeline", database_id: "REPLACE_WITH_PIPELINE_D1_ID" }] })],
    ["non-UUID database_id", JSON.stringify({ d1_databases: [{ binding: "D1", database_name: "pipeline", database_id: "not-a-uuid" }] })],
  ];
  const refusalCases = [
    ["local", ["migrate", "--config", configPath, "--cli", "cf", "--local"]],
    ["env", ["migrate", "--config", configPath, "--cli", "cf", "--env", "staging"]],
    ["extra", ["migrate", "--config", configPath, "--cli", "cf", "--", "--strict"]],
    ["keep-vars", ["migrate", "--config", configPath, "--cli", "cf", "--keep-vars"]],
    ["repeated", ["migrate", "--config", configPath, "--cli", "cf", "--config", configPath]],
    ["unknown", ["migrate", "--config", configPath, "--cli", "cf", "--profile", "staging"]],
    ["deploy", ["deploy", "--config", configPath, "--cli", "cf"]],
    ["cli-missing", ["migrate", "--config", configPath, "--cli"]],
    ["cli-invalid", ["migrate", "--config", configPath, "--cli", "other"]],
  ];
  const refusalResults = [];
  for (const [label, argv] of refusalCases) {
    const refusalErrors = [];
    const before = requests.length;
    const result = await cli.executeCloudflareCli(argv, {
      cwd: configDir,
      env: { ...baseEnv, CF_BIN: fakeOverrideBin },
      readText: () => validConfig,
      stderr: (message) => refusalErrors.push(message),
      spawn: async (request) => { requests.push(request); return 0; },
    });
    check(result.exitCode !== 0 && requests.length === before && refusalErrors.length === 1, `${label} did not refuse before spawn`);
    check(!refusalErrors[0].includes("\n"), `${label} refusal was not one line`);
    refusalResults.push({ label, reason: refusalErrors[0] });
  }
  for (const [label, text] of invalidConfigs) {
    const refusalErrors = [];
    const before = requests.length;
    const result = await cli.executeCloudflareCli(["migrate", "--config", configPath, "--cli", "cf"], {
      cwd: configDir,
      env: { ...baseEnv, CF_BIN: fakeOverrideBin },
      readText: () => text,
      stderr: (message) => refusalErrors.push(message),
      spawn: async (request) => { requests.push(request); return 0; },
    });
    check(result.exitCode !== 0 && requests.length === before && refusalErrors.length === 1 && refusalErrors[0].includes("real UUID"), `${label} was not a UUID refusal`);
    refusalResults.push({ label, reason: refusalErrors[0] });
  }

  const resolution = [];
  const resolutionRun = async (label, env) => {
    const resolutionRequests = [];
    const result = await cli.executeCloudflareCli(["migrate", "--config", configPath, "--cli", "cf"], {
      cwd: configDir,
      env: { ...baseEnv, ...env },
      readText: () => validConfig,
      stderr: () => {},
      spawn: async (request) => { resolutionRequests.push(request); return 0; },
    });
    check(result.exitCode === 0 && resolutionRequests.length > 0, `${label} cf resolution did not spawn`);
    resolution.push({ label, executable: resolutionRequests[0].command[0] });
  };
  await resolutionRun("CF_BIN", { CF_BIN: fakeOverrideBin });
  await resolutionRun("config-local-bin", { CF_BIN: undefined });
  await rm(fakeLocalBin);
  await resolutionRun("PATH", { CF_BIN: undefined });
  const missingErrors = [];
  const missingRequests = [];
  const missing = await cli.executeCloudflareCli(["migrate", "--config", configPath, "--cli", "cf"], {
    cwd: configDir,
    env: { ...baseEnv, CF_BIN: undefined, PATH: join(configDir, "no-cf-path") },
    readText: () => validConfig,
    stderr: (message) => missingErrors.push(message),
    spawn: async (request) => { missingRequests.push(request); return 0; },
  });
  check(missing.exitCode !== 0 && missingRequests.length === 0 && missingErrors[0]?.includes("npm i -g cf") && missingErrors[0]?.includes("node >=22"), "missing cf did not give the install hint");
  await rm(configDir, { recursive: true, force: true });
  return {
    defaultPlansPinned: true,
    starterPlan: starter,
    samplePlan: sample,
    sampleCfDirectories: sampleCf.map((plan) => ({ cwd: plan.cwd, command: plan.plannedCommand })),
    cfRequests: validRequests.map((request) => ({ command: request.command, cwd: request.cwd, account: request.env.CLOUDFLARE_ACCOUNT_ID, marker: request.env.SEKIBAN_DCB_CF_HELPER, token: request.env.CLOUDFLARE_API_TOKEN })),
    wranglerMarkerRemoved: true,
    refusals: refusalResults,
    resolution,
    missingCfHint: missingErrors[0],
  };
}

async function runCheck() {
  await buildHelper();
  const proofRoot = await mkdtemp(join(tmpdir(), "sdt-g104-check-"));
  try {
    const { project, created } = await createProject(proofRoot, "G104 CF CLI Project");
    const starter = assertTemplateAndStarter(project);
    const guard = {
      withoutMarker: assertGuardChild(join(project, "cloudflare.config.ts"), false),
      withMarker: assertGuardChild(join(project, "cloudflare.config.ts"), true),
    };
    const plans = await checkPlansAndSpawns();
    process.stdout.write(`${JSON.stringify({
      result: "g104-cf-cli-check-passed",
      project: "g104-cf-cli-project",
      create: { cleanTempDirectory: true, output: created },
      starter,
      guard,
      plans,
      credentialFree: true,
      cfInvoked: false,
    }, null, 2)}\n`);
  } finally {
    await rm(proofRoot, { recursive: true, force: true });
  }
}

function npmTree(project) {
  return JSON.parse(run("npm", ["ls", "--json", "--depth=0"], { cwd: project }).stdout);
}

function installedPackage(project, name) {
  const manifestPath = join(project, "node_modules", ...name.split("/"), "package.json");
  check(existsSync(manifestPath), `installed package is missing: ${name}`);
  return packageJson(manifestPath);
}

async function registryAndHelperInstall(project, helperPack) {
  const manifestPath = join(project, "package.json");
  const original = await readFile(manifestPath, "utf8");
  const generated = JSON.parse(original);
  const registryManifest = {
    name: generated.name,
    version: generated.version,
    private: true,
    dependencies: Object.fromEntries(matchedSet.map((name) => [name, "0.2.0"])),
  };
  await writeFile(manifestPath, `${JSON.stringify(registryManifest, null, 2)}\n`);
  let registryTree;
  try {
    run("npm", ["install", "--no-package-lock", "--ignore-scripts", "--no-audit", "--no-fund", "--registry", registry], { cwd: project });
    registryTree = npmTree(project);
  } finally {
    await writeFile(manifestPath, original);
  }
  const registryPackages = {};
  for (const name of matchedSet) {
    const resolved = registryTree.dependencies?.[name]?.resolved ?? "";
    check(resolved.startsWith(`${registry}/`) && !resolved.startsWith("file:"), `${name} did not resolve from npm registry`);
    check(installedPackage(project, name).version === "0.2.0", `${name} did not resolve to 0.2.0`);
    registryPackages[name] = { version: "0.2.0", resolved };
  }
  run("npm", ["install", "--no-package-lock", "--ignore-scripts", "--no-audit", "--no-fund", "--registry", registry, helperPack], { cwd: project });
  const helperTree = npmTree(project);
  check(helperTree.dependencies?.[helperPackage] !== undefined, "packed helper was not installed");
  check(installedPackage(project, helperPackage).version === "0.1.0", "packed helper version changed");
  check(existsSync(join(project, "node_modules/.bin/dcb-cloudflare")), "helper bin was not installed");
  check(existsSync(join(project, "node_modules/wrangler/bin/wrangler.js")), "project wrangler was not installed");
  return {
    matchedSet: { source: registry, packages: registryPackages },
    helper: { source: "local npm pack", version: installedPackage(project, helperPackage).version },
    wrangler: { version: installedPackage(project, "wrangler").version },
  };
}

function projectWrangler(project) {
  const path = join(project, "node_modules/wrangler/bin/wrangler.js");
  check(existsSync(path), "project-local wrangler is missing");
  return path;
}

function wranglerResult(project, args) {
  const result = commandResult(process.execPath, [projectWrangler(project), ...args], {
    cwd: project,
    env: safeEnv({ WRANGLER_LOG: "debug", WRANGLER_SEND_METRICS: "false", CI: "true" }),
    timeout: 120_000,
  });
  check(!result.error || result.error.code !== "ETIMEDOUT", `wrangler timed out: ${args.join(" ")}`);
  return { status: result.status, output: result.output, command: result.command };
}

function assertWranglerSurface(project, output) {
  const config = parseJsonc(readFileSync(join(project, "wrangler.jsonc"), "utf8"));
  const requiredBindings = config.durable_objects.bindings.map((binding) => binding.class_name);
  for (const value of [...requiredBindings, ...config.d1_databases.map((database) => database.database_name), ...config.queues.producers.map((producer) => producer.queue)]) {
    check(output.includes(value), `wrangler dry run omitted binding or queue ${value}`);
  }
  const lines = output.split(/\r?\n/);
  const readIndex = lines.findIndex((line) => /✨ Read \d+ files? from the assets directory /.test(line));
  check(readIndex >= 0, `wrangler debug output omitted the complete asset file list: ${excerpt(output, 12000)}`);
  const readMatch = lines[readIndex].match(/✨ Read (\d+) files? from the assets directory /);
  check(readMatch !== null, `wrangler debug output has an invalid asset file-list header: ${excerpt(output, 12000)}`);
  const listedAssets = [];
  for (let index = readIndex + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.startsWith("/") && line.length > 1) {
      listedAssets.push(line.slice(1));
      continue;
    }
    if (/^Ignoring asset:\s*/.test(line)) continue;
    break;
  }
  check(listedAssets.length === Number(readMatch[1]), `wrangler asset file list was incomplete: expected ${readMatch[1]}, got ${listedAssets.length}`);
  const ignored = [...output.matchAll(/^Ignoring asset:\s*(.+?)\s*$/gm)].map((match) => match[1]);
  check(ignored.every((asset) => listedAssets.includes(asset)), `wrangler ignored an asset not present in its file list: ${ignored.join(", ")}`);
  const uploadedAssets = listedAssets.filter((asset) => !ignored.includes(asset)).sort();
  assert.deepEqual(uploadedAssets, ["app.js", "index.html", "styles.css"], `Wrangler uploaded asset set changed: ${uploadedAssets.join(", ")}`);
  const ignoredAssets = ignored.map((asset) => `public/${asset}`).sort();
  return { durableObjects: requiredBindings, d1: config.d1_databases.map((database) => database.database_name), queue: config.queues.producers[0].queue, uploadedAssets, ignoredAssets };
}

function assertCfCall(result, needle, label) {
  check(!result.timedOut, `${label} timed out`);
  check(result.output.includes(needle), `${label} did not print ${needle}: ${excerpt(result.output)}`);
}

async function rootCfCall(project, args, options = {}) {
  const before = manifest(project);
  const result = runCf(project, args, options);
  const after = manifest(project);
  const changed = changedPaths(before, after);
  check(changed.length === 0, `root cf call changed the generated project: ${changed.join(", ")}`);
  return { ...result, unchanged: true, changed };
}

async function localPersist() {
  return mkdtemp(join(tmpdir(), "sdt-g104-cf-state-"));
}

async function freshCopy(project, parent, name) {
  const copy = join(parent, name);
  await cp(project, copy, {
    recursive: true,
    filter: (source) => !source.split(sep).includes("node_modules"),
  });
  symlinkSync(join(project, "node_modules"), join(copy, "node_modules"), "dir");
  return copy;
}

async function subdirectoryProbe(project, parent, kind) {
  const copy = await freshCopy(project, parent, `subdir-${kind}`);
  const before = manifest(copy);
  const result = kind === "deploy" ? runCf(join(copy, "public"), ["deploy", "--dry-run"]) : runCf(copy, ["init", "public", "--no-install"]);
  const after = manifest(copy);
  const changed = changedPaths(before, after);
  check(changed.length > 0, `${kind} subdirectory probe did not record the known bypass`);
  check(changed.every((path) => path.startsWith("public/")), `${kind} subdirectory probe changed a path outside public: ${changed.join(", ")}`);
  check(changed.includes("public/cloudflare.config.ts") && changed.includes("public/wrangler.config.ts"), `${kind} subdirectory probe did not add both cf config files`);
  const wrangler = wranglerResult(copy, ["deploy", "--dry-run", "--config", "wrangler.jsonc"]);
  check(wrangler.status === 0, `${kind} subdirectory copy Wrangler dry run failed: ${excerpt(wrangler.output)}`);
  const assets = assertWranglerSurface(copy, wrangler.output);
  await rm(copy, { recursive: true, force: true });
  return {
    command: result.command,
    status: result.status,
    output: excerpt(result.output),
    changedPaths: changed,
    manifestRule: "exempt: fresh subdirectory copy intentionally records cf additions",
    wranglerAssets: assets.uploadedAssets,
    ignoredAssets: assets.ignoredAssets,
  };
}

async function runWithCf() {
  const probeRoot = await mkdtemp(join(tmpdir(), "sdt-g104-with-cf-"));
  const packRoot = await mkdtemp(join(tmpdir(), "sdt-g104-pack-"));
  const persistDirs = [];
  try {
    const { project, created } = await createProject(probeRoot, "G104 CF CLI Project");
    const version = await rootCfCall(project, ["--version"]);
    check(version.status === 0 && version.output.includes("1.0.0-beta.5"), `cf 1.0.0-beta.5 is required: ${excerpt(version.output)}`);
    const pack = run("npm", ["pack", "--pack-destination", packRoot, "--silent"], { cwd: join(root, "packages/dcb-cloudflare") });
    const helperPackName = readdirSync(packRoot).find((name) => name.endsWith(".tgz"));
    check(helperPackName !== undefined, `helper npm pack produced no archive: ${pack.stdout}`);
    const installs = await registryAndHelperInstall(project, join(packRoot, helperPackName));

    const pinnedWranglerCalls = [];
    for (const [label, args] of [
      ["4.125 deploy", ["deploy", "--dry-run"]],
      ["4.125 build", ["build"]],
      ["4.125 dev", ["dev"]],
    ]) {
      const call = await rootCfCall(project, args);
      assertCfCall(call, "wrangler@4.136.0", label);
      pinnedWranglerCalls.push({ label, status: call.status, output: excerpt(call.output), unchanged: call.unchanged });
    }
    const initOld = await rootCfCall(project, ["init", "."]);
    assertCfCall(initOld, "existing", "4.125 init");
    const migrateOld = await rootCfCall(project, ["migrate", "--dry-run", "--no-install"]);
    assertCfCall(migrateOld, "cloudflare.config.ts", "4.125 migrate");
    pinnedWranglerCalls.push({ label: "4.125 init", status: initOld.status, output: excerpt(initOld.output), unchanged: initOld.unchanged });
    pinnedWranglerCalls.push({ label: "4.125 migrate", status: migrateOld.status, output: excerpt(migrateOld.output), unchanged: migrateOld.unchanged });

    const wranglerRuns = [];
    const firstWrangler = wranglerResult(project, ["deploy", "--dry-run", "--config", "wrangler.jsonc"]);
    check(firstWrangler.status === 0, `Wrangler 4.125 dry run failed: ${excerpt(firstWrangler.output)}`);
    wranglerRuns.push({ version: "4.125.0", ...assertWranglerSurface(project, firstWrangler.output), output: excerpt(firstWrangler.output) });

    run("npm", ["i", "--no-save", "--no-package-lock", "--ignore-scripts", "--no-audit", "--no-fund", "wrangler@4.143.0"], { cwd: project });
    check(installedPackage(project, "wrangler").version === "4.143.0", "wrangler upgrade did not install 4.143.0");

    const modernCalls = [];
    for (const [label, args] of [
      ["4.143 deploy guard", ["deploy", "--dry-run"]],
      ["4.143 build guard", ["build"]],
      ["4.143 dev guard", ["dev"]],
    ]) {
      const call = await rootCfCall(project, args);
      assertCfCall(call, guardMessagePrefix, label);
      modernCalls.push({ label, status: call.status, output: excerpt(call.output), unchanged: call.unchanged });
    }
    for (const [label, args] of [
      ["4.143 deploy marked", ["deploy", "--dry-run"]],
      ["4.143 build marked", ["build"]],
      ["4.143 dev marked", ["dev"]],
    ]) {
      const call = await rootCfCall(project, args, { marker: true });
      assertCfCall(call, noWorkerMessage, label);
      modernCalls.push({ label, status: call.status, output: excerpt(call.output), unchanged: call.unchanged });
    }
    const initModern = await rootCfCall(project, ["init", "."]);
    assertCfCall(initModern, "existing", "4.143 init");
    const migrateModern = await rootCfCall(project, ["migrate", "--dry-run", "--no-install"]);
    assertCfCall(migrateModern, "cloudflare.config.ts", "4.143 migrate");
    modernCalls.push({ label: "4.143 init", status: initModern.status, output: excerpt(initModern.output), unchanged: initModern.unchanged });
    modernCalls.push({ label: "4.143 migrate", status: migrateModern.status, output: excerpt(migrateModern.output), unchanged: migrateModern.unchanged });

    const persistList = await localPersist();
    persistDirs.push(persistList);
    const list = await rootCfCall(project, ["d1", "migrations", "list", randomUUID(), "--local", "--persist-to", persistList]);
    assertCfCall(list, guardMessagePrefix, "unmarked local D1 list");
    const persistG32 = await localPersist();
    const persistMv = await localPersist();
    persistDirs.push(persistG32, persistMv);
    const applyG32 = await rootCfCall(project, ["d1", "migrations", "apply", randomUUID(), "--dir", "migrations/d1/g32", "--local", "--persist-to", persistG32], { marker: true, timeout: 120_000 });
    check(applyG32.status === 0, `marked g32 local D1 apply failed${applyG32.timedOut ? " (timed out)" : ""}: ${excerpt(applyG32.output, 12000)}`);
    const applyMv = await rootCfCall(project, ["d1", "migrations", "apply", randomUUID(), "--dir", "migrations/mv", "--local", "--persist-to", persistMv], { marker: true, timeout: 120_000 });
    check(applyMv.status === 0, `marked MV local D1 apply failed${applyMv.timedOut ? " (timed out)" : ""}: ${excerpt(applyMv.output, 12000)}`);
    const d1Calls = [
      { label: "list without marker", status: list.status, output: excerpt(list.output), persistTo: persistList, unchanged: list.unchanged },
      { label: "apply g32", status: applyG32.status, output: excerpt(applyG32.output), persistTo: persistG32, unchanged: applyG32.unchanged },
      { label: "apply mv", status: applyMv.status, output: excerpt(applyMv.output), persistTo: persistMv, unchanged: applyMv.unchanged },
    ];

    const secondWrangler = wranglerResult(project, ["deploy", "--dry-run", "--config", "wrangler.jsonc"]);
    check(secondWrangler.status === 0, `Wrangler 4.143 dry run failed: ${excerpt(secondWrangler.output)}`);
    wranglerRuns.push({ version: "4.143.0", ...assertWranglerSurface(project, secondWrangler.output), output: excerpt(secondWrangler.output) });

    const subdirectories = [
      await subdirectoryProbe(project, probeRoot, "deploy"),
      await subdirectoryProbe(project, probeRoot, "init"),
    ];
    check(!existsSync(join(project, ".cloudflare")), "generated project acquired .cloudflare during cf proof");
    check(!existsSync(join(project, ".gitignore")), "generated project acquired .gitignore during cf proof");
    process.stdout.write(`${JSON.stringify({
      result: "g104-cf-cli-with-cf-passed",
      cfVersion: { command: version.command, output: excerpt(version.output) },
      project: "g104-cf-cli-project",
      create: { output: created },
      installs,
      pinnedWrangler: pinnedWranglerCalls,
      modernWrangler: modernCalls,
      d1: d1Calls,
      wranglerRuns,
      subdirectories,
      safety: {
        credentialFree: true,
        tokenUnsetForEveryCfCall: true,
        allCfCallsInThrowawayDirectory: true,
        noRemoteD1: true,
        noNonDryRunDeploy: true,
        rootAndD1ManifestsUnchanged: true,
      },
    }, null, 2)}\n`);
  } finally {
    for (const path of persistDirs) await rm(path, { recursive: true, force: true });
    await rm(probeRoot, { recursive: true, force: true });
    await rm(packRoot, { recursive: true, force: true });
  }
}

async function main() {
  if (process.env.G32_DEPLOY_LIVE === "1") fail("refusing while G32_DEPLOY_LIVE=1");
  const args = process.argv.slice(2);
  if (args.length !== 1 || !["--check", "--with-cf"].includes(args[0])) fail("usage: node scripts/g104-cf-cli.mjs --check|--with-cf");
  if (args[0] === "--check") await runCheck();
  else await runWithCf();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
