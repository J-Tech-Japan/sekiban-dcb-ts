#!/usr/bin/env node
/**
 * Read-only deployed identity gate for SDT-G50.
 *
 * It proves whether the normal-config service can be reused without a
 * redeploy: current main must retain the deployed config byte-for-byte and
 * have no runtime/domain source drift from the version's annotated commit.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";

const root = process.cwd();
const TOKEN_VARIABLES = Object.freeze([
  "CLOUDFLARE_API_TOKEN",
  "CF_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CF_API_KEY",
  "WRANGLER_API_TOKEN",
]);

function fail(message) {
  throw new Error(`g50-deployed-identity:${message}`);
}

function required(name, value) {
  if (typeof value !== "string" || value.length === 0) fail(`${name} is required`);
  return value;
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function scrubbedEnvironment() {
  const environment = { ...process.env, WRANGLER_WRITE_LOGS: "false" };
  for (const key of TOKEN_VARIABLES) delete environment[key];
  return environment;
}

function command(executable, args, environment = process.env) {
  const result = spawnSync(executable, args, { cwd: root, encoding: "utf8", env: environment });
  return Object.freeze({
    executable,
    arguments: args,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error === undefined ? {} : { startError: result.error.message }),
  });
}

function requiredCommand(label, result) {
  if (result.startError !== undefined) fail(`${label} could not start: ${result.startError}`);
  if (result.status !== 0) fail(`${label} exited ${result.status}: ${result.stderr.trim()}`);
  return result.stdout;
}

function git(args) {
  return requiredCommand(`git ${args.join(" ")}`, command("git", args));
}

function json(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    fail(`${label} did not return JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function evaluateIdentity({
  versions,
  expectedVersion,
  expectedConfigCommit,
  mainCommit,
  observedMainCommit,
  expectedConfig,
  mainConfig,
  runtimeDiffPaths,
}) {
  const version = Array.isArray(versions) ? versions.find((entry) => entry?.id === expectedVersion) : undefined;
  const versionMessage = typeof version?.annotations?.["workers/message"] === "string"
    ? version.annotations["workers/message"]
    : "";
  const versionMatches = version !== undefined && versionMessage.includes(expectedConfigCommit);
  const mainMatches = observedMainCommit === mainCommit;
  const configMatches = sha256(expectedConfig) === sha256(mainConfig);
  const runtimeMatches = runtimeDiffPaths.length === 0;
  return Object.freeze({
    versionMatches,
    mainMatches,
    configMatches,
    runtimeMatches,
    reuseExistingDeployment: versionMatches && mainMatches && configMatches && runtimeMatches,
    deployedVersion: version ?? null,
    versionMessage,
    expectedConfigSha256: sha256(expectedConfig),
    mainConfigSha256: sha256(mainConfig),
    runtimeDiffPaths,
  });
}

function write(path, value) {
  const absolute = resolve(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function main() {
  const wrangler = required("--wrangler", argument("--wrangler", "./node_modules/.bin/wrangler"));
  const service = required("--service", argument("--service", "sekiban-dcb-meeting-room-cloudflare-only"));
  const expectedVersion = required("--expected-version", argument("--expected-version"));
  const expectedConfigCommit = required("--expected-config-commit", argument("--expected-config-commit"));
  const mainCommit = required("--main-commit", argument("--main-commit"));
  const configPath = required("--config", argument("--config", "samples/meeting-room/wrangler.cloudflare-only.jsonc"));
  const output = argument("--output", ".artifacts/sdt-g50-deployed-identity.json");
  const whoami = command(wrangler, ["whoami", "--json"], scrubbedEnvironment());
  const document = {
    schema: "sdt-g50-deployed-identity/v1",
    task: "SDT-G50",
    recordedAt: new Date().toISOString(),
    service,
    apiTokenFallbackVariablesUnset: TOKEN_VARIABLES,
    whoami,
  };
  try {
    requiredCommand("wrangler whoami --json", whoami);
    // Do not make a second Wrangler call if OAuth failed at the required
    // first checkpoint; that would violate the one-window honest-stop rule.
    const versions = command(wrangler, ["versions", "list", "--name", service, "--json"], scrubbedEnvironment());
    document.versions = versions;
    const versionsOutput = requiredCommand("wrangler versions list", versions);
    const observedMainCommit = git(["rev-parse", "origin/main"]).trim();
    const expectedConfig = git(["show", `${expectedConfigCommit}:${configPath}`]);
    const mainConfig = git(["show", `${mainCommit}:${configPath}`]);
    const runtimeDiffPaths = git(["diff", "--name-only", `${expectedConfigCommit}..${mainCommit}`, "--", "packages", "samples/meeting-room/src"])
      .split("\n").filter(Boolean);
    document.identity = evaluateIdentity({
      versions: json(versionsOutput, "wrangler versions list"),
      expectedVersion,
      expectedConfigCommit,
      mainCommit,
      observedMainCommit,
      expectedConfig,
      mainConfig,
      runtimeDiffPaths,
    });
    document.decision = document.identity.reuseExistingDeployment
      ? "reuse-existing-deployment-no-redeploy"
      : "identity-mismatch-deploy-current-main-required";
    write(output, document);
    process.stdout.write(`${JSON.stringify({ output, decision: document.decision, identity: document.identity }, null, 2)}\n`);
    if (!document.identity.reuseExistingDeployment) process.exitCode = 3;
  } catch (error) {
    document.error = error instanceof Error ? error.message : String(error);
    document.decision = "identity-check-failed-no-deploy";
    write(output, document);
    throw error;
  }
}

if (import.meta.url === `file://${resolve(process.argv[1] ?? "")}`) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
