#!/usr/bin/env node
/**
 * Deployed SDT-G53 control-route mismatch witness.
 *
 * The bearer value is read only to construct the request and is never echoed,
 * persisted, or included in the evidence artifact.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function required(label, value) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

export function verifyScopeMismatch(status, body) {
  if (status !== 403) throw new Error(`G53 mismatch probe expected HTTP 403, received ${status}`);
  if (body === null || typeof body !== "object" || Array.isArray(body) || body.code !== "scope.mismatch") {
    throw new Error("G53 mismatch probe did not return typed scope.mismatch");
  }
  if (Object.hasOwn(body, "expectedServiceId") || Object.hasOwn(body, "configuredServiceId")) {
    throw new Error("G53 mismatch probe leaked a deployment identity");
  }
}

/**
 * The deployed conformance endpoint's protocol body contains only a typed
 * `code` and human-readable `error`. Persist exactly that safe surface even
 * when verification fails; never turn a diagnostic response into evidence
 * that could disclose an identity or a bearer credential.
 */
export function evidenceBody(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return {
      code: "non_json_response",
      error: "G53 mismatch probe response was not a typed JSON object",
    };
  }
  return {
    code: typeof body.code === "string" ? body.code : "untyped_response",
    error: typeof body.error === "string" ? body.error : "G53 mismatch probe response omitted error",
  };
}

function writeProbeArtifact(report, artifact) {
  const output = resolve(report);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

async function main() {
  if (process.argv.includes("--self-test")) {
    verifyScopeMismatch(403, { code: "scope.mismatch", error: "generic" });
    let red = false;
    try { verifyScopeMismatch(200, { code: "scope.mismatch" }); } catch { red = true; }
    if (!red) throw new Error("G53 mismatch self-test mutation unexpectedly passed");
    const safeBody = evidenceBody({
      code: "scope.mismatch",
      error: "generic",
      expectedServiceId: "must-not-be-persisted",
    });
    if (safeBody.code !== "scope.mismatch" || safeBody.error !== "generic" || Object.hasOwn(safeBody, "expectedServiceId")) {
      throw new Error("G53 mismatch self-test evidence-body redaction unexpectedly failed");
    }
    process.stdout.write(`${JSON.stringify({ result: "g53-scope-mismatch-e2e-self-test-passed" })}\n`);
    return;
  }

  const baseUrl = required("--base-url", argument("--base-url"));
  const tokenFile = required("--token-file", argument("--token-file") ?? process.env.G53_CONFORMANCE_TOKEN_FILE);
  const report = required("--report", argument("--report"));
  const token = readFileSync(tokenFile, "utf8").trim();
  if (token.length === 0) throw new Error("G53 conformance token file is empty");

  const endpoint = new URL("/conformance/v1/g53-scope-mismatch", baseUrl).toString();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let response;
  try {
    response = await fetch(endpoint, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json", "user-agent": "SDT-G53-mismatch-e2e/1.0" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    const artifact = {
      probe: "SDT-G53 control-route scope mismatch",
      startedAt,
      endpoint,
      status: null,
      body: { code: "probe_transport_error", error: "G53 mismatch probe request failed before an HTTP response" },
      elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
      result: "failed",
      authorization: "redacted; supplied from protected token file",
    };
    writeProbeArtifact(report, artifact);
    throw new Error("G53 mismatch probe request failed before an HTTP response");
  }
  const elapsedMs = Math.round((performance.now() - started) * 1000) / 1000;
  let body;
  try {
    body = await response.json();
  } catch {
    const artifact = {
      probe: "SDT-G53 control-route scope mismatch",
      startedAt,
      endpoint,
      status: response.status,
      body: evidenceBody(undefined),
      elapsedMs,
      result: "failed",
      authorization: "redacted; supplied from protected token file",
    };
    writeProbeArtifact(report, artifact);
    throw new Error("G53 mismatch probe response was not JSON");
  }

  const artifact = {
    probe: "SDT-G53 control-route scope mismatch",
    startedAt,
    endpoint,
    status: response.status,
    body: evidenceBody(body),
    elapsedMs,
    result: "passed",
    authorization: "redacted; supplied from protected token file",
  };
  try {
    verifyScopeMismatch(response.status, body);
  } catch (error) {
    artifact.result = "failed";
    writeProbeArtifact(report, artifact);
    throw error;
  }
  writeProbeArtifact(report, artifact);
  process.stdout.write(`${JSON.stringify(artifact)}\n`);
}

await main();
