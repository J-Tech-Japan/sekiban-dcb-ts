import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";

const root = new URL("..", import.meta.url).pathname;
const packageNames = ["dcb-core", "dcb-runtime", "dcb-client"];

for (const packageDirectory of packageNames) {
  const packageName = `@sekiban/${packageDirectory}`;
  const packageJsonPath = `${root}packages/${packageDirectory}/package.json`;
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  assert.equal(packageJson.private, true, `${packageName} must remain private`);
  assert.equal(packageJson.type, "module", `${packageName} must be ESM`);
  assert.equal(packageJson.sideEffects, false, `${packageName} must be tree-shakeable`);
  assert.ok(packageJson.exports?.["."], `${packageName} must expose its root entrypoint`);
  await readFile(`${root}packages/${packageDirectory}/${packageJson.types}`, "utf8");
  await assert.rejects(import(`${packageName}/dist/index.js`), /not exported|ERR_PACKAGE_PATH_NOT_EXPORTED/);
  await import(packageName);
}

const sampleSource = `${root}samples/meeting-room/src`;
const sampleEntries = await (async function collect(directory) {
  const entries = await (await import("node:fs/promises")).readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await collect(path));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
})(sampleSource);
for (const file of sampleEntries) {
  const source = await readFile(file, "utf8");
  assert.doesNotMatch(source, /\.\.\/\.\.\/packages\/|packages\/[^/]+\/src\//, `sample must not deep-import workspace sources: ${file}`);
  assert.doesNotMatch(source, /from\s+["'][^"']*packages\/[^"']*["']/, `sample must use package entrypoints: ${file}`);
}
const runtimeModule = await import("@sekiban/dcb-runtime");
assert.equal(typeof runtimeModule.createRuntimeWorker, "function", "runtime public registration API is required");

const bundled = await build({
  stdin: {
    contents: 'import { defineTag } from "@sekiban/dcb-core"; console.log(defineTag("g", "c").id);',
    resolveDir: root,
    sourcefile: "g13-consumer-fixture.ts",
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const output = bundled.outputFiles?.[0]?.text ?? "";
assert.match(output, /g.*c/);
assert.ok(!output.includes("Cyclic JSON value"), "unused core validation code should be tree-shaken");
console.log("SDT-G13/G14 consumer fixtures passed: public entrypoints, registration API, deep-import rejection, tree shaking");
