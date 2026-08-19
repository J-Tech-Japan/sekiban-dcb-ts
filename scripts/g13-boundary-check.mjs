import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const root = new URL("..", import.meta.url).pathname;

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

const coreFiles = await sourceFiles(`${root}packages/dcb-core/src`);
for (const file of coreFiles) {
  const source = await readFile(file, "utf8");
  assert.doesNotMatch(source, /@cloudflare|from\s+["']cloudflare|\b(?:DurableObject|Hyperdrive|Queue)\b|\bfetch\s*\(/, `dcb-core must stay platform independent: ${file}`);
}

const corePackage = JSON.parse(await readFile(`${root}packages/dcb-core/package.json`, "utf8"));
const runtimePackage = JSON.parse(await readFile(`${root}packages/dcb-runtime/package.json`, "utf8"));
const clientPackage = JSON.parse(await readFile(`${root}packages/dcb-client/package.json`, "utf8"));
assert.deepEqual(Object.keys(corePackage.dependencies ?? {}), [], "dcb-core must have no runtime dependencies");
assert.deepEqual(Object.keys(runtimePackage.dependencies ?? {}), ["@sekiban/dcb-core"], "runtime may depend only on core");
assert.deepEqual(Object.keys(clientPackage.dependencies ?? {}), ["@sekiban/dcb-core"], "client may depend only on core");
assert.ok(runtimePackage.exports?.["./cosmos"], "Cosmos must be an explicit runtime export subpath");
assert.ok(runtimePackage.exports?.["./d1"], "D1 must be an explicit runtime export subpath");
assert.ok(runtimePackage.exports?.["./d1-mv"], "D1 MV must be an explicit runtime export subpath");
assert.ok(runtimePackage.exports?.["./mv"], "MV runtime types must be an explicit runtime export subpath");
const runtimeIndex = await readFile(`${root}packages/dcb-runtime/src/index.ts`, "utf8");
assert.match(runtimeIndex, /export function createRuntimeWorker/, "runtime must expose the public registration API");
assert.doesNotMatch(runtimeIndex, /export .*ProjectorRegistry|export .*QueryRegistry/, "runtime registries must remain private");
const cosmosSource = await readFile(`${root}packages/dcb-runtime/src/store/CosmosEventStore.ts`, "utf8");
assert.doesNotMatch(cosmosSource, /x-sdt-g11-service-id|x-sdt-g9-test-service-id|x-sdt-g4-test-service-id/, "Cosmos storage cannot select a namespace through internal headers");
const cosmosProvider = await readFile(`${root}packages/dcb-runtime/src/cosmos.ts`, "utf8");
assert.doesNotMatch(cosmosProvider, /Request|headers|serviceId.*header/i, "Cosmos provider selection must be composition-only, never request-header driven");
const d1Source = await readFile(`${root}packages/dcb-runtime/src/store/D1EventStore.ts`, "utf8");
assert.doesNotMatch(d1Source, /x-sdt-g11-service-id|x-sdt-g9-test-service-id|x-sdt-g4-test-service-id/, "D1 storage cannot select a namespace through internal headers");
assert.match(d1Source, /COLLATE BINARY/, "D1 store must preserve opaque bytewise SUID ordering");
const sampleFiles = await sourceFiles(`${root}samples/meeting-room/src`);
for (const file of sampleFiles) {
  const source = await readFile(file, "utf8");
  assert.doesNotMatch(source, /\.\.\/\.\.\/packages\/|packages\/[^/]+\/src\//, `sample deep import boundary: ${file}`);
}
console.log("SDT-G13/G14/G12 package-boundary fixture passed: core is platform independent, runtime registration stays private, Cosmos is opt-in, and sample consumes public entrypoints");
