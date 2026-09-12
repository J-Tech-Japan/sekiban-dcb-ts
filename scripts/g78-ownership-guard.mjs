#!/usr/bin/env node
/** Static/package-root guard for SDT-G78 AC1 ownership movement. */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const executor = readFileSync(resolve(root, "packages/dcb-client/src/executor.ts"), "utf8");
const index = readFileSync(resolve(root, "packages/dcb-client/src/index.ts"), "utf8");
const contract = readFileSync(resolve(root, "packages/dcb-client/src/cloud-contract.ts"), "utf8");

function fail(message) { throw new Error(`G78 ownership guard: ${message}`); }
function assert(condition, message) { if (!condition) fail(message); }

function check(executorSource, indexSource, contractSource) {
  assert(!/createSekibanCloudTransport/.test(executorSource), "cloud runtime factory remains in executor source");
  assert(!/cloudResult/.test(executorSource), "cloud-specific wrapper remains in executor source");
  assert(!/export\s+(?:async\s+)?function\s+createSekibanCloudTransport/.test(indexSource), "cloud runtime factory is declared by the package root");
  assert(!/export\s*\{[^}]*createSekibanCloudTransport/.test(indexSource), "cloud runtime factory is re-exported by the package root");
  assert(/export\s+type\s*\{\s*SekibanCloudTransportOptions\s*\}/.test(indexSource), "options type-only export is missing");
  assert(/export\s+interface\s+SekibanCloudTransportOptions/.test(contractSource), "options interface is missing");
  for (const key of ["BaseUrl", "ServiceId", "CredentialId", "CredentialSecret"]) {
    assert(new RegExp(`readonly\\s+${key}\\s*:`).test(contractSource), `options key ${key} is missing`);
  }
  return true;
}

const result = { status: check(executor, index, contract) ? "g78-ownership-valid" : "invalid" };
if (process.argv.includes("--self-test")) {
  const runtimeExportMutant = `${index}\nexport { createSekibanCloudTransport };\n`;
  let red = false;
  try { check(executor, runtimeExportMutant, contract); } catch { red = true; }
  assert(red, "callable cloud-root export mutant was accepted");
  result.mutant = "callable-cloud-root-export-red";
}

if (existsSync(resolve(root, "packages/dcb-client/dist/index.js"))) {
  const built = readFileSync(resolve(root, "packages/dcb-client/dist/index.js"), "utf8");
  assert(!/createSekibanCloudTransport/.test(built), "built package still exposes the cloud runtime factory");
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
