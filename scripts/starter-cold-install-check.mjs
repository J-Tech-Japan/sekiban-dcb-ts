#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registry = "https://registry.npmjs.org/";
const createPackage = "@sekiban/create-dcb";
const helperPackage = "@sekiban/dcb-cloudflare";
const runtimePackage = "@sekiban/dcb-runtime";

function fail(message) {
  throw new Error(`starter-cold-install:${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function packageJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function commandOutput(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed: ${commandOutput(result)}`);
  }
  return result;
}

export function cleanEnvironment(source, work) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase().startsWith("npm_") || [
      "NODE_AUTH_TOKEN",
      "NPM_TOKEN",
      "CLOUDFLARE_API_TOKEN",
      "NODE_ENV",
    ].includes(key)) delete env[key];
  }
  env.npm_config_userconfig = join(work, ".npmrc");
  env.npm_config_cache = join(work, ".npm-cache");
  env.npm_config_registry = registry;
  return env;
}

function childEnvironment(work) {
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, ".npmrc"), "");
  mkdirSync(join(work, ".npm-cache"), { recursive: true });
  return cleanEnvironment(process.env, work);
}

function walkFiles(directory, prefix = "") {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    const name = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...walkFiles(path, name));
    else if (entry.isFile()) files.push(name);
  }
  return files.sort();
}

function templateFiles() {
  return walkFiles(join(root, "packages/create-dcb/template"));
}

function canonical(path) {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

function assertOutsideRepository(installedPackages) {
  const repository = canonical(root);
  for (const { name, path } of installedPackages) {
    const real = canonical(path);
    assert(real !== repository && !real.startsWith(`${repository}${sep}`), `installed package ${name} resolved inside the repository`);
  }
}

export function assertViewOutput(output, name, version) {
  if (/\bE404\b|\b404\b|not found/i.test(String(output))) {
    fail(`starter package ${name}@${version} is not on the registry`);
  }
}

function assertViewResult(result, name, version) {
  if (result.status !== 0) {
    assertViewOutput(commandOutput(result), name, version);
    fail(`npm view failed for ${name}@${version}: ${commandOutput(result)}`);
  }
  assertViewOutput(commandOutput(result), name, version);
}

function versionParts(value) {
  const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? match.slice(1, 4).map(Number) : null;
}

export function satisfiesRange(range, version) {
  const actual = versionParts(version);
  if (!actual) return false;
  if (range === version) return true;
  const caret = String(range).match(/^\^(\d+)\.(\d+)\.(\d+)$/);
  if (!caret) return false;
  const minimum = caret.slice(1).map(Number);
  if (minimum[0] !== actual[0]) return false;
  if (minimum[0] === 0 && minimum[1] !== actual[1]) return false;
  if (minimum[0] === 0 && minimum[1] === 0 && minimum[2] !== actual[2]) return false;
  return actual[1] > minimum[1] || (actual[1] === minimum[1] && actual[2] >= minimum[2]);
}

export function assertHelperRange(range, packedVersion) {
  assert(satisfiesRange(range, packedVersion), `generated dependency ${helperPackage} range ${range} is not satisfied by packed version ${packedVersion}`);
}

export function assertTarballFiles(name, paths) {
  const files = [...paths].sort();
  if (name === helperPackage) {
    assert(files.includes("dist/cli.js") && files.includes("dist/index.js"), `tarball ${name} is missing its built entrypoints`);
    assert(!files.some((path) => path.startsWith("src/")), `tarball ${name} contains source path ${files.find((path) => path.startsWith("src/"))}`);
    return;
  }
  const allowed = (path) => path === "package.json" || path === "README.md" || path === "LICENSE" || path.startsWith("bin/") || path.startsWith("template/");
  assert(files.includes("bin/create-dcb.mjs") && files.includes("template/package.json"), `tarball ${name} is missing the CLI or template`);
  assert(files.every(allowed), `tarball ${name} contains an unexpected path ${files.find((path) => !allowed(path))}`);
}

export function assertGeneratedFileSet(actual, expected) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  assert(JSON.stringify(left) === JSON.stringify(right), "generated project files differ from the packed template");
}

function nodeModulesEntries(lockfile) {
  return Object.entries(lockfile.packages ?? {}).filter(([key]) => key.includes("node_modules/"));
}

export function assertLockfile(lockfile, mode, options = {}) {
  const entries = Object.entries(lockfile.packages ?? {});
  for (const [key, entry] of entries) {
    if (entry?.link === true) fail(`lockfile entry ${key} is a link`);
  }

  if (mode === "pack") {
    const helperTarball = resolve(options.helperTarball);
    const rootSpecifier = lockfile.packages?.[""]?.dependencies?.[helperPackage] ?? "";
    if (rootSpecifier !== `file:${helperTarball}`) {
      fail(`generated root dependency ${helperPackage} is not the packed tarball specifier`);
    }
    const helperEntry = lockfile.packages?.[`node_modules/${helperPackage}`];
    const resolved = helperEntry?.resolved ?? "";
    if (!String(resolved).startsWith("file:")) {
      fail(`installed package ${helperPackage} did not resolve to the packed tarball`);
    }
    const resolvedTarball = canonical(resolve(options.lockfileDirectory, String(resolved).slice("file:".length)));
    if (helperEntry.version !== options.helperVersion || resolvedTarball !== helperTarball) {
      fail(`installed package ${helperPackage} did not resolve to the packed tarball`);
    }
  }

  for (const [key, entry] of nodeModulesEntries(lockfile)) {
    if (mode === "pack" && key === `node_modules/${helperPackage}`) continue;
    const resolved = String(entry?.resolved ?? "");
    if (!resolved.startsWith(registry)) {
      if (key.endsWith(`node_modules/${runtimePackage}`)) fail(`installed package ${runtimePackage} resolved outside the registry`);
      fail(`installed package ${key.split("node_modules/").at(-1)} resolved outside the registry`);
    }
  }

  const runtimeEntries = entries.filter(([key]) => key.endsWith(`node_modules/${runtimePackage}`));
  assert(runtimeEntries.length === 1, `${runtimePackage} is installed more than once`);

  if (options.installedPackages) assertOutsideRepository(options.installedPackages);
  return {
    lockEntries: entries.length,
    nodeModulesEntries: nodeModulesEntries(lockfile).length,
    runtimeEntries: runtimeEntries.length,
  };
}

function installedSekibanPackages(project) {
  const found = [];
  function visit(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name === "@sekiban") {
        for (const packageEntry of readdirSync(path, { withFileTypes: true })) {
          if (packageEntry.isDirectory() && existsSync(join(path, packageEntry.name, "package.json"))) {
            found.push({ name: `@sekiban/${packageEntry.name}`, path: join(path, packageEntry.name) });
          }
        }
      }
      visit(path);
    }
  }
  visit(join(project, "node_modules"));
  return found;
}

function packageVersion(name) {
  return packageJson(join(root, "packages", name.replace("@sekiban/", ""), "package.json")).version;
}

function packPackage(name, work, env) {
  const directory = join(root, "packages", name.replace("@sekiban/", ""));
  const result = run("npm", ["pack", "--json", "--pack-destination", join(work, "packs")], { cwd: directory, env });
  const report = JSON.parse(result.stdout)[0];
  const paths = report.files.map((file) => file.path);
  assertTarballFiles(name, paths);
  return { name, version: report.version, filename: report.filename, path: join(work, "packs", report.filename), files: paths };
}

function packMode(work, env) {
  run("npm", ["run", "build", "-w", helperPackage], { cwd: root, env });
  mkdirSync(join(work, "packs"), { recursive: true });
  const helper = packPackage(helperPackage, work, env);
  const creator = packPackage(createPackage, work, env);
  const createdExpected = creator.files.filter((path) => path.startsWith("template/")).map((path) => path.slice("template/".length));
  run("npm", ["exec", "--yes", "--package", creator.path, "--", "create-dcb", "Cold Start Booking"], { cwd: work, env });
  return { helper, creator, createdExpected };
}

function registryMode(work, env) {
  const creatorVersion = packageVersion(createPackage);
  const helperVersion = packageVersion(helperPackage);
  for (const [name, version] of [[createPackage, creatorVersion], [helperPackage, helperVersion]]) {
    const result = spawnSync("npm", ["view", `${name}@${version}`, "version"], { cwd: work, env, encoding: "utf8", maxBuffer: 1024 * 1024 });
    assertViewResult(result, name, version);
  }
  run("npm", ["exec", "--yes", "--package", `${createPackage}@${creatorVersion}`, "--", "create-dcb", "Cold Start Booking"], { cwd: work, env });
  return {
    helper: { name: helperPackage, version: helperVersion },
    creator: { name: createPackage, version: creatorVersion, files: templateFiles() },
    createdExpected: templateFiles(),
  };
}

function finishInstall(work, env, mode, artifact, receipt) {
  const project = join(work, "cold-start-booking");
  assert(existsSync(project), "create-dcb did not create cold-start-booking");
  assertGeneratedFileSet(walkFiles(project), artifact.createdExpected);
  const authority = packageJson(join(root, "contracts/cosmos-layout.json"));
  const descriptor = packageJson(join(project, "cosmos.experimental.json"));
  const descriptorBytes = readFileSync(join(project, "cosmos.experimental.json"));
  const templateDescriptorBytes = readFileSync(join(root, "packages/create-dcb/template/cosmos.experimental.json"));
  assert(Buffer.compare(descriptorBytes, templateDescriptorBytes) === 0, "starter Cosmos descriptor is not byte-identical to the template");
  assert(descriptor.stability === "experimental" && descriptor.provider === "cosmos", "starter Cosmos descriptor lost its experimental marker");
  assert(descriptor.active === false, "starter Cosmos descriptor must remain inactive");
  assert(JSON.stringify(descriptor.bindings) === JSON.stringify(authority.bindings), "starter Cosmos bindings differ from the authority");
  const expectedContainers = Object.fromEntries(Object.entries(authority.containers).map(([key, entry]) => [key, {
    name: entry.name,
    partitionKeyPath: entry.partitionKeyPath,
    partitionValueKinds: entry.partitionValueKinds,
    documentIds: entry.documentIds,
  }]));
  assert(JSON.stringify(descriptor.containers) === JSON.stringify(expectedContainers), "starter Cosmos descriptor differs from the authority");
  const starterWorker = readFileSync(join(project, "src/worker.ts"), "utf8");
  assert(!starterWorker.includes("@sekiban/dcb-runtime/cosmos"), "generated worker activated Cosmos");
  const starterWrangler = readFileSync(join(project, "wrangler.jsonc"), "utf8");
  assert(starterWrangler.includes('"d1_databases"') && !starterWrangler.includes("COSMOS_KEY"), "generated Wrangler composition is not active D1-only");

  const manifestPath = join(project, "package.json");
  const manifest = packageJson(manifestPath);
  const helperRange = manifest.dependencies?.[helperPackage];
  assertHelperRange(helperRange, artifact.helper.version);
  if (mode === "pack") {
    manifest.dependencies[helperPackage] = `file:${artifact.helper.path}`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  run("npm", ["install", "--include=dev", "--no-audit", "--no-fund", "--ignore-scripts"], { cwd: project, env });
  const lockfilePath = join(project, "package-lock.json");
  const lockfile = packageJson(lockfilePath);
  const installedPackages = installedSekibanPackages(project);
  const lockSummary = assertLockfile(lockfile, mode, {
    helperTarball: mode === "pack" ? artifact.helper.path : undefined,
    helperVersion: mode === "pack" ? artifact.helper.version : undefined,
    lockfileDirectory: project,
    installedPackages,
  });

  run("npm", ["run", "typecheck"], { cwd: project, env });
  assert(existsSync(join(project, "node_modules/.bin/dcb-cloudflare")), "generated project is missing dcb-cloudflare bin");
  assert(existsSync(join(project, "node_modules/wrangler/bin/wrangler.js")), "generated project is missing project-local Wrangler");
  const outdir = join(work, "dry-run");
  mkdirSync(outdir, { recursive: true });
  run(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "deploy", "--config", "wrangler.jsonc", "--dry-run", "--outdir", outdir], { cwd: project, env });
  const bundles = walkFiles(outdir).filter((path) => /\.js$/.test(path));
  assert(bundles.length > 0, "Wrangler dry-run did not write a bundle");
  const bundle = bundles.map((path) => readFileSync(join(outdir, path), "utf8")).join("\n");
  assert(bundle.includes("create-room") && bundle.includes("reserve-room"), "Wrangler dry-run bundle omitted the booking commands");
  receipt.project = { files: walkFiles(project).length, typecheck: "passed", dryRun: "passed", bookingMarkers: ["create-room", "reserve-room"] };
  receipt.lockfile = lockSummary;
}

function expectFailure(action, prefix) {
  try {
    action();
  } catch (error) {
    assert(error instanceof Error && error.message.startsWith(`starter-cold-install:${prefix}`), `expected failure prefix ${prefix}, got ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  fail(`expected failure prefix ${prefix}`);
}

function baseLockfile() {
  const runtime = `${registry}@sekiban/dcb-runtime/-/dcb-runtime-0.2.0.tgz`;
  return {
    packages: {
      "": { dependencies: { [helperPackage]: "file:/tmp/dcb-cloudflare.tgz" } },
      [`node_modules/${helperPackage}`]: { version: "0.1.0", resolved: "file:/tmp/dcb-cloudflare.tgz" },
      [`node_modules/${runtimePackage}`]: { version: "0.2.0", resolved: runtime },
      "node_modules/@sekiban/dcb-core": { version: "0.2.0", resolved: `${registry}@sekiban/dcb-core/-/dcb-core-0.2.0.tgz` },
      "node_modules/@sekiban/dcb-domain": { version: "0.2.0", resolved: `${registry}@sekiban/dcb-domain/-/dcb-domain-0.2.0.tgz` },
    },
  };
}

function selfTest() {
  const work = "/tmp/starter-cold-install-self-test";
  const fixture = {
    npm_config_userconfig: "bad-lower",
    NPM_CONFIG_USERCONFIG: "bad-upper",
    npm_config_cache: "bad-cache",
    NPM_CONFIG_REGISTRY: "bad-registry",
    NODE_AUTH_TOKEN: "secret",
    NPM_TOKEN: "secret",
    CLOUDFLARE_API_TOKEN: "secret",
    NODE_ENV: "production",
    KEEP: "yes",
  };
  const greenEnvironment = cleanEnvironment(fixture, work);
  assert(greenEnvironment.npm_config_userconfig === join(work, ".npmrc") && greenEnvironment.npm_config_cache === join(work, ".npm-cache") && greenEnvironment.npm_config_registry === registry, "child environment green control is incorrect");
  assert(!Object.keys(greenEnvironment).some((key) => key.toLowerCase().startsWith("npm_") && key !== key.toLowerCase()), "child environment green control keeps an uppercase npm variable");
  assert(!["NODE_AUTH_TOKEN", "NPM_TOKEN", "CLOUDFLARE_API_TOKEN", "NODE_ENV"].some((key) => key in greenEnvironment), "child environment green control keeps a removed token");
  const environmentRed = { ...greenEnvironment, NPM_CONFIG_USERCONFIG: "leak" };
  expectFailure(() => {
    if ("NPM_CONFIG_USERCONFIG" in environmentRed) fail("child environment keeps NPM_CONFIG_USERCONFIG");
  }, "child environment keeps NPM_CONFIG_USERCONFIG");

  expectFailure(() => assertViewOutput("npm error code E404", helperPackage, "0.1.0"), `starter package ${helperPackage}@0.1.0 is not on the registry`);
  assertViewOutput("0.1.0", helperPackage, "0.1.0");
  expectFailure(() => assertHelperRange("^0.1.0", "0.2.0"), `generated dependency ${helperPackage} range ^0.1.0 is not satisfied by packed version 0.2.0`);
  assertHelperRange("^0.1.0", "0.1.0");

  const lock = baseLockfile();
  const installed = [
    { name: "@sekiban/dcb-core", path: "/tmp/node_modules/@sekiban/dcb-core" },
    { name: runtimePackage, path: "/tmp/node_modules/@sekiban/dcb-runtime" },
  ];
  assertLockfile(lock, "pack", { helperTarball: "/tmp/dcb-cloudflare.tgz", helperVersion: "0.1.0", lockfileDirectory: "/tmp", installedPackages: installed });
  const rootNotPacked = structuredClone(lock);
  rootNotPacked.packages[""].dependencies[helperPackage] = "file:/tmp/wrong-helper.tgz";
  expectFailure(() => assertLockfile(rootNotPacked, "pack", { helperTarball: "/tmp/dcb-cloudflare.tgz", helperVersion: "0.1.0", lockfileDirectory: "/tmp", installedPackages: installed }), `generated root dependency ${helperPackage} is not the packed tarball specifier`);
  const runtimeOutsideRegistry = structuredClone(lock);
  runtimeOutsideRegistry.packages[`node_modules/${runtimePackage}`].resolved = "file:/tmp/runtime.tgz";
  expectFailure(() => assertLockfile(runtimeOutsideRegistry, "pack", { helperTarball: "/tmp/dcb-cloudflare.tgz", helperVersion: "0.1.0", lockfileDirectory: "/tmp", installedPackages: installed }), `installed package ${runtimePackage} resolved outside the registry`);
  const helperNotPacked = structuredClone(lock);
  helperNotPacked.packages[`node_modules/${helperPackage}`].resolved = `${registry}@sekiban/dcb-cloudflare/-/dcb-cloudflare-0.1.0.tgz`;
  expectFailure(() => assertLockfile(helperNotPacked, "pack", { helperTarball: "/tmp/dcb-cloudflare.tgz", helperVersion: "0.1.0", lockfileDirectory: "/tmp", installedPackages: installed }), `installed package ${helperPackage} did not resolve to the packed tarball`);
  const insideRepository = installed.map((entry) => entry.name === "@sekiban/dcb-core" ? { ...entry, path: root } : entry);
  expectFailure(() => assertOutsideRepository(insideRepository), "installed package @sekiban/dcb-core resolved inside the repository");
  const link = structuredClone(lock);
  link.packages["node_modules/@sekiban/dcb-domain"].link = true;
  expectFailure(() => assertLockfile(link, "pack", { helperTarball: "/tmp/dcb-cloudflare.tgz", helperVersion: "0.1.0", lockfileDirectory: "/tmp", installedPackages: installed }), "lockfile entry node_modules/@sekiban/dcb-domain is a link");
  const duplicate = structuredClone(lock);
  duplicate.packages[`node_modules/other/node_modules/${runtimePackage}`] = { version: "0.2.0", resolved: `${registry}@sekiban/dcb-runtime/-/dcb-runtime-0.2.0.tgz` };
  expectFailure(() => assertLockfile(duplicate, "pack", { helperTarball: "/tmp/dcb-cloudflare.tgz", helperVersion: "0.1.0", lockfileDirectory: "/tmp", installedPackages: installed }), `${runtimePackage} is installed more than once`);

  assertTarballFiles(helperPackage, ["dist/cli.js", "dist/index.js"]);
  expectFailure(() => assertTarballFiles(helperPackage, ["dist/cli.js", "dist/index.js", "src/index.ts"]), `tarball ${helperPackage} contains source path src/index.ts`);
  assertGeneratedFileSet(["package.json", "src/index.ts"], ["package.json", "src/index.ts"]);
  expectFailure(() => assertGeneratedFileSet(["package.json", "src/index.ts", "README.md"], ["package.json", "src/index.ts"]), "generated project files differ from the packed template");
  console.log(JSON.stringify({ result: "starter-cold-install-self-test-passed", checks: 11 }));
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    assert(args.length === 1, "usage: npm run test:starter-cold-install -- --self-test");
    selfTest();
    return;
  }
  const sourceIndex = args.indexOf("--source");
  const source = sourceIndex === -1 ? "pack" : args[sourceIndex + 1];
  assert(["pack", "registry"].includes(source) && args.filter((arg) => arg === "--source").length <= 1, "source must be pack or registry");
  const work = mkdtempSync(join(tmpdir(), "starter-cold-install-"));
  try {
    const workReal = canonical(work);
    const repoReal = canonical(root);
    assert(workReal !== repoReal && !workReal.startsWith(`${repoReal}${sep}`), "temporary work directory is inside the repository");
    const env = childEnvironment(work);
    const artifact = source === "pack" ? packMode(work, env) : registryMode(work, env);
    const receipt = {
      mode: source,
      packages: {
        [createPackage]: artifact.creator.version,
        [helperPackage]: artifact.helper.version,
      },
      tarballs: source === "pack" ? [artifact.creator.filename, artifact.helper.filename] : [],
    };
    finishInstall(work, env, source, artifact, receipt);
    console.log(JSON.stringify(receipt));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
