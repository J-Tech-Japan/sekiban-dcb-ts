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

async function main() {
  if (process.argv.includes("--self-test")) {
    verifyScopeMismatch(403, { code: "scope.mismatch", error: "generic" });
    let red = false;
    try { verifyScopeMismatch(200, { code: "scope.mismatch" }); } catch { red = true; }
    if (!red) throw new Error("G53 mismatch self-test mutation unexpectedly passed");
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
  const response = await fetch(endpoint, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json", "user-agent": "SDT-G53-mismatch-e2e/1.0" },
    signal: AbortSignal.timeout(30_000),
  });
  const elapsedMs = Math.round((performance.now() - started) * 1000) / 1000;
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("G53 mismatch probe response was not JSON");
  }
  verifyScopeMismatch(response.status, body);

  const artifact = {
    probe: "SDT-G53 control-route scope mismatch",
    startedAt,
    endpoint,
    status: response.status,
    body,
    elapsedMs,
    authorization: "redacted; supplied from protected token file",
  };
  const output = resolve(report);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(artifact)}\n`);
}

await main();
