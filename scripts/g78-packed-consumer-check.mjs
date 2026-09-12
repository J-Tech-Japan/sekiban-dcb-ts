#!/usr/bin/env node
/**
 * Compile-only migration proof for the designated downstream identity.  The
 * @sekiban/cloud-client package used here is a deterministic declaration-only
 * fixture; this script intentionally does not import, execute, publish, or
 * make a runtime-conformance claim about the downstream package.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

const root = resolve(new URL("..", import.meta.url).pathname);
const packageRoots = ["dcb-core", "dcb-domain", "dcb-client"].map((name) => join(root, "packages", name));
const fixtureRoot = join(root, "test/fixtures/g78-cloud-client-contract");
const temp = await mkdtemp(join(tmpdir(), "sdt-g78-packed-consumer-"));
const npmCache = process.env.NPM_CONFIG_CACHE ?? join(temp, ".npm-cache");

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NPM_CONFIG_CACHE: npmCache },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      const result = { status, signal, stdout, stderr };
      if (status === 0 && signal === null) resolvePromise(result);
      else reject(new Error(`${command} ${args.join(" ")} exited ${status ?? signal}\n${stdout}\n${stderr}`));
    });
  });
}

try {
  await writeFile(join(temp, "package.json"), JSON.stringify({ private: true, type: "module" }, null, 2));
  await mkdir(join(temp, "src"), { recursive: true });
  await writeFile(join(temp, "tsconfig.node16.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "Node16", moduleResolution: "Node16", strict: true, skipLibCheck: true, outDir: "dist-node16" },
    include: ["src/**/*.ts"],
  }, null, 2));
  await writeFile(join(temp, "tsconfig.bundler.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true, outDir: "dist-bundler" },
    include: ["src/**/*.ts"],
  }, null, 2));
  await writeFile(join(temp, "src/main.ts"), `
import { createSekibanCloudTransport } from "@sekiban/cloud-client";
import type { SekibanCloudTransportOptions, SerializedDcbTransport } from "@sekiban/cloud-client";

const options: SekibanCloudTransportOptions = {
  BaseUrl: "https://cloud.example.test",
  ServiceId: "service-42",
  CredentialId: "credential-id",
  CredentialSecret: "credential-secret",
};
const transport: SerializedDcbTransport = createSekibanCloudTransport(options);
void transport;
`);

  const tarballs = [];
  for (const packageRoot of [...packageRoots, fixtureRoot]) {
    const packed = JSON.parse((await run("npm", ["pack", "--json", "--pack-destination", temp], packageRoot)).stdout);
    tarballs.push(join(temp, packed[0].filename));
  }
  const [core, domain, client, cloud] = tarballs;
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", core, domain, "typescript@5.9.3"], temp);
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", client], temp);
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", cloud], temp);
  const tsc = join(temp, "node_modules/.bin/tsc");
  const node16 = await run(tsc, ["-p", "tsconfig.node16.json"], temp);
  const bundler = await run(tsc, ["-p", "tsconfig.bundler.json"], temp);
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    proof: "compile-only-contract-fixture",
    designatedIdentity: "createSekibanCloudTransport from @sekiban/cloud-client@0.2.0",
    runtimeClaim: false,
    publicationClaim: false,
    typeBoundary: "SekibanCloudTransportOptions -> SerializedDcbTransport",
    compilers: {
      node16: { status: node16.status, signal: node16.signal },
      bundler: { status: bundler.status, signal: bundler.signal },
    },
  }, null, 2)}\n`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
