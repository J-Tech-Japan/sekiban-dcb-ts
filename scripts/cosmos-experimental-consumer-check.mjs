#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function main() {
  const work = mkdtempSync(join(tmpdir(), "sdt-g122-cosmos-consumer-"));
  const env = {
    ...process.env,
    npm_config_userconfig: join(work, ".npmrc"),
    npm_config_cache: join(work, ".npm-cache"),
    npm_config_registry: "https://registry.npmjs.org/",
  };
  try {
    mkdirSync(join(work, ".npm-cache"), { recursive: true });
    writeFileSync(join(work, ".npmrc"), "\n");
    const pack = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", work], join(root, "packages/dcb-runtime"), env).stdout)[0];
    const tarball = join(work, pack.filename);
    const consumer = join(work, "consumer");
    mkdirSync(consumer, { recursive: true });
    writeFileSync(join(consumer, "package.json"), `${JSON.stringify({
      name: "sdt-g122-cosmos-consumer",
      private: true,
      type: "module",
      dependencies: { "@sekiban/dcb-runtime": `file:${tarball}`, "@cloudflare/workers-types": "5.20260820.1" },
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
    const tsc = join(root, "node_modules/.bin/tsc");
    const esbuild = join(root, "node_modules/.bin/esbuild");
    run(tsc, ["--noEmit", "-p", "tsconfig.json"], consumer, env);
    run(esbuild, ["worker.ts", "--bundle", "--format=esm", "--platform=neutral", "--external:postgres", "--external:cloudflare:workers", "--outfile=bundle.js"], consumer, env);
    const starterWorker = readFileSync(join(root, "packages/create-dcb/template/src/worker.ts"), "utf8");
    assert.doesNotMatch(starterWorker, /@sekiban\/dcb-runtime\/cosmos/);
    assert.ok(existsSync(join(consumer, "bundle.js")), "consumer bundle was not written");
    process.stdout.write(JSON.stringify({ result: "cosmos-consumer-check-passed", pack: pack.filename, starterCosmosImport: false }) + "\n");
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
