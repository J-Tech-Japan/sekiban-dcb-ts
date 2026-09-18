#!/usr/bin/env node
/**
 * Evaluate whether the active Cloudflare deployment is an SDT-G99 npm-consumer
 * tip suitable for speed/latency measurement.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export const G99_NPM_CONSUMER_TIP_MARKER = "SDT-G99 npm-consumer tip";
export const G99_TIP_SERVICE = "sekiban-dcb-meeting-room-cloudflare-only";

const TOKEN_VARIABLES = Object.freeze([
  "CLOUDFLARE_API_TOKEN",
  "CF_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CF_API_KEY",
  "WRANGLER_API_TOKEN",
]);

export function evaluateTipIdentity({ deployments, expectedCommit, service, expectedVersionId }) {
  if (service !== G99_TIP_SERVICE) {
    return Object.freeze({
      ok: false,
      reason: `service must be ${G99_TIP_SERVICE}`,
      activeVersionId: null,
      message: "",
    });
  }
  const active = Array.isArray(deployments)
    ? [...deployments]
        .filter((entry) => {
          const versions = entry?.versions;
          return Array.isArray(versions) && versions.some((v) => Number(v?.percentage) === 100);
        })
        .sort((a, b) => String(b?.created_on ?? "").localeCompare(String(a?.created_on ?? "")))[0]
    : undefined;
  if (active === undefined) {
    return Object.freeze({
      ok: false,
      reason: "no 100% traffic deployment found",
      activeVersionId: null,
      message: "",
    });
  }
  const message = typeof active?.annotations?.["workers/message"] === "string"
    ? active.annotations["workers/message"]
    : "";
  const version = Array.isArray(active.versions)
    ? active.versions.find((v) => Number(v?.percentage) === 100)
    : undefined;
  const activeVersionId = typeof version?.version_id === "string" ? version.version_id : null;
  if (!message.includes(G99_NPM_CONSUMER_TIP_MARKER)) {
    return Object.freeze({
      ok: false,
      reason: `active deployment message missing '${G99_NPM_CONSUMER_TIP_MARKER}'`,
      activeVersionId,
      message,
    });
  }
  if (typeof expectedCommit !== "string" || expectedCommit.length < 7 || !message.includes(expectedCommit)) {
    return Object.freeze({
      ok: false,
      reason: "active deployment message does not include expected tip commit",
      activeVersionId,
      message,
    });
  }
  if (typeof expectedVersionId === "string" && expectedVersionId.length > 0 && activeVersionId !== expectedVersionId) {
    return Object.freeze({
      ok: false,
      reason: "active tip version id does not match expected version id",
      activeVersionId,
      message,
    });
  }
  return Object.freeze({
    ok: true,
    reason: null,
    activeVersionId,
    message,
  });
}

function scrubbedEnvironment() {
  const environment = { ...process.env, WRANGLER_WRITE_LOGS: "false" };
  for (const key of TOKEN_VARIABLES) delete environment[key];
  return environment;
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

/**
 * Live fail-closed tip gate for g50 / speed samplers.
 * Lists deployments via wrangler and requires an npm-consumer tip message.
 */
export function assertLiveTipIdentity({
  wrangler = "./node_modules/.bin/wrangler",
  service = G99_TIP_SERVICE,
  expectedCommit,
  expectedVersionId,
  cwd = process.cwd(),
} = {}) {
  if (typeof expectedCommit !== "string" || expectedCommit.length < 7) {
    throw new Error("g99-tip-identity: expectedCommit is required");
  }
  const result = spawnSync(
    wrangler,
    ["deployments", "list", "--name", service, "--json"],
    { cwd, encoding: "utf8", env: scrubbedEnvironment() },
  );
  if (result.error !== undefined) {
    throw new Error(`g99-tip-identity: wrangler could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`g99-tip-identity: wrangler deployments list exited ${result.status}: ${(result.stderr ?? "").trim()}`);
  }
  let deployments;
  try {
    deployments = JSON.parse(result.stdout ?? "");
  } catch (error) {
    throw new Error(`g99-tip-identity: deployments list did not return JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const identity = evaluateTipIdentity({
    deployments,
    expectedCommit,
    service,
    ...(expectedVersionId === undefined ? {} : { expectedVersionId }),
  });
  if (!identity.ok) {
    throw new Error(`g99-tip-identity: ${identity.reason}; message=${JSON.stringify(identity.message)}`);
  }
  return identity;
}

function main() {
  const wrangler = argument("--wrangler", "./node_modules/.bin/wrangler");
  const service = argument("--service", G99_TIP_SERVICE);
  const expectedCommit = argument("--expected-commit", process.env.G50_SOURCE_COMMIT ?? process.env.G99_TIP_COMMIT);
  const expectedVersionId = argument("--expected-version", process.env.G50_VERSION_ID ?? process.env.G99_TIP_VERSION_ID);
  if (typeof expectedCommit !== "string" || expectedCommit.length === 0) {
    throw new Error("g99-tip-identity: pass --expected-commit or G50_SOURCE_COMMIT / G99_TIP_COMMIT");
  }
  const identity = assertLiveTipIdentity({
    wrangler,
    service,
    expectedCommit,
    ...(typeof expectedVersionId === "string" && expectedVersionId.length > 0 ? { expectedVersionId } : {}),
  });
  process.stdout.write(`${JSON.stringify({
    schema: "sdt-g99-tip-identity/v1",
    ok: true,
    service,
    expectedCommit,
    ...(typeof expectedVersionId === "string" && expectedVersionId.length > 0 ? { expectedVersionId } : {}),
    activeVersionId: identity.activeVersionId,
    message: identity.message,
  }, null, 2)}\n`);
}

if (import.meta.url === `file://${resolve(process.argv[1] ?? "")}`) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
