#!/usr/bin/env node
/**
 * Derive the SDT-G40 CI command inventory from the workflow and package
 * scripts.  The workflow contributes every `run:` block; npm invocations are
 * then expanded recursively through package.json so a removed nested check is
 * observable as well as a removed workflow step.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const DEFAULT_WORKFLOW = ".github/workflows/ci.yml";
const DEFAULT_PACKAGE = "package.json";
const SCHEMA = "sdt-g40-ci-step-inventory/v1";

function fail(message) {
  throw new Error(`g40-ci-step-inventory:${message}`);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeCommand(value) {
  return value
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function isBlockScalar(value) {
  return /^(?:[>|])(?:[+-])?$/.test(value.trim());
}

/**
 * This intentionally small parser covers the GitHub Actions `run:` grammar
 * used in ci.yml.  It does not attempt to parse YAML generally, which keeps
 * the inventory independent of a transient node_modules dependency.
 */
export function extractRunSteps(workflowText) {
  const lines = workflowText.replace(/\r/g, "").split("\n");
  const steps = [];
  let insideJobs = false;
  let currentJob = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "jobs:") {
      insideJobs = true;
      continue;
    }
    if (!insideJobs) continue;

    const jobMatch = line.match(/^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/);
    if (jobMatch) {
      currentJob = jobMatch[1];
      continue;
    }

    const runMatch = line.match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
    if (!runMatch || currentJob === null) continue;

    const propertyIndent = runMatch[1].length;
    let command = runMatch[2];
    if (isBlockScalar(command)) {
      const block = [];
      let cursor = index + 1;
      while (cursor < lines.length) {
        const candidate = lines[cursor];
        if (candidate.trim().length === 0) {
          block.push(candidate);
          cursor += 1;
          continue;
        }
        if (indentOf(candidate) <= propertyIndent) break;
        block.push(candidate);
        cursor += 1;
      }
      const contentIndent = Math.min(...block.filter((entry) => entry.trim().length > 0).map(indentOf));
      command = block.map((entry) => (entry.trim().length === 0 ? "" : entry.slice(contentIndent))).join("\n");
      index = cursor - 1;
    }

    const normalized = normalizeCommand(command);
    if (normalized.length === 0) fail(`empty run block in ${currentJob} at line ${index + 1}`);
    steps.push({ job: currentJob, line: index + 1, command: normalized });
  }

  if (steps.length === 0) fail("no CI run steps were found");
  return steps;
}

function invokedNpmScripts(command) {
  const invocations = [];
  for (const match of command.matchAll(/\bnpm\s+run\s+([A-Za-z0-9:_-]+)([^\n;&|]*)/g)) {
    invocations.push({
      name: match[1],
      // `npm run build --workspaces` dispatches each workspace's build script;
      // it must not recursively resolve this root package's `build` script.
      workspace: /--workspaces?\b/.test(match[2]),
      invocation: normalizeCommand(match[0]),
    });
  }
  for (const match of command.matchAll(/\bnpm\s+test\b/g)) {
    invocations.push({ name: "test", workspace: false, invocation: normalizeCommand(match[0]) });
  }
  return invocations;
}

function addEntry(entries, type, command, extra = {}) {
  const normalized = normalizeCommand(command);
  const id = `${type}:${digest(normalized)}`;
  const existing = entries.get(id);
  if (existing !== undefined) return existing;
  const entry = { id, type, command: normalized, ...extra };
  entries.set(id, entry);
  return entry;
}

function workspacePaths(packageDocument) {
  const workspaces = packageDocument.workspaces;
  if (workspaces === undefined) return [];
  if (!Array.isArray(workspaces) || !workspaces.every((entry) => typeof entry === "string" && entry.length > 0)) {
    fail("package.json workspaces must be an array of concrete package paths");
  }
  return workspaces;
}

export function readWorkspacePackageTexts(packageText, readWorkspacePackage) {
  let packageDocument;
  try {
    packageDocument = JSON.parse(packageText);
  } catch (error) {
    fail(`package.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return Object.fromEntries(workspacePaths(packageDocument).map((workspace) => [workspace, readWorkspacePackage(`${workspace}/package.json`)]));
}

function workspaceScriptMaps(workspacePackageTexts) {
  const result = new Map();
  for (const [workspace, text] of Object.entries(workspacePackageTexts)) {
    let document;
    try {
      document = JSON.parse(text);
    } catch (error) {
      fail(`${workspace}/package.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (document.scripts === null || typeof document.scripts !== "object" || Array.isArray(document.scripts)) {
      fail(`${workspace}/package.json scripts must be an object`);
    }
    result.set(workspace, document.scripts);
  }
  return result;
}

function expandWorkspaceScript(name, workspaceScripts, entries) {
  let found = 0;
  for (const [workspace, scripts] of workspaceScripts) {
    const definition = scripts[name];
    if (typeof definition !== "string" || definition.trim().length === 0) continue;
    found += 1;
    addEntry(entries, "npm-workspace-script", definition, { npmScript: name, workspace });
  }
  if (found === 0) fail(`workspace invocation '${name}' has no matching workspace script`);
}

function expandNpmScript(name, scripts, workspaceScripts, entries, ancestry = []) {
  if (ancestry.includes(name)) fail(`npm script cycle ${[...ancestry, name].join(" -> ")}`);
  const definition = scripts[name];
  if (typeof definition !== "string" || definition.trim().length === 0) {
    fail(`workflow invokes npm script '${name}', but package.json does not define it`);
  }
  addEntry(entries, "npm-script", definition, { npmScript: name });
  for (const nested of invokedNpmScripts(definition)) {
    if (nested.workspace) {
      addEntry(entries, "npm-workspace-invocation", nested.invocation, { npmScript: nested.name });
      expandWorkspaceScript(nested.name, workspaceScripts, entries);
      continue;
    }
    expandNpmScript(nested.name, scripts, workspaceScripts, entries, [...ancestry, name]);
  }
}

function sourceText(path, ref) {
  if (ref === undefined) return readFileSync(path, "utf8");
  try {
    return execFileSync("git", ["show", `${ref}:${path}`], { encoding: "utf8" });
  } catch (error) {
    fail(`cannot read ${path} from ${ref}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function generateInventory({ workflowText, packageText, workspacePackageTexts = {}, source = {} }) {
  let packageDocument;
  try {
    packageDocument = JSON.parse(packageText);
  } catch (error) {
    fail(`package.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const scripts = packageDocument.scripts;
  if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) fail("package.json scripts must be an object");
  const expectedWorkspacePaths = workspacePaths(packageDocument);
  for (const workspace of expectedWorkspacePaths) {
    if (workspacePackageTexts[workspace] === undefined) fail(`workspace package ${workspace}/package.json was not supplied`);
  }
  const workspaceScripts = workspaceScriptMaps(workspacePackageTexts);

  const entries = new Map();
  const runSteps = extractRunSteps(workflowText);
  for (const step of runSteps) {
    const entry = addEntry(entries, "workflow-run", step.command);
    const sources = entry.sources ?? [];
    sources.push({ job: step.job, line: step.line });
    entry.sources = sources;
    for (const invocation of invokedNpmScripts(step.command)) {
      if (invocation.workspace) {
        addEntry(entries, "npm-workspace-invocation", invocation.invocation, { npmScript: invocation.name });
        expandWorkspaceScript(invocation.name, workspaceScripts, entries);
        continue;
      }
      expandNpmScript(invocation.name, scripts, workspaceScripts, entries);
    }
  }

  const leafCommands = [...entries.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((entry) => ({ ...entry, sources: entry.sources?.sort((left, right) => left.job.localeCompare(right.job) || left.line - right.line) }));

  return {
    schema: SCHEMA,
    generator: "scripts/g40-ci-step-inventory.mjs",
    source,
    runStepCount: runSteps.length,
    leafCommandCount: leafCommands.length,
    leafCommands,
  };
}

function parseArguments(argv) {
  const options = { workflow: DEFAULT_WORKFLOW, packagePath: DEFAULT_PACKAGE, ref: undefined, write: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--workflow") options.workflow = argv[++index];
    else if (argument === "--package") options.packagePath = argv[++index];
    else if (argument === "--ref") options.ref = argv[++index];
    else if (argument === "--write") options.write = argv[++index];
    else fail(`unknown argument ${argument}`);
  }
  if ([options.workflow, options.packagePath, options.ref, options.write].some((value) => value === "")) fail("empty option value");
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const inventory = generateInventory({
    workflowText: sourceText(options.workflow, options.ref),
    packageText: sourceText(options.packagePath, options.ref),
    workspacePackageTexts: readWorkspacePackageTexts(sourceText(options.packagePath, options.ref), (path) => sourceText(path, options.ref)),
    source: {
      workflow: options.workflow,
      packageJson: options.packagePath,
      ...(options.ref === undefined ? { ref: "working-tree" } : { ref: options.ref }),
    },
  });
  const serialized = `${JSON.stringify(inventory, null, 2)}\n`;
  if (options.write !== undefined) writeFileSync(options.write, serialized);
  process.stdout.write(serialized);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
