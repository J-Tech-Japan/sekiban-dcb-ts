#!/usr/bin/env node
/** Validates that a G42 deploy changes code only, not primary bindings/config. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

function fail(message) {
  throw new Error(`g42-deployment-witness:${message}`);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

function same(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function bytesDigest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function string(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function activeDeployment(deployments, label) {
  const rows = array(deployments, label);
  const active = rows.find((row) => Array.isArray(row?.versions) && row.versions.length === 1 && row.versions[0]?.percentage === 100);
  if (active === undefined) fail(`${label} has no one-version 100 percent deployment`);
  const versionId = string(active.versions[0].version_id, `${label}.versions[0].version_id`);
  return Object.freeze({ deploymentId: string(active.id, `${label}.id`), versionId, message: active.annotations?.["workers/message"] ?? null });
}

function deployedByMessage(deployments, message) {
  const matches = array(deployments, "after deployments").filter((deployment) => deployment?.annotations?.["workers/message"] === message);
  if (matches.length !== 1) fail(`expected exactly one deployment with G42 message; found ${matches.length}`);
  const deployment = matches[0];
  if (!Array.isArray(deployment.versions) || deployment.versions.length !== 1 || deployment.versions[0]?.percentage !== 100) {
    fail("G42 deployment is not a single 100 percent version");
  }
  return Object.freeze({ deploymentId: string(deployment.id, "after deployment.id"), versionId: string(deployment.versions[0].version_id, "after deployment.version_id") });
}

function configProjection(version) {
  const resources = object(version.resources, "version.resources");
  const script = object(resources.script, "version.resources.script");
  return Object.freeze({
    scriptRuntime: canonical(object(resources.script_runtime, "version.resources.script_runtime")),
    handlers: canonical({
      handlers: array(script.handlers, "version.resources.script.handlers"),
      named_handlers: array(script.named_handlers, "version.resources.script.named_handlers"),
    }),
    bindings: canonical([...array(resources.bindings, "version.resources.bindings")]
      .sort((left, right) => `${left?.type ?? ""}:${left?.name ?? ""}`.localeCompare(`${right?.type ?? ""}:${right?.name ?? ""}`))),
  });
}

function routeProjection(configText) {
  let config;
  try { config = object(JSON.parse(configText), "config"); } catch { fail("config must be JSON/JSONC without comments"); }
  return Object.freeze({
    workersDev: config.workers_dev ?? null,
    routes: config.routes ?? [],
    triggers: config.triggers ?? {},
    assets: config.assets ?? null,
  });
}

export function assertG42DeploymentWitness({ beforeDeployments, afterDeployments, beforeVersion, afterVersion, message, worker, baseUrl, sourceCommit, configText }) {
  const before = activeDeployment(beforeDeployments, "before deployments");
  const deployed = deployedByMessage(afterDeployments, message);
  const after = activeDeployment(afterDeployments, "after deployments");
  if (after.versionId !== deployed.versionId) fail("G42 deployment is not the active 100 percent deployment");
  if (string(afterVersion.id, "after version.id") !== after.versionId) fail("after version read-back differs from active deployment version");
  if (string(beforeVersion.id, "before version.id") !== before.versionId) fail("before version read-back differs from prior active version");
  const beforeProjection = configProjection(beforeVersion);
  const afterProjection = configProjection(afterVersion);
  if (!same(beforeProjection, afterProjection)) fail("remote primary runtime/binding projection changed during G42 deploy");
  const source = string(sourceCommit, "sourceCommit");
  if (!/^[a-f0-9]{40}$/.test(source)) fail("sourceCommit must be a full git SHA");
  if (!message.includes(source)) fail("G42 deployment message does not bind the source commit");
  const routes = routeProjection(string(configText, "configText"));
  const number = afterVersion.number;
  if (!Number.isSafeInteger(number) || number < 1) fail("after version number is invalid");
  return Object.freeze({
    schema: "sdt.g42.deployment-witness/v1",
    worker: string(worker, "worker"),
    source: "wrangler versions/deployments read-back",
    sourceCommit: source,
    prior: before,
    deployed: Object.freeze({ ...deployed, versionNumber: number }),
    providerIdentity: Object.freeze({
      worker: string(worker, "worker"),
      versionId: after.versionId,
      versionNumber: number,
      baseUrl: string(baseUrl, "baseUrl"),
      configReadbackDigest: digest(afterProjection),
    }),
    remoteConfigUnchanged: true,
    projectionDigest: digest(afterProjection),
    configFileDigest: bytesDigest(configText),
    routeConfig: routes,
    beforeVersionReadbackDigest: digest(beforeVersion),
    afterVersionReadbackDigest: digest(afterVersion),
    explicitlyChangedSurface: "primary component authenticated conformance route /conformance/v1/g42/journal-first-touch",
  });
}

export function selfTest() {
  const resources = {
    script: { handlers: ["fetch"], named_handlers: [{ name: "JournalDurableObject", handlers: ["class"] }] },
    script_runtime: { compatibility_date: "2026-08-18", compatibility_flags: ["nodejs_compat"] },
    bindings: [{ name: "JOURNAL", type: "durable_object_namespace", namespace_id: "fixture" }],
  };
  const beforeVersion = { id: "before", number: 1, resources };
  const afterVersion = { id: "after", number: 2, resources: structuredClone(resources) };
  const sourceCommit = "a".repeat(40);
  const beforeDeployments = [{ id: "prior-deploy", versions: [{ version_id: "before", percentage: 100 }], annotations: { "workers/message": "prior" } }];
  const afterDeployments = [{ id: "g42-deploy", versions: [{ version_id: "after", percentage: 100 }], annotations: { "workers/message": `g42 ${sourceCommit}` } }, ...beforeDeployments];
  const mutated = structuredClone(afterVersion);
  mutated.resources.bindings.push({ name: "EXTRA", type: "plain_text", text: "bad" });
  let forcedRed = false;
  const configText = JSON.stringify({ workers_dev: false, routes: [], triggers: { crons: [] }, assets: { directory: "public" } });
  const parameters = { beforeDeployments, afterDeployments, beforeVersion, afterVersion, message: `g42 ${sourceCommit}`, worker: "fixture", baseUrl: "https://fixture.example", sourceCommit, configText };
  const accepted = assertG42DeploymentWitness(parameters);
  try { assertG42DeploymentWitness({ ...parameters, afterVersion: mutated }); } catch { forcedRed = true; }
  if (!forcedRed) fail("binding mutation unexpectedly passed");
  return Object.freeze({ accepted, forcedRed: "binding-projection" });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function main() {
  if (process.argv.includes("--self-test")) {
    console.log(JSON.stringify(selfTest(), null, 2));
    return;
  }
  const required = (name) => string(argument(name), name);
  const result = assertG42DeploymentWitness({
    beforeDeployments: JSON.parse(readFileSync(required("--before-deployments"), "utf8")),
    afterDeployments: JSON.parse(readFileSync(required("--after-deployments"), "utf8")),
    beforeVersion: JSON.parse(readFileSync(required("--before-version"), "utf8")),
    afterVersion: JSON.parse(readFileSync(required("--after-version"), "utf8")),
    message: required("--message"),
    worker: required("--worker"),
    baseUrl: required("--base-url"),
    sourceCommit: required("--source-commit"),
    configText: readFileSync(required("--config"), "utf8"),
  });
  const output = required("--output");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${resolve(process.argv[1] ?? "")}`) main();
