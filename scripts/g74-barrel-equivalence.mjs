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
const wildcardMutatePath = join(root, "scripts/fixtures/g74-barrel-wildcard-mutate.json");
const dropExportMutatePath = join(root, "scripts/fixtures/g74-barrel-drop-export-mutate.json");

function fail(message) {
  throw new Error(`SDT-G74 barrel equivalence: ${message}`);
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

async function extract(options = {}) {
  const temp = await mkdtemp(join(tmpdir(), "sdt-g74-barrel-equivalence-"));
  try {
    const output = join(temp, "model.json");
    const args = [extractorPath, "--output", output];
    if (options.mutateSpec !== undefined) args.push("--mutate", options.mutateSpec);
    const result = spawnSync(process.execPath, args, { cwd: root, env: { ...process.env }, encoding: "utf8" });
    if (result.status !== 0) fail(`release extractor failed\n${result.stdout}\n${result.stderr}`);
    return JSON.parse(await readFile(output, "utf8"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function assertEquivalence(explicit, wildcard) {
  const explicitRoot = clientRoot(explicit);
  const wildcardRoot = clientRoot(wildcard);
  const explicitByKey = new Map(explicitRoot.symbols.map((symbol) => [symbolKey(symbol), symbol]));
  const wildcardByKey = new Map(wildcardRoot.symbols.map((symbol) => [symbolKey(symbol), symbol]));
  if (explicitByKey.size !== wildcardByKey.size) {
    fail(`export set size differs explicit=${explicitByKey.size} wildcard=${wildcardByKey.size}`);
  }
  for (const key of explicitByKey.keys()) {
    if (!wildcardByKey.has(key)) fail(`export ${key} present in explicit barrel but not wildcard barrel`);
  }
  if (publicSurfaceHash(explicit) !== publicSurfaceHash(wildcard)) {
    fail("explicit and wildcard barrels do not hash equally once alias flags are normalized");
  }
  const explicitProjection = hashProjection(explicit);
  const wildcardProjection = hashProjection(wildcard);
  if (JSON.stringify(explicitProjection) !== JSON.stringify(wildcardProjection)) {
    fail("hash projection differs beyond alias normalization");
  }
  for (const [key, explicitSymbol] of explicitByKey) {
    const wildcardSymbol = wildcardByKey.get(key);
    const leftAlias = explicitSymbol.namespace?.alias ?? false;
    const rightAlias = wildcardSymbol.namespace?.alias ?? false;
    const stripAlias = (symbol) => JSON.stringify({
      ...symbol,
      namespace: { ...symbol.namespace, alias: undefined },
    });
    if (stripAlias(explicitSymbol) !== stripAlias(wildcardSymbol)) {
      fail(`symbol ${key} shape differs beyond alias flags`);
    }
    const fromExecutor = (explicitSymbol.declarations?.[0]?.file ?? "").includes("executor");
    if (fromExecutor && leftAlias === rightAlias) {
      fail(`executor-origin symbol ${key} must differ only by alias flag (explicit=${leftAlias}, wildcard=${rightAlias})`);
    }
  }
}

function expectRed(label, action) {
  let red = false;
  try {
    action();
  } catch {
    red = true;
  }
  if (!red) fail(`${label} mutant unexpectedly passed`);
  return `${label}-red`;
}

const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const explicit = process.argv.includes("--use-baseline") ? baseline : await extract();
const wildcard = await extract({ mutateSpec: wildcardMutatePath });
assertEquivalence(explicit, wildcard);
const dropped = await extract({ mutateSpec: dropExportMutatePath });
const selfTest = [
  expectRed("dropped-export", () => assertEquivalence(dropped, wildcard)),
];
process.stdout.write(`${JSON.stringify({
  status: "PASS",
  publicSurfaceHash: explicit.publicSurfaceHash,
  explicitExecutorExports: clientRoot(explicit).symbols.filter((symbol) => (symbol.declarations?.[0]?.file ?? "").includes("executor")).length,
  wildcardExecutorExports: clientRoot(wildcard).symbols.filter((symbol) => (symbol.declarations?.[0]?.file ?? "").includes("executor")).length,
  proof: "independent-wildcard-extraction",
  selfTest,
}, null, 2)}\n`);
