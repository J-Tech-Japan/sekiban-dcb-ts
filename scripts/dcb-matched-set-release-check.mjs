#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tag = process.argv[2] ?? "";
const expected = { core: "0.1.0", domain: "0.1.0", client: "0.1.0" };
const manifests = {};
for (const [key, directory] of Object.entries({ core: "dcb-core", domain: "dcb-domain", client: "dcb-client" })) {
  manifests[key] = JSON.parse(await readFile(resolve(root, "packages", directory, "package.json"), "utf8"));
}
for (const [key, version] of Object.entries(expected)) {
  if (manifests[key].version !== version) throw new Error(`SDT-G64 release guard: ${key} is ${manifests[key].version}, expected ${version}`);
  if (manifests[key].private !== false) throw new Error(`SDT-G64 release guard: ${key} is private`);
}
if (manifests.client.dependencies?.["@sekiban/dcb-core"] !== expected.core ||
    manifests.client.dependencies?.["@sekiban/dcb-domain"] !== expected.domain) {
  throw new Error("SDT-G64 release guard: client dependencies are not the matched 0.1.0 set");
}
if (tag !== "" && tag !== `dcb-v${expected.core}`) {
  throw new Error(`SDT-G64 release guard: tag ${tag} is not dcb-v${expected.core}`);
}
console.log(JSON.stringify({ status: "PASS", tag: tag || null, order: ["@sekiban/dcb-core", "@sekiban/dcb-domain", "@sekiban/dcb-client"], version: expected.core }));
