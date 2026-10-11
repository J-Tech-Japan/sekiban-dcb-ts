import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const matchedSet = Object.freeze([
  "@sekiban/dcb-core",
  "@sekiban/dcb-domain",
  "@sekiban/dcb-client",
  "@sekiban/dcb-runtime",
]);

export const starterPackages = Object.freeze([
  ...matchedSet,
  "@sekiban/dcb-cloudflare",
  "@sekiban/create-dcb",
]);

export function packageManifest(root, name) {
  return JSON.parse(readFileSync(resolve(root, "packages", name.slice("@sekiban/".length), "package.json"), "utf8"));
}

export function targetManifests(root) {
  return Object.fromEntries(starterPackages.map((name) => [name, packageManifest(root, name)]));
}

export function dependencyTarballMap(artifacts) {
  return Object.fromEntries(artifacts.map((artifact) => [artifact.name, artifact]));
}

export function localDependencySpec(artifact) {
  return `file:${resolve(artifact.path)}`;
}

export function rewriteStarterDependencies(manifest, artifacts) {
  const result = structuredClone(manifest);
  const byName = dependencyTarballMap(artifacts);
  for (const name of [...matchedSet, "@sekiban/dcb-cloudflare"]) {
    if (!byName[name]) throw new Error(`missing local tarball for ${name}`);
    result.dependencies[name] = localDependencySpec(byName[name]);
  }
  return result;
}

export function assertExactLocalDependencyGraph(lockfile, project, artifacts) {
  const byName = dependencyTarballMap(artifacts);
  const packageEntries = lockfile.packages ?? {};
  for (const [key, entry] of Object.entries(packageEntries)) {
    if (entry?.link === true) throw new Error(`workspace link found at ${key}`);
  }

  for (const name of [...matchedSet, "@sekiban/dcb-cloudflare"]) {
    const key = `node_modules/${name}`;
    const entry = packageEntries[key];
    const artifact = byName[name];
    if (!entry) throw new Error(`local tarball ${name} is missing from the lockfile`);
    if (entry.version !== artifact.version) throw new Error(`wrong tarball version for ${name}: ${entry.version}`);
    const resolved = String(entry.resolved ?? "");
    if (!resolved.startsWith("file:")) throw new Error(`registry resolution of target ${name}: ${resolved}`);
    const actual = resolve(project, resolved.slice("file:".length));
    if (resolve(actual) !== resolve(artifact.path)) throw new Error(`wrong local tarball for ${name}`);
  }

  for (const [key] of Object.entries(packageEntries)) {
    for (const name of [...matchedSet, "@sekiban/dcb-cloudflare"]) {
      if (key.endsWith(`node_modules/${name}`) && key !== `node_modules/${name}`) {
        throw new Error(`duplicate local tarball ${name} at ${key}`);
      }
    }
  }
  return {
    localPackages: [...matchedSet, "@sekiban/dcb-cloudflare"],
    workspaceLinks: false,
    registryTargets: false,
  };
}
