#!/usr/bin/env node
/** Guard the committed release-shaped G74 surface and its export classification. */
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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

function compareProjection(left, right) {
  const project = (model) => ({ packages: model.packages, entryPoints: model.entryPoints, runtimeNamespaces: model.runtimeNamespaces });
  return JSON.stringify(project(left)) === JSON.stringify(project(right));
}

function expectedHash(model) {
  return createHash("sha256").update(JSON.stringify(model.entryPoints)).digest("hex");
}

function assertSurfaceEqual(baseline, current) {
  if (baseline.schema !== current.schema) fail(`schema changed from ${baseline.schema} to ${current.schema}`);
  if (baseline.generatedBy?.typescript !== current.generatedBy?.typescript) fail("extractor TypeScript version changed");
  if (!compareProjection(baseline, current)) fail("release-shaped public surface drifted");
  if (current.publicSurfaceHash !== expectedHash(current)) fail("current publicSurfaceHash does not match the enumerated entry points");
}

function sourceExportNames(sourceText) {
  const source = ts.createSourceFile("executor.ts", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set();
  for (const statement of source.statements) {
    const exported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
    if (!exported) continue;
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      if (statement.name !== undefined) names.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
    } else if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) names.add((element.name ?? element.propertyName).text);
    }
  }
  return [...names].sort();
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
  const temp = await mkdtemp(join(root, ".g74-surface-guard-"));
  const output = join(temp, "current.json");
  const environment = { ...process.env };
  const result = spawnSync(process.execPath, [extractorPath, "--output", output], { cwd: root, env: environment, encoding: "utf8" });
  if (result.status !== 0) fail(`release extractor failed\n${result.stdout}\n${result.stderr}`);
  const current = JSON.parse(await readFile(output, "utf8"));
  await rm(temp, { recursive: true, force: true });
  return current;
}

const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const ledger = JSON.parse(await readFile(classificationPath, "utf8"));
const sourceText = await readFile(join(root, "packages/dcb-client/src/executor.ts"), "utf8");
assertClassification(sourceText, ledger);

if (process.argv.includes("--self-test")) {
  const mutationResults = [];
  mutationResults.push(expectMutationRed("removed-export", (model) => {
    clientRoot(model).symbols = clientRoot(model).symbols.filter((symbol) => symbol.name !== "SekibanExecutor");
  }, baseline));
  mutationResults.push(expectMutationRed("renamed-export", (model) => {
    firstSymbol(model, (symbol) => symbol.name === "SekibanExecutor").name = "SekibanExecutorRenamed";
  }, baseline));
  mutationResults.push(expectMutationRed("parameter-type-change", (model) => {
    const symbol = firstSymbol(model, (candidate) => candidate.signatures.call[0]?.parameters.length > 0);
    symbol.signatures.call[0].parameters[0].type = "never";
  }, baseline));
  mutationResults.push(expectMutationRed("return-type-change", (model) => {
    const symbol = firstSymbol(model, (candidate) => candidate.signatures.call.length > 0);
    symbol.signatures.call[0].returnType = "never";
  }, baseline));
  mutationResults.push(expectMutationRed("type-widening", (model) => {
    const symbol = firstSymbol(model, (candidate) => candidate.name === "JsonPrimitive");
    symbol.type = `${symbol.type} | undefined`;
  }, baseline));
  mutationResults.push(expectMutationRed("type-narrowing", (model) => {
    const symbol = firstSymbol(model, (candidate) => candidate.name === "JsonPrimitive");
    symbol.type = "string";
  }, baseline));
  mutationResults.push(expectMutationRed("public-root-export-addition", (model) => {
    const entry = clientRoot(model);
    const template = clone(entry.symbols[0]);
    template.name = "UnexpectedPublicRootAddition";
    entry.symbols.push(template);
    entry.symbols.sort((left, right) => left.name.localeCompare(right.name));
  }, baseline));
  let unclassifiedRed = false;
  try {
    assertClassification(sourceText + "\nexport interface NewlyUnclassified { value: string }\n", ledger);
  } catch (error) {
    unclassifiedRed = true;
    mutationResults.push({ label: "unclassified-executor-export", result: "RED_DETECTED", reason: error instanceof Error ? error.message : String(error) });
  }
  if (!unclassifiedRed) fail("unclassified executor export self-test unexpectedly passed");
  process.stdout.write(`${JSON.stringify({ schema: "sdt-g74-surface-guard-self-test/v1", status: "PASS", mutations: mutationResults }, null, 2)}\n`);
} else {
  const current = await extractCurrent();
  assertSurfaceEqual(baseline, current);
  process.stdout.write(`${JSON.stringify({ status: "PASS", publicSurfaceHash: current.publicSurfaceHash, packages: current.packages.length, entryPoints: current.entryPoints.length, executorExports: Object.keys(ledger.exports).length }, null, 2)}\n`);
}
