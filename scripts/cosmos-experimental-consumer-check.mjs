#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);

function fail(message) {
  throw new Error(`cosmos-experimental-consumer:${message}`);
}

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed: ${String(result.stdout ?? "")}${String(result.stderr ?? "")}`);
  }
  return result;
}

function packPackage(name, destination, env) {
  const directory = join(root, "packages", name.slice("@sekiban/".length));
  const report = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", destination], directory, env).stdout)[0];
  return {
    name,
    version: report.version,
    path: join(destination, report.filename),
    filename: report.filename,
  };
}

function assertLocalTargetGraph(consumer, artifacts) {
  const lockfile = JSON.parse(readFileSync(join(consumer, "package-lock.json"), "utf8"));
  const packageEntries = lockfile.packages ?? {};
  const repoPackages = `${realpathSync(join(root, "packages"))}/`;
  for (const artifact of artifacts) {
    const key = `node_modules/${artifact.name}`;
    const entry = packageEntries[key];
    assert.ok(entry, `installed target is missing from the lockfile: ${artifact.name}`);
    assert.equal(entry.version, artifact.version, `installed ${artifact.name} version mismatch`);
    assert.match(String(entry.resolved ?? ""), /^file:/, `${artifact.name} was not resolved from a local tarball`);
    const installedManifest = join(consumer, "node_modules", artifact.name, "package.json");
    assert.equal(JSON.parse(readFileSync(installedManifest, "utf8")).version, artifact.version);
    assert.ok(!realpathSync(installedManifest).startsWith(repoPackages), `${artifact.name} resolved from the repository`);
  }
  for (const key of Object.keys(packageEntries)) {
    for (const artifact of artifacts) {
      assert.ok(
        !key.endsWith(`node_modules/${artifact.name}`) || key === `node_modules/${artifact.name}`,
        `duplicate target installation for ${artifact.name}: ${key}`,
      );
    }
  }
  return {
    packages: Object.fromEntries(artifacts.map((artifact) => [artifact.name, { version: artifact.version, source: "local npm pack" }])),
    registryTargets: false,
  };
}

function main() {
  const work = mkdtempSync(join(tmpdir(), "sdt-g122-cosmos-consumer-"));
  const env = {
    ...process.env,
    npm_config_userconfig: process.env.NPM_CONFIG_USERCONFIG ?? join(work, ".npmrc"),
    npm_config_cache: join(work, ".npm-cache"),
    npm_config_registry: "https://registry.npmjs.org/",
  };
  delete env.NODE_AUTH_TOKEN;
  delete env.NPM_TOKEN;
  try {
    mkdirSync(join(work, ".npm-cache"), { recursive: true });
    if (env.npm_config_userconfig === join(work, ".npmrc")) writeFileSync(join(work, ".npmrc"), "\n");
    const artifacts = ["@sekiban/dcb-core", "@sekiban/dcb-runtime"].map((name) => packPackage(name, work, env));
    const core = artifacts.find((artifact) => artifact.name === "@sekiban/dcb-core");
    const runtime = artifacts.find((artifact) => artifact.name === "@sekiban/dcb-runtime");
    const consumer = join(work, "consumer");
    mkdirSync(consumer, { recursive: true });
    writeFileSync(join(consumer, "package.json"), `${JSON.stringify({
      name: "sdt-g122-cosmos-consumer",
      private: true,
      type: "module",
      dependencies: {
        "@sekiban/dcb-core": `file:${core.path}`,
        "@sekiban/dcb-runtime": `file:${runtime.path}`,
        "@cloudflare/workers-types": "5.20260820.1",
      },
    }, null, 2)}\n`);
    writeFileSync(join(consumer, "tsconfig.json"), `${JSON.stringify({
      compilerOptions: { target: "ES2022", lib: ["ES2022", "WebWorker"], module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true, types: ["@cloudflare/workers-types"] },
      include: ["worker.ts"],
    }, null, 2)}\n`);
    writeFileSync(join(consumer, "worker.ts"), [
      'import { createRuntimeWorker } from "@sekiban/dcb-runtime";',
      'import { createCosmosStoreProvider } from "@sekiban/dcb-runtime/cosmos";',
      "const worker = createRuntimeWorker({ storeProvider: createCosmosStoreProvider() });",
      "export default worker;",
    ].join("\n") + "\n");
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], consumer, env);
    const graph = assertLocalTargetGraph(consumer, artifacts);
    const tsc = join(root, "node_modules/.bin/tsc");
    const esbuild = join(root, "node_modules/.bin/esbuild");
    run(tsc, ["--noEmit", "-p", "tsconfig.json"], consumer, env);
    run(esbuild, ["worker.ts", "--bundle", "--format=esm", "--platform=neutral", "--external:postgres", "--external:cloudflare:workers", "--outfile=bundle.js"], consumer, env);
    const starterWorker = readFileSync(join(root, "packages/create-dcb/template/src/worker.ts"), "utf8");
    assert.doesNotMatch(starterWorker, /@sekiban\/dcb-runtime\/cosmos/);
    assert.ok(existsSync(join(consumer, "bundle.js")), "consumer bundle was not written");
    process.stdout.write(JSON.stringify({ result: "cosmos-consumer-check-passed", packs: artifacts.map(({ filename }) => filename), graph, starterCosmosImport: false }) + "\n");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
