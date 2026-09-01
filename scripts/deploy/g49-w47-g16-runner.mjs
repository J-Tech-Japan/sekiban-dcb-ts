#!/usr/bin/env node
/**
 * Detached, single-attempt launcher for the unmodified SDT-G16 harness.
 *
 * The detached runner, rather than an interactive shell, owns the several
 * minute list-query wait. Its status file is both the completion signal and
 * the durable process/exit receipt. It never retries a failed harness.
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = process.cwd();

function fail(message) {
  throw new Error(`g49-w47-g16-runner: ${message}`);
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (value === undefined || value.length === 0) fail(`${option} requires a value`);
  return value;
}

function parseArgs(argv) {
  const options = {
    mode: undefined,
    status: undefined,
    log: undefined,
    report: undefined,
    baseUrl: undefined,
    serviceId: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--mode") options.mode = requiredValue(argv, ++index, argument);
    else if (argument === "--status") options.status = requiredValue(argv, ++index, argument);
    else if (argument === "--log") options.log = requiredValue(argv, ++index, argument);
    else if (argument === "--report") options.report = requiredValue(argv, ++index, argument);
    else if (argument === "--base-url") options.baseUrl = requiredValue(argv, ++index, argument);
    else if (argument === "--service-id") options.serviceId = requiredValue(argv, ++index, argument);
    else fail(`unknown argument ${JSON.stringify(argument)}`);
  }
  if (!new Set(["launch", "run", "status"]).has(options.mode)) fail("--mode must be launch, run, or status");
  if (!options.status) fail("--status is required");
  if (options.mode !== "status") {
    for (const key of ["log", "report", "baseUrl", "serviceId"]) {
      if (!options[key]) fail(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
    }
  }
  return options;
}

function now() {
  return new Date().toISOString();
}

function path(value) {
  return resolve(root, value);
}

function readStatus(statusPath) {
  if (!existsSync(statusPath)) return {};
  try {
    return JSON.parse(readFileSync(statusPath, "utf8"));
  } catch (error) {
    fail(`cannot parse status ${statusPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeStatus(statusPath, value) {
  mkdirSync(dirname(statusPath), { recursive: true });
  writeFileSync(statusPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function command(options) {
  return [
    "npm",
    "run",
    "e2e:g16",
    "--",
    "--base-url",
    options.baseUrl,
    "--report",
    options.report,
  ];
}

function launch(options) {
  const statusPath = path(options.status);
  const logPath = path(options.log);
  mkdirSync(dirname(logPath), { recursive: true });
  writeStatus(statusPath, {
    schema: "sdt-g49-pr98-w47-g16-process/v1",
    state: "launching",
    launchedAt: now(),
    launcherPid: process.pid,
    command: command(options),
    serviceId: options.serviceId,
    report: options.report,
    log: options.log,
    harness: "scripts/deploy/g15-e2e.py",
    detached: true,
  });
  const logFd = openSync(logPath, "a", 0o600);
  const child = spawn(process.execPath, [
    resolve(root, "scripts/deploy/g49-w47-g16-runner.mjs"),
    "--mode", "run",
    "--status", options.status,
    "--log", options.log,
    "--report", options.report,
    "--base-url", options.baseUrl,
    "--service-id", options.serviceId,
  ], {
    cwd: root,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, G15_EXPECTED_SERVICE_ID: options.serviceId },
  });
  closeSync(logFd);
  if (!Number.isInteger(child.pid) || child.pid <= 0) fail("detached runner did not return a process identity");
  writeStatus(statusPath, {
    ...readStatus(statusPath),
    state: "running",
    runnerPid: child.pid,
    runnerLaunchedAt: now(),
  });
  child.unref();
  process.stdout.write(`${JSON.stringify(readStatus(statusPath), null, 2)}\n`);
}

function run(options) {
  const statusPath = path(options.status);
  const started = now();
  const before = readStatus(statusPath);
  const args = command(options);
  writeStatus(statusPath, {
    ...before,
    schema: "sdt-g49-pr98-w47-g16-process/v1",
    state: "running",
    runnerPid: process.pid,
    runnerStartedAt: started,
    command: args,
    serviceId: options.serviceId,
    report: options.report,
    log: options.log,
    harness: "scripts/deploy/g15-e2e.py",
    detached: true,
  });
  const result = spawnSync(args[0], args.slice(1), {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, G15_EXPECTED_SERVICE_ID: options.serviceId },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const reportPath = path(options.report);
  const completed = {
    ...readStatus(statusPath),
    state: "completed",
    finishedAt: now(),
    npmPid: Number.isInteger(result.pid) ? result.pid : null,
    exitCode: result.status,
    signal: result.signal,
    reportExists: existsSync(reportPath),
    reportBytes: existsSync(reportPath) ? statSync(reportPath).size : null,
    ...(result.error === undefined ? {} : { startError: result.error.message }),
  };
  writeStatus(statusPath, completed);
  if (result.error) fail(`npm could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`npm run e2e:g16 exited ${result.status}`);
  if (!completed.reportExists) fail("successful G16 exit did not create its report");
}

function status(options) {
  const value = readStatus(path(options.status));
  if (Object.keys(value).length === 0) fail("status file does not exist");
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "launch") launch(options);
  else if (options.mode === "run") run(options);
  else status(options);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
