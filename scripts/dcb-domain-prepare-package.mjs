#!/usr/bin/env node
import { copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = resolve(root, "packages/dcb-domain");

await copyFile(resolve(root, "LICENSE"), resolve(packageRoot, "LICENSE"));
console.error(JSON.stringify({ status: "PASS", package: "@sekiban/dcb-domain", prepared: ["LICENSE", "dist-declarations"] }));
