/**
 * The single definition of the SDT-G74 public-surface identity.
 *
 * Both the extractor and the guard import this module, so the hash the extractor
 * records and the hash the guard recomputes cannot drift apart.
 *
 * The hash covers what a consumer of executor-facade-v1 can observe, and
 * deliberately excludes facts that change without any API change:
 *
 * - package version numbers, and an intra-@sekiban dependency range that pins
 *   exactly the package's own version, which moves on every release without
 *   changing the surface (a looser or different intra-scope range is kept);
 * - comments, which the extractor already removes from declaration text;
 * - TypeScript's internal symbol ids in names such as `__@eventPayloadBrand@40873`,
 *   which depend on program construction order rather than on the declaration;
 * - the re-export `alias` flag, which distinguishes `export *` from an explicit
 *   named re-export of the same declaration and is not visible to a consumer.
 *
 * Everything else in the projection is part of the identity.
 */
import { createHash } from "node:crypto";

const INTERNAL_SYMBOL_ID = /__@([^@\s"\\]+)@\d+/g;
const INTRA_SCOPE = "@sekiban/";

/** Replace `__@name@12345` with `__@name` in every string of a JSON value. */
export function normalizeInternalSymbolIds(value) {
  if (typeof value === "string") return value.replace(INTERNAL_SYMBOL_ID, "__@$1");
  if (Array.isArray(value)) return value.map(normalizeInternalSymbolIds);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeInternalSymbolIds(entry)]));
  }
  return value;
}

function normalizeDependencies(dependencies, ownVersion) {
  if (dependencies === undefined) return undefined;
  return Object.fromEntries(Object.entries(dependencies).map(([name, range]) => [
    name,
    name.startsWith(INTRA_SCOPE) && range === ownVersion ? "<intra-scope-exact>" : range,
  ]));
}

const DEPENDENCY_FIELDS = ["peerDependencies", "optionalDependencies"];

/** A shallow copy without the named keys, keeping the order of the rest. */
function omit(value, ...keys) {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}

function withoutAlias(symbol) {
  return { ...symbol, namespace: omit(symbol.namespace ?? {}, "alias") };
}

/** The exact projection that defines the surface identity. */
export function hashProjection(model) {
  return normalizeInternalSymbolIds({
    packages: (model.packages ?? []).map((pkg) => ({
      ...omit(pkg, "version", "dependencies", "otherFields"),
      dependencies: normalizeDependencies(pkg.dependencies ?? {}, pkg.version),
      otherFields: Object.fromEntries(Object.entries(pkg.otherFields ?? {}).map(([key, value]) => [
        key,
        DEPENDENCY_FIELDS.includes(key) ? normalizeDependencies(value, pkg.version) : value,
      ])),
    })),
    entryPoints: (model.entryPoints ?? []).map((entry) => ({
      ...omit(entry, "version", "symbols"),
      symbols: (entry.symbols ?? []).map(withoutAlias),
    })),
    reachableDeclarations: model.reachableDeclarations ?? [],
    declarationFiles: model.declarationFiles ?? [],
    runtimeNamespaces: model.runtimeNamespaces ?? {},
  });
}

export function publicSurfaceHash(model) {
  return createHash("sha256").update(JSON.stringify(hashProjection(model))).digest("hex");
}
