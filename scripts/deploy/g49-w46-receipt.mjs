#!/usr/bin/env node
/**
 * Append one raw, timestamped operation to the SDT-G49 W46 deployment receipt.
 *
 * The runner intentionally has no retry path.  Each Wrangler child is started
 * synchronously with API-token fallback variables removed, so a failed remote
 * operation is durably recorded before this process exits non-zero.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const root = process.cwd();
const schema = "sdt-g49-pr98-w46-window-receipt/v1";
const tokenVariables = [
  "CLOUDFLARE_API_TOKEN",
  "CF_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CF_API_KEY",
  "WRANGLER_API_TOKEN",
];
const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

function fail(message) {
  throw new Error(`g49-w46-receipt: ${message}`);
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (value === undefined || value.length === 0 || value === "--") fail(`${option} requires a value`);
  return value;
}

function parseArgs(argv) {
  const separator = argv.indexOf("--");
  const options = {
    receipt: undefined,
    operation: undefined,
    event: undefined,
    file: undefined,
    gitHead: false,
    wrangler: undefined,
    args: separator < 0 ? [] : argv.slice(separator + 1),
  };
  const flags = separator < 0 ? argv : argv.slice(0, separator);
  for (let index = 0; index < flags.length; index += 1) {
    const argument = flags[index];
    if (argument === "--receipt") options.receipt = requiredValue(flags, ++index, argument);
    else if (argument === "--operation") options.operation = requiredValue(flags, ++index, argument);
    else if (argument === "--event") options.event = requiredValue(flags, ++index, argument);
    else if (argument === "--file") options.file = requiredValue(flags, ++index, argument);
    else if (argument === "--git-head") options.gitHead = true;
    else if (argument === "--wrangler") options.wrangler = requiredValue(flags, ++index, argument);
    else fail(`unknown argument ${JSON.stringify(argument)}`);
  }
  if (!options.receipt) fail("--receipt is required");
  if (!options.operation) fail("--operation is required");
  const selected = [options.event !== undefined, options.file !== undefined, options.gitHead, options.args.length > 0];
  if (selected.filter(Boolean).length !== 1) {
    fail("select exactly one of --event, --file, --git-head, or a Wrangler command after --");
  }
  if (options.args.length > 0 && !options.wrangler) fail("a Wrangler command requires --wrangler");
  if (options.wrangler && options.args.length === 0) fail("--wrangler requires a command after --");
  return options;
}

function now() {
  return new Date().toISOString();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseJson(value) {
  const cleaned = value.replace(ansiEscape, "").trim();
  if (cleaned.length === 0) return undefined;
  try {
    return JSON.parse(cleaned);
  } catch {
    return undefined;
  }
}

function receiptPath(path) {
  return resolve(root, path);
}

function loadReceipt(path) {
  if (!existsSync(path)) {
    return { schema, startedAt: now(), operations: [] };
  }
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot parse existing receipt ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (receipt?.schema !== schema || !Array.isArray(receipt.operations)) fail(`existing receipt ${path} has an unexpected shape`);
  return receipt;
}

function writeReceipt(path, receipt) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}

function append(receipt, operation) {
  receipt.operations.push({ sequence: receipt.operations.length + 1, recordedAt: now(), ...operation });
  receipt.updatedAt = now();
}

function scrubbedEnvironment() {
  const environment = { ...process.env, WRANGLER_WRITE_LOGS: "false" };
  for (const key of tokenVariables) delete environment[key];
  return environment;
}

function gitHead() {
  const result = spawnSync("git", ["show", "-s", "--format=%H%n%s%n%cI", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) fail(`git head capture could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`git head capture exited ${result.status}: ${result.stderr.trim()}`);
  const [commit, subject, committedAt] = result.stdout.trim().split("\n");
  if (!commit || !subject || !committedAt) fail("git head capture returned an incomplete commit identity");
  return { commit, subject, committedAt };
}

function record(options) {
  const path = receiptPath(options.receipt);
  const receipt = loadReceipt(path);
  let failedMessage;
  if (options.event !== undefined) {
    append(receipt, { kind: "event", operation: options.operation, event: options.event });
  } else if (options.file !== undefined) {
    const absolute = resolve(root, options.file);
    if (!existsSync(absolute)) fail(`file receipt input does not exist: ${options.file}`);
    const content = readFileSync(absolute, "utf8");
    append(receipt, {
      kind: "file",
      operation: options.operation,
      file: {
        path: relative(root, absolute),
        sha256: sha256(content),
        content,
      },
    });
  } else if (options.gitHead) {
    append(receipt, { kind: "git", operation: options.operation, head: gitHead() });
  } else {
    const result = spawnSync(options.wrangler, options.args, {
      cwd: root,
      encoding: "utf8",
      env: scrubbedEnvironment(),
    });
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    append(receipt, {
      kind: "wrangler",
      operation: options.operation,
      command: {
        executable: options.wrangler,
        arguments: options.args,
        apiTokenFallbackVariablesUnset: tokenVariables,
      },
      result: {
        status: result.status,
        signal: result.signal,
        stdout,
        stderr,
        ...(parseJson(stdout) === undefined ? {} : { json: parseJson(stdout) }),
        ...(result.error === undefined ? {} : { startError: result.error.message }),
      },
    });
    if (result.error) failedMessage = `${options.operation} could not start: ${result.error.message}`;
    else if (result.status !== 0) failedMessage = `${options.operation} exited ${result.status}${stderr.trim() ? `: ${stderr.trim()}` : ""}`;
  }
  writeReceipt(path, receipt);
  if (failedMessage !== undefined) fail(failedMessage);
  process.stdout.write(`${JSON.stringify(receipt.operations.at(-1), null, 2)}\n`);
}

try {
  record(parseArgs(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
