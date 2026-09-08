#!/usr/bin/env node
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = resolve(root, "packages/dcb-domain");

await rm(resolve(packageRoot, "dist"), { recursive: true, force: true });
await mkdir(resolve(packageRoot, "dist"), { recursive: true });
await copyFile(resolve(root, "LICENSE"), resolve(packageRoot, "LICENSE"));
console.log(JSON.stringify({ status: "PASS", package: "@sekiban/dcb-domain", prepared: ["dist", "LICENSE"] }));
