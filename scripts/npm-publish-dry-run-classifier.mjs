#!/usr/bin/env node
import assert from "node:assert/strict";

/**
 * Classify a failed credential-free publish probe without turning any failure
 * into a pass.  Registry collisions are expected after a version is released,
 * but malformed package output is a packaging failure even if another part of
 * npm's output happens to mention a collision.
 */
export function classifyPublishFailure(result, { packageName, version } = {}) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const invalidManifest = /(?:EJSONPARSE|JSON\.parse|invalid\s+(?:package(?:\.json)?|manifest)|package\.json[^\n]*(?:invalid|unexpected|parse)|ENOENT[^\n]*package\.json)/i.test(output);
  if (invalidManifest) {
    return {
      kind: "invalid-packaging",
      packageName: packageName ?? null,
      version: version ?? null,
      status: result.status ?? null,
      signal: result.signal ?? null,
      reason: "npm reported malformed or unavailable package metadata",
    };
  }
  if (/(?:cannot publish over|previously published versions|EPUBLISHCONFLICT|version collision)/i.test(output)) {
    return {
      kind: "version-collision",
      packageName: packageName ?? null,
      version: version ?? null,
      status: result.status ?? null,
      signal: result.signal ?? null,
      reason: "target package version is already published",
    };
  }
  return {
    kind: "publish-or-environment-failure",
    packageName: packageName ?? null,
    version: version ?? null,
    status: result.status ?? null,
    signal: result.signal ?? null,
    reason: "npm publish dry-run failed without a recognized version-collision or manifest signature",
  };
}

export function assertDryRunFailureClassification(result, expected) {
  const actual = classifyPublishFailure(result, expected);
  assert.equal(actual.kind, expected.kind, `unexpected dry-run failure classification: ${JSON.stringify(actual)}`);
  return actual;
}

function selfTest() {
  const collision = assertDryRunFailureClassification({
    status: 1,
    signal: null,
    stdout: "",
    stderr: "npm error You cannot publish over the previously published versions: 0.1.0",
  }, { packageName: "@sekiban/dcb-core", version: "0.1.0", kind: "version-collision" });
  const invalidManifest = assertDryRunFailureClassification({
    status: 1,
    signal: null,
    stdout: "",
    stderr: "npm error code EJSONPARSE: Unexpected token in package.json (also saw a stale collision warning)",
  }, { packageName: "@sekiban/dcb-core", version: "0.1.1", kind: "invalid-packaging" });

  // Explicit red mutant: a broken manifest must never be relabelled as a
  // version collision merely because a generic collision matcher was added.
  let brokenManifestCollisionMutantRed = false;
  try {
    assert.equal("version-collision", invalidManifest.kind, "broken-manifest collision mutant escaped");
  } catch {
    brokenManifestCollisionMutantRed = true;
  }
  assert.equal(brokenManifestCollisionMutantRed, true, "broken-manifest collision mutant was not detected");
  console.log(JSON.stringify({
    status: "PASS",
    guard: "npm-publish-dry-run-classifier",
    collision,
    invalidManifest,
    redMutant: { id: "broken-manifest-as-version-collision", result: "red" },
  }, null, 2));
}

if (process.argv.includes("--self-test")) selfTest();
