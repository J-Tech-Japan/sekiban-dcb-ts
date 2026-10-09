#!/usr/bin/env node
/* global process */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundledTemplate = resolve(packageRoot, "template");

function fail(message) {
  throw new Error(`create-dcb: ${message}`);
}

function slugify(value) {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length === 0) fail("project name must contain at least one letter or number");
  return slug.length <= 48 ? slug : slug.slice(0, 48).replace(/-+$/g, "");
}

function sourceTemplate() {
  if (existsSync(join(bundledTemplate, "package.json"))) return bundledTemplate;
  fail("starter template is missing from this installation");
}

function assertTargetIsWritable(target) {
  if (!existsSync(target)) return;
  const stats = statSync(target);
  if (!stats.isDirectory()) fail(`target ${target} exists and is not a directory`);
  if (readdirSync(target).length > 0) fail(`target ${target} exists and is not empty`);
}

function replacements(slug) {
  return {
    PROJECT_NAME: slug,
    WORKER_NAME: `${slug}-worker`,
    SERVICE_ID: slug,
    PIPELINE_DB: `${slug}-pipeline`,
    MV_DB: `${slug}-mv`,
    QUEUE_NAME: `${slug}-outbox`,
    DLQ_NAME: `${slug}-outbox-dlq`,
  };
}

function substitute(text, values, file) {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) => {
    const value = values[key];
    if (value === undefined) fail(`unknown placeholder ${whole} in ${file}`);
    return value;
  });
}

function copyTree(source, target, values, root = source) {
  const entries = readdirSync(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(targetPath, { recursive: true });
      copyTree(sourcePath, targetPath, values, root);
      continue;
    }
    if (!entry.isFile()) fail(`unsupported template entry ${relative(root, sourcePath)}`);
    const relativePath = relative(root, sourcePath);
    const text = readFileSync(sourcePath, "utf8");
    writeFileSync(targetPath, substitute(text, values, relativePath));
  }
}

function main(argv) {
  if (argv.length !== 1) fail("usage: create-dcb <project-name>");
  const slug = slugify(argv[0]);
  const target = resolve(process.cwd(), slug);
  assertTargetIsWritable(target);
  mkdirSync(target, { recursive: true });
  copyTree(sourceTemplate(), target, replacements(slug));
  process.stdout.write(`Created ${target}\n`);
  process.stdout.write("Next: npm install, run npm run deploy:check, then follow DEPLOYMENT.md; no resources are created.\n");
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
