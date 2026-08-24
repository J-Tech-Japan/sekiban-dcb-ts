#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const SAMPLE_COUNT = 100;
const CADENCE_MS = 2_000;
const IDLE_SCHEDULE_MS = Object.freeze([2_000, 15_000, 180_000]);
const FIXTURE_VERSION = "sdt-g30-b0-v1";
const FIXTURE_TAG = "room:g30-baseline";
// Use a registered Meeting Room event rather than a synthetic payload so the
// exact same B0 command crosses the production admission parser as well as
// the normal commit path. The payload deliberately carries no discriminator.
const FIXTURE_PAYLOAD = JSON.stringify({ roomId: "g30-baseline", name: "SDT-G30 attribution baseline" });

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function required(name, value) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function sha(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function encodedPayload() {
  return Buffer.from(FIXTURE_PAYLOAD, "utf8").toString("base64");
}

function commitEnvelope() {
  return {
    version: 1,
    eventCandidates: [{ payload: encodedPayload(), eventPayloadName: "RoomCreated", tags: [FIXTURE_TAG] }],
    consistencyTags: [],
  };
}

async function request(baseUrl, path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-cache");
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, { ...init, headers, cache: "no-store" });
  const raw = await response.text();
  let body;
  try { body = raw.length === 0 ? {} : JSON.parse(raw); } catch { body = { raw }; }
  return { response, body, raw };
}

function requestId(response) {
  const value = response.headers.get("cf-ray");
  if (typeof value !== "string" || value.length === 0) throw new Error("Cloudflare did not return cf-ray; cannot create a 1:1 client/trace ledger");
  return value;
}

function assertCommit(result) {
  if (result.response.status !== 200 || !Array.isArray(result.body?.writtenEvents) || result.body.writtenEvents.length === 0) {
    throw new Error(`G30 B0 commit was not an eligible non-empty HTTP-200 result: ${JSON.stringify({ status: result.response.status, body: result.body })}`);
  }
  return result.body.writtenEvents[0];
}

export function assertDeploymentWitness(witness, phase, sourceCommit, configDigest) {
  if (
    witness?.task !== "SDT-G30" || witness?.phase !== phase || witness?.sourceCommit !== sourceCommit ||
    witness?.configDigest !== configDigest || witness?.placement !== "off" ||
    typeof witness?.serviceId !== "string" || witness.serviceId.length === 0 ||
    typeof witness?.worker !== "string" || witness.worker.length === 0 ||
    typeof witness?.deployedVersion?.id !== "string" || witness.deployedVersion.id.length === 0 ||
    !Number.isSafeInteger(witness?.deployedVersion?.number) ||
    typeof witness?.deployedVersion?.createdOn !== "string" || witness.deployedVersion.createdOn.length === 0 ||
    witness?.deployedVersion?.message !== `SDT-G30 B0 ${phase} ${witness.serviceId} ${sourceCommit} ${configDigest}`
  ) throw new Error("G30 external deployment witness is invalid");
  return witness;
}

/**
 * Sends the exact same V1 payload/tag fixture at a fixed 2-second schedule.
 * The body carries no G30 diagnostic extension.  cf-ray is a platform header
 * used solely to join the independent client ledger to Cloudflare telemetry.
 */
export async function measureB0Phase({ baseUrl, token, phase, sourceCommit, configDigest, deploymentWitness, samples = SAMPLE_COUNT, warmup = 5 }) {
  if (!["A", "B", "A-prime"].includes(phase)) throw new Error("G30 phase must be A, B, or A-prime");
  if (samples !== SAMPLE_COUNT) throw new Error(`G30 B0 requires exactly ${SAMPLE_COUNT} retained samples`);
  if (!Number.isSafeInteger(warmup) || warmup < 5 || warmup > 30) throw new Error("G30 warmup must be 5..30 requests");
  const authorization = { authorization: `Bearer ${token}` };
  const configWitness = assertDeploymentWitness(deploymentWitness, phase, sourceCommit, configDigest);
  const endpoint = "/conformance/v1/api/sekiban/serialized/commit";
  const warmupLedger = [];
  for (let index = 0; index < warmup; index += 1) {
    const startedAtMs = Date.now();
    const result = await request(baseUrl, endpoint, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify(commitEnvelope()),
    });
    const completedAtMs = Date.now();
    const event = assertCommit(result);
    warmupLedger.push({ index, requestId: requestId(result.response), startedAtMs, completedAtMs, eventId: event.id ?? null, status: result.response.status });
    await sleep(CADENCE_MS);
  }
  const fixedStartMs = Date.now() + CADENCE_MS;
  const ledger = [];
  for (let index = 0; index < samples; index += 1) {
    const scheduledStartMs = fixedStartMs + index * CADENCE_MS;
    await sleep(scheduledStartMs - Date.now());
    const startedAtMs = Date.now();
    const result = await request(baseUrl, endpoint, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify(commitEnvelope()),
    });
    const completedAtMs = Date.now();
    const event = assertCommit(result);
    ledger.push({
      index,
      requestId: requestId(result.response),
      status: result.response.status,
      eligible: true,
      nonEmpty: true,
      replacement: false,
      serviceId: configWitness.serviceId,
      clientRegion: process.env.G30_CLIENT_REGION ?? "unspecified-client-region",
      tagSetDigest: sha(FIXTURE_TAG),
      payloadDigest: sha(FIXTURE_PAYLOAD),
      fixtureVersion: FIXTURE_VERSION,
      scheduledStartMs,
      startedAtMs,
      completedAtMs,
      responseLatencyMs: completedAtMs - startedAtMs,
      eventId: typeof event?.id === "string" ? event.id : null,
      committedSuid: typeof event?.sortableUniqueIdValue === "string" ? event.sortableUniqueIdValue : null,
      statusRaw: { httpStatus: result.response.status, cfRay: requestId(result.response) },
    });
  }
  // B is the sole trace-sampled phase.  Its idle experiment is a sequence of
  // real V1 commits whose previous/next request ids and timestamps are
  // retained. The B0 contract derives gaps from these records; no caller may
  // supply a claimed activation or idle result.
  let idleExperiment;
  if (phase === "B") {
    const requests = [];
    const windows = [];
    let previous = ledger.at(-1);
    if (previous === undefined) throw new Error("G30 B idle experiment requires a retained canonical request");
    for (const scheduledGapMs of IDLE_SCHEDULE_MS) {
      await sleep(scheduledGapMs);
      const startedAtMs = Date.now();
      const result = await request(baseUrl, endpoint, {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: JSON.stringify(commitEnvelope()),
      });
      const completedAtMs = Date.now();
      const event = assertCommit(result);
      const next = {
        requestId: requestId(result.response),
        status: result.response.status,
        startedAtMs,
        completedAtMs,
        responseLatencyMs: completedAtMs - startedAtMs,
        eventId: typeof event?.id === "string" ? event.id : null,
        committedSuid: typeof event?.sortableUniqueIdValue === "string" ? event.sortableUniqueIdValue : null,
        statusRaw: { httpStatus: result.response.status, cfRay: requestId(result.response) },
      };
      requests.push(next);
      windows.push({
        scheduledGapMs,
        previousRequestId: previous.requestId,
        nextRequestId: next.requestId,
      });
      previous = next;
    }
    idleExperiment = Object.freeze({ scheduleMs: IDLE_SCHEDULE_MS, requests, windows });
  }
  return {
    task: "SDT-G30",
    phase,
    capturedAt: new Date().toISOString(),
    endpoint,
    deploymentWitness: configWitness,
    fixture: { version: FIXTURE_VERSION, payloadDigest: sha(FIXTURE_PAYLOAD), tagSetDigest: sha(FIXTURE_TAG), rawValues: "redacted-from-trace; fixed values are defined in the runbook source" },
    configuration: {
      serviceId: configWitness.serviceId,
      placement: configWitness.placement,
      deployedVersion: configWitness.deployedVersion.id,
      sourceCommit,
      configDigest,
      // The deployed config file is the authority for this value.  It is
      // deliberately not mirrored through a phase-specific Worker variable:
      // A(off)->B(on)->A'(off) may change sampling, but no diagnostic runtime
      // config is permitted to vary with the phase.
      observability: { traces: { enabled: true, head_sampling_rate: phase === "B" ? 1 : 0 } },
    },
    warmup: { requested: warmup, requests: warmupLedger },
    rawAttempts: [],
    ledger,
    ...(idleExperiment === undefined ? {} : { idleExperiment }),
  };
}

async function main() {
  const baseUrl = required("--base-url", argument("--base-url", process.env.G30_BASE_URL));
  const token = readFileSync(required("--token-file", argument("--token-file", process.env.G30_CONFORMANCE_TOKEN_FILE)), "utf8").trim();
  const phase = required("--phase", argument("--phase"));
  const sourceCommit = required("--source-commit", argument("--source-commit", process.env.G30_SOURCE_COMMIT));
  const configDigest = required("--config-digest", argument("--config-digest", process.env.G30_CONFIG_DIGEST));
  const deploymentWitness = JSON.parse(readFileSync(required("--deployment-witness", argument("--deployment-witness")), "utf8"));
  if (token.length === 0) throw new Error("G30 conformance token is empty");
  const output = argument("--output", `.artifacts/g30-b0-${phase}.json`);
  const measured = await measureB0Phase({ baseUrl, token, phase, sourceCommit, configDigest, deploymentWitness });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(measured, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ phase, samples: measured.ledger.length, firstRequestId: measured.ledger[0]?.requestId ?? null }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
