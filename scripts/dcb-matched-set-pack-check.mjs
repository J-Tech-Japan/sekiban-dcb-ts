#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = "0.1.1";
const packageNames = ["dcb-core", "dcb-domain", "dcb-client"];
const packageRoots = Object.fromEntries(packageNames.map((name) => [name, resolve(root, "packages", name)]));
const allowedEntries = {
  "dcb-core": new Set(["LICENSE", "README.md", "dist", "package.json", "src", "tsconfig.build.json", "tsconfig.json"]),
  "dcb-domain": new Set(["LICENSE", "README.md", "boundary-fixtures", "diagnostic-fixtures", "dist", "package.json", "src", "tsconfig.build.json", "tsconfig.json", "tsconfig.typecheck.json", "typecheck-fixtures"]),
  "dcb-client": new Set(["LICENSE", "README.md", "dist", "package.json", "src", "tsconfig.build.json", "tsconfig.json"]),
};

function fail(message) {
  throw new Error(`SDT-G64 pack guard: ${message}`);
}

function expect(value, message) {
  if (!value) fail(message);
}

function exact(value, expected, label) {
  if (JSON.stringify(value) !== JSON.stringify(expected)) fail(`${label} is ${JSON.stringify(value)}, expected ${JSON.stringify(expected)}`);
}

const manifests = {};
for (const name of packageNames) {
  const packageRoot = packageRoots[name];
  const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  manifests[name] = manifest;
  expect(!/(?:workspace:|file:|link:)/.test(JSON.stringify(manifest)), `${name} manifest contains a workspace/file/link dependency specifier`);
  expect(manifest.name === `@sekiban/${name}`, `${name} package name is incorrect`);
  expect(manifest.version === version, `${name} version must be ${version}`);
  expect(manifest.private === false, `${name} package must be public`);
  expect(manifest.license === "Elastic-2.0", `${name} license must be Elastic-2.0`);
  expect(manifest.type === "module" && manifest.sideEffects === false, `${name} must be side-effect-free ESM`);
  expect(manifest.engines?.node === ">=20", `${name} must declare node >=20`);
  exact(manifest.files, ["dist", "README.md", "LICENSE"], `${name} files allowlist`);
  expect(manifest.publishConfig?.access === "public" && manifest.publishConfig?.provenance === true, `${name} public provenance publishConfig is missing`);
  expect(manifest.exports?.["."]?.types === "./dist/index.d.ts", `${name} type export is incorrect`);
  expect(manifest.exports?.["."]?.import === "./dist/index.js", `${name} import export is incorrect`);
  expect(typeof manifest.repository?.url === "string" && manifest.repository.url.includes("sekiban-dcb-ts"), `${name} repository metadata is missing`);
  expect(typeof manifest.homepage === "string" && typeof manifest.bugs?.url === "string", `${name} project links are missing`);
  const entries = await readdir(packageRoot, { withFileTypes: true });
  const unexpected = entries.map((entry) => entry.name).filter((entry) => !allowedEntries[name].has(entry));
  expect(unexpected.length === 0, `${name} contains unexpected package entries: ${unexpected.join(", ")}`);
  for (const required of ["README.md", ...(name === "dcb-domain" ? [] : ["LICENSE"])]) {
    const contents = await readFile(resolve(packageRoot, required), "utf8");
    expect(contents.trim().length > 0, `${name} is missing a non-empty ${required}`);
  }
}

const domain = manifests["dcb-domain"];
exact(Object.keys(domain.dependencies ?? {}).sort(), ["zod"], "domain runtime dependency allowlist");
expect(domain.dependencies.zod === "4.4.3", "domain zod dependency must remain pinned at 4.4.3");
exact(manifests["dcb-core"].dependencies ?? {}, {}, "core runtime dependency allowlist");
exact(manifests["dcb-core"].devDependencies ?? {}, {}, "core dev dependency allowlist");
exact(manifests["dcb-client"].dependencies, {
  "@sekiban/dcb-core": version,
  "@sekiban/dcb-domain": version,
}, "client matched runtime dependencies");
exact(manifests["dcb-client"].devDependencies ?? {}, {}, "client dev dependency allowlist");

const packages = [];
for (const name of packageNames) {
  const packageRoot = packageRoots[name];
  const env = { ...process.env };
  if (env.NPM_CONFIG_CACHE !== undefined) env.npm_config_cache = env.NPM_CONFIG_CACHE;
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: packageRoot, encoding: "utf8", env });
  if (result.status !== 0) fail(`${name} npm pack failed\n${result.stderr}`);
  let report;
  try {
    report = JSON.parse(result.stdout)[0];
  } catch (error) {
    fail(`${name} npm pack did not return JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const names = report.files.map((file) => file.path);
  const allowed = (entry) => entry === "package.json" || entry === "README.md" || entry === "LICENSE" || entry.startsWith("dist/");
  const unexpected = names.filter((entry) => !allowed(entry));
  expect(unexpected.length === 0, `${name} tarball contains unexpected files: ${unexpected.join(", ")}`);
  for (const required of ["package.json", "README.md", "LICENSE", "dist/index.js", "dist/index.d.ts"]) {
    expect(names.includes(required), `${name} tarball omitted ${required}`);
  }
  expect(!names.some((entry) => entry.endsWith(".map")), `${name} tarball must not contain source maps`);
  expect(report.unpackedSize <= 1_000_000, `${name} tarball exceeds 1,000,000 unpacked bytes`);
  packages.push({ name: manifests[name].name, version, files: names, unpackedSize: report.unpackedSize });
}

console.log(JSON.stringify({ status: "PASS", set: packageNames.map((name) => manifests[name].name), version, packages }, null, 2));
