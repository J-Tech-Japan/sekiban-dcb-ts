#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = resolve(root, "packages/dcb-domain");
const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
const allowedEntries = new Set([
  "LICENSE",
  "README.md",
  "boundary-fixtures",
  "diagnostic-fixtures",
  "dist",
  "package.json",
  "src",
  "tsconfig.build.json",
  "tsconfig.json",
  "tsconfig.typecheck.json",
  "typecheck-fixtures",
]);
const entries = await readdir(packageRoot, { withFileTypes: true });
const unexpectedEntries = entries.map((entry) => entry.name).filter((name) => !allowedEntries.has(name));
if (unexpectedEntries.length > 0) {
  throw new Error(`SDT-G59 pack guard: unexpected package entries: ${unexpectedEntries.join(", ")}`);
}
if (packageJson.private !== false) throw new Error("SDT-G59 pack guard: package must be public");
if (typeof packageJson.version !== "string" || packageJson.version.length === 0) throw new Error("SDT-G71 pack guard: package version is missing");
if (packageJson.license !== "Elastic-2.0") throw new Error("SDT-G59 pack guard: license must be Elastic-2.0");
if (JSON.stringify(packageJson.files) !== JSON.stringify(["dist", "README.md", "LICENSE"])) {
  throw new Error(`SDT-G59 pack guard: files allowlist is ${JSON.stringify(packageJson.files)}`);
}
if (packageJson.publishConfig?.access !== "public" || packageJson.publishConfig?.provenance !== true) {
  throw new Error("SDT-G71 pack guard: public provenance publishConfig is missing");
}
if (JSON.stringify(Object.keys(packageJson.dependencies ?? {}).sort()) !== JSON.stringify(["@sekiban/dcb-core", "zod"])) {
  throw new Error("SDT-G59 pack guard: runtime dependency allowlist must be exactly @sekiban/dcb-core and zod");
}
if (packageJson.dependencies["@sekiban/dcb-core"] !== "0.2.2") {
  throw new Error("SDT-G59 pack guard: @sekiban/dcb-core must be pinned at 0.2.2");
}
if (packageJson.dependencies.zod !== "4.4.3") {
  throw new Error("SDT-G59 pack guard: zod must remain pinned at 4.4.3");
}

const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: packageRoot, encoding: "utf8" });
if (packed.status !== 0) throw new Error(`SDT-G59 pack guard: npm pack failed\n${packed.stderr}`);
const report = JSON.parse(packed.stdout)[0];
const names = report.files.map((file) => file.path);
const allowedPacked = (name) => name === "package.json" || name === "README.md" || name === "LICENSE" || name.startsWith("dist/");
const unexpectedPacked = names.filter((name) => !allowedPacked(name));
if (unexpectedPacked.length > 0) throw new Error(`SDT-G59 pack guard: tarball contains unexpected files: ${unexpectedPacked.join(", ")}`);
for (const required of ["package.json", "README.md", "LICENSE", "dist/index.js", "dist/index.d.ts", "dist/testing.js", "dist/testing.d.ts"]) {
  if (!names.includes(required)) throw new Error(`SDT-G59 pack guard: tarball omitted ${required}`);
}
if (names.some((name) => name.startsWith("dist/") && name.endsWith(".map"))) {
  throw new Error("SDT-G59 pack guard: source maps are not allowed in the release tarball");
}
// Zod stays an external dependency so codec failures use the consumer's
// pinned constructors. Keep a documented upper bound on the neutral bundle.
const maxUnpackedBytes = 1_000_000;
if (report.unpackedSize > maxUnpackedBytes) {
  throw new Error(`SDT-G59 pack guard: unpacked tarball is ${report.unpackedSize} bytes, limit is ${maxUnpackedBytes}`);
}
console.log(JSON.stringify({
  status: "PASS",
  package: packageJson.name,
  version: packageJson.version,
  files: names,
  fileCount: names.length,
  unpackedSize: report.unpackedSize,
  maxUnpackedBytes,
}));
