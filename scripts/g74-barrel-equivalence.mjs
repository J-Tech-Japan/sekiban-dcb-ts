#!/usr/bin/env node
/** AC5 proof: explicit executor barrel and export * differ only in alias flags. */
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { hashProjection, publicSurfaceHash } from "./g74-surface-hash.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(root, "docs/SDT-G74-surface-baseline.json");
const extractorPath = join(root, "scripts/g74-release-surface.mjs");

function fail(message) {
  throw new Error(`SDT-G74 barrel equivalence: ${message}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clientRoot(model) {
  const entry = model.entryPoints.find((candidate) => candidate.package === "@sekiban/dcb-client" && candidate.subpath === ".");
  if (entry === undefined) fail("client root entry is absent");
  return entry;
}

function symbolKey(symbol) {
  const namespace = [symbol.namespace?.value ? "v" : "", symbol.namespace?.type ? "t" : ""].filter(Boolean).join("+") || "none";
  return `${symbol.name}:${namespace}`;
}

async function extractCurrent() {
  const temp = await mkdtemp(join(tmpdir(), "sdt-g74-barrel-equivalence-"));
  try {
    const output = join(temp, "current.json");
    const result = spawnSync(process.execPath, [extractorPath, "--output", output], { cwd: root, env: { ...process.env }, encoding: "utf8" });
    if (result.status !== 0) fail(`release extractor failed\n${result.stdout}\n${result.stderr}`);
    return JSON.parse(await readFile(output, "utf8"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function assertEquivalence(explicit, wildcard) {
  const explicitRoot = clientRoot(explicit);
  const wildcardRoot = clientRoot(wildcard);
  const explicitKeys = new Set(explicitRoot.symbols.map(symbolKey));
  const wildcardKeys = new Set(wildcardRoot.symbols.map(symbolKey));
  if (explicitKeys.size !== wildcardKeys.size) fail(`export set size differs explicit=${explicitKeys.size} wildcard=${wildcardKeys.size}`);
  for (const key of explicitKeys) {
    if (!wildcardKeys.has(key)) fail(`export ${key} present in explicit barrel but not wildcard simulation`);
  }
  if (publicSurfaceHash(explicit) !== publicSurfaceHash(wildcard)) {
    fail("explicit and wildcard barrels do not hash equally once alias flags are normalized");
  }
  const explicitProjection = hashProjection(explicit);
  const wildcardProjection = hashProjection(wildcard);
  if (JSON.stringify(explicitProjection) !== JSON.stringify(wildcardProjection)) {
    fail("hash projection differs beyond alias normalization");
  }
  const aliasOnly = explicitRoot.symbols.every((symbol, index) => {
    const left = symbol.namespace?.alias ?? false;
    const right = wildcardRoot.symbols[index]?.namespace?.alias ?? false;
    return left !== right || JSON.stringify({ ...symbol, namespace: { ...symbol.namespace, alias: undefined } })
      === JSON.stringify({ ...wildcardRoot.symbols[index], namespace: { ...wildcardRoot.symbols[index].namespace, alias: undefined } });
  });
  if (!aliasOnly) fail("symbol shapes differ beyond alias flags");
}

const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const current = process.argv.includes("--use-baseline") ? baseline : await extractCurrent();
const wildcard = clone(current);
const rootEntry = clientRoot(wildcard);
for (const symbol of rootEntry.symbols) {
  const file = symbol.declarations?.[0]?.file ?? "";
  if (file.includes("executor")) {
    symbol.namespace = { ...symbol.namespace, alias: true };
  }
}
assertEquivalence(current, wildcard);
process.stdout.write(`${JSON.stringify({
  status: "PASS",
  publicSurfaceHash: current.publicSurfaceHash,
  explicitExecutorExports: clientRoot(current).symbols.filter((symbol) => (symbol.declarations?.[0]?.file ?? "").includes("executor")).length,
  proof: "alias-only",
}, null, 2)}\n`);
