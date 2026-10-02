#!/usr/bin/env node
/**
 * Build the current SDT-G40 graph from the repository's workflow, lane and
 * npm-script sources. The graph is deliberately current-tree data: it has
 * no historical command list or capability allowlist.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import yaml from "js-yaml";
import {
  configuredWorkspaces,
  hasMatchingPath,
  isLocalPathToken,
  npmInvocations,
  normalizePathToken,
  repoRelativePattern,
  shellTokens,
  workspaceForSelector,
} from "./repository-reference-check.mjs";

const SCHEMA = "sdt-g40-ci-step-inventory/v2";
const WORKFLOW_RE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const SHELL_OPERATORS = new Set(["&&", "||", ";", "|"]);

function fail(message) {
  throw new Error(`g40-ci-step-inventory:${message}`);
}

export function normalizeCommand(value) {
  return String(value)
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ");
}

function shellLogicalLines(value) {
  const lines = [];
  const text = String(value).replace(/\r/g, "");
  let buffer = "";
  let quote = null;
  let escaped = false;
  let comment = false;
  let wordHasCharacters = false;
  let logicalLine = 0;
  const flushLine = () => {
    lines.push({ text: buffer, logicalLine });
    buffer = "";
    wordHasCharacters = false;
    logicalLine += 1;
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (comment) {
      if (character === "\n") {
        comment = false;
        flushLine();
      }
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
      flushLine();
      continue;
    }
    if (/\s/.test(character)) {
      buffer += character;
      wordHasCharacters = false;
      continue;
    }
    let operator;
    if ((character === "&" || character === "|") && text[index + 1] === character) {
      operator = `${character}${character}`;
      index += 1;
    } else if (character === ";" || character === "|" || character === "&") {
      operator = character;
    }
    if (operator !== undefined) {
      buffer += operator;
      wordHasCharacters = false;
      continue;
    }
    buffer += character;
    wordHasCharacters = true;
  }
  if (buffer.length > 0 || text.endsWith("\n") === false) flushLine();
  return lines;
}

/** Split shell lists while preserving independent lines and folded continuations. */
export function shellCommandSegments(value) {
  const segments = [];
  for (const line of shellLogicalLines(value)) {
    let buffer = "";
    let quote = null;
    let escaped = false;
    let pendingOperator = false;
    let lastSegment;
    const flush = () => {
      const command = buffer.trim();
      buffer = "";
      if (command.length === 0) return;
      lastSegment = {
        command,
        hasFollowingOperator: false,
        hasPrecedingOperator: pendingOperator,
        logicalLine: line.logicalLine,
      };
      pendingOperator = false;
      segments.push(lastSegment);
    };
    for (let index = 0; index < line.text.length; index += 1) {
      const character = line.text[index];
      if (escaped) {
        buffer += character;
        escaped = false;
        continue;
      }
      if (quote !== null) {
        buffer += character;
        if (character === "\\" && quote === '"') escaped = true;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === "'" || character === '"') {
        quote = character;
        buffer += character;
        continue;
      }
      if (character === "\\") {
        buffer += character;
        escaped = true;
        continue;
      }
      let operator;
      if ((character === "&" || character === "|") && line.text[index + 1] === character) {
        operator = `${character}${character}`;
        index += 1;
      } else if (character === ";" || character === "|" || character === "&") {
        operator = character;
      }
      if (operator !== undefined) {
        flush();
        if (lastSegment !== undefined) lastSegment.hasFollowingOperator = true;
        pendingOperator = true;
        continue;
      }
      buffer += character;
    }
    flush();
  }
  return segments;
}

export function ciGlobRegex(pattern) {
  let result = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      result += ".*";
      index += 1;
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

export function matchesCiGlob(path, pattern) {
  if (typeof path !== "string" || typeof pattern !== "string") return false;
  return ciGlobRegex(pattern).test(path);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function gitFiles(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
}

function packageRecord(relativePath, document) {
  const safeDocument = document !== null && typeof document === "object" && !Array.isArray(document) ? document : {};
  return {
    relativePath,
    directory: dirname(relativePath) === "." ? "" : dirname(relativePath),
    name: typeof safeDocument.name === "string" ? safeDocument.name : undefined,
    document: safeDocument,
    scripts: safeDocument.scripts !== null && typeof safeDocument.scripts === "object" && !Array.isArray(safeDocument.scripts)
      ? safeDocument.scripts
      : {},
  };
}

export function loadSnapshot(root = process.cwd()) {
  const loadErrors = [];
  let files = [];
  try {
    files = gitFiles(root);
  } catch (error) {
    loadErrors.push({
      code: "manifest-shape",
      message: `could not list tracked files: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  function readTracked(path, code = "manifest-shape") {
    if (!files.includes(path)) {
      loadErrors.push({ code, message: `${path} is missing` });
      return undefined;
    }
    try {
      return readFileSync(join(root, path), "utf8");
    } catch (error) {
      loadErrors.push({ code, message: `could not read ${path}: ${error instanceof Error ? error.message : String(error)}` });
      return undefined;
    }
  }
  function readJsonTracked(path, code = "manifest-shape") {
    const text = readTracked(path, code);
    if (text === undefined) return {};
    try {
      return JSON.parse(text);
    } catch (error) {
      loadErrors.push({ code, message: `${path} is invalid JSON: ${error instanceof Error ? error.message : String(error)}` });
      return {};
    }
  }
  const rootPackage = packageRecord("package.json", readJsonTracked("package.json"));
  const packageCandidates = files
    .filter((file) => /\/package\.json$/.test(file))
    .map((path) => packageRecord(path, {}));
  let configuredCandidates = [];
  try {
    configuredCandidates = configuredWorkspaces(rootPackage, packageCandidates);
  } catch (error) {
    loadErrors.push({
      code: "manifest-shape",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const workspacePaths = configuredCandidates.map((entry) => entry.relativePath).sort();
  const packages = [rootPackage, ...workspacePaths.map((path) => packageRecord(
    path,
    readJsonTracked(path),
  ))];
  for (const currentPackage of packages) {
    const scripts = currentPackage.document.scripts;
    if (scripts !== undefined && (scripts === null || typeof scripts !== "object" || Array.isArray(scripts))) {
      loadErrors.push({ code: "manifest-shape", message: `${currentPackage.relativePath} scripts must be an object` });
    }
  }
  const packageByPath = new Map(packages.map((entry) => [entry.relativePath, entry]));
  const configured = workspacePaths.map((path) => packageByPath.get(path)).filter(Boolean);
  const workflows = files
    .filter((file) => WORKFLOW_RE.test(file))
    .sort()
    .map((path) => {
      const text = readTracked(path, "workflow-shape") ?? "";
      let document = {};
      if (text.length > 0) {
        try {
          document = yaml.load(text, { schema: yaml.JSON_SCHEMA }) ?? {};
        } catch (error) {
          loadErrors.push({
            code: "workflow-shape",
            message: `${path} is invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      return { path, text, document };
    });
  const manifest = readJsonTracked("ci/lanes.json");
  const commitTraceBundle = files.includes("contracts/commit-trace-bundle.json")
    ? readJsonTracked("contracts/commit-trace-bundle.json")
    : null;
  return {
    root,
    files,
    loadErrors,
    rootPackage,
    packages,
    packageByPath,
    configuredWorkspaces: configured,
    manifest,
    commitTraceBundle,
    workflows,
  };
}

export function cloneSnapshot(snapshot) {
  return structuredClone(snapshot);
}

function triggerNames(workflow) {
  const document = workflow?.document ?? {};
  const value = document.on ?? document[true];
  if (Array.isArray(value)) return new Set(value);
  if (typeof value === "string") return new Set([value]);
  if (value !== null && typeof value === "object") return new Set(Object.keys(value));
  return new Set();
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function effectiveWorkingDirectory(workflow, job, step) {
  const safeWorkflow = object(workflow);
  const safeJob = object(job);
  const safeStep = object(step);
  const candidates = [
    safeStep["working-directory"],
    object(safeJob.defaults).run?.["working-directory"],
    object(object(safeWorkflow.document).defaults).run?.["working-directory"],
  ];
  const configured = candidates.find((value) => value !== undefined);
  return {
    value: typeof configured === "string" ? configured : "",
    invalid: configured !== undefined && typeof configured !== "string",
  };
}

export function extractWorkflowRuns(workflow) {
  const safeWorkflow = object(workflow);
  const jobs = object(object(safeWorkflow.document).jobs);
  const runs = [];
  for (const [jobName, jobValue] of Object.entries(jobs)) {
    const job = object(jobValue);
    const steps = Array.isArray(job.steps) ? job.steps : [];
    steps.forEach((stepValue, stepIndex) => {
      const step = object(stepValue);
      if (typeof step.run !== "string" || normalizeCommand(step.run).length === 0) return;
      const workingDirectory = effectiveWorkingDirectory(workflow, job, step);
      runs.push({
        workflowPath: safeWorkflow.path,
        workflow: safeWorkflow,
        jobName,
        job,
        step,
        stepIndex,
        command: normalizeCommand(step.run),
        rawCommand: step.run,
        workingDirectory: workingDirectory.value,
        workingDirectoryInvalid: workingDirectory.invalid,
        triggers: triggerNames(workflow),
      });
    });
  }
  return runs;
}

function packageForDirectory(snapshot, directory) {
  const normalized = normalize(directory || ".").replaceAll("\\", "/").replace(/^\.\//, "");
  const directoryPath = normalized === "." ? "" : normalized;
  return array(snapshot?.packages)
    .filter((entry) => entry !== null && typeof entry === "object")
    .filter((entry) => entry.directory === "" || directoryPath === entry.directory || directoryPath.startsWith(`${entry.directory}/`))
    .sort((left, right) => right.directory.length - left.directory.length)[0]
    ?? snapshot.rootPackage;
}

function packageForSelector(snapshot, selector, source) {
  try {
    return workspaceForSelector(selector, array(snapshot?.packages), array(snapshot?.configuredWorkspaces), source);
  } catch {
    return undefined;
  }
}

function addUnique(list, keySet, key, value) {
  if (keySet.has(key)) return;
  keySet.add(key);
  list.push(value);
}

function pathTokenFiles(snapshot, command, baseDir) {
  const files = [];
  const seen = new Set();
  for (const rawToken of shellTokens(command)) {
    const token = normalizePathToken(rawToken);
    if (!isLocalPathToken(token)) continue;
    const normalized = repoRelativePattern(baseDir, token);
    if (normalized.length === 0 || normalized.startsWith("../") || normalized === ".." || normalized.startsWith("/")) continue;
    if (/[?*]/.test(normalized)) continue;
    if ((normalized.startsWith("scripts/") || normalized.startsWith("test/")) && !seen.has(normalized)) {
      seen.add(normalized);
      files.push(normalized);
    }
  }
  return files;
}

function findMissingPaths(snapshot, command, baseDir) {
  const missing = [];
  const seen = new Set();
  for (const rawToken of shellTokens(command)) {
    const token = normalizePathToken(rawToken);
    if (!isLocalPathToken(token)) continue;
    if (hasMatchingPath(snapshot.files, token, baseDir, { allowIgnoredArtifacts: true, allowDynamic: true })) continue;
    const key = `${baseDir}:${token}`;
    if (!seen.has(key)) {
      seen.add(key);
      missing.push({ token, baseDir });
    }
  }
  return missing;
}

function ciLocalInvocation(tokens, start) {
  let cursor = start + 2;
  const args = [];
  while (cursor < tokens.length && !SHELL_OPERATORS.has(tokens[cursor])) {
    args.push(tokens[cursor]);
    cursor += 1;
  }
  const selections = [];
  let invalidArgument = false;
  let all = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--lane" || argument === "--lanes") {
      const value = args[++index];
      if (value === undefined) {
        invalidArgument = true;
        continue;
      }
      selections.push({ kind: "lane", values: String(value).split(",").filter(Boolean) });
      if (argument !== "--lane") invalidArgument = true;
      continue;
    }
    if (argument === "--tier") {
      const value = args[++index];
      if (value === undefined) {
        invalidArgument = true;
        continue;
      }
      selections.push({ kind: "tier", values: [String(value)] });
      continue;
    }
    if (argument === "--full" || argument === "--all") {
      all = true;
      if (argument === "--all") invalidArgument = true;
      continue;
    }
    if (argument === "--ci") continue;
    invalidArgument = true;
    if (argument === "--manifest" || argument === "--affected" || argument === "--skip-bootstrap") index += 1;
  }
  return { args, selections, invalidArgument, all };
}

function resolveSelectedLanes(snapshot, parsed) {
  const lanes = Array.isArray(snapshot.manifest?.lanes) ? snapshot.manifest.lanes : [];
  const laneNames = new Set(lanes.map((lane) => lane?.name));
  const selected = new Set();
  const unknown = [];
  if (parsed.all) for (const lane of lanes) if (lane?.name !== undefined) selected.add(lane.name);
  for (const selection of parsed.selections) {
    if (selection.kind === "lane") {
      for (const name of selection.values) {
        if (!laneNames.has(name)) unknown.push(name);
        else selected.add(name);
      }
    } else if (selection.values[0] === "full") {
      for (const lane of lanes) selected.add(lane.name);
    } else if (["pr", "local"].includes(selection.values[0])) {
      for (const lane of lanes.filter((entry) => entry?.tier === selection.values[0])) if (lane?.name !== undefined) selected.add(lane.name);
    } else {
      unknown.push(selection.values[0]);
    }
  }
  return { selected: [...selected], unknown };
}

function isCiLocalPath(token) {
  return typeof token === "string" && normalizePathToken(token).replace(/^\.\//, "") === "scripts/ci-local.mjs";
}

function isSetLine(command) {
  return shellTokens(command)[0] === "set";
}

function commandContext(snapshot, baseDir, source) {
  return { snapshot, baseDir, source };
}

function makeResolution(snapshot) {
  const resolution = {
    errors: [],
    errorKeys: new Set(),
    scripts: [],
    scriptKeys: new Set(),
    terminals: [],
    terminalKeys: new Set(),
    dispatches: [],
    missingPaths: [],
    missingPathKeys: new Set(),
    closureByLane: new Map(),
  };

  function error(code, message, source = undefined) {
    const key = `${code}:${message}`;
    if (resolution.errorKeys.has(key)) return;
    resolution.errorKeys.add(key);
    resolution.errors.push({ code, message, source });
  }

  function recordCommand(command, context, collector) {
    for (const file of pathTokenFiles(snapshot, command, context.baseDir)) collector?.files.add(file);
    for (const missing of findMissingPaths(snapshot, command, context.baseDir)) {
      const key = `${missing.baseDir}:${missing.token}`;
      if (resolution.missingPathKeys.has(key)) continue;
      resolution.missingPathKeys.add(key);
      resolution.missingPaths.push({ ...missing, source: context.source });
    }
  }

  function dispatchesFromCommand(command, context, collector) {
    const tokens = shellTokens(command);
    let index = 0;
    while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1;
    if (tokens[index] !== "node" || typeof tokens[index + 1] !== "string" || !isCiLocalPath(tokens[index + 1])) return;
    const parsed = ciLocalInvocation(tokens, index);
    const lanes = resolveSelectedLanes(snapshot, parsed);
    const directWorkflowDispatch = context.source?.origin === "workflow"
      && context.source?.kind === "workflow-run"
      && context.source?.scriptName === undefined;
    const workflowScriptDispatch = context.source?.origin === "workflow" && !directWorkflowDispatch;
    const dispatch = {
      command: normalizeCommand(command),
      args: parsed.args,
      selectedLanes: workflowScriptDispatch ? [] : lanes.selected,
      unknownNames: lanes.unknown,
      invalidArgument: parsed.invalidArgument || context.source?.shellContinuation === true || workflowScriptDispatch,
      directWorkflowDispatch,
      source: context.source,
      workflowPath: context.source?.workflowPath,
      jobName: context.source?.jobName,
      stepIndex: context.source?.stepIndex,
      origin: context.source?.origin ?? "script",
    };
    resolution.dispatches.push(dispatch);
    collector?.dispatches.push(dispatch);
    for (const name of lanes.unknown) error("unknown-lane-or-tier", `ci-local names unknown lane or tier ${name}`, context.source);
    if ((parsed.invalidArgument || context.source?.shellContinuation === true) && context.source?.origin === "workflow") {
      error("ci-local-argument", `workflow ci-local invocation uses unsupported arguments: ${parsed.args.join(" ")}`, context.source);
    }
  }

  function targetPackages(invocation, currentPackage, source) {
    if (invocation.parseError !== undefined) {
      const code = invocation.parseError === "missing-workspace-selector" ? "manifest-shape" : "undefined-npm-script";
      error(code, `${source} has ${invocation.parseError} in npm invocation`, { label: source });
      return [];
    }
    if (invocation.allWorkspaces) return array(snapshot?.configuredWorkspaces);
    if (invocation.selectors.length > 0) {
      return invocation.selectors.map((selector) => {
        const target = packageForSelector(snapshot, selector, source);
        if (target === undefined) {
          error("undefined-npm-script", `${source} selects unknown workspace ${selector}`, source);
          return null;
        }
        return target;
      }).filter(Boolean);
    }
    return [currentPackage];
  }

  function resolveScript(currentPackage, scriptName, ancestry, collector, source) {
    if (currentPackage === null || typeof currentPackage !== "object") {
      error("manifest-shape", `${source?.label ?? "command"} has no package context`, source);
      return;
    }
    const key = `${currentPackage.relativePath}:${scriptName}`;
    const definition = currentPackage.scripts?.[scriptName];
    if (typeof definition !== "string" || definition.trim().length === 0) {
      if (source?.ifPresent) return;
      error("undefined-npm-script", `${source?.label ?? "command"} invokes npm script ${scriptName} in ${currentPackage.relativePath}`, source);
      return;
    }
    if (ancestry.includes(key)) {
      error("npm-script-cycle", `npm script cycle ${[...ancestry, key].join(" -> ")}`, source);
      return;
    }
    addUnique(resolution.scripts, resolution.scriptKeys, key, {
      packagePath: currentPackage.relativePath,
      packageName: currentPackage.name,
      name: scriptName,
      command: normalizeCommand(definition),
    });
    const forwarded = source?.forwardedArgs?.length ? ` ${source.forwardedArgs.join(" ")}` : "";
    const nextSource = { ...source, origin: source?.origin ?? "script", packagePath: currentPackage.relativePath, scriptName, forwardedArgs: undefined };
    resolveCommand(`${definition}${forwarded}`, commandContext(snapshot, currentPackage.directory, nextSource), [...ancestry, key], collector);
  }

  function resolveCommand(command, context, ancestry, collector) {
    for (const segment of shellCommandSegments(command)) {
      const normalized = normalizeCommand(segment.command);
      if (normalized.length === 0) continue;
      const segmentSource = {
        ...context.source,
        shellContinuation: segment.hasFollowingOperator === true || segment.hasPrecedingOperator === true || context.source?.shellContinuation === true,
      };
      const segmentContext = { ...context, source: segmentSource };
      recordCommand(normalized, segmentContext, collector);
      dispatchesFromCommand(normalized, segmentContext, collector);
      const invocations = npmInvocations(normalized);
      if (invocations.length === 0) {
        const key = `${segmentContext.source?.kind ?? "command"}:${segmentContext.source?.label ?? "unknown"}:${normalized}`;
        addUnique(resolution.terminals, resolution.terminalKeys, key, {
          command: normalized,
          baseDir: segmentContext.baseDir,
          source: segmentContext.source,
        });
        collector?.terminals.push(normalized);
        continue;
      }
      for (const invocation of invocations) {
        const targets = targetPackages(invocation, packageForDirectory(snapshot, segmentContext.baseDir), segmentContext.source?.label ?? "command");
        for (const target of targets) {
          resolveScript(target, invocation.script, ancestry, collector, {
            ...segmentContext.source,
            label: `${segmentContext.source?.label ?? "command"} -> npm ${invocation.script}`,
            ifPresent: invocation.ifPresent,
            forwardedArgs: invocation.forwardedArgs,
          });
        }
      }
    }
  }

  function walkAllScripts() {
    for (const currentPackage of array(snapshot?.packages)) {
      for (const scriptName of Object.keys(object(currentPackage?.scripts))) {
        resolveScript(currentPackage, scriptName, [], { files: new Set(), dispatches: [], terminals: [] }, {
          kind: "script-body",
          label: `npm script ${scriptName} in ${currentPackage.relativePath}`,
          origin: "script",
        });
      }
    }
  }

  function resolveWorkflowRuns() {
    for (const workflow of array(snapshot?.workflows)) {
      for (const run of extractWorkflowRuns(workflow)) {
        const collector = { files: new Set(), dispatches: [], terminals: [] };
        const source = {
          kind: "workflow-run",
          origin: "workflow",
          label: `${run.workflowPath}:${run.jobName}:${run.stepIndex + 1}`,
          workflowPath: run.workflowPath,
          jobName: run.jobName,
          stepIndex: run.stepIndex,
          triggers: [...run.triggers],
        };
        if (run.workingDirectoryInvalid) {
          error("workflow-shape", `${run.workflowPath}:${run.jobName}:${run.stepIndex + 1} working-directory must be a string`, source);
        }
        const segmentResults = [];
        for (const segment of shellCommandSegments(run.rawCommand ?? run.command)) {
          const dispatchCount = collector.dispatches.length;
          resolveCommand(segment.command, commandContext(snapshot, repoRelativePattern("", run.workingDirectory), {
            ...source,
            shellContinuation: segment.hasFollowingOperator === true || segment.hasPrecedingOperator === true,
          }), [], collector);
          segmentResults.push({ segment, dispatches: collector.dispatches.slice(dispatchCount) });
        }
        if (collector.dispatches.length > 0) {
          const onlyDispatchAndSetLines = collector.dispatches.length === 1
            && collector.dispatches.every((dispatch) => dispatch.directWorkflowDispatch)
            && segmentResults.every(({ segment, dispatches }) => dispatches.length > 0 || isSetLine(segment.command));
          if (!onlyDispatchAndSetLines) {
            for (const dispatch of collector.dispatches) dispatch.invalidArgument = true;
          }
        }
        run.collector = collector;
      }
    }
  }

  function resolveManifestCommands() {
    const lanes = array(snapshot?.manifest?.lanes);
    for (const lane of lanes) {
      const laneCollector = { files: new Set(), dispatches: [], terminals: [] };
      resolution.closureByLane.set(lane?.name, laneCollector);
      for (const command of array(lane?.commands)) {
        const source = {
          kind: "manifest-command",
          origin: "manifest",
          label: `lane ${lane?.name}/${command?.id}`,
          laneName: lane?.name,
          commandId: command?.id,
        };
        resolveCommand(command?.command ?? "", commandContext(snapshot, "", source), [], laneCollector);
      }
    }
  }

  for (const loadError of array(snapshot?.loadErrors)) {
    const safeLoadError = object(loadError);
    error(safeLoadError.code ?? "manifest-shape", safeLoadError.message ?? "invalid graph load error");
  }
  walkAllScripts();
  resolveWorkflowRuns();
  resolveManifestCommands();
  return resolution;
}

function manifestSummary(manifest) {
  const lanes = array(manifest?.lanes);
  return lanes.map((lane) => ({
    name: lane?.name,
    tier: lane?.tier,
    commandCount: Array.isArray(lane?.commands) ? lane.commands.length : 0,
    affectedPaths: Array.isArray(lane?.affectedPaths) ? lane.affectedPaths : [],
  }));
}

export function buildCurrentGraph(snapshotOrRoot = process.cwd()) {
  const snapshot = typeof snapshotOrRoot === "string" ? loadSnapshot(snapshotOrRoot) : snapshotOrRoot;
  const resolution = makeResolution(snapshot);
  const workflows = array(snapshot?.workflows);
  const packages = array(snapshot?.packages);
  const workflowRuns = workflows.flatMap((workflow) => extractWorkflowRuns(workflow));
  const graph = {
    schema: SCHEMA,
    snapshot,
    workflows: workflows.map((workflow) => {
      const safeWorkflow = object(workflow);
      return {
        path: safeWorkflow.path,
        triggers: [...triggerNames(safeWorkflow)].sort(),
        jobs: Object.keys(object(safeWorkflow.document?.jobs)),
      };
    }),
    workflowRuns,
    packages: packages.map((entry) => ({ path: entry.relativePath, name: entry.name, scripts: Object.keys(object(entry?.scripts)).sort() })),
    manifest: {
      schema: snapshot.manifest?.schema,
      tiers: snapshot.manifest?.tiers,
      lanes: manifestSummary(snapshot.manifest),
    },
    resolution,
    terminalCommands: resolution.terminals,
    dispatches: resolution.dispatches,
  };
  return graph;
}

export function inventoryFromGraph(graph) {
  const snapshot = graph.snapshot;
  const manifestCommands = [];
  const lanes = array(snapshot?.manifest?.lanes);
  for (const lane of lanes) {
    for (const command of array(lane?.commands)) {
      manifestCommands.push({
        id: `manifest-command:${digest(`${lane?.name}:${command?.id}`)}`,
        type: "manifest-command",
        command: normalizeCommand(command?.command ?? ""),
        commandId: command?.id,
        lane: lane?.name,
        tier: lane?.tier,
        ...(command?.env === undefined ? {} : { env: command.env }),
      });
    }
  }
  const scripts = graph.resolution.scripts.map((entry) => ({
    id: `npm-script:${digest(`${entry.packagePath}:${entry.name}`)}`,
    type: "npm-script",
    command: entry.command,
    npmScript: entry.name,
    packagePath: entry.packagePath,
  }));
  const terminals = graph.terminalCommands.map((entry) => ({
    id: `terminal:${digest(`${entry.source?.label ?? ""}:${entry.command}`)}`,
    type: "terminal-command",
    command: entry.command,
    source: entry.source,
  }));
  const workflowRuns = graph.workflowRuns.map((run) => ({
    id: `workflow-run:${digest(`${run.workflowPath}:${run.jobName}:${run.stepIndex}:${run.command}`)}`,
    type: "workflow-run",
    command: run.command,
    workflow: run.workflowPath,
    job: run.jobName,
    step: run.stepIndex + 1,
  }));
  const entries = [...workflowRuns, ...manifestCommands, ...scripts, ...terminals]
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    schema: SCHEMA,
    generator: "scripts/g40-ci-step-inventory.mjs",
    source: { kind: "working-tree" },
    workflowCount: graph.workflows.length,
    workflowRunCount: workflowRuns.length,
    packageCount: graph.packages.length,
    scriptCount: scripts.length,
    manifestCommandCount: manifestCommands.length,
    terminalCommandCount: terminals.length,
    leafCommandCount: entries.length,
    workflows: graph.workflows,
    tiers: snapshot.manifest?.tiers ?? {},
    lanes: manifestSummary(snapshot.manifest),
    leafCommands: entries,
  };
}

export function generateInventory({ root = process.cwd() } = {}) {
  return inventoryFromGraph(buildCurrentGraph(root));
}

function parseArguments(argv) {
  const options = { root: process.cwd(), write: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") options.root = argv[++index];
    else if (argument === "--write") options.write = argv[++index];
    else fail(`unknown argument ${argument}`);
  }
  if ([options.root, options.write].some((value) => value === "")) fail("empty option value");
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const inventory = generateInventory(options);
  const serialized = `${JSON.stringify(inventory, null, 2)}\n`;
  if (options.write !== undefined) writeFileSync(options.write, serialized);
  process.stdout.write(serialized);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
