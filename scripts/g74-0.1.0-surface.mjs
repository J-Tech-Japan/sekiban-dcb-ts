#!/usr/bin/env node
/** Extract installable @sekiban/*@0.1.0 registry tarballs and diff against the candidate baseline. */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { publicSurfaceHash } from "./g74-surface-hash.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(root, "docs/SDT-G74-surface-baseline.json");
const receiptPath = join(root, "docs/SDT-G74-0.1.0-receipt.json");
const routedPath = join(root, "docs/SDT-G74-routed-items.json");
const extractorPath = join(root, "scripts/g74-release-surface.mjs");
const mutateSpecPath = join(root, "scripts/fixtures/g74-0.1.0-ts2835-mutate.json");
const packageNames = ["dcb-core", "dcb-domain", "dcb-client"];
const registryPackages = ["@sekiban/dcb-core@0.1.0", "@sekiban/dcb-domain@0.1.0", "@sekiban/dcb-client@0.1.0"];

function fail(message) {
  throw new Error(`SDT-G74 0.1.0 surface: ${message}`);
}

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed (${result.status ?? result.signal})\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function symbolId(entry) {
  return `${entry.package}::${entry.name}`;
}

function flattenSymbols(model) {
  const map = new Map();
  for (const entry of model.entryPoints) {
    for (const symbol of entry.symbols) {
      map.set(symbolId({ package: entry.package, name: symbol.name }), { entry, symbol });
    }
  }
  return map;
}

function diffModels(left, right) {
  const leftSymbols = flattenSymbols(left);
  const rightSymbols = flattenSymbols(right);
  const removed = [];
  const added = [];
  const changed = [];
  for (const [id, { symbol }] of leftSymbols) {
    if (!rightSymbols.has(id)) removed.push(id);
    else {
      const other = rightSymbols.get(id).symbol;
      if (JSON.stringify(symbol) !== JSON.stringify(other)) changed.push({ id, before: symbol, after: other });
    }
  }
  for (const id of rightSymbols.keys()) {
    if (!leftSymbols.has(id)) added.push(id);
  }
  return { removed: removed.sort(), added: added.sort(), changed: changed.sort((a, b) => a.id.localeCompare(b.id)) };
}

async function downloadTarballs(packDir) {
  await mkdir(packDir, { recursive: true });
  const archives = {};
  for (const [index, spec] of registryPackages.entries()) {
    const shortName = packageNames[index];
    const output = run("npm", ["pack", spec, "--json", "--pack-destination", packDir]);
    const report = JSON.parse(output)[0];
    if (report?.filename === undefined) fail(`npm pack ${spec} did not return a filename`);
    archives[shortName] = join(packDir, report.filename);
  }
  return archives;
}

async function extractWithFixes(packDir, outputPath) {
  const result = spawnSync(process.execPath, [extractorPath, "--pack-dir", packDir, "--mutate", mutateSpecPath, "--output", outputPath], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) fail(`0.1.0 extraction failed\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(await readFile(outputPath, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const temp = await mkdtemp(join(tmpdir(), "sdt-g74-010-"));
try {
  const packDir = join(temp, "packs");
  const archives = await downloadTarballs(packDir);
  const modelPath = join(temp, "0.1.0-model.json");
  const model = await extractWithFixes(packDir, modelPath);
  const diff = diffModels(model, baseline);
  const receipt = {
    schema: "sdt-g74-0.1.0-receipt/v1",
    extractedAt: new Date().toISOString(),
    sourceTag: "dcb-v0.1.0",
    sourceCommit: "7353b987e94a999d60ec6b41b1df2387efb11ac5",
    registryPackages: await Promise.all(registryPackages.map(async (spec, index) => ({
      spec,
      archive: archives[packageNames[index]],
      integrity: sha256(await readFile(archives[packageNames[index]])),
    }))),
    specifierNormalization: {
      disclosure: "Unmodified 0.1.0 tarballs fail strict extraction with TS2835 on relative imports without .js extensions.",
      edits: JSON.parse(await readFile(mutateSpecPath, "utf8")).edits.map(({ package: pkg, file, search, replace }) => ({ package: pkg, file, search, replace })),
    },
    modelHash: publicSurfaceHash(model),
    candidateHash: baseline.publicSurfaceHash,
    diffSummary: {
      removedExportCount: diff.removed.length,
      addedExportCount: diff.added.length,
      changedExportCount: diff.changed.length,
    },
  };
  if (process.argv.includes("--write")) {
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    const existingRouted = JSON.parse(await readFile(routedPath, "utf8").catch(() => "{\"items\":[]}"));
    existingRouted.receiptModelHash = receipt.modelHash;
    existingRouted.candidateHash = receipt.candidateHash;
    await writeFile(routedPath, `${JSON.stringify(existingRouted, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify({ status: "PASS", receipt, diff: { removed: diff.removed, added: diff.added, changed: diff.changed.map((entry) => entry.id) } }, null, 2)}\n`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
