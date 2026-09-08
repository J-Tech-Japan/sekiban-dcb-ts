#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
const output = process.argv[3];
if (tag === undefined || output === undefined) throw new Error("usage: dcb-domain-release-notes.mjs <tag> <output>");
const version = tag.replace(/^dcb-domain-v/, "");
const changelog = await readFile(resolve(root, "CHANGELOG.md"), "utf8");
const marker = `## @sekiban/dcb-domain ${version}`;
const start = changelog.indexOf(marker);
if (start < 0) throw new Error(`SDT-G59 release notes: missing ${marker}`);
const end = changelog.indexOf("\n## ", start + marker.length);
const notes = changelog.slice(start, end < 0 ? undefined : end).trim() + "\n";
await writeFile(output, notes, "utf8");
console.log(JSON.stringify({ status: "PASS", tag, output, bytes: Buffer.byteLength(notes) }));
