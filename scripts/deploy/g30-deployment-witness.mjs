#!/usr/bin/env node
/**
 * Bind a deployed G30 phase to Cloudflare's immutable Worker Version metadata.
 *
 * This deliberately lives outside the Worker: G30 must not add a diagnostic
 * route, header, or V1 field merely to prove the deployed candidate. The
 * runbook deploys from a clean final C and then requires the platform's
 * version list to retain an exact phase/C/config-digest message.
 */
import { readFileSync, writeFileSync } from "node:fs";

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const PHASES = new Set(["A", "B", "A-prime"]);

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function nonEmpty(name, value) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`G30 ${name} is required`);
  return value;
}

function sourceCommit(value) {
  const commit = nonEmpty("source commit", value);
  if (!SHA.test(commit)) throw new Error("G30 source commit must be a full SHA");
  return commit;
}

function configDigest(value) {
  const digest = nonEmpty("configuration digest", value);
  if (!DIGEST.test(digest)) throw new Error("G30 configuration digest must be sha256 hex");
  return digest;
}

export function deploymentMessage(phase, commit, digest, serviceId) {
  if (!PHASES.has(phase)) throw new Error("G30 deployment phase must be A, B, or A-prime");
  return `SDT-G30 B0 ${phase} ${nonEmpty("service id", serviceId)} ${sourceCommit(commit)} ${configDigest(digest)}`;
}

function versionsArray(value) {
  if (!Array.isArray(value)) throw new Error("G30 Wrangler versions JSON must be an array");
  return value;
}

function versionIds(versions, label) {
  const ids = versionsArray(versions).map((version, index) => {
    if (typeof version?.id !== "string" || version.id.length === 0) {
      throw new Error(`G30 ${label} Worker version at index ${index} lacks id`);
    }
    return version.id;
  });
  if (new Set(ids).size !== ids.length) throw new Error(`G30 ${label} Worker versions contain duplicate ids`);
  return new Set(ids);
}

/**
 * Fail closed unless the post-deploy list has exactly one new immutable
 * version for this phase. Repeating an interrupted B0 at the same C/config
 * intentionally creates another identical message, so message equality alone
 * is not enough to identify the deployment made by the current invocation.
 */
export function selectDeployedVersion(versions, expectedMessage, priorVersions) {
  const priorIds = versionIds(priorVersions, "pre-deploy");
  const matches = versionsArray(versions).filter((version) =>
    version?.annotations?.["workers/message"] === expectedMessage && !priorIds.has(version?.id),
  );
  if (matches.length !== 1) {
    throw new Error(`G30 expected exactly one newly deployed Worker version with message ${expectedMessage}; found ${matches.length}`);
  }
  const version = matches[0];
  if (typeof version?.id !== "string" || version.id.length === 0) throw new Error("G30 deployed Worker version lacks id");
  if (typeof version?.number !== "number" || !Number.isSafeInteger(version.number)) throw new Error("G30 deployed Worker version lacks numeric version number");
  if (typeof version?.metadata?.created_on !== "string" || version.metadata.created_on.length === 0) throw new Error("G30 deployed Worker version lacks created_on");
  if (typeof version?.metadata?.source !== "string" || version.metadata.source.length === 0) throw new Error("G30 deployed Worker version lacks source metadata");
  return Object.freeze({
    id: version.id,
    number: version.number,
    createdOn: version.metadata.created_on,
    source: version.metadata.source,
    message: expectedMessage,
  });
}

export function buildDeploymentWitness({ phase, sourceCommit: commit, configDigest: digest, serviceId, worker, versions, priorVersions }) {
  const normalizedServiceId = nonEmpty("service id", serviceId);
  const message = deploymentMessage(phase, commit, digest, normalizedServiceId);
  return Object.freeze({
    task: "SDT-G30",
    phase,
    sourceCommit: sourceCommit(commit),
    configDigest: configDigest(digest),
    placement: "off",
    serviceId: normalizedServiceId,
    worker: nonEmpty("worker name", worker),
    deployedVersion: selectDeployedVersion(versions, message, priorVersions),
    source: "wrangler-versions-list-json",
  });
}

export function selfTest() {
  const commit = "a".repeat(40);
  const digest = "b".repeat(64);
  const message = deploymentMessage("B", commit, digest, "g32-fixture");
  const priorVersions = [{
    id: "00000000-0000-4000-8000-000000000001",
    number: 7,
    metadata: { created_on: "2026-08-23T00:00:00.000Z", source: "wrangler" },
    annotations: { "workers/message": message },
  }];
  const versions = [...priorVersions, {
    id: "00000000-0000-4000-8000-000000000002",
    number: 8,
    metadata: { created_on: "2026-08-24T00:00:00.000Z", source: "wrangler" },
    annotations: { "workers/message": message },
  }];
  const witness = buildDeploymentWitness({ phase: "B", sourceCommit: commit, configDigest: digest, serviceId: "g32-fixture", worker: "fixture-worker", versions, priorVersions });
  let duplicateRed = false;
  try { selectDeployedVersion(versions, message, []); } catch (error) { duplicateRed = String(error).includes("newly deployed"); }
  if (!duplicateRed) throw new Error("G30 deployment witness pre-deploy snapshot mutation unexpectedly passed");
  let snapshotRed = false;
  try { selectDeployedVersion(versions, message, versions); } catch (error) { snapshotRed = String(error).includes("newly deployed"); }
  if (!snapshotRed) throw new Error("G30 deployment witness current-version snapshot mutation unexpectedly passed");
  let messageRed = false;
  try { selectDeployedVersion(versions, `${message}-wrong`, priorVersions); } catch (error) { messageRed = String(error).includes("newly deployed"); }
  if (!messageRed) throw new Error("G30 deployment witness message mutation unexpectedly passed");
  return { phase: witness.phase, candidateIndependent: true, duplicateRed, snapshotRed, messageRed };
}

function main() {
  if (process.argv.includes("--self-test")) {
    console.log(JSON.stringify(selfTest(), null, 2));
    return;
  }
  const witness = buildDeploymentWitness({
    phase: nonEmpty("phase", argument("--phase")),
    sourceCommit: argument("--source-commit", process.env.G30_SOURCE_COMMIT),
    configDigest: argument("--config-digest", process.env.G30_CONFIG_DIGEST),
    serviceId: argument("--service-id", process.env.G30_SERVICE_ID),
    worker: argument("--worker", process.env.G30_WORKER_NAME),
    versions: JSON.parse(readFileSync(nonEmpty("versions", argument("--versions")), "utf8")),
    priorVersions: JSON.parse(readFileSync(nonEmpty("prior versions", argument("--prior-versions")), "utf8")),
  });
  const output = nonEmpty("output", argument("--output"));
  writeFileSync(output, `${JSON.stringify(witness, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ phase: witness.phase, versionId: witness.deployedVersion.id, versionNumber: witness.deployedVersion.number }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
