#!/usr/bin/env node

import * as nodeAssert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { receiptTopology, validateDeployCheckReceipt } from "./g103-create-starter.mjs";
import {
  matchedSet,
  starterPackages,
  rewriteStarterDependencies,
  assertExactLocalDependencyGraph,
} from "./starter-pack-helpers.mjs";

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
      "CLOUDFLARE_ACCOUNT_ID",
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

export function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return String(left).localeCompare(String(right));
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function greatestVersion(versions) {
  assert(Array.isArray(versions) && versions.length > 0, "version list is empty");
  return [...versions].sort(compareVersions).at(-1);
}

export function greatestCommonVersion(creatorVersions, helperVersions) {
  const helper = new Set(helperVersions);
  const common = creatorVersions.filter((version) => helper.has(version));
  if (common.length === 0) fail("no common published creator and helper version");
  return greatestVersion(common);
}

export function selectRegistryPair({ creatorTarget, helperTarget, creatorVersions, helperVersions }) {
  assert(typeof creatorTarget === "string" && creatorTarget.length > 0, "creator target version is missing");
  assert(typeof helperTarget === "string" && helperTarget.length > 0, "helper target version is missing");
  assert(Array.isArray(creatorVersions) && Array.isArray(helperVersions), "registry version lists are missing");
  if (creatorVersions.includes(creatorTarget) && helperVersions.includes(helperTarget)) {
    return { creatorVersion: creatorTarget, helperVersion: helperTarget, selection: "manifest-target" };
  }
  const version = greatestCommonVersion(creatorVersions, helperVersions);
  return { creatorVersion: version, helperVersion: version, selection: "published-baseline" };
}

function exactVersion(value) {
  return /^\d+\.\d+\.\d+$/.test(String(value ?? ""));
}

export function prepareRegistryManifest(manifest, helperVersion) {
  const dependencies = manifest?.dependencies ?? {};
  const originalRange = dependencies[helperPackage];
  assertHelperRange(originalRange, helperVersion);
  const matchedSpecifiers = {};
  for (const name of matchedSet) {
    const specifier = dependencies[name];
    assert(exactVersion(specifier), `selected creator template dependency ${name} is not an exact version`);
    matchedSpecifiers[name] = specifier;
  }
  const rewritten = structuredClone(manifest);
  rewritten.dependencies[helperPackage] = helperVersion;
  return { manifest: rewritten, originalRange, matchedSpecifiers };
}

function registryLockEntries(lockfile, name) {
  return Object.entries(lockfile?.packages ?? {}).filter(([key]) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`));
}

function registryResolution(resolved) {
  return String(resolved ?? "").startsWith(registry);
}

export function assertRegistryInstalledGraph({
  manifest,
  lockfile,
  helperVersion,
  matchedSpecifiers,
  installedVersions,
  installedHelperVersion,
}) {
  const rootSpecifier = manifest?.dependencies?.[helperPackage];
  assert(exactVersion(rootSpecifier), `generated root dependency ${helperPackage} is a loose specifier`);
  assert(rootSpecifier === helperVersion, `generated root dependency ${helperPackage} is not the exact selected helper`);
  const lockRoot = lockfile?.packages?.[""]?.dependencies?.[helperPackage];
  assert(exactVersion(lockRoot), `lockfile root specifier ${helperPackage} is a loose specifier`);
  assert(lockRoot === helperVersion, `lockfile root specifier ${helperPackage} is not the exact selected helper`);
  const helperEntries = registryLockEntries(lockfile, helperPackage);
  assert(helperEntries.length !== 0, "helper lock entry is missing");
  assert(helperEntries.length === 1, "helper lock entry is duplicated");
  const helperEntry = helperEntries[0][1];
  assert(helperEntry?.version === helperVersion, "helper lock entry version is not the selected helper");
  assert(registryResolution(helperEntry?.resolved), "helper lock entry is not a registry resolution");
  assert(installedHelperVersion === helperVersion, "installed helper version is not the selected helper");
  for (const name of matchedSet) {
    const expected = matchedSpecifiers?.[name];
    assert(exactVersion(expected), `selected creator template dependency ${name} is not an exact version`);
    assert(installedVersions?.[name] === expected, `${name} installed version drifted from the selected creator template`);
    const entries = registryLockEntries(lockfile, name);
    assert(entries.length !== 0, `${name} lock entry is missing`);
    assert(entries.length === 1, `${name} lock entry is duplicated or mixed-version`);
    const entry = entries[0][1];
    assert(entry?.version === expected, `${name} locked version drifted from the selected creator template`);
    assert(registryResolution(entry?.resolved), `${name} is not a registry resolution`);
  }
}

export function registryReceiptFacts({ creatorVersion, helperVersion, matchedVersions }) {
  return {
    packages: {
      [createPackage]: creatorVersion,
      [helperPackage]: helperVersion,
    },
    matchedDependencies: { ...matchedVersions },
  };
}

export function assertRegistryReceipt(receipt, { creatorVersion, helperVersion, matchedSpecifiers, installedVersions }) {
  assert(receipt?.packages?.[createPackage] === creatorVersion, "receipt creator version drifted from the selected creator");
  assert(receipt?.packages?.[helperPackage] === helperVersion, "receipt helper version drifted from the selected helper");
  for (const name of matchedSet) {
    const recorded = receipt?.matchedDependencies?.[name];
    assert(recorded === matchedSpecifiers?.[name], `receipt matched version for ${name} drifted from the selected creator template`);
    assert(recorded === installedVersions?.[name], `receipt matched version for ${name} drifted from the installed package`);
  }
}

export function assertTarballFiles(name, paths) {
  const files = [...paths].sort();
  if (name === helperPackage) {
    assert(files.includes("dist/cli.js") && files.includes("dist/index.js"), `tarball ${name} is missing its built entrypoints`);
    assert(!files.some((path) => path.startsWith("src/")), `tarball ${name} contains source path ${files.find((path) => path.startsWith("src/"))}`);
    return;
  }
  if (matchedSet.includes(name)) {
    const allowed = (path) => path === "package.json" || path === "README.md" || path === "LICENSE" || path.startsWith("dist/");
    assert(files.includes("dist/index.js") && files.includes("dist/index.d.ts"), `tarball ${name} is missing its built entrypoints`);
    assert(files.every(allowed), `tarball ${name} contains an unexpected path ${files.find((path) => !allowed(path))}`);
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
    if (options.artifacts) {
      const graph = assertExactLocalDependencyGraph(lockfile, options.lockfileDirectory, options.artifacts);
      if (options.installedPackages) assertOutsideRepository(options.installedPackages);
      return { ...graph, lockEntries: entries.length, nodeModulesEntries: nodeModulesEntries(lockfile).length };
    }
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
  for (const name of [...matchedSet, helperPackage]) {
    run("npm", ["run", "build", "-w", name], { cwd: root, env });
  }
  mkdirSync(join(work, "packs"), { recursive: true });
  const artifacts = starterPackages.map((name) => packPackage(name, work, env));
  const helper = artifacts.find((artifact) => artifact.name === helperPackage);
  const creator = artifacts.find((artifact) => artifact.name === createPackage);
  const createdExpected = creator.files.filter((path) => path.startsWith("template/")).map((path) => path.slice("template/".length));
  run("npm", ["exec", "--yes", "--package", creator.path, "--", "create-dcb", "Cold Start Booking"], { cwd: work, env });
  return { artifacts, helper, creator, createdExpected };
}

function publishedVersionList(name, env, cwd) {
  const result = spawnSync("npm", ["view", name, "versions", "--json"], {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    assertViewOutput(commandOutput(result), name, "versions");
    fail(`npm view versions failed for ${name}: ${commandOutput(result)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    fail(`npm view versions for ${name} did not return JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const versions = Array.isArray(parsed) ? parsed : [parsed];
  assert(
    versions.length > 0 && versions.every((version) => typeof version === "string" && version.length > 0),
    `npm view versions for ${name} is not a version list`,
  );
  return versions;
}

function registryMode(work, env) {
  const creatorTarget = packageVersion(createPackage);
  const helperTarget = packageVersion(helperPackage);
  const selected = selectRegistryPair({
    creatorTarget,
    helperTarget,
    creatorVersions: publishedVersionList(createPackage, env, work),
    helperVersions: publishedVersionList(helperPackage, env, work),
  });
  const creatorVersion = selected.creatorVersion;
  const helperVersion = selected.helperVersion;
  const packDirectory = join(work, "registry-pack");
  mkdirSync(packDirectory, { recursive: true });
  const packed = JSON.parse(run("npm", ["pack", "--json", "--silent", "--pack-destination", packDirectory, `${createPackage}@${creatorVersion}`], { cwd: work, env }).stdout)[0];
  const files = packed.files.map((file) => file.path.replace(/^package\//, ""));
  assertTarballFiles(createPackage, files);
  run("npm", ["exec", "--yes", "--package", `${createPackage}@${creatorVersion}`, "--", "create-dcb", "Cold Start Booking"], { cwd: work, env });
  return {
    helper: { name: helperPackage, version: helperVersion },
    creator: { name: createPackage, version: creatorVersion, files },
    createdExpected: files.filter((path) => path.startsWith("template/")).map((path) => path.slice("template/".length)),
    selection: selected.selection,
  };
}

function parseLastJson(output, label) {
  const start = output.lastIndexOf("\n{");
  assert(start >= 0, `${label} did not print a JSON receipt`);
  try {
    return JSON.parse(output.slice(start + 1));
  } catch (error) {
    fail(`${label} printed invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function finishInstall(work, env, mode, artifact, receipt) {
  const project = join(work, "cold-start-booking");
  assert(existsSync(project), "create-dcb did not create cold-start-booking");
  assertGeneratedFileSet(walkFiles(project), artifact.createdExpected);
  const corePath = "scripts/offline-provider-validation.mjs";
  if (mode === "pack") {
    const routes = readFileSync(join(project, "src/booking-routes.ts"), "utf8");
    const domain = readFileSync(join(project, "src/booking-domain.ts"), "utf8");
    assert(routes.includes('"/api/read/room"'), "packed room read is missing the keyed route");
    assert(routes.includes("RoomProjector"), "packed room read is missing RoomProjector");
    assert(routes.includes("/api/sekiban/serialized/tag-state"), "packed room read is missing the tag-state endpoint");
    assert(routes.includes("lastSortedUniqueId"), "packed room read dropped lastSortedUniqueId");
    assert(routes.includes('"/api/read/reservations"'), "packed reservation list route is missing");
    assert(domain.includes("GetReservationListQuery"), "packed reservation list query is missing");
    assert(!routes.includes("/api/read/room-query"), "packed routes still dispatch /api/read/room-query");
    assert(!routes.includes("GetRoomStateQuery"), "packed routes still name GetRoomStateQuery");
    assert(!domain.includes("GetRoomStateQuery"), "packed domain still registers GetRoomStateQuery");
    assert(!routes.includes("record.lastSortableUniqueId"), "packed room read still uses lastSortableUniqueId");
    assert(artifact.createdExpected.includes(corePath), "creator pack omitted the offline validation core");
    const sourceCore = readFileSync(join(root, "scripts/lib/offline-provider-validation.mjs"));
    const templateCore = readFileSync(join(root, "packages/create-dcb/template", corePath));
    const generatedCore = readFileSync(join(project, corePath));
    assert(Buffer.compare(sourceCore, templateCore) === 0, "repository and packed template offline cores drifted");
    assert(Buffer.compare(templateCore, generatedCore) === 0, "packed template and generated offline cores drifted");
    const topology = packageJson(join(project, "deployment-topology.json"));
    const repair = topology.secrets.find((entry) => entry.name === "REPAIR_OPERATOR_TOKEN");
    assert(repair?.verification === "external", "packed topology is missing the conditional repair prerequisite");
    assert(repair.optional === true && repair.forbiddenIn === "vars", "packed topology repair entry is not optional");
    assert(
      JSON.stringify(repair.requiredWhen) === JSON.stringify(["operator-route-mounted", "runtime-fetch-direct"]),
      "packed topology repair conditions changed",
    );
    for (const file of ["DEPLOYMENT.md", "README.md", "AGENTS.md"]) {
      const text = readFileSync(join(project, file), "utf8").replace(/\s+/g, " ");
      assert(text.includes("REPAIR_OPERATOR_TOKEN"), `packed ${file} omitted the repair prerequisite`);
      assert(text.includes("extraPath") && text.includes("extraPrefix"), `packed ${file} omitted the source triggers`);
      assert(text.includes("does not verify remote state"), `packed ${file} omitted the offline-only boundary`);
      assert(text.includes("exact maintenance-only mount"), `packed ${file} omitted the stock gate boundary`);
      assert(
        text.includes("receipt expectations, route tests, and applicable runbook policy"),
        `packed ${file} omitted the coordinated customization contract`,
      );
      assert(
        text.includes("generated runtime mount is not maintenance-only"),
        `packed ${file} omitted the mount-shape diagnostic`,
      );
      assert(
        !text.includes("Provision it through Wrangler before adding"),
        `packed ${file} treats token provisioning as sufficient`,
      );
    }
  }
  const descriptorPath = join(project, "cosmos.experimental.json");
  if (existsSync(descriptorPath)) {
    const authority = packageJson(join(root, "contracts/cosmos-layout.json"));
    const descriptor = packageJson(descriptorPath);
    const descriptorBytes = readFileSync(descriptorPath);
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
  } else {
    assert(mode === "registry", "packed starter lost its Cosmos descriptor");
  }
  const starterWorker = readFileSync(join(project, "src/worker.ts"), "utf8");
  assert(!starterWorker.includes("@sekiban/dcb-runtime/cosmos"), "generated worker activated Cosmos");
  if (mode === "pack") {
    assert(
      starterWorker.includes("forwardSerializedRoutes: false"),
      "packed worker omitted forwardSerializedRoutes: false",
    );
    assert(starterWorker.includes('extraPrefixes: ["/maintenance"]'), "packed worker changed the maintenance prefix");
    assert(!starterWorker.includes("extraPaths"), "packed worker mounted an extra path");
    const maintenancePrefixes = starterWorker.match(/extraPrefixes:\s*\["\/maintenance"\]/g) ?? [];
    assert(maintenancePrefixes.length === 1, "packed worker maintenance prefix is not exactly one");
  }
  const starterWrangler = readFileSync(join(project, "wrangler.jsonc"), "utf8");
  assert(starterWrangler.includes('"d1_databases"') && !starterWrangler.includes("COSMOS_KEY"), "generated Wrangler composition is not active D1-only");

  const manifestPath = join(project, "package.json");
  const manifest = packageJson(manifestPath);
  const helperRange = manifest.dependencies?.[helperPackage];
  assertHelperRange(helperRange, artifact.helper.version);
  let matchedSpecifiers;
  if (mode === "registry") {
    const prepared = prepareRegistryManifest(manifest, artifact.helper.version);
    matchedSpecifiers = prepared.matchedSpecifiers;
    writeFileSync(manifestPath, `${JSON.stringify(prepared.manifest, null, 2)}\n`);
  }
  if (mode === "pack") {
    Object.assign(manifest, rewriteStarterDependencies(manifest, artifact.artifacts));
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  run("npm", ["install", "--include=dev", "--no-audit", "--no-fund", "--ignore-scripts"], { cwd: project, env });
  const lockfilePath = join(project, "package-lock.json");
  const lockfile = packageJson(lockfilePath);
  const installedPackages = installedSekibanPackages(project);
  const lockSummary = assertLockfile(lockfile, mode, {
    helperTarball: mode === "pack" ? artifact.helper.path : undefined,
    helperVersion: mode === "pack" ? artifact.helper.version : undefined,
    artifacts: mode === "pack" ? artifact.artifacts : undefined,
    lockfileDirectory: project,
    installedPackages,
  });
  if (mode === "registry") {
    const installedManifest = packageJson(manifestPath);
    const installedVersions = Object.fromEntries(matchedSet.map((name) => [
      name,
      packageJson(join(project, "node_modules", name, "package.json")).version,
    ]));
    const installedHelperVersion = packageJson(join(project, "node_modules", helperPackage, "package.json")).version;
    assertRegistryInstalledGraph({
      manifest: installedManifest,
      lockfile,
      helperVersion: artifact.helper.version,
      matchedSpecifiers,
      installedVersions,
      installedHelperVersion,
    });
    const facts = registryReceiptFacts({
      creatorVersion: artifact.creator.version,
      helperVersion: artifact.helper.version,
      matchedVersions: installedVersions,
    });
    assertRegistryReceipt(facts, {
      creatorVersion: artifact.creator.version,
      helperVersion: artifact.helper.version,
      matchedSpecifiers,
      installedVersions,
    });
    receipt.packages = facts.packages;
    receipt.matchedDependencies = facts.matchedDependencies;
    receipt.selection = artifact.selection;
  }

  run("npm", ["run", "typecheck"], { cwd: project, env });
  assert(existsSync(join(project, "node_modules/.bin/dcb-cloudflare")), "generated project is missing dcb-cloudflare bin");
  assert(existsSync(join(project, "node_modules/wrangler/bin/wrangler.js")), "generated project is missing project-local Wrangler");
  const gate = manifest.scripts?.["deploy:check"];
  if (gate === "node scripts/deploy-check.mjs") {
    const result = run("npm", ["run", "deploy:check"], { cwd: project, env });
    const gateReceipt = parseLastJson(result.stdout, "deploy:check");
    const authority = packageJson(join(project, "deployment-topology.json"));
    try {
      validateDeployCheckReceipt(gateReceipt, authority);
    } catch (error) {
      fail(`deploy:check receipt is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    const receiptMutant = structuredClone(gateReceipt);
    const d1 = receiptMutant.topology.find((entry) => entry.kind === "d1");
    assert(d1 !== undefined, "deploy:check receipt mutation fixture is missing a D1 row");
    d1.binding = "RECEIPT_DRIFT";
    const location = receiptMutant.placeholders.locations.find((entry) => entry.binding === "D1");
    assert(location !== undefined, "deploy:check receipt mutation fixture is missing the D1 placeholder");
    location.binding = "RECEIPT_DRIFT";
    let mutantRejected = false;
    try {
      validateDeployCheckReceipt(receiptMutant, authority);
    } catch {
      mutantRejected = true;
    }
    assert(mutantRejected, "deploy:check receipt accepted a D1 binding mutant");
    receipt.gate = "public-deploy-check";
  } else {
    const outdir = join(work, "legacy-dry-run");
    mkdirSync(outdir, { recursive: true });
    run(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "deploy", "--config", "wrangler.jsonc", "--dry-run", "--outdir", outdir], { cwd: project, env });
    const bundles = walkFiles(outdir).filter((path) => /\.js$/.test(path));
    assert(bundles.length > 0, "Wrangler dry-run did not write a bundle");
    const bundle = bundles.map((path) => readFileSync(join(outdir, path), "utf8")).join("\n");
    assert(bundle.includes("create-room") && bundle.includes("reserve-room"), "Wrangler dry-run bundle omitted the booking commands");
    receipt.gate = "legacy-project-local-wrangler-fallback";
  }
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
  const checks = [];
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
  checks.push("child-environment-green-control");
  const environmentRed = { ...greenEnvironment, NPM_CONFIG_USERCONFIG: "leak" };
  expectFailure(() => {
    if ("NPM_CONFIG_USERCONFIG" in environmentRed) fail("child environment keeps NPM_CONFIG_USERCONFIG");
  }, "child environment keeps NPM_CONFIG_USERCONFIG");
  checks.push("child-environment-uppercase-npm");

  expectFailure(() => assertViewOutput("npm error code E404", helperPackage, "0.1.0"), `starter package ${helperPackage}@0.1.0 is not on the registry`);
  checks.push("registry-view-missing");
  assertViewOutput("0.1.0", helperPackage, "0.1.0");
  checks.push("registry-view-present");
  expectFailure(() => assertHelperRange("^0.1.0", "0.2.0"), `generated dependency ${helperPackage} range ^0.1.0 is not satisfied by packed version 0.2.0`);
  checks.push("helper-range-rejected");
  assertHelperRange("^0.1.0", "0.1.0");
  checks.push("helper-range-accepted");

  const lock = baseLockfile();
  const installed = [
    { name: "@sekiban/dcb-core", path: "/tmp/node_modules/@sekiban/dcb-core" },
    { name: runtimePackage, path: "/tmp/node_modules/@sekiban/dcb-runtime" },
  ];
  assertLockfile(lock, "pack", { helperTarball: "/tmp/dcb-cloudflare.tgz", helperVersion: "0.1.0", lockfileDirectory: "/tmp", installedPackages: installed });
  checks.push("pack-lockfile-accepted");
  const rootNotPacked = structuredClone(lock);
  rootNotPacked.packages[""].dependencies[helperPackage] = "file:/tmp/wrong-helper.tgz";
  expectFailure(() => assertLockfile(rootNotPacked, "pack", { helperTarball: "/tmp/dcb-cloudflare.tgz", helperVersion: "0.1.0", lockfileDirectory: "/tmp", installedPackages: installed }), `generated root dependency ${helperPackage} is not the packed tarball specifier`);
  checks.push("pack-root-not-packed");
  const runtimeOutsideRegistry = structuredClone(lock);
  runtimeOutsideRegistry.packages[`node_modules/${runtimePackage}`].resolved = "file:/tmp/runtime.tgz";
  expectFailure(() => assertLockfile(runtimeOutsideRegistry, "pack", { helperTarball: "/tmp/dcb-cloudflare.tgz", helperVersion: "0.1.0", lockfileDirectory: "/tmp", installedPackages: installed }), `installed package ${runtimePackage} resolved outside the registry`);
  checks.push("pack-runtime-outside-registry");
  const helperNotPacked = structuredClone(lock);
  helperNotPacked.packages[`node_modules/${helperPackage}`].resolved = `${registry}@sekiban/dcb-cloudflare/-/dcb-cloudflare-0.1.0.tgz`;
  expectFailure(() => assertLockfile(helperNotPacked, "pack", { helperTarball: "/tmp/dcb-cloudflare.tgz", helperVersion: "0.1.0", lockfileDirectory: "/tmp", installedPackages: installed }), `installed package ${helperPackage} did not resolve to the packed tarball`);
  checks.push("pack-helper-not-packed");
  const insideRepository = installed.map((entry) => entry.name === "@sekiban/dcb-core" ? { ...entry, path: root } : entry);
  expectFailure(() => assertOutsideRepository(insideRepository), "installed package @sekiban/dcb-core resolved inside the repository");
  checks.push("installed-package-inside-repository");
  const link = structuredClone(lock);
  link.packages["node_modules/@sekiban/dcb-domain"].link = true;
  expectFailure(() => assertLockfile(link, "pack", { helperTarball: "/tmp/dcb-cloudflare.tgz", helperVersion: "0.1.0", lockfileDirectory: "/tmp", installedPackages: installed }), "lockfile entry node_modules/@sekiban/dcb-domain is a link");
  checks.push("pack-lockfile-link");
  const duplicate = structuredClone(lock);
  duplicate.packages[`node_modules/other/node_modules/${runtimePackage}`] = { version: "0.2.0", resolved: `${registry}@sekiban/dcb-runtime/-/dcb-runtime-0.2.0.tgz` };
  expectFailure(() => assertLockfile(duplicate, "pack", { helperTarball: "/tmp/dcb-cloudflare.tgz", helperVersion: "0.1.0", lockfileDirectory: "/tmp", installedPackages: installed }), `${runtimePackage} is installed more than once`);
  checks.push("pack-runtime-duplicate");

  const graphArtifacts = [...matchedSet, helperPackage].map((name) => ({
    name,
    version: "1.0.0",
    path: `/tmp/sdt-g132-${name.replaceAll("/", "-")}.tgz`,
  }));
  const graphLock = {
    packages: Object.fromEntries([
      ["", {
        dependencies: Object.fromEntries(
          graphArtifacts.map((artifact) => [artifact.name, `file:${artifact.path}`]),
        ),
      }],
      ...graphArtifacts.map((artifact) => [
        `node_modules/${artifact.name}`,
        { version: artifact.version, resolved: `file:${artifact.path}` },
      ]),
    ]),
  };
  assertExactLocalDependencyGraph(graphLock, "/tmp", graphArtifacts);
  checks.push("exact-local-dependency-graph");
  const graphFailure = (label, mutate, message) => {
    const mutant = structuredClone(graphLock);
    mutate(mutant);
    nodeAssert.throws(
      () => assertExactLocalDependencyGraph(mutant, "/tmp", graphArtifacts),
      new RegExp(message),
      label,
    );
    checks.push(label);
  };
  graphFailure(
    "missing local tarball",
    (mutant) => { delete mutant.packages[`node_modules/${matchedSet[0]}`]; },
    "local tarball",
  );
  graphFailure(
    "duplicate local tarball",
    (mutant) => {
      mutant.packages[`node_modules/nested/node_modules/${matchedSet[0]}`] =
        mutant.packages[`node_modules/${matchedSet[0]}`];
    },
    "duplicate local tarball",
  );
  graphFailure(
    "wrong tarball version",
    (mutant) => { mutant.packages[`node_modules/${matchedSet[0]}`].version = "2.0.0"; },
    "wrong tarball version",
  );
  graphFailure(
    "workspace link",
    (mutant) => { mutant.packages[`node_modules/${matchedSet[0]}`].link = true; },
    "workspace link",
  );
  graphFailure(
    "registry target substitution",
    (mutant) => { mutant.packages[`node_modules/${matchedSet[0]}`].resolved = `${registry}target.tgz`; },
    "registry resolution of target",
  );
  nodeAssert.throws(
    () => rewriteStarterDependencies({ dependencies: {} }, graphArtifacts.slice(0, -1)),
    /missing local tarball/,
    "missing local tarball artifact must be rejected before installation",
  );
  checks.push("missing-tarball-artifact");

  assertTarballFiles(helperPackage, ["dist/cli.js", "dist/index.js"]);
  checks.push("helper-tarball-files");
  expectFailure(() => assertTarballFiles(helperPackage, ["dist/cli.js", "dist/index.js", "src/index.ts"]), `tarball ${helperPackage} contains source path src/index.ts`);
  checks.push("helper-tarball-rejects-source");
  assertTarballFiles(createPackage, ["bin/create-dcb.mjs", "template/package.json", "template/DEPLOYMENT.md", "template/deployment-topology.json", "template/scripts/deploy-check.mjs"]);
  checks.push("creator-tarball-files");
  assertGeneratedFileSet(["package.json", "src/index.ts"], ["package.json", "src/index.ts"]);
  checks.push("generated-file-set");
  expectFailure(() => assertGeneratedFileSet(["package.json", "src/index.ts", "README.md"], ["package.json", "src/index.ts"]), "generated project files differ from the packed template");
  checks.push("generated-file-set-mismatch");

  function receiptAuthority(includeRepair) {
    const secrets = [{
      name: "INCIDENT_MAINTAINER_TOKEN",
      optional: true,
      ownership: "runtime-owned",
      forbiddenIn: "vars",
    }];
    if (includeRepair) {
      secrets.push({
        name: "REPAIR_OPERATOR_TOKEN",
        optional: true,
        ownership: "runtime-owned",
        forbiddenIn: "vars",
        verification: "external",
        requiredWhen: ["operator-route-mounted", "runtime-fetch-direct"],
      });
    }
    return {
      d1: [{
        binding: "D1",
        databaseName: "pipeline",
        placeholderPath: "d1_databases[binding=D1].database_id",
        creationCommand: "npx wrangler d1 create pipeline",
        replacement: "Replace the id.",
        migrationsDir: "migrations/d1/g32",
      }],
      queues: { producers: [], consumers: [], creation: [] },
      durableObjects: { bindings: [], migrations: [] },
      assets: { directory: "public" },
      triggers: { crons: [] },
      vars: { SDT_SERVICE_ID: "fixture" },
      secrets,
    };
  }
  function receiptFor(authority, extras = {}) {
    return {
      bundle: { projectLocalWrangler: true, dryRun: true, createRoom: true, reserveRoom: true },
      placeholders: {
        status: "fresh-template",
        locations: authority.d1.map((entry) => ({
          binding: entry.binding,
          path: entry.placeholderPath,
          databaseName: entry.databaseName,
          creationCommand: entry.creationCommand,
          replacement: entry.replacement,
        })),
      },
      topology: receiptTopology(authority),
      migrationFileCounts: [{ binding: "D1", files: 1 }],
      removedCredentialVariables: [
        "CLOUDFLARE_ACCOUNT_ID",
        "CLOUDFLARE_API_TOKEN",
        "REPAIR_OPERATOR_TOKEN",
      ],
      ...extras,
    };
  }
  const modernAuthority = receiptAuthority(true);
  const modernReceipt = receiptFor(modernAuthority, {
    runtimeExposure: {
      operatorRoutes: "unmounted",
      directRuntimeFetch: false,
      serializedRoutes: "unmounted",
    },
    externalPrerequisites: [{
      name: "REPAIR_OPERATOR_TOKEN",
      required: false,
      verification: "external",
      remoteStateChecked: false,
    }],
  });
  validateDeployCheckReceipt(modernReceipt, modernAuthority);
  checks.push("modern-receipt");
  const missingSerialized = structuredClone(modernReceipt);
  delete missingSerialized.runtimeExposure.serializedRoutes;
  nodeAssert.throws(
    () => validateDeployCheckReceipt(missingSerialized, modernAuthority),
    /runtime exposure/,
    "modern authority accepted a receipt without serializedRoutes",
  );
  checks.push("modern-receipt-missing-serialized-routes");
  const mountedSerialized = structuredClone(modernReceipt);
  mountedSerialized.runtimeExposure.serializedRoutes = "mounted";
  nodeAssert.throws(
    () => validateDeployCheckReceipt(mountedSerialized, modernAuthority),
    /runtime exposure/,
    "modern authority accepted a mounted serialized route state",
  );
  checks.push("modern-receipt-mounted-serialized-routes");
  const missingPrerequisite = structuredClone(modernReceipt);
  delete missingPrerequisite.externalPrerequisites;
  nodeAssert.throws(
    () => validateDeployCheckReceipt(missingPrerequisite, modernAuthority),
    /external prerequisite/,
    "modern authority accepted a receipt without the prerequisite",
  );
  checks.push("modern-receipt-missing-prerequisite");
  const changedPrerequisite = structuredClone(modernReceipt);
  changedPrerequisite.externalPrerequisites[0].required = true;
  nodeAssert.throws(
    () => validateDeployCheckReceipt(changedPrerequisite, modernAuthority),
    /prerequisite/,
    "modern authority accepted a changed prerequisite",
  );
  checks.push("modern-receipt-changed-prerequisite");
  const extraPrerequisiteField = structuredClone(modernReceipt);
  extraPrerequisiteField.externalPrerequisites[0].note = "extra";
  nodeAssert.throws(
    () => validateDeployCheckReceipt(extraPrerequisiteField, modernAuthority),
    /prerequisite/,
    "modern authority accepted an extra prerequisite field",
  );
  checks.push("modern-receipt-extra-field");
  const publishedAuthority = receiptAuthority(false);
  const publishedReceipt = receiptFor(publishedAuthority);
  delete publishedReceipt.removedCredentialVariables;
  validateDeployCheckReceipt(publishedReceipt, publishedAuthority);
  checks.push("published-receipt");
  const publishedWithExposure = structuredClone(publishedReceipt);
  publishedWithExposure.runtimeExposure = { operatorRoutes: "unmounted", directRuntimeFetch: false };
  nodeAssert.throws(
    () => validateDeployCheckReceipt(publishedWithExposure, publishedAuthority),
    /published receipt/,
    "published authority accepted a modern exposure field",
  );
  checks.push("published-receipt-rejects-exposure");

  const published = "0.4.2";
  const target = "0.4.3";
  const higher = "0.4.9";
  const matched = "1.5.0";
  const matchedSpecifiers = Object.fromEntries(matchedSet.map((name) => [name, matched]));
  const admittingRange = `^${published}`;
  assert(satisfiesRange(admittingRange, published) && satisfiesRange(admittingRange, target), "fixture helper range must admit both the published pair and the helper-only target");

  const complete = selectRegistryPair({
    creatorTarget: target,
    helperTarget: target,
    creatorVersions: [published, target, higher],
    helperVersions: [published, target, higher],
  });
  assert(complete.selection === "manifest-target", "complete target pair did not select the manifest targets");
  assert(complete.creatorVersion === target && complete.helperVersion === target, "complete target pair was not selected");
  assert(complete.helperVersion !== higher, "complete target pair fell through to a higher common version");
  checks.push("registry-complete-target-pair");

  const baseline = selectRegistryPair({
    creatorTarget: target,
    helperTarget: target,
    creatorVersions: ["0.4.0", published],
    helperVersions: ["0.4.0", published],
  });
  const baselineCommon = greatestCommonVersion(["0.4.0", published], ["0.4.0", published]);
  assert(baseline.selection === "published-baseline", "published baseline used the manifest target path");
  assert(baseline.creatorVersion === baselineCommon && baseline.helperVersion === baselineCommon, "published baseline did not select the greatest common version");
  assert(baseline.creatorVersion !== target && baseline.helperVersion !== target, "published baseline selected an unpublished target");
  checks.push("registry-published-baseline");

  const creatorVersions = ["0.4.0", published];
  const helperVersions = ["0.4.0", published, target];
  const partial = selectRegistryPair({
    creatorTarget: target,
    helperTarget: target,
    creatorVersions,
    helperVersions,
  });
  const partialCommon = greatestCommonVersion(creatorVersions, helperVersions);
  assert(partial.selection === "published-baseline", "partial visibility treated the helper-only target as the release pair");
  assert(
    partial.creatorVersion === partialCommon && partial.helperVersion === partialCommon,
    "partial visibility selected the helper-only target instead of the greatest common published pair",
  );
  assert(partial.helperVersion !== target, "partial visibility installed the helper target while the creator target is absent");
  assert(!creatorVersions.includes(target) && helperVersions.includes(target), "partial-visibility fixture did not hide the creator target");
  const generated = {
    dependencies: {
      ...matchedSpecifiers,
      [helperPackage]: admittingRange,
    },
  };
  const prepared = prepareRegistryManifest(generated, partial.helperVersion);
  assert(prepared.originalRange === admittingRange, "partial visibility did not capture the original helper range");
  assert(satisfiesRange(prepared.originalRange, target), "partial visibility fixture range does not admit the visible helper target");
  assert(prepared.manifest.dependencies[helperPackage] === partial.helperVersion, "partial visibility did not rewrite the helper to the exact selected version");
  assert(prepared.manifest.dependencies[helperPackage] !== target, "partial visibility pinned the visible helper target");
  assert(prepared.manifest.dependencies[helperPackage] !== admittingRange, "exact helper pin was dropped");
  for (const name of matchedSet) {
    assert(prepared.manifest.dependencies[name] === matchedSpecifiers[name], "registry rewrite changed a matched specifier");
  }
  checks.push("registry-partial-visibility-exact-rewrite");

  expectFailure(() => selectRegistryPair({
    creatorTarget: "3.0.0",
    helperTarget: "3.0.0",
    creatorVersions: ["1.0.0"],
    helperVersions: ["2.0.0"],
  }), "no common published creator and helper version");
  checks.push("registry-no-common-version");

  const incompatible = {
    dependencies: {
      ...matchedSpecifiers,
      [helperPackage]: "^9.0.0",
    },
  };
  const incompatibleSnapshot = structuredClone(incompatible);
  expectFailure(
    () => prepareRegistryManifest(incompatible, published),
    `generated dependency ${helperPackage} range ^9.0.0 is not satisfied by packed version ${published}`,
  );
  assert(JSON.stringify(incompatible) === JSON.stringify(incompatibleSnapshot), "incompatible helper range mutated the generated manifest");
  checks.push("registry-incompatible-helper-range");

  function registryGraph(options = {}) {
    const helperVersion = options.helperVersion ?? published;
    const specifiers = options.matchedSpecifiers ?? matchedSpecifiers;
    const installedVersions = options.installedVersions ?? { ...specifiers };
    const rootSpecifier = options.rootSpecifier ?? helperVersion;
    const lockRootSpecifier = options.lockRootSpecifier ?? helperVersion;
    const helperLockVersion = options.helperLockVersion ?? helperVersion;
    const helperResolved = options.helperResolved ?? `${registry}@sekiban/dcb-cloudflare/-/dcb-cloudflare-${helperLockVersion}.tgz`;
    const packages = {
      "": { dependencies: { ...specifiers, [helperPackage]: lockRootSpecifier } },
    };
    if (options.omitHelperLock !== true) {
      packages[`node_modules/${helperPackage}`] = { version: helperLockVersion, resolved: helperResolved };
    }
    for (const name of matchedSet) {
      if (options.omitLock?.[name] === true) continue;
      const short = name.slice("@sekiban/".length);
      const locked = options.lockedVersions?.[name] ?? specifiers[name];
      const resolved = options.resolved?.[name] ?? `${registry}@sekiban/${short}/-/${short}-${locked}.tgz`;
      packages[`node_modules/${name}`] = { version: locked, resolved };
    }
    return {
      manifest: { dependencies: { ...specifiers, [helperPackage]: rootSpecifier } },
      lockfile: { packages },
      helperVersion,
      matchedSpecifiers: specifiers,
      installedVersions,
      installedHelperVersion: options.installedHelperVersion ?? helperVersion,
    };
  }

  assertRegistryInstalledGraph(registryGraph());
  checks.push("registry-lock-accepted");
  const pinnedGraph = registryGraph({
    helperVersion: prepared.manifest.dependencies[helperPackage],
    rootSpecifier: prepared.manifest.dependencies[helperPackage],
    lockRootSpecifier: prepared.manifest.dependencies[helperPackage],
  });
  assertRegistryInstalledGraph(pinnedGraph);
  checks.push("registry-partial-visibility-installed-graph");
  expectFailure(
    () => assertRegistryInstalledGraph(registryGraph({ rootSpecifier: admittingRange })),
    `generated root dependency ${helperPackage} is a loose specifier`,
  );
  checks.push("registry-loose-root-specifier");
  expectFailure(
    () => assertRegistryInstalledGraph(registryGraph({ rootSpecifier: target })),
    `generated root dependency ${helperPackage} is not the exact selected helper`,
  );
  checks.push("registry-wrong-root-specifier");
  expectFailure(
    () => assertRegistryInstalledGraph(registryGraph({ lockRootSpecifier: admittingRange })),
    `lockfile root specifier ${helperPackage} is a loose specifier`,
  );
  checks.push("registry-loose-lock-root-specifier");
  expectFailure(
    () => assertRegistryInstalledGraph(registryGraph({ lockRootSpecifier: target })),
    `lockfile root specifier ${helperPackage} is not the exact selected helper`,
  );
  checks.push("registry-wrong-lock-root-specifier");
  expectFailure(
    () => assertRegistryInstalledGraph(registryGraph({ omitHelperLock: true })),
    "helper lock entry is missing",
  );
  checks.push("registry-missing-helper-lock");
  expectFailure(
    () => assertRegistryInstalledGraph(registryGraph({ helperLockVersion: target })),
    "helper lock entry version is not the selected helper",
  );
  checks.push("registry-wrong-helper-lock");
  expectFailure(
    () => assertRegistryInstalledGraph(registryGraph({ helperResolved: "file:/tmp/helper.tgz" })),
    "helper lock entry is not a registry resolution",
  );
  checks.push("registry-non-registry-helper-lock");
  const duplicateHelper = registryGraph();
  duplicateHelper.lockfile.packages[`node_modules/nested/node_modules/${helperPackage}`] = {
    version: published,
    resolved: `${registry}@sekiban/dcb-cloudflare/-/dcb-cloudflare-${published}.tgz`,
  };
  expectFailure(() => assertRegistryInstalledGraph(duplicateHelper), "helper lock entry is duplicated");
  checks.push("registry-duplicate-helper-lock");
  const driftedName = matchedSet[0];
  expectFailure(
    () => assertRegistryInstalledGraph(registryGraph({ omitLock: { [driftedName]: true } })),
    `${driftedName} lock entry is missing`,
  );
  checks.push("registry-missing-matched-lock");
  expectFailure(
    () => assertRegistryInstalledGraph(registryGraph({ installedHelperVersion: target })),
    "installed helper version is not the selected helper",
  );
  checks.push("registry-installed-helper-drift");
  expectFailure(
    () => assertRegistryInstalledGraph(registryGraph({
      installedVersions: { ...matchedSpecifiers, [driftedName]: target },
    })),
    `${driftedName} installed version drifted from the selected creator template`,
  );
  checks.push("registry-matched-installed-drift");
  expectFailure(
    () => assertRegistryInstalledGraph(registryGraph({
      lockedVersions: { [driftedName]: target },
    })),
    `${driftedName} locked version drifted from the selected creator template`,
  );
  checks.push("registry-matched-lock-drift");
  expectFailure(
    () => assertRegistryInstalledGraph(registryGraph({
      resolved: { [driftedName]: "file:/tmp/matched.tgz" },
    })),
    `${driftedName} is not a registry resolution`,
  );
  checks.push("registry-non-registry-matched");
  const mixed = registryGraph();
  mixed.lockfile.packages[`node_modules/nested/node_modules/${driftedName}`] = {
    version: target,
    resolved: `${registry}@sekiban/dcb-core/-/dcb-core-${target}.tgz`,
  };
  expectFailure(
    () => assertRegistryInstalledGraph(mixed),
    `${driftedName} lock entry is duplicated or mixed-version`,
  );
  checks.push("registry-matched-mixed-version");
  const receiptFacts = registryReceiptFacts({
    creatorVersion: partial.creatorVersion,
    helperVersion: partial.helperVersion,
    matchedVersions: matchedSpecifiers,
  });
  assertRegistryReceipt(receiptFacts, {
    creatorVersion: partial.creatorVersion,
    helperVersion: partial.helperVersion,
    matchedSpecifiers,
    installedVersions: matchedSpecifiers,
  });
  assert(receiptFacts.packages[createPackage] === partialCommon, "receipt creator version is not the selected published pair");
  assert(receiptFacts.packages[helperPackage] === partialCommon, "receipt helper version is not the selected published pair");
  assert(receiptFacts.packages[helperPackage] !== target, "receipt recorded the helper-only target");
  for (const name of matchedSet) {
    assert(receiptFacts.matchedDependencies[name] === matchedSpecifiers[name], "receipt matched version is not the selected creator template");
  }
  checks.push("registry-exact-receipt");
  const driftedReceipt = structuredClone(receiptFacts);
  driftedReceipt.matchedDependencies[driftedName] = target;
  expectFailure(
    () => assertRegistryReceipt(driftedReceipt, {
      creatorVersion: partial.creatorVersion,
      helperVersion: partial.helperVersion,
      matchedSpecifiers,
      installedVersions: matchedSpecifiers,
    }),
    `receipt matched version for ${driftedName} drifted from the selected creator template`,
  );
  checks.push("registry-receipt-drift");
  const helperReceipt = structuredClone(receiptFacts);
  helperReceipt.packages[helperPackage] = target;
  expectFailure(
    () => assertRegistryReceipt(helperReceipt, {
      creatorVersion: partial.creatorVersion,
      helperVersion: partial.helperVersion,
      matchedSpecifiers,
      installedVersions: matchedSpecifiers,
    }),
    "receipt helper version drifted from the selected helper",
  );
  checks.push("registry-receipt-helper-drift");

  console.log(JSON.stringify({
    result: "starter-cold-install-self-test-passed",
    checks: checks.length,
  }));
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
    const packageVersions = source === "pack"
      ? Object.fromEntries(artifact.artifacts.map(({ name, version }) => [name, version]))
      : { [createPackage]: artifact.creator.version, [helperPackage]: artifact.helper.version };
    const receipt = {
      mode: source,
      packages: packageVersions,
      tarballs: source === "pack" ? artifact.artifacts.map(({ name, filename, version }) => ({ name, filename, version })) : [],
    };
    finishInstall(work, env, source, artifact, receipt);
    console.log(JSON.stringify(receipt));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
