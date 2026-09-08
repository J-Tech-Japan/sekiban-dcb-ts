#!/usr/bin/env node
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(new URL(".", import.meta.url).pathname, "..");
const declarationRoot = join(root, "packages", "dcb-domain", "dist");

function withJavaScriptExtension(specifier) {
  return /\.(?:js|json|mjs|cjs|d\.ts)$/.test(specifier) ? specifier : `${specifier}.js`;
}

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    else if (entry.name.endsWith(".d.ts")) {
      const source = await readFile(path, "utf8");
      const fixed = source
        .replace(/(\bfrom\s+["'])(\.{1,2}\/[^"']+)(["'])/g, (_match, prefix, specifier, suffix) => `${prefix}${withJavaScriptExtension(specifier)}${suffix}`)
        .replace(/(\bimport\s*\(\s*["'])(\.{1,2}\/[^"']+)(["'])/g, (_match, prefix, specifier, suffix) => `${prefix}${withJavaScriptExtension(specifier)}${suffix}`);
      if (fixed !== source) await writeFile(path, fixed);
    }
  }
}

await visit(declarationRoot);
console.log(JSON.stringify({ status: "PASS", declarations: "node16-compatible-relative-specifiers" }));
