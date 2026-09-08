#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(await readFile(resolve(root, "packages/dcb-domain/package.json"), "utf8")).version;
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (tag === undefined || !tag.startsWith("dcb-domain-v")) throw new Error("SDT-G59 release guard: expected tag dcb-domain-v<version>");
const tagVersion = tag.slice("dcb-domain-v".length);
if (tagVersion !== version) throw new Error(`SDT-G59 release guard: tag ${tagVersion} does not match package version ${version}`);
console.log(JSON.stringify({ status: "PASS", tag, version }));
