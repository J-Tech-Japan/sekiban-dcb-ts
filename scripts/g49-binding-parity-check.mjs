#!/usr/bin/env node
/**
 * SDT-G49 normal-config Durable Object binding parity guard.
 *
 * The normal meeting-room config is deployable only when the Durable Object
 * classes exported by its Worker and the namespaces used by the Cloudflare
 * runtime agree with the config's bindings and SQLite migrations.  This guard
 * derives both sides from implementation source; it does not repeat the
 * expected binding set from the Wrangler manifest.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.cwd();
const entrypointPath = "samples/meeting-room/src/worker.cloudflare-only.ts";
const runtimePath = "packages/dcb-runtime/src/cloudflare.ts";
const defaultConfigPath = "samples/meeting-room/wrangler.cloudflare-only.jsonc";
const runtimeModule = "@sekiban/dcb-runtime/cloudflare";
const checkerPath = fileURLToPath(import.meta.url);

function fail(message) {
  throw new Error("G49 binding parity check failed: " + message);
}

function read(path) {
  return readFileSync(path, "utf8");
}

function readFromRoot(relativePath) {
  return read(resolve(root, relativePath));
}

function identifier(value, label) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)) fail(label + " is not an identifier: " + JSON.stringify(value));
  return value;
}

function unique(values, label) {
  const duplicates = values.filter((value, index) => values.indexOf(value) !== index);
  if (duplicates.length > 0) fail(label + " repeats " + [...new Set(duplicates)].join(", "));
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(label + " must be an object");
  return value;
}

function stringArray(value, label) {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.length > 0)) {
    fail(label + " must be a non-empty string array");
  }
  return value;
}

function stripJsonComments(source) {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (inString) {
      result += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === "\"") inString = false;
      continue;
    }
    if (current === "\"") {
      inString = true;
      result += current;
      continue;
    }
    if (current === "/" && next === "/") {
      const newline = source.indexOf("\n", index + 2);
      if (newline < 0) break;
      result += "\n";
      index = newline;
      continue;
    }
    if (current === "/" && next === "*") {
      const closing = source.indexOf("*/", index + 2);
      if (closing < 0) fail("unterminated JSONC block comment");
      result += " ";
      index = closing + 1;
      continue;
    }
    result += current;
  }
  return result;
}

function jsonc(path) {
  try {
    return JSON.parse(stripJsonComments(read(path)));
  } catch (error) {
    fail(path + " is not valid JSONC: " + (error instanceof Error ? error.message : String(error)));
  }
}

function parseNamedSpecifiers(block, label) {
  const entries = new Map();
  for (const raw of block.split(",")) {
    const cleaned = raw.trim().replace(/^type\s+/, "");
    if (cleaned.length === 0) continue;
    const parts = cleaned.split(/\s+as\s+/);
    if (parts.length > 2) fail(label + " has an invalid specifier " + JSON.stringify(cleaned));
    const imported = identifier(parts[0].trim(), label);
    const local = identifier((parts[1] ?? parts[0]).trim(), label);
    if (entries.has(local)) fail(label + " repeats local import " + local);
    entries.set(local, imported);
  }
  if (entries.size === 0) fail(label + " has no specifiers");
  return entries;
}

function namedImportFrom(source, moduleName, label) {
  const escapedModule = moduleName.replace(/[.*+?^$()|[\]{}]/g, "\\$&");
  const expression = new RegExp("import\\s*\\{([\\s\\S]*?)\\}\\s*from\\s*[\\\"']" + escapedModule + "[\\\"']\\s*;", "g");
  const matches = [...source.matchAll(expression)];
  if (matches.length !== 1) fail(label + " must have exactly one named import from " + moduleName);
  return parseNamedSpecifiers(matches[0][1], label);
}

function allRelativeNamedImports(source, label) {
  const imports = new Map();
  const expression = /import\s+\{([\s\S]*?)\}\s+from\s+["'](\.[^"']+)["']\s*;/g;
  for (const match of source.matchAll(expression)) {
    const specifiers = parseNamedSpecifiers(match[1], label + " import " + match[2]);
    for (const [local, imported] of specifiers) {
      if (imports.has(local)) fail(label + " repeats local runtime import " + local);
      imports.set(local, { imported, moduleName: match[2] });
    }
  }
  return imports;
}

function namedExports(source, label) {
  const exports = new Map();
  const expression = /^export\s*\{([^}]*)\}\s*;$/gm;
  for (const match of source.matchAll(expression)) {
    const specifiers = parseNamedSpecifiers(match[1], label);
    for (const [local, exported] of specifiers) {
      if (exports.has(local)) fail(label + " repeats local export " + local);
      exports.set(local, exported);
    }
  }
  return exports;
}

function resolveRuntimeModule(moduleName) {
  const base = resolve(dirname(resolve(root, runtimePath)), moduleName);
  const candidates = [base + ".ts", base + ".tsx", resolve(base, "index.ts")];
  const match = candidates.find((candidate) => existsSync(candidate));
  if (match === undefined) fail("runtime implementation import cannot be resolved: " + moduleName);
  return match;
}

function runtimeWrapperClasses(source) {
  const relativeImports = allRelativeNamedImports(source, "cloudflare runtime");
  const wrappers = new Map();
  const expression = /^export class ([A-Za-z_$][A-Za-z0-9_$]*) extends ([A-Za-z_$][A-Za-z0-9_$]*)\s*\{/gm;
  for (const match of source.matchAll(expression)) {
    const className = match[1];
    const baseAlias = match[2];
    const imported = relativeImports.get(baseAlias);
    if (imported === undefined) continue;
    const implementationPath = resolveRuntimeModule(imported.moduleName);
    const implementation = read(implementationPath);
    const durableClass = new RegExp(
      "export class\\s+" + imported.imported.replace(/[.*+?^$()|[\]{}]/g, "\\$&") + "\\b[^{}]*\\bimplements\\s+DurableObject\\b",
    );
    if (!durableClass.test(implementation)) {
      fail("runtime wrapper " + className + " does not resolve to a DurableObject implementation");
    }
    wrappers.set(className, {
      implementationClass: imported.imported,
      implementationPath: implementationPath.slice(root.length + 1),
    });
  }
  if (wrappers.size === 0) fail("cloudflare runtime has no Durable Object wrapper classes");
  return wrappers;
}

function runtimeNamespaceBindings(source) {
  const interfaceMatch = source.match(/export interface CloudflareOnlyEnv\s*\{([\s\S]*?)\n\}/);
  if (interfaceMatch === null) fail("CloudflareOnlyEnv interface is missing");
  const bindings = [];
  for (const match of interfaceMatch[1].matchAll(/^\s*(?:readonly\s+)?([A-Z][A-Z0-9_]*):\s*DurableObjectNamespace\s*;/gm)) {
    bindings.push(match[1]);
  }
  if (bindings.length === 0) fail("CloudflareOnlyEnv declares no DurableObjectNamespace bindings");
  unique(bindings, "CloudflareOnlyEnv DurableObjectNamespace bindings");
  return bindings;
}

function canonical(value) {
  return value
    .replace(/DurableObject$/, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toLowerCase();
}

function bindingForClass(className, bindingNames) {
  const classStem = canonical(className);
  const exact = bindingNames.filter((binding) => canonical(binding) === classStem);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) fail("runtime class " + className + " has ambiguous exact binding matches");
  const prefix = bindingNames.filter((binding) => {
    const bindingStem = canonical(binding);
    return classStem.startsWith(bindingStem) || bindingStem.startsWith(classStem);
  });
  if (prefix.length !== 1) {
    fail("runtime class " + className + " cannot be uniquely matched to a CloudflareOnlyEnv namespace; candidates=" + prefix.join(", "));
  }
  return prefix[0];
}

export function deriveBindingPairs() {
  const entrypoint = readFromRoot(entrypointPath);
  const runtime = readFromRoot(runtimePath);
  const entryImports = namedImportFrom(entrypoint, runtimeModule, "meeting-room worker");
  const entryExports = namedExports(entrypoint, "meeting-room worker");
  const wrappers = runtimeWrapperClasses(runtime);
  const namespaceBindings = runtimeNamespaceBindings(runtime);
  const pairs = [];
  for (const [localName, importedName] of entryImports) {
    const exportedName = entryExports.get(localName);
    if (exportedName === undefined || !wrappers.has(importedName)) continue;
    pairs.push({
      binding: bindingForClass(exportedName, namespaceBindings),
      className: exportedName,
      runtimeClass: importedName,
      implementationClass: wrappers.get(importedName).implementationClass,
      implementationPath: wrappers.get(importedName).implementationPath,
    });
  }
  if (pairs.length === 0) fail("meeting-room worker exports no runtime Durable Object classes");
  unique(pairs.map((pair) => pair.binding), "derived Durable Object bindings");
  unique(pairs.map((pair) => pair.className), "derived Durable Object classes");
  const derivedBindings = new Set(pairs.map((pair) => pair.binding));
  const unrepresentedNamespaces = namespaceBindings.filter((binding) => !derivedBindings.has(binding));
  if (unrepresentedNamespaces.length > 0) {
    fail("CloudflareOnlyEnv namespaces lack Worker-exported classes: " + unrepresentedNamespaces.join(", "));
  }
  return pairs.sort((left, right) => left.binding.localeCompare(right.binding));
}

function configBindings(document) {
  const durableObjects = object(document.durable_objects, "durable_objects");
  if (!Array.isArray(durableObjects.bindings)) fail("durable_objects.bindings must be an array");
  const bindings = durableObjects.bindings.map((entry, index) => {
    const binding = object(entry, "durable_objects.bindings[" + index + "]");
    if (typeof binding.name !== "string" || binding.name.length === 0) fail("durable_objects.bindings[" + index + "].name must be a string");
    if (typeof binding.class_name !== "string" || binding.class_name.length === 0) fail("durable_objects.bindings[" + index + "].class_name must be a string");
    return { binding: binding.name, className: binding.class_name };
  });
  unique(bindings.map((binding) => binding.binding), "configured Durable Object bindings");
  unique(bindings.map((binding) => binding.className), "configured Durable Object classes");
  return bindings;
}

function migrationClasses(document) {
  if (!Array.isArray(document.migrations)) fail("migrations must be an array");
  const entries = [];
  for (const [index, raw] of document.migrations.entries()) {
    const migration = object(raw, "migrations[" + index + "]");
    if (typeof migration.tag !== "string" || migration.tag.length === 0) fail("migrations[" + index + "].tag must be a string");
    for (const className of stringArray(migration.new_sqlite_classes, "migrations[" + index + "].new_sqlite_classes")) {
      entries.push({ className, tag: migration.tag });
    }
  }
  unique(entries.map((entry) => entry.className), "new_sqlite_classes");
  return entries;
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((entry) => right.has(entry));
}

export function inspectBindingParity(configPath = resolve(root, defaultConfigPath)) {
  const document = jsonc(configPath);
  const derived = deriveBindingPairs();
  const declared = configBindings(document);
  const migrations = migrationClasses(document);
  const derivedNames = new Set(derived.map((pair) => pair.binding));
  const declaredNames = new Set(declared.map((pair) => pair.binding));
  if (!sameSet(derivedNames, declaredNames)) {
    const missing = [...derivedNames].filter((name) => !declaredNames.has(name));
    const extra = [...declaredNames].filter((name) => !derivedNames.has(name));
    fail("normal config Durable Object binding set differs from implementation; missing=[" + missing.join(", ") + "], extra=[" + extra.join(", ") + "]");
  }
  const expectedByBinding = new Map(derived.map((pair) => [pair.binding, pair.className]));
  for (const pair of declared) {
    const expectedClass = expectedByBinding.get(pair.binding);
    if (pair.className !== expectedClass) {
      fail("normal config binding " + pair.binding + " maps to " + pair.className + ", expected implementation class " + expectedClass);
    }
  }
  const declaredClasses = new Set(declared.map((pair) => pair.className));
  const migratedClasses = new Set(migrations.map((entry) => entry.className));
  if (!sameSet(declaredClasses, migratedClasses)) {
    const missing = [...declaredClasses].filter((className) => !migratedClasses.has(className));
    const extra = [...migratedClasses].filter((className) => !declaredClasses.has(className));
    fail("normal config new_sqlite_classes differs from declared Durable Object classes; missing=[" + missing.join(", ") + "], extra=[" + extra.join(", ") + "]");
  }
  return { document, derived, declared, migrations };
}

function parseArguments(argv) {
  const options = { configPath: resolve(root, defaultConfigPath), selfTest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--config") {
      const value = argv[++index];
      if (value === undefined || value.length === 0) fail("--config requires a path");
      options.configPath = resolve(root, value);
    } else if (argument === "--self-test") {
      options.selfTest = true;
    } else {
      fail("unknown argument " + argument);
    }
  }
  return options;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function requireRed(configPath, label) {
  const result = spawnSync(process.execPath, [checkerPath, "--config", configPath], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status === 0) fail(label + " mutant unexpectedly passed");
}

function selfTest(configPath) {
  const inspection = inspectBindingParity(configPath);
  const temporary = mkdtempSync(resolve(tmpdir(), "sdt-g49-binding-parity-"));
  const bindingOmissions = [];
  const migrationOmissions = [];
  try {
    for (const pair of inspection.derived) {
      const bindingCopy = clone(inspection.document);
      bindingCopy.durable_objects.bindings = bindingCopy.durable_objects.bindings.filter((entry) => entry.name !== pair.binding);
      const bindingPath = resolve(temporary, "binding-" + pair.binding + ".jsonc");
      writeFileSync(bindingPath, JSON.stringify(bindingCopy, null, 2) + "\n");
      requireRed(bindingPath, "binding omission for " + pair.binding);
      bindingOmissions.push({ binding: pair.binding, className: pair.className, result: "red" });

      const migrationCopy = clone(inspection.document);
      const removedTags = migrationCopy.migrations
        .filter((entry) => entry.new_sqlite_classes.includes(pair.className))
        .map((entry) => entry.tag);
      if (removedTags.length === 0) fail("self-test could not find a migration for " + pair.className);
      migrationCopy.migrations = migrationCopy.migrations
        .filter((entry) => !entry.new_sqlite_classes.includes(pair.className));
      const migrationPath = resolve(temporary, "migration-" + pair.binding + ".jsonc");
      writeFileSync(migrationPath, JSON.stringify(migrationCopy, null, 2) + "\n");
      requireRed(migrationPath, "migration omission for " + pair.binding);
      migrationOmissions.push({ binding: pair.binding, className: pair.className, removedMigrationTags: removedTags, result: "red" });
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  process.stdout.write(JSON.stringify({
    result: "g49-binding-parity-mutants-red",
    bindingOmissionMutants: bindingOmissions,
    migrationOmissionMutants: migrationOmissions,
  }, null, 2) + "\n");
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.selfTest) return selfTest(options.configPath);
  const inspection = inspectBindingParity(options.configPath);
  process.stdout.write(JSON.stringify({
    result: "g49-binding-parity-passed",
    config: options.configPath.slice(root.length + 1),
    derivedBindings: inspection.derived.map((pair) => ({
      binding: pair.binding,
      className: pair.className,
      runtimeClass: pair.runtimeClass,
      implementationClass: pair.implementationClass,
      implementationPath: pair.implementationPath,
    })),
    migrations: inspection.migrations,
  }, null, 2) + "\n");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
