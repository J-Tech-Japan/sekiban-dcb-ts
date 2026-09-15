#!/usr/bin/env node
/** Guard the committed release-shaped G74 surface and its export classification. */
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { hashProjection, publicSurfaceHash } from "./g74-surface-hash.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(root, "docs/SDT-G74-surface-baseline.json");
const classificationPath = join(root, "docs/SDT-G74-export-classification.json");
const extractorPath = join(root, "scripts/g74-release-surface.mjs");

function fail(message) {
  throw new Error(`SDT-G74 surface guard: ${message}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Name the projection sections that differ, so a drift report says where. */
function driftedSections(left, right) {
  const a = hashProjection(left);
  const b = hashProjection(right);
  return Object.keys(a).filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
}

function assertSurfaceEqual(baseline, current) {
  if (baseline.schema !== current.schema) fail(`schema changed from ${baseline.schema} to ${current.schema}`);
  if (baseline.generatedBy?.typescript !== current.generatedBy?.typescript) fail("extractor TypeScript version changed");
  if (current.publicSurfaceHash !== publicSurfaceHash(current)) fail("current publicSurfaceHash does not match its own projection");
  if (baseline.publicSurfaceHash !== publicSurfaceHash(baseline)) fail("committed baseline publicSurfaceHash does not match its own projection");
  const drifted = driftedSections(baseline, current);
  if (drifted.length > 0) fail(`release-shaped public surface drifted in: ${drifted.join(", ")}`);
}

/**
 * The executor module's exports as the type checker sees them, so `export enum`,
 * `export namespace`, `export *` and `export default` are counted as well as the
 * common declaration forms. The source text is served from memory so the
 * self-test can add an export without touching the file.
 */
function sourceExportNames(sourceText) {
  const fileName = join(root, "packages/dcb-client/src/executor.ts");
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  };
  const host = ts.createCompilerHost(options, true);
  const readSourceFile = host.getSourceFile.bind(host);
  const readFileText = host.readFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) => (resolve(name) === fileName
    ? ts.createSourceFile(name, sourceText, languageVersion, true, ts.ScriptKind.TS)
    : readSourceFile(name, languageVersion, onError, shouldCreate));
  host.readFile = (name) => (resolve(name) === fileName ? sourceText : readFileText(name));
  const program = ts.createProgram([fileName], options, host);
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(fileName);
  const moduleSymbol = sourceFile === undefined ? undefined : checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol === undefined) fail("executor module symbol could not be resolved");
  return checker.getExportsOfModule(moduleSymbol).map((symbol) => symbol.name).sort();
}

function assertClassification(sourceText, ledger) {
  const sourceNames = sourceExportNames(sourceText);
  const ledgerNames = Object.keys(ledger.exports ?? {}).sort();
  if (JSON.stringify(sourceNames) !== JSON.stringify(ledgerNames)) {
    fail(`executor export classification mismatch; source=${sourceNames.join(",")}; ledger=${ledgerNames.join(",")}`);
  }
  for (const [name, classification] of Object.entries(ledger.exports)) {
    if (classification !== "public" && classification !== "module-internal") fail(`${name} has invalid classification ${classification}`);
  }
}

/** Every ledger-public executor export must reach the client root with matching namespace. */
function assertLedgerRootCrossCheck(model, ledger) {
  const root = clientRoot(model);
  const rootByName = new Map(root.symbols.map((symbol) => [symbol.name, symbol]));
  const publicLedger = Object.entries(ledger.exports ?? {}).filter(([, classification]) => classification === "public");
  for (const [name] of publicLedger) {
    const symbol = rootByName.get(name);
    if (symbol === undefined) fail(`ledger-public export ${name} is missing from @sekiban/dcb-client root`);
  }
  for (const symbol of root.symbols) {
    const origin = symbol.declarations?.[0]?.file ?? "";
    if (!origin.includes("executor")) continue;
    const classification = ledger.exports?.[symbol.name];
    if (classification !== "public") {
      fail(`executor-origin root export ${symbol.name} is not ledger-public (${classification ?? "unclassified"})`);
    }
  }
}

function expectMutationRed(label, mutate, baseline) {
  const mutant = clone(baseline);
  mutate(mutant);
  try {
    assertSurfaceEqual(baseline, mutant);
  } catch (error) {
    return { label, result: "RED_DETECTED", reason: error instanceof Error ? error.message : String(error) };
  }
  fail(`${label} unexpectedly passed the surface guard`);
}

function clientRoot(model) {
  const entry = model.entryPoints.find((candidate) => candidate.package === "@sekiban/dcb-client" && candidate.subpath === ".");
  if (entry === undefined) fail("client root entry is absent");
  return entry;
}

function firstSymbol(model, predicate = () => true) {
  for (const entry of model.entryPoints) {
    const symbol = entry.symbols.find(predicate);
    if (symbol !== undefined) return symbol;
  }
  fail("mutation target symbol was not found");
}

async function extractCurrent() {
  // The temporary directory lives outside the repository and is removed even when
  // extraction fails, so a failed run never leaves an empty directory behind.
  const temp = await mkdtemp(join(tmpdir(), "sdt-g74-surface-guard-"));
  try {
    const output = join(temp, "current.json");
    const result = spawnSync(process.execPath, [extractorPath, "--output", output], { cwd: root, env: { ...process.env }, encoding: "utf8" });
    if (result.status !== 0) fail(`release extractor failed\n${result.stdout}\n${result.stderr}`);
    return JSON.parse(await readFile(output, "utf8"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const ledger = JSON.parse(await readFile(classificationPath, "utf8"));
const sourceText = await readFile(join(root, "packages/dcb-client/src/executor.ts"), "utf8");
assertClassification(sourceText, ledger);

if (process.argv.includes("--self-test")) {
  const comparatorResults = []; // JSON comparator unit tests only; real drift proofs live in g74-drift-mutation-runner.mjs
  comparatorResults.push(expectMutationRed("removed-export", (model) => {
    clientRoot(model).symbols = clientRoot(model).symbols.filter((symbol) => symbol.name !== "SekibanExecutor");
  }, baseline));
  comparatorResults.push(expectMutationRed("renamed-export", (model) => {
    firstSymbol(model, (symbol) => symbol.name === "SekibanExecutor").name = "SekibanExecutorRenamed";
  }, baseline));
  comparatorResults.push(expectMutationRed("parameter-type-change", (model) => {
    const symbol = firstSymbol(model, (candidate) => candidate.signatures.call[0]?.parameters.length > 0);
    symbol.signatures.call[0].parameters[0].type = "never";
  }, baseline));
  comparatorResults.push(expectMutationRed("return-type-change", (model) => {
    const symbol = firstSymbol(model, (candidate) => candidate.signatures.call.length > 0);
    symbol.signatures.call[0].returnType = "never";
  }, baseline));
  comparatorResults.push(expectMutationRed("type-widening", (model) => {
    const symbol = firstSymbol(model, (candidate) => candidate.name === "JsonPrimitive");
    symbol.type = `${symbol.type} | undefined`;
  }, baseline));
  comparatorResults.push(expectMutationRed("type-narrowing", (model) => {
    const symbol = firstSymbol(model, (candidate) => candidate.name === "JsonPrimitive");
    symbol.type = "string";
  }, baseline));
  comparatorResults.push(expectMutationRed("public-root-export-addition", (model) => {
    const entry = clientRoot(model);
    const template = clone(entry.symbols[0]);
    template.name = "UnexpectedPublicRootAddition";
    entry.symbols.push(template);
    entry.symbols.sort((left, right) => left.name.localeCompare(right.name));
  }, baseline));
  let ledgerRootRed = false;
  try {
    const mutantLedger = clone(ledger);
    delete mutantLedger.exports.SekibanExecutor;
    assertLedgerRootCrossCheck(baseline, mutantLedger);
  } catch (error) {
    ledgerRootRed = true;
    comparatorResults.push({ label: "ledger-root-cross-check", result: "RED_DETECTED", reason: error instanceof Error ? error.message : String(error) });
  }
  if (!ledgerRootRed) fail("ledger-root-cross-check self-test unexpectedly passed");
  const unclassifiedForms = [
    ["unclassified-executor-export", "\nexport interface NewlyUnclassified { value: string }\n"],
    ["unclassified-executor-enum", "\nexport enum NewlyUnclassifiedEnum { One }\n"],
    ["unclassified-executor-namespace", "\nexport namespace NewlyUnclassifiedNamespace { export const value = 1; }\n"],
    ["unclassified-executor-star-reexport", "\nexport * from \"./errors.js\";\n"],
  ];
  for (const [label, addition] of unclassifiedForms) {
    let red = false;
    try {
      assertClassification(sourceText + addition, ledger);
    } catch (error) {
      red = true;
      comparatorResults.push({ label, result: "RED_DETECTED", reason: error instanceof Error ? error.message : String(error) });
    }
    if (!red) fail(`${label} self-test unexpectedly passed`);
  }
  process.stdout.write(`${JSON.stringify({ schema: "sdt-g74-surface-guard-self-test/v1", status: "PASS", note: "comparator unit tests over in-memory JSON; they do not touch the release artifact", comparatorTests: comparatorResults }, null, 2)}\n`);
} else {
  const current = await extractCurrent();
  assertSurfaceEqual(baseline, current);
  assertLedgerRootCrossCheck(current, ledger);
  process.stdout.write(`${JSON.stringify({ status: "PASS", publicSurfaceHash: current.publicSurfaceHash, packages: current.packages.length, entryPoints: current.entryPoints.length, executorExports: Object.keys(ledger.exports).length }, null, 2)}\n`);
}
