#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const schema = "sdt-g105-reference-check/v1";

function fail(kind, message) {
  const error = new Error(`reference-check:${kind}:${message}`);
  error.kind = kind;
  throw error;
}

function trackedFiles(repoRoot) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

function parseJson(repoRoot, relativePath, label) {
  const absolutePath = join(repoRoot, relativePath);
  if (!existsSync(absolutePath)) fail("missing-file", `${label} ${relativePath} does not exist`);
  try {
    return JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch (error) {
    fail("manifest-parse", `${label} ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function globRegex(pattern) {
  let result = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        result += "(?:.*/)?";
        index += 2;
      } else {
        result += ".*";
        index += 1;
      }
    } else if (character === "*") {
      result += "[^/]*";
    } else if (character === "?") {
      result += "[^/]";
    } else {
      result += /[\\^$+?.()|[\]{}]/.test(character) ? `\\${character}` : character;
    }
  }
  return new RegExp(`^${result}$`);
}

export function normalizePathToken(token) {
  return token
    .replace(/^['"]|['"]$/g, "")
    .replace(/[),;]+$/g, "")
    .replace(/^\.\//, "");
}

export function repoRelativePattern(baseDir, token) {
  const normalized = normalize(join(baseDir || ".", token)).replaceAll("\\", "/");
  return normalized === "." ? "" : normalized;
}

export function hasMatchingPath(files, pattern, baseDir = "", { allowIgnoredArtifacts = false, allowDynamic = false } = {}) {
  const normalizedToken = normalizePathToken(pattern);
  if (normalizedToken.length === 0) return false;
  if (normalizedToken.includes("${") || normalizedToken.startsWith("$")) return allowDynamic;
  const normalized = repoRelativePattern(baseDir, normalizedToken);
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) return false;
  if (allowIgnoredArtifacts && (normalized === ".artifacts" || normalized.startsWith(".artifacts/"))) return true;
  if (!/[?*]/.test(normalized)) {
    return files.some((file) => file === normalized || file.startsWith(`${normalized}/`));
  }
  const matcher = globRegex(normalized);
  return files.some((file) => matcher.test(file));
}

export function shellTokens(command) {
  const tokens = [];
  let buffer = "";
  let quote = null;
  let escaped = false;
  let tokenStarted = false;
  const flush = () => {
    if (!tokenStarted) return;
    tokens.push(buffer);
    buffer = "";
    tokenStarted = false;
  };
  const text = String(command);
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      buffer += character;
      escaped = false;
      tokenStarted = true;
      continue;
    }
    if (quote !== null) {
      if (quote === '"' && character === "\\") {
        buffer += character;
        escaped = true;
        tokenStarted = true;
      } else if (character === quote) {
        quote = null;
        tokenStarted = true;
      } else {
        buffer += character;
        tokenStarted = true;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(character)) {
      flush();
      continue;
    }
    buffer += character;
    tokenStarted = true;
  }
  flush();
  return tokens;
}

function isShellOperator(token) {
  return token === "&&" || token === "||" || token === ";" || token === "|" || token === "&";
}

function shellCommandFragments(command) {
  const fragments = [];
  let buffer = "";
  let quote = null;
  let escaped = false;
  let comment = false;
  let wordHasCharacters = false;
  const flush = () => {
    const fragment = buffer.trim();
    buffer = "";
    wordHasCharacters = false;
    if (fragment.length > 0) fragments.push(fragment);
  };
  for (let index = 0; index < String(command).length; index += 1) {
    const character = String(command)[index];
    if (comment) {
      if (character === "\n") comment = false;
      else continue;
      flush();
      continue;
    }
    if (escaped) {
      if (character === "\n" && quote === null) {
        buffer = buffer.slice(0, -1);
        buffer += " ";
      } else {
        buffer += character;
      }
      escaped = false;
      wordHasCharacters = true;
      continue;
    }
    if (quote !== null) {
      buffer += character;
      if (character === "\\" && quote === '"') escaped = true;
      else if (character === quote) quote = null;
      if (character === "\n") flush();
      else wordHasCharacters = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      buffer += character;
      wordHasCharacters = true;
      continue;
    }
    if (character === "\\") {
      buffer += character;
      escaped = true;
      wordHasCharacters = true;
      continue;
    }
    if (character === "#" && !wordHasCharacters) {
      comment = true;
      continue;
    }
    if (character === "\n") {
      flush();
      continue;
    }
    if (/\s/.test(character)) {
      buffer += character;
      wordHasCharacters = false;
      continue;
    }
    let operator;
    if ((character === "&" || character === "|") && String(command)[index + 1] === character) {
      operator = `${character}${character}`;
      index += 1;
    } else if (character === ";" || character === "|" || character === "&") {
      operator = character;
    }
    if (operator !== undefined) {
      flush();
      continue;
    }
    buffer += character;
    wordHasCharacters = true;
  }
  flush();
  return fragments;
}

function isLeadingAssignment(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

export function npmInvocations(command) {
  const invocations = [];
  for (const fragment of shellCommandFragments(command)) {
    const tokens = shellTokens(fragment);
    let commandIndex = 0;
    while (commandIndex < tokens.length && isLeadingAssignment(tokens[commandIndex])) commandIndex += 1;
    if (tokens[commandIndex] !== "npm") continue;
    const selectors = [];
    let allWorkspaces = false;
    let ifPresent = false;
    let parseError;
    let subcommand;
    let script;
    let forwardedArgs = [];
    const addOption = (tokensAt, cursor) => {
      const token = tokensAt[cursor];
      if (token === "--workspaces" || token === "-ws") {
        allWorkspaces = true;
        return cursor + 1;
      }
      if (token === "--if-present") {
        ifPresent = true;
        return cursor + 1;
      }
      if (token === "--workspace" || token === "-w") {
        const selector = tokensAt[cursor + 1];
        if (selector === undefined || isShellOperator(selector) || selector.startsWith("-")) {
          parseError = "missing-workspace-selector";
          return tokensAt.length;
        }
        selectors.push(selector);
        return cursor + 2;
      }
      if (token.startsWith("--workspace=")) {
        const selector = token.slice("--workspace=".length);
        if (selector.length === 0) parseError = "missing-workspace-selector";
        else selectors.push(selector);
        return cursor + 1;
      }
      if (token.startsWith("-w=")) {
        const selector = token.slice(3);
        if (selector.length === 0) parseError = "missing-workspace-selector";
        else selectors.push(selector);
        return cursor + 1;
      }
      return undefined;
    };
    for (let cursor = commandIndex + 1; cursor < tokens.length;) {
      const token = tokens[cursor];
      if (token === "--" && subcommand !== undefined) {
        forwardedArgs = tokens.slice(cursor + 1);
        break;
      }
      const nextCursor = token.startsWith("-") ? addOption(tokens, cursor) : undefined;
      if (nextCursor !== undefined) {
        cursor = nextCursor;
        continue;
      }
      if (subcommand === undefined) {
        if (token.startsWith("-")) {
          cursor += 1;
          continue;
        }
        subcommand = token;
        if (["test", "start", "stop", "restart"].includes(subcommand)) script = subcommand;
        else if (subcommand !== "run" && subcommand !== "run-script") break;
        cursor += 1;
        continue;
      }
      if (script === undefined && (subcommand === "run" || subcommand === "run-script")) {
        if (token.startsWith("-")) {
          cursor += 1;
          continue;
        }
        script = token;
      }
      cursor += 1;
    }
    if (script !== undefined || parseError !== undefined) invocations.push({ script, selectors, allWorkspaces, ifPresent, forwardedArgs, parseError });
  }
  return invocations;
}

function localPathTokens(command) {
  const tokens = shellTokens(command);
  return [...new Set(tokens
    .map(normalizePathToken)
    .filter((token) => isLocalPathToken(token)))];
}

export function isLocalPathToken(token) {
  if (token.length === 0 || token.startsWith("-") || token.startsWith("$") || token.includes("${")) return false;
  if (/^(?:https?:|git@|ssh:)/i.test(token) || token.startsWith("@")) return false;
  if (token.startsWith("node_modules/")) return false;
  if (/^(?:\.\.\/|\.\/)/.test(token)) return true;
  return /^(?:scripts|test|packages|samples|contracts|tools|templates|ci|docs|\.github|src|public|migrations)\//.test(token) ||
    /^(?:wrangler[^/]*\.jsonc|vitest[^/]*\.ts|tsconfig[^/]*\.json|package(?:-lock)?\.json|README\.md|CHANGELOG\.md|LICENSE|NOTICE|\.gitignore)$/.test(token);
}

function assertLocalPaths(files, command, source, baseDir = "") {
  for (const token of localPathTokens(command)) {
    if (!hasMatchingPath(files, token, baseDir, { allowIgnoredArtifacts: true, allowDynamic: true })) {
      fail("missing-file", `${source} names missing path ${token}`);
    }
  }
}

function manifestInfo(repoRoot, relativePath) {
  const document = parseJson(repoRoot, relativePath, "package manifest");
  const scripts = document.scripts ?? {};
  if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) {
    fail("manifest-shape", `${relativePath} scripts is not an object`);
  }
  return {
    relativePath,
    directory: dirname(relativePath) === "." ? "" : dirname(relativePath),
    name: typeof document.name === "string" ? document.name : undefined,
    document,
    scripts,
  };
}

function packageManifests(repoRoot, tracked) {
  const paths = tracked.filter((file) => file === "package.json" || /\/package\.json$/.test(file));
  const manifests = paths.map((relativePath) => manifestInfo(repoRoot, relativePath));
  const rootManifest = manifests.find((manifest) => manifest.relativePath === "package.json");
  if (rootManifest === undefined) fail("missing-file", "root package manifest package.json does not exist");
  return { manifests, rootManifest };
}

function workspacePatterns(rootManifest) {
  const workspaces = rootManifest.document.workspaces;
  if (workspaces === undefined) return [];
  if (Array.isArray(workspaces)) return workspaces;
  if (workspaces !== null && typeof workspaces === "object" && Array.isArray(workspaces.packages)) return workspaces.packages;
  fail("manifest-shape", "root package manifest workspaces is not an array or packages object");
}

export function configuredWorkspaces(rootManifest, manifests) {
  const configured = [];
  for (const pattern of workspacePatterns(rootManifest)) {
    if (typeof pattern !== "string") fail("manifest-shape", "root package manifest workspace selector is not a string");
    const normalized = repoRelativePattern("", pattern);
    const matcher = /[?*]/.test(normalized) ? globRegex(normalized) : undefined;
    const matches = manifests.filter((manifest) => {
      if (manifest.relativePath === "package.json") return false;
      return matcher === undefined
        ? manifest.directory === normalized || manifest.relativePath === `${normalized}/package.json`
        : matcher.test(manifest.directory);
    });
    if (matches.length === 0) fail("missing-file", `root workspace selector ${pattern} matches no package manifest`);
    configured.push(...matches);
  }
  return [...new Map(configured.map((manifest) => [manifest.relativePath, manifest])).values()];
}

export function workspaceForSelector(selector, manifests, configured, source) {
  const normalized = repoRelativePattern("", selector);
  const pathMatches = manifests.filter((manifest) => manifest.relativePath !== "package.json" && (
    manifest.directory === normalized || manifest.relativePath === `${normalized}/package.json`
  ));
  const nameMatches = manifests.filter((manifest) => manifest.name === selector);
  const matches = [...new Map([...pathMatches, ...nameMatches].map((manifest) => [manifest.relativePath, manifest])).values()];
  if (matches.length !== 1) fail("missing-workspace", `${source} selects unknown or ambiguous workspace ${selector}`);
  if (!configured.some((manifest) => manifest.relativePath === matches[0].relativePath)) {
    fail("missing-workspace", `${source} selects a package outside root workspaces ${selector}`);
  }
  return matches[0];
}

function assertNpmScriptReferences(command, source, currentManifest, manifests, configured) {
  for (const invocation of npmInvocations(command)) {
    if (invocation.parseError !== undefined) {
      fail(invocation.parseError === "missing-workspace-selector" ? "manifest-shape" : "missing-script", `${source} has ${invocation.parseError} in npm invocation`);
    }
    const targets = invocation.allWorkspaces
      ? configured
      : invocation.selectors.length > 0
        ? invocation.selectors.map((selector) => workspaceForSelector(selector, manifests, configured, source))
        : [currentManifest];
    for (const target of targets) {
      if (Object.hasOwn(target.scripts, invocation.script)) continue;
      if (invocation.ifPresent) continue;
      fail("missing-script", `${source} invokes npm script ${invocation.script} in ${target.relativePath}, which is not defined`);
    }
  }
}

function extractWorkflowCommands(text) {
  const commands = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)run:\s*(.*)$/);
    if (!match) continue;
    const indent = match[1].length;
    if (match[2] !== "|" && match[2] !== ">") {
      commands.push({ line: index + 1, command: match[2].replace(/^['"]|['"]$/g, "") });
      continue;
    }
    const body = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      const lineIndent = line.match(/^\s*/)[0].length;
      if (line.trim().length > 0 && lineIndent <= indent) {
        index -= 1;
        break;
      }
      body.push(line.slice(Math.min(line.length, indent + 2)));
    }
    commands.push({ line: index + 1, command: body.join("\n") });
  }
  return commands;
}

function extractPathFilters(text) {
  const filters = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const section = lines[index].match(/^(\s+)(paths(?:-ignore)?)\s*:\s*$/);
    if (!section) continue;
    const sectionIndent = section[1].length;
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      const indentation = line.match(/^\s*/)[0].length;
      if (line.trim().length > 0 && indentation <= sectionIndent) {
        index -= 1;
        break;
      }
      const item = line.match(/^\s+-\s+(.+?)\s*$/);
      if (!item) continue;
      filters.push(item[1].replace(/^['"]|['"]$/g, ""));
    }
  }
  return filters;
}

function assertLaneManifest(repoRoot, files, rootManifest, manifests, configured) {
  const manifest = parseJson(repoRoot, "ci/lanes.json", "lane manifest");
  if (!Array.isArray(manifest.lanes)) fail("manifest-shape", "ci/lanes.json lanes is not an array");
  let commandCount = 0;
  let selectorCount = 0;
  for (const lane of manifest.lanes) {
    if (!Array.isArray(lane.affectedPaths)) fail("manifest-shape", `lane ${lane.name} affectedPaths is not an array`);
    for (const selector of lane.affectedPaths) {
      if (typeof selector !== "string") fail("manifest-shape", `lane ${lane.name} affected path selector is not a string`);
      selectorCount += 1;
      if (!hasMatchingPath(files, selector)) fail("missing-file", `lane ${lane.name} affected path ${selector} matches no tracked file`);
    }
    if (!Array.isArray(lane.commands)) fail("manifest-shape", `${lane.name} commands is not an array`);
    for (const command of lane.commands) {
      commandCount += 1;
      assertNpmScriptReferences(command.command, `lane ${lane.name}/${command.id}`, rootManifest, manifests, configured);
      assertLocalPaths(files, command.command, `lane ${lane.name}/${command.id}`);
    }
  }
  return { lanes: manifest.lanes.length, commands: commandCount, laneSelectors: selectorCount };
}

function assertWorkflows(repoRoot, files, rootManifest, manifests, configured) {
  const workflowFiles = files.filter((file) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file));
  let commandCount = 0;
  let filterCount = 0;
  for (const relativePath of workflowFiles) {
    const text = readFileSync(join(repoRoot, relativePath), "utf8");
    for (const { line, command } of extractWorkflowCommands(text)) {
      commandCount += 1;
      assertNpmScriptReferences(command, `${relativePath}:${line}`, rootManifest, manifests, configured);
      assertLocalPaths(files, command, `${relativePath}:${line}`);
    }
    for (const filter of extractPathFilters(text)) {
      filterCount += 1;
      if (!hasMatchingPath(files, filter)) fail("missing-file", `${relativePath} path filter ${filter} matches no tracked file`);
    }
    const workingDirectories = [...text.matchAll(/^\s+working-directory:\s*([^\s#]+)\s*$/gm)].map((match) => match[1]);
    for (const directory of workingDirectories) {
      if (!hasMatchingPath(files, directory)) fail("missing-file", `${relativePath} working-directory ${directory} does not exist`);
    }
  }
  return { workflows: workflowFiles.length, workflowCommands: commandCount, pathFilters: filterCount };
}

function checkRepository(repoRoot) {
  const tracked = trackedFiles(repoRoot);
  const { manifests, rootManifest } = packageManifests(repoRoot, tracked);
  const configured = configuredWorkspaces(rootManifest, manifests);
  let npmScripts = 0;
  for (const manifest of manifests) {
    for (const [name, command] of Object.entries(manifest.scripts)) {
      npmScripts += 1;
      if (typeof command !== "string") fail("manifest-shape", `npm script ${name} in ${manifest.relativePath} is not a string`);
      assertNpmScriptReferences(command, `npm script ${name} in ${manifest.relativePath}`, manifest, manifests, configured);
      assertLocalPaths(tracked, command, `npm script ${name} in ${manifest.relativePath}`, manifest.directory);
    }
  }
  return {
    schema,
    packageManifests: manifests.length,
    npmScripts,
    ...assertLaneManifest(repoRoot, tracked, rootManifest, manifests, configured),
    ...assertWorkflows(repoRoot, tracked, rootManifest, manifests, configured),
  };
}

function writeSelfTestFixture(repoRoot, { workspaceScript = "node test/existing.mjs", laneSelector = "packages/fixture/test/existing.mjs" } = {}) {
  writeFileSync(join(repoRoot, "package.json"), JSON.stringify({
    name: "fixture-root",
    private: true,
    workspaces: ["packages/fixture"],
    scripts: {
      ok: "node scripts/existing.mjs",
      rootOnly: "node scripts/existing.mjs",
      delegated: "npm run workspace-only --workspace @fixture/workspace",
      delegatedShort: "npm run -w @fixture/workspace workspace-only",
    },
  }, null, 2));
  writeFileSync(join(repoRoot, "packages/fixture/package.json"), JSON.stringify({
    name: "@fixture/workspace",
    private: true,
    scripts: {
      "workspace-only": workspaceScript,
      "calls-local": "npm run workspace-only",
    },
  }, null, 2));
  writeFileSync(join(repoRoot, "ci/lanes.json"), JSON.stringify({
    lanes: [{
      name: "cheap",
      affectedPaths: [laneSelector],
      commands: [{ id: "ok", command: "npm run delegated && npm run delegatedShort" }],
    }],
  }));
  writeFileSync(join(repoRoot, ".github/workflows/ci.yml"), [
    "on:",
    "  push:",
    "    paths:",
    "      - scripts/existing.mjs",
    "jobs:",
    "  check:",
    "    steps:",
    "      - run: node scripts/existing.mjs",
  ].join("\n"));
}

function expectSelfTestFailure(action, kind, label) {
  try {
    action();
  } catch (error) {
    if (error?.kind === kind) return;
    throw new Error(`reference-check-self-test: ${label} expected ${kind}, got ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new Error(`reference-check-self-test: ${label} unexpectedly passed`);
}

function runSelfTest() {
  const repoRoot = mkdtempSync(join(tmpdir(), "sdt-g105-reference-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repoRoot, stdio: "ignore" });
    mkdirSync(join(repoRoot, "scripts"), { recursive: true });
    mkdirSync(join(repoRoot, "packages/fixture/test"), { recursive: true });
    mkdirSync(join(repoRoot, ".github/workflows"), { recursive: true });
    mkdirSync(join(repoRoot, "ci"), { recursive: true });
    writeFileSync(join(repoRoot, "scripts/existing.mjs"), "process.exit(0);\n");
    writeFileSync(join(repoRoot, "packages/fixture/test/existing.mjs"), "process.exit(0);\n");
    writeSelfTestFixture(repoRoot);
    execFileSync("git", ["add", "package.json", "ci/lanes.json", ".github/workflows/ci.yml", "scripts/existing.mjs", "packages/fixture/package.json", "packages/fixture/test/existing.mjs"], { cwd: repoRoot, stdio: "ignore" });
    checkRepository(repoRoot);

    const beforeSelector = npmInvocations("FOO=bar npm --workspace @fixture/workspace run workspace-only");
    const afterSelector = npmInvocations("npm run workspace-only --workspace @fixture/workspace --if-present");
    const quotedWorkspaceForms = [
      'npm --workspace="@fixture/workspace" run workspace-only',
      "npm --workspace='@fixture/workspace' run workspace-only",
      'npm -w "@fixture/workspace" run workspace-only',
      'npm run workspace-only --workspace="@fixture/workspace"',
      "npm run workspace-only --workspace='@fixture/workspace'",
      'npm run workspace-only -w "@fixture/workspace"',
    ];
    const quotedWorkspaceInvocations = quotedWorkspaceForms.map((fixture) => npmInvocations(fixture));
    if (beforeSelector.length !== 1 || beforeSelector[0].selectors[0] !== "@fixture/workspace" || afterSelector.length !== 1 || afterSelector[0].ifPresent !== true ||
      quotedWorkspaceInvocations.some((invocations) => invocations.length !== 1 || invocations[0].selectors[0] !== "@fixture/workspace" || invocations[0].script !== "workspace-only")) {
      throw new Error("reference-check-self-test: workspace options were not accepted before and after the npm subcommand");
    }
    if (npmInvocations("echo npm run g108-missing").length !== 0) {
      throw new Error("reference-check-self-test: npm in an echo argument was treated as executable");
    }

    writeSelfTestFixture(repoRoot);
    const redManifest = JSON.parse(readFileSync(join(repoRoot, "ci/lanes.json"), "utf8"));
    redManifest.lanes[0].commands[0].command = "npm --workspace @fixture/workspace run g108-missing";
    writeFileSync(join(repoRoot, "ci/lanes.json"), JSON.stringify(redManifest));
    expectSelfTestFailure(() => checkRepository(repoRoot), "missing-script", "workspace option before subcommand mutant");

    writeSelfTestFixture(repoRoot);
    const malformedSelectorManifest = JSON.parse(readFileSync(join(repoRoot, "ci/lanes.json"), "utf8"));
    malformedSelectorManifest.lanes[0].commands[0].command = "npm run workspace-only -w";
    writeFileSync(join(repoRoot, "ci/lanes.json"), JSON.stringify(malformedSelectorManifest));
    expectSelfTestFailure(() => checkRepository(repoRoot), "manifest-shape", "workspace option without selector mutant");

    writeSelfTestFixture(repoRoot);
    const greenManifest = JSON.parse(readFileSync(join(repoRoot, "ci/lanes.json"), "utf8"));
    greenManifest.lanes[0].commands[0].command = "echo npm run g108-missing";
    writeFileSync(join(repoRoot, "ci/lanes.json"), JSON.stringify(greenManifest));
    checkRepository(repoRoot);

    writeSelfTestFixture(repoRoot, { workspaceScript: "node test/missing.mjs" });
    expectSelfTestFailure(() => checkRepository(repoRoot), "missing-file", "non-root manifest missing path mutant");

    writeSelfTestFixture(repoRoot, { workspaceScript: "node test/existing.mjs", laneSelector: "packages/fixture/missing.mjs" });
    expectSelfTestFailure(() => checkRepository(repoRoot), "missing-file", "lane selector missing path mutant");

    writeSelfTestFixture(repoRoot);
    writeFileSync(join(repoRoot, "packages/fixture/package.json"), JSON.stringify({
      name: "@fixture/workspace",
      private: true,
      scripts: { "workspace-only": "node test/existing.mjs", "calls-local": "npm run rootOnly" },
    }, null, 2));
    expectSelfTestFailure(() => checkRepository(repoRoot), "missing-script", "workspace namespace mutant");

    return {
      schema: "sdt-g105-reference-self-test/v1",
      passed: [
        "all-package-manifests",
        "workspace-script-namespace",
        "workspace-selector",
        "workspace-short-selector",
        "non-root-manifest-missing-path-mutant",
        "lane-selector-missing-path-mutant",
      ],
    };
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    process.stdout.write(`${JSON.stringify(process.argv.includes("--self-test") ? runSelfTest() : checkRepository(root), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
