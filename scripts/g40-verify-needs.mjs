#!/usr/bin/env node
/** Fail the required verify context unless every split CI job succeeded. */
function fail(message) {
  throw new Error(`g40-verify-needs:${message}`);
}

export function assertNeeds(raw) {
  let needs;
  try {
    needs = JSON.parse(raw);
  } catch (error) {
    fail(`G40_VERIFY_NEEDS_JSON is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (needs === null || typeof needs !== "object" || Array.isArray(needs) || Object.keys(needs).length === 0) {
    fail("G40_VERIFY_NEEDS_JSON must describe at least one dependency");
  }
  const unhealthy = Object.entries(needs)
    .filter(([, state]) => state === null || typeof state !== "object" || state.result !== "success")
    .map(([job, state]) => `${job}=${state !== null && typeof state === "object" ? String(state.result) : "invalid"}`);
  if (unhealthy.length > 0) fail(`split dependencies must all succeed; ${unhealthy.join(", ")}`);
}

function expectFailure(raw, label) {
  try {
    assertNeeds(raw);
  } catch {
    return;
  }
  fail(`self-test ${label} unexpectedly passed`);
}

if (process.argv.includes("--self-test")) {
  assertNeeds(JSON.stringify({ passed: { result: "success" } }));
  expectFailure(JSON.stringify({ failed: { result: "failure" } }), "failure");
  expectFailure(JSON.stringify({ skipped: { result: "skipped" } }), "skipped");
  process.stdout.write(`${JSON.stringify({ schema: "sdt-g40-verify-needs-self-test/v1", verified: ["success", "failure", "skipped"] }, null, 2)}\n`);
} else {
  assertNeeds(process.env.G40_VERIFY_NEEDS_JSON ?? "");
  process.stdout.write("All split CI dependencies succeeded.\n");
}
