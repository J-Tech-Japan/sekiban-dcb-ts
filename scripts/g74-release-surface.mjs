#!/usr/bin/env node
/**
 * SDT-G74 release-shaped public surface extractor.
 *
 * The model is deliberately produced from npm-pack output, then resolved
 * through each package's exports map with TypeScript's Node16 resolver.  It
 * is not a source grep or an assignability-only approximation.
 */
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageNames = ["dcb-core", "dcb-domain", "dcb-client"];
const compilerVersion = ts.version;

function fail(message) {
  throw new Error(`SDT-G74 release surface: ${message}`);
}

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed (${result.status ?? result.signal})\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function parseJsonOutput(output, label) {
  try {
    return JSON.parse(output);
  } catch (error) {
    fail(`${label} did not return JSON: ${error instanceof Error ? error.message : String(error)}\n${output}`);
  }
}

function normalizedText(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\/\/#[^\n]*\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

function stableTypeText(text) {
  return text
    .replace(/import\("[^"]+\/node_modules\/(?:((?:@sekiban\/)[^/"\\]+(?:\/[^"\\]+)?)|(zod(?:\/[^"\\]+)?))"\)/g, 'import("$1$2")')
    .replace(/\/private\/var\/[^"]+\/node_modules\//g, "node_modules/")
    .replace(/\/var\/[^"]+\/node_modules\//g, "node_modules/");
}

function relativeDeclarationPath(fileName, packageRoot) {
  return relative(realpathSync(packageRoot), realpathSync(fileName)).split("\\").join("/");
}

function declarationKind(node) {
  if (node === undefined) return "unknown";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isVariableDeclaration(node)) return "variable";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isModuleDeclaration(node)) return "namespace";
  if (ts.isPropertySignature(node)) return "property";
  if (ts.isMethodSignature(node)) return "method";
  return ts.SyntaxKind[node.kind] ?? "unknown";
}

function hasModifier(node, kind) {
  return node.modifiers?.some((modifier) => modifier.kind === kind) === true;
}

function typeParameterFacts(parameters, checker, location) {
  return (parameters ?? []).map((parameter) => {
    const constraint = parameter.constraint;
    const baseConstraint = checker?.getBaseConstraintOfType?.(parameter);
    return {
      name: parameter.name?.getText?.() ?? parameter.symbol?.name ?? checker?.typeToString(parameter, location, ts.TypeFormatFlags.NoTruncation) ?? "anonymous",
      constraint: constraint === undefined
        ? (baseConstraint === undefined ? null : stableTypeText(checker.typeToString(baseConstraint, location, ts.TypeFormatFlags.NoTruncation)))
        : (constraint.getText?.() === undefined ? stableTypeText(checker?.typeToString(constraint, location, ts.TypeFormatFlags.NoTruncation) ?? "") || null : normalizedText(constraint.getText())),
      default: parameter.default === undefined
        ? null
        : (parameter.default.getText?.() === undefined ? stableTypeText(checker?.typeToString(parameter.default, location, ts.TypeFormatFlags.NoTruncation) ?? "") || null : normalizedText(parameter.default.getText())),
      const: hasModifier(parameter, ts.SyntaxKind.ConstKeyword),
    };
  });
}

function signatureFacts(checker, symbol, declaration) {
  const type = checker.getTypeOfSymbolAtLocation(symbol, declaration ?? symbol.valueDeclaration ?? undefined);
  const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
  const constructors = checker.getSignaturesOfType(type, ts.SignatureKind.Construct);
  const format = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;
  const one = (signature) => ({
    typeParameters: typeParameterFacts(signature.typeParameters, checker, declaration),
    parameters: signature.parameters.map((parameter) => {
      const parameterDeclaration = parameter.valueDeclaration ?? parameter.declarations?.[0];
      const parameterType = checker.getTypeOfSymbolAtLocation(parameter, parameterDeclaration ?? declaration);
      return {
        name: parameter.name,
        optional: (parameter.flags & ts.SymbolFlags.Optional) !== 0 || parameterDeclaration?.questionToken !== undefined,
        rest: parameterDeclaration?.dotDotDotToken !== undefined,
        type: stableTypeText(checker.typeToString(parameterType, parameterDeclaration ?? declaration, format)),
      };
    }),
    returnType: stableTypeText(checker.typeToString(signature.getReturnType(), declaration, format)),
  });
  return { call: signatures.map(one), construct: constructors.map(one) };
}

function syntaxMarkers(declarations) {
  const text = declarations.map((declaration) => declaration.getText()).join("\n");
  const flags = {
    union: /\|/.test(text),
    intersection: /&/.test(text),
    tuple: /\[[^\]]*,[^\]]*\]/.test(text),
    indexSignature: /\[[^\]]+\s*:\s*[^\]]+\]\s*:/.test(text),
    conditional: /\bextends\b[^?]+\?/.test(text),
    mapped: /\{\s*\[/.test(text),
    unknown: /\bunknown\b/.test(text),
    any: /\bany\b/.test(text),
    never: /\bnever\b/.test(text),
    uniqueSymbol: /\bunique\s+symbol\b/.test(text),
    brand: /brand|opaque|__brand|unique\s+symbol/i.test(text),
  };
  return flags;
}

function memberFacts(checker, symbol, declaration) {
  const type = checker.getDeclaredTypeOfSymbol(symbol);
  const properties = type.getProperties?.() ?? [];
  const format = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;
  return properties.map((property) => {
    const propertyDeclaration = property.valueDeclaration ?? property.declarations?.[0];
    const propertyType = checker.getTypeOfSymbolAtLocation(property, propertyDeclaration ?? declaration);
    return {
      name: property.name,
      optional: (property.flags & ts.SymbolFlags.Optional) !== 0 || propertyDeclaration?.questionToken !== undefined,
      readonly: propertyDeclaration?.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword) === true,
      type: stableTypeText(checker.typeToString(propertyType, propertyDeclaration ?? declaration, format)),
    };
  });
}

function symbolNamespaceFlags(symbol, checker) {
  const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const valueMask = ts.SymbolFlags.Class | ts.SymbolFlags.Function | ts.SymbolFlags.Variable |
    ts.SymbolFlags.Enum | ts.SymbolFlags.ValueModule | ts.SymbolFlags.Method |
    ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor;
  const typeMask = ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias | ts.SymbolFlags.TypeParameter |
    ts.SymbolFlags.TypeLiteral | ts.SymbolFlags.Type | ts.SymbolFlags.NamespaceModule;
  return {
    value: (resolved.flags & valueMask) !== 0,
    type: (resolved.flags & typeMask) !== 0 || (resolved.flags & ts.SymbolFlags.Class) !== 0,
    alias: (symbol.flags & ts.SymbolFlags.Alias) !== 0,
  };
}

function exportedTypeText(checker, symbol, primary) {
  if (primary === undefined) return null;
  if (ts.isTypeAliasDeclaration(primary)) {
    return stableTypeText(normalizedText(primary.type.getText(primary.getSourceFile())));
  }
  if (ts.isInterfaceDeclaration(primary)) return null;
  return stableTypeText(checker.typeToString(
    checker.getTypeOfSymbolAtLocation(symbol, primary),
    primary,
    ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
  ));
}

function exportedSymbolFacts(checker, symbol, packageRoot) {
  const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const declarations = (resolved.declarations ?? symbol.declarations ?? []).slice().sort((left, right) => {
    const leftFile = left.getSourceFile().fileName;
    const rightFile = right.getSourceFile().fileName;
    return leftFile.localeCompare(rightFile) || left.getStart() - right.getStart();
  });
  const primary = declarations[0];
  const namespace = symbolNamespaceFlags(symbol, checker);
  const typeText = exportedTypeText(checker, symbol, primary);
  return {
    name: symbol.name,
    namespace,
    declarations: declarations.map((declaration) => ({
      file: relativeDeclarationPath(declaration.getSourceFile().fileName, packageRoot),
      kind: declarationKind(declaration),
      text: normalizedText(declaration.getText()),
      typeParameters: typeParameterFacts(declaration.typeParameters),
    })),
    type: typeText,
    signatures: primary === undefined ? { call: [], construct: [] } : signatureFacts(checker, symbol, primary),
    members: primary === undefined ? [] : memberFacts(checker, resolved, primary),
    syntax: syntaxMarkers(declarations),
  };
}

async function packedPackages(temp) {
  const packRoot = join(temp, "packs");
  await mkdir(packRoot, { recursive: true });
  const packages = {};
  for (const shortName of packageNames) {
    const packageRoot = resolve(root, "packages", shortName);
    const report = parseJsonOutput(run("npm", ["pack", "--json", "--pack-destination", packRoot], packageRoot), `${shortName} npm pack`)[0];
    if (report === undefined || typeof report.filename !== "string") fail(`${shortName} pack report missing filename`);
    const archive = join(packRoot, report.filename);
    const extraction = join(temp, "extracted", shortName);
    await mkdir(extraction, { recursive: true });
    run("tar", ["-xzf", archive, "-C", extraction], root);
    const extractedRoot = join(extraction, "package");
    const manifest = JSON.parse(await readFile(join(extractedRoot, "package.json"), "utf8"));
    packages[shortName] = { shortName, packageRoot, extractedRoot, manifest, report };
  }
  return packages;
}

async function createResolutionRoot(temp, packages) {
  const resolutionRoot = join(temp, "resolution");
  const scope = join(resolutionRoot, "node_modules", "@sekiban");
  await mkdir(scope, { recursive: true });
  for (const shortName of packageNames) {
    await cp(packages[shortName].extractedRoot, join(scope, shortName), { recursive: true });
  }
  await cp(join(root, "node_modules", "zod"), join(resolutionRoot, "node_modules", "zod"), { recursive: true });
  return resolutionRoot;
}

function declarationEntry(manifest, subpath) {
  const exportEntry = manifest.exports?.[subpath];
  if (exportEntry === undefined || typeof exportEntry.types !== "string" || typeof exportEntry.import !== "string") {
    fail(`${manifest.name} ${subpath} has no explicit types/import exports`);
  }
  return { subpath, types: exportEntry.types, import: exportEntry.import };
}

function resolveDeclaration(entry, packageDir, resolutionRoot) {
  const packageName = JSON.parse(entry.manifestText).name;
  const specifier = entry.subpath === "." ? packageName : `${packageName}/${entry.subpath.slice(2)}`;
  const containing = join(resolutionRoot, "surface-entry.ts");
  const result = ts.resolveModuleName(
    specifier,
    containing,
    {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.Node16,
      moduleResolution: ts.ModuleResolutionKind.Node16,
      strict: true,
      resolveJsonModule: true,
    },
    ts.sys,
  ).resolvedModule;
  if (result === undefined || !result.resolvedFileName.endsWith(".d.ts")) {
    fail(`exports-map declaration resolution failed for ${specifier}`);
  }
  const expected = resolve(packageDir, entry.types);
  if (realpathSync(result.resolvedFileName) !== realpathSync(expected)) {
    fail(`${specifier} resolved to ${result.resolvedFileName}, expected ${expected}`);
  }
  return { specifier, fileName: result.resolvedFileName, expectedImport: entry.import };
}

async function extractModel() {
  const temp = await mkdtemp(join(tmpdir(), "sdt-g74-surface-"));
  try {
    const packages = await packedPackages(temp);
    const resolutionRoot = await createResolutionRoot(temp, packages);
    const rootFile = join(resolutionRoot, "surface-entry.ts");
    await writeFile(rootFile, "export {};\n");
    const entries = [];
    for (const shortName of packageNames) {
      const packageInfo = packages[shortName];
      const subpaths = Object.keys(packageInfo.manifest.exports ?? {}).sort();
      for (const subpath of subpaths) {
        const entry = declarationEntry(packageInfo.manifest, subpath);
        const resolved = resolveDeclaration({
          manifestText: JSON.stringify(packageInfo.manifest),
          subpath,
          types: entry.types,
        }, join(resolutionRoot, "node_modules", "@sekiban", shortName), resolutionRoot);
        entries.push({ shortName, packageInfo, entry, resolved });
      }
    }
    const compilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.Node16,
      moduleResolution: ts.ModuleResolutionKind.Node16,
      strict: true,
      skipLibCheck: false,
      noEmit: true,
      types: [],
    };
    const program = ts.createProgram(entries.map((entry) => entry.resolved.fileName), compilerOptions);
    const checker = program.getTypeChecker();
    const declarationDiagnostics = ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
    if (declarationDiagnostics.length > 0) {
      const rendered = ts.formatDiagnosticsWithColorAndContext(declarationDiagnostics.slice(0, 8), {
        getCurrentDirectory: () => resolutionRoot,
        getCanonicalFileName: (value) => value,
        getNewLine: () => "\n",
      });
      fail(`strict declaration resolution emitted ${declarationDiagnostics.length} error(s)\n${rendered}`);
    }
    const modelEntries = [];
    for (const entry of entries) {
      const sourceFile = program.getSourceFile(entry.resolved.fileName);
      if (sourceFile === undefined) fail(`TypeScript program did not contain ${entry.resolved.fileName}`);
      const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
      if (moduleSymbol === undefined) fail(`no module symbol for ${entry.resolved.specifier}`);
      const symbols = checker.getExportsOfModule(moduleSymbol)
        .map((symbol) => exportedSymbolFacts(checker, symbol, join(resolutionRoot, "node_modules", "@sekiban", entry.shortName)))
        .sort((left, right) => left.name.localeCompare(right.name));
      modelEntries.push({
        package: entry.packageInfo.manifest.name,
        shortName: entry.shortName,
        version: entry.packageInfo.manifest.version,
        subpath: entry.entry.subpath,
        declaration: entry.entry.types,
        import: entry.entry.import,
        resolvedDeclaration: entry.entry.types,
        symbols,
        runtimeNames: symbols.filter((symbol) => symbol.namespace.value).map((symbol) => symbol.name).sort(),
      });
    }
    const manifestFacts = packageNames.map((shortName) => {
      const manifest = packages[shortName].manifest;
      return {
        name: manifest.name,
        version: manifest.version,
        private: manifest.private ?? false,
        exports: Object.fromEntries(Object.keys(manifest.exports ?? {}).sort().map((subpath) => [subpath, declarationEntry(manifest, subpath)])),
        dependencies: Object.fromEntries(Object.entries(manifest.dependencies ?? {}).sort()),
      };
    });
    const model = {
      schema: "sdt-g74-surface/v1",
      generatedBy: { typescript: compilerVersion, module: "Node16", moduleResolution: "Node16", target: "ES2022", source: "npm pack + prepack + exports-map-resolved declarations" },
      packages: manifestFacts,
      entryPoints: modelEntries,
      publicSurfaceHash: createHash("sha256").update(JSON.stringify(modelEntries)).digest("hex"),
    };
    const runtimeNamespaces = {};
    for (const entry of entries) {
      const target = join(entry.packageInfo.extractedRoot, entry.entry.import);
      const namespace = await import(`${pathToFileURL(target).href}?g74=${entry.shortName}-${entry.entry.subpath}`);
      const key = `${entry.packageInfo.manifest.name}${entry.entry.subpath === "." ? "" : `/${entry.entry.subpath.slice(2)}`}`;
      runtimeNamespaces[key] = Object.keys(namespace).sort();
    }
    model.runtimeNamespaces = runtimeNamespaces;
    return { model, temp };
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}

const output = process.argv[process.argv.indexOf("--output") + 1];
const keep = process.argv.includes("--keep-temp");
const result = await extractModel();
if (output === undefined) {
  process.stdout.write(`${JSON.stringify(result.model, null, 2)}\n`);
} else {
  await writeFile(resolve(root, output), `${JSON.stringify(result.model, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: "PASS", output: resolve(root, output), publicSurfaceHash: result.model.publicSurfaceHash, packageCount: result.model.packages.length, entryPointCount: result.model.entryPoints.length }, null, 2)}\n`);
}
if (!keep) await rm(result.temp, { recursive: true, force: true });
