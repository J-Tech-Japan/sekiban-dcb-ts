/**
 * The single definition of the SDT-G74 public-surface identity.
 *
 * Both the extractor and the guard import this module, so the hash the extractor
 * records and the hash the guard recomputes cannot drift apart.
 *
 * The hash covers what a consumer of executor-facade-v1 can observe, and
 * deliberately excludes facts that change without any API change:
 *
 * - package version numbers, and the versions of intra-@sekiban dependencies,
 *   which change on every release without changing the surface;
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

function normalizeDependencies(dependencies) {
  return Object.fromEntries(Object.entries(dependencies ?? {}).map(([name, range]) => [
    name,
    name.startsWith(INTRA_SCOPE) ? "<intra-scope>" : range,
  ]));
}

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
      ...omit(pkg, "version", "dependencies"),
      dependencies: normalizeDependencies(pkg.dependencies),
    })),
    entryPoints: (model.entryPoints ?? []).map((entry) => ({
      ...omit(entry, "version", "symbols"),
      symbols: (entry.symbols ?? []).map(withoutAlias),
    })),
    reachableDeclarations: model.reachableDeclarations ?? [],
    runtimeNamespaces: model.runtimeNamespaces ?? {},
  });
}

export function publicSurfaceHash(model) {
  return createHash("sha256").update(JSON.stringify(hashProjection(model))).digest("hex");
}
