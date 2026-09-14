#!/usr/bin/env node
/**
 * SDT-G74 release-shaped public surface extractor.
 *
 * The model is deliberately produced from npm-pack output, then resolved
 * through each package's exports map with TypeScript's Node16 resolver.  It
 * is not a source grep or an assignability-only approximation.
 */
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import ts from "typescript";
import { publicSurfaceHash } from "./g74-surface-hash.mjs";

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

/**
 * Comments are documentation, not surface: a JSDoc edit on a member must not move
 * the surface identity any more than one on a top-level declaration does (whose
 * leading comment `getText()` already excludes). The TypeScript scanner drops
 * comment trivia without touching string or template literal contents.
 */
function withoutComments(text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  let result = "";
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) {
      result += " ";
      continue;
    }
    result += scanner.getTokenText();
  }
  return result;
}

function normalizedText(text) {
  return withoutComments(text.replace(/\r\n/g, "\n"))
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

/** True when any hop of an export alias chain is `export type`. */
function exportedTypeOnly(symbol, checker) {
  let current = symbol;
  for (let hop = 0; hop < 32 && current !== undefined && (current.flags & ts.SymbolFlags.Alias) !== 0; hop += 1) {
    for (const declaration of current.declarations ?? []) {
      if (ts.isExportSpecifier(declaration) && (declaration.isTypeOnly || declaration.parent?.parent?.isTypeOnly)) return true;
      if (ts.isExportDeclaration(declaration) && declaration.isTypeOnly) return true;
      if (ts.isImportSpecifier(declaration) && (declaration.isTypeOnly || declaration.parent?.parent?.isTypeOnly)) return true;
      if (ts.isImportClause(declaration) && declaration.isTypeOnly) return true;
    }
    current = checker.getImmediateAliasedSymbol(current);
  }
  return false;
}

function symbolNamespaceFlags(symbol, checker) {
  const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const typeOnly = exportedTypeOnly(symbol, checker);
  const valueMask = ts.SymbolFlags.Class | ts.SymbolFlags.Function | ts.SymbolFlags.Variable |
    ts.SymbolFlags.Enum | ts.SymbolFlags.ValueModule | ts.SymbolFlags.Method |
    ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor;
  const typeMask = ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias | ts.SymbolFlags.TypeParameter |
    ts.SymbolFlags.TypeLiteral | ts.SymbolFlags.Type | ts.SymbolFlags.NamespaceModule;
  return {
    // A value re-exported with `export type` is not a value to a consumer.
    value: (resolved.flags & valueMask) !== 0 && !typeOnly,
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


/**
 * Drift proofs must change the release artifact itself, not a copy of the
 * baseline JSON. `--mutate <spec.json>` names text edits applied to the extracted
 * tarball contents before any fact is read. Every edit states how many matches it
 * expects; a stale anchor that matches nothing fails loudly instead of silently
 * turning a mutant into a no-op.
 */
const packDirFlag = process.argv.indexOf("--pack-dir");
const packCacheDir = packDirFlag === -1 ? undefined : resolve(root, process.argv[packDirFlag + 1] ?? "");
if (packDirFlag !== -1 && (process.argv[packDirFlag + 1] === undefined || process.argv[packDirFlag + 1].startsWith("--"))) {
  process.stderr.write("g74-release-surface: --pack-dir requires a directory\n");
  process.exit(2);
}
const mutateFlag = process.argv.indexOf("--mutate");
const mutationSpecPath = mutateFlag === -1 ? undefined : process.argv[mutateFlag + 1];
if (mutateFlag !== -1 && (mutationSpecPath === undefined || mutationSpecPath.startsWith("--"))) {
  process.stderr.write("g74-release-surface: --mutate requires a spec path\n");
  process.exit(2);
}
const artifactMutations = mutationSpecPath === undefined
  ? []
  : JSON.parse(readFileSync(resolve(root, mutationSpecPath), "utf8")).edits;

async function applyArtifactMutations(shortName, extractedRoot) {
  for (const edit of artifactMutations.filter((candidate) => candidate.package === shortName)) {
    const target = join(extractedRoot, edit.file);
    const text = await readFile(target, "utf8");
    const matches = text.split(edit.search).length - 1;
    if (matches !== edit.expectedMatches) {
      fail(`mutation anchor for ${shortName}/${edit.file} matched ${matches} time(s), expected ${edit.expectedMatches}: ${JSON.stringify(edit.search)}`);
    }
    await writeFile(target, text.split(edit.search).join(edit.replace));
  }
}

async function packedPackages(temp) {
  const packRoot = join(temp, "packs");
  await mkdir(packRoot, { recursive: true });
  const packages = {};
  for (const shortName of packageNames) {
    const packageRoot = resolve(root, "packages", shortName);
    let report;
    let archive;
    if (packCacheDir === undefined) {
      report = parseJsonOutput(run("npm", ["pack", "--json", "--pack-destination", packRoot], packageRoot), `${shortName} npm pack`)[0];
      if (report === undefined || typeof report.filename !== "string") fail(`${shortName} pack report missing filename`);
      archive = join(packRoot, report.filename);
    } else {
      // Reuse tarballs already produced by `npm pack` for this exact head. Each run
      // still extracts a fresh copy, so an artifact mutation never leaks into the next.
      const candidates = readdirSync(packCacheDir).filter((name) => name.startsWith(`sekiban-${shortName}-`) && name.endsWith(".tgz"));
      if (candidates.length !== 1) fail(`--pack-dir must hold exactly one sekiban-${shortName}-*.tgz, found ${candidates.length}`);
      archive = join(packCacheDir, candidates[0]);
      report = { filename: candidates[0], reusedFrom: "pack-dir" };
    }
    const extraction = join(temp, "extracted", shortName);
    await mkdir(extraction, { recursive: true });
    run("tar", ["-xzf", archive, "-C", extraction], root);
    const extractedRoot = join(extraction, "package");
    await applyArtifactMutations(shortName, extractedRoot);
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

/**
 * Node picks the first matching export condition, so condition order is part of
 * the contract. Subpaths are sorted; conditions keep their manifest order as
 * [condition, target] pairs.
 */
function exportsInResolutionOrder(exportsField) {
  const conditions = (value) => (value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value).map(([condition, target]) => [condition, conditions(target)])
    : value);
  if (typeof exportsField === "string") return exportsField;
  return Object.fromEntries(Object.keys(exportsField).sort().map((subpath) => [subpath, conditions(exportsField[subpath])]));
}

function sortedDeep(value) {
  if (Array.isArray(value)) return value.map(sortedDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedDeep(value[key])]));
  }
  return value;
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


/** Package metadata that is not part of what a consumer compiles or runs against. */
const MANIFEST_METADATA_FIELDS = new Set([
  "author", "bugs", "contributors", "description", "devDependencies", "files", "funding",
  "gitHead", "homepage", "keywords", "license", "publishConfig", "readme", "readmeFilename",
  "repository", "scripts",
]);

/**
 * Facts a declaration file carries outside its exports: triple-slash directives
 * pull lib, types or files into every consumer's program, and `declare global` or
 * `declare module` augmentations change types the consumer did not import from us.
 * Only files that carry at least one such fact are recorded.
 */
function declarationFileFacts(program, scopeRoot) {
  const scope = realpathSync(scopeRoot);
  const facts = [];
  for (const sourceFile of program.getSourceFiles()) {
    const fileName = realpathSync(sourceFile.fileName);
    if (!fileName.startsWith(scope)) continue;
    const packageDir = fileName.slice(scope.length + 1).split("/")[0];
    const directives = {
      lib: sourceFile.libReferenceDirectives.map((directive) => directive.fileName).sort(),
      path: sourceFile.referencedFiles.map((directive) => directive.fileName).sort(),
      types: sourceFile.typeReferenceDirectives.map((directive) => directive.fileName).sort(),
    };
    const augmentations = sourceFile.statements
      .filter((statement) => ts.isModuleDeclaration(statement) && (
        (statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0 || ts.isStringLiteral(statement.name)))
      .map((statement) => normalizedText(statement.getText()))
      .sort();
    if (directives.lib.length + directives.path.length + directives.types.length + augmentations.length === 0) continue;
    facts.push({
      package: `@sekiban/${packageDir}`,
      file: relativeDeclarationPath(sourceFile.fileName, join(scopeRoot, packageDir)),
      directives,
      augmentations,
    });
  }
  return facts.sort((left, right) => left.package.localeCompare(right.package) || left.file.localeCompare(right.file));
}

const TYPE_REFERENCE_NAMES = (node) => {
  if (ts.isTypeReferenceNode(node)) return node.typeName;
  if (ts.isExpressionWithTypeArguments(node)) return node.expression;
  if (ts.isTypeQueryNode(node)) return node.exprName;
  if (ts.isImportTypeNode(node)) return node.qualifier;
  // A brand member `readonly [tagFamilyBrand]: F` reaches the non-exported
  // `declare const tagFamilyBrand: unique symbol` through its computed name.
  if (ts.isComputedPropertyName(node)) return node.expression;
  return undefined;
};

/**
 * Walk every type the public signatures can reach and record the declarations
 * that live inside the packed @sekiban packages but are not themselves exported.
 * A public function taking `LegacyDomainDefinition` exposes that interface's
 * shape even though its name is not exported, so making one of its members
 * required is a breaking change the surface must see.
 */
function reachableDeclarationFacts(checker, exportedSymbols, scopeRoot) {
  const inScope = (declaration) => realpathSync(declaration.getSourceFile().fileName).startsWith(realpathSync(scopeRoot));
  const keyOf = (declaration) => `${realpathSync(declaration.getSourceFile().fileName)}:${declaration.getStart()}`;
  const exportedKeys = new Set();
  const queue = [];
  for (const symbol of exportedSymbols) {
    const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    for (const declaration of resolved.declarations ?? []) {
      if (!inScope(declaration)) continue;
      exportedKeys.add(keyOf(declaration));
      queue.push(declaration);
    }
  }
  const visited = new Set(exportedKeys);
  const recorded = [];
  while (queue.length > 0) {
    const declaration = queue.shift();
    const visit = (node) => {
      const nameNode = TYPE_REFERENCE_NAMES(node);
      if (nameNode !== undefined) {
        let target = checker.getSymbolAtLocation(nameNode);
        if (target !== undefined && target.flags & ts.SymbolFlags.Alias) target = checker.getAliasedSymbol(target);
        for (const referenced of target?.declarations ?? []) {
          if (!inScope(referenced)) continue;
          const key = keyOf(referenced);
          if (visited.has(key)) continue;
          visited.add(key);
          queue.push(referenced);
          const packageDir = realpathSync(referenced.getSourceFile().fileName).slice(realpathSync(scopeRoot).length + 1).split("/")[0];
          recorded.push({
            package: `@sekiban/${packageDir}`,
            file: relativeDeclarationPath(referenced.getSourceFile().fileName, join(scopeRoot, packageDir)),
            name: referenced.name?.getText?.() ?? target.name,
            kind: declarationKind(referenced),
            text: normalizedText(referenced.getText()),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(declaration);
  }
  return recorded.sort((left, right) =>
    left.package.localeCompare(right.package) ||
    left.file.localeCompare(right.file) ||
    left.name.localeCompare(right.name) ||
    left.text.localeCompare(right.text));
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
    const allExportedSymbols = [];
    for (const entry of entries) {
      const sourceFile = program.getSourceFile(entry.resolved.fileName);
      if (sourceFile === undefined) fail(`TypeScript program did not contain ${entry.resolved.fileName}`);
      const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
      if (moduleSymbol === undefined) fail(`no module symbol for ${entry.resolved.specifier}`);
      const exportedModuleSymbols = checker.getExportsOfModule(moduleSymbol);
      allExportedSymbols.push(...exportedModuleSymbols);
      const symbols = exportedModuleSymbols
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
      for (const subpath of Object.keys(manifest.exports ?? {})) declarationEntry(manifest, subpath);
      // Deny by default: every manifest field is a consumer-visible fact unless it
      // is named here as package metadata. A new peerDependencies, sideEffects,
      // types or bin field therefore changes the model without anyone listing it.
      const extra = Object.fromEntries(Object.keys(manifest)
        .filter((key) => !MANIFEST_METADATA_FIELDS.has(key) && !["name", "version", "private", "type", "engines", "exports", "dependencies"].includes(key))
        .sort()
        .map((key) => [key, sortedDeep(manifest[key])]));
      return {
        name: manifest.name,
        version: manifest.version,
        private: manifest.private ?? false,
        type: manifest.type ?? null,
        engines: sortedDeep(manifest.engines ?? {}),
        exports: exportsInResolutionOrder(manifest.exports ?? {}),
        dependencies: Object.fromEntries(Object.entries(manifest.dependencies ?? {}).sort()),
        otherFields: extra,
      };
    });
    const model = {
      schema: "sdt-g74-surface/v3",
      generatedBy: { typescript: compilerVersion, module: "Node16", moduleResolution: "Node16", target: "ES2022", source: "npm pack + prepack + exports-map-resolved declarations" },
      packages: manifestFacts,
      entryPoints: modelEntries,
      reachableDeclarations: reachableDeclarationFacts(checker, allExportedSymbols, join(resolutionRoot, "node_modules", "@sekiban")),
      declarationFiles: declarationFileFacts(program, join(resolutionRoot, "node_modules", "@sekiban")),
    };
    const runtimeNamespaces = {};
    for (const entry of entries) {
      const target = join(entry.packageInfo.extractedRoot, entry.entry.import);
      const namespace = await import(`${pathToFileURL(target).href}?g74=${entry.shortName}-${entry.entry.subpath}`);
      const key = `${entry.packageInfo.manifest.name}${entry.entry.subpath === "." ? "" : `/${entry.entry.subpath.slice(2)}`}`;
      runtimeNamespaces[key] = Object.keys(namespace).sort();
    }
    model.runtimeNamespaces = runtimeNamespaces;
    model.publicSurfaceHash = publicSurfaceHash(model);
    return { model, temp };
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}

const outputFlag = process.argv.indexOf("--output");
// A missing --output means stdout. indexOf returns -1 when the flag is absent,
// and -1 + 1 is 0, which is argv[0]: the node executable. Never write there.
const output = outputFlag === -1 ? undefined : process.argv[outputFlag + 1];
if (outputFlag !== -1 && (output === undefined || output.startsWith("--"))) {
  process.stderr.write("g74-release-surface: --output requires a path\n");
  process.exit(2);
}
const keep = process.argv.includes("--keep-temp");
const result = await extractModel();
if (output === undefined) {
  process.stdout.write(`${JSON.stringify(result.model, null, 2)}\n`);
} else {
  await writeFile(resolve(root, output), `${JSON.stringify(result.model, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: "PASS", output: resolve(root, output), publicSurfaceHash: result.model.publicSurfaceHash, packageCount: result.model.packages.length, entryPointCount: result.model.entryPoints.length }, null, 2)}\n`);
}
if (!keep) await rm(result.temp, { recursive: true, force: true });
