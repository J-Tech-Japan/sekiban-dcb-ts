#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTH_MODES,
  buildPublishPlan,
  selectAuthentication,
  selectProvenance,
} from "./g72-trusted-publishing-selection.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const selectionPath = resolve(root, "scripts/g72-trusted-publishing-selection.mjs");
const workflowPath = resolve(root, ".github/workflows/release-dcb-matched-set.yml");

function assertAuthenticationMatrix() {
  const cases = [
    {
      name: "trusted publisher selected without token",
      input: { trustedPublishing: "true", tokenConfigured: false },
      expected: AUTH_MODES.TRUSTED_PUBLISHING,
    },
    {
      name: "token selected when trusted publisher is unavailable",
      input: { trustedPublishing: "false", tokenConfigured: true },
      expected: AUTH_MODES.TOKEN,
    },
    {
      name: "credential-free dry-run selected without either credential",
      input: { trustedPublishing: "false", tokenConfigured: false },
      expected: AUTH_MODES.DRY_RUN,
    },
    {
      name: "trusted publisher wins when a legacy token is still present",
      input: { trustedPublishing: "true", tokenConfigured: true },
      expected: AUTH_MODES.TRUSTED_PUBLISHING,
    },
  ];
  const results = cases.map(({ name, input, expected }) => {
    const actual = selectAuthentication(input);
    assert.equal(actual, expected, name);
    return { name, actual };
  });
  return results;
}

function assertProvenanceMatrix() {
  const privatePlan = selectProvenance({ repositoryPrivate: true });
  const publicPlan = selectProvenance({ repositoryPrivate: false });
  assert.equal(privatePlan.provenanceEnabled, false, "private source repositories omit provenance");
  assert.deepEqual(privatePlan.publishEnvironment, { NPM_CONFIG_PROVENANCE: "false" });
  assert.equal(publicPlan.provenanceEnabled, true, "public source repositories enable provenance");
  assert.deepEqual(publicPlan.publishEnvironment, {});
  assert.throws(
    () => selectProvenance({ repositoryPrivate: "not-a-visibility" }),
    /repository visibility must be a boolean/,
  );
  return { private: privatePlan, public: publicPlan };
}

function assertWorkflowUsesProductSelection() {
  const workflow = readFileSync(workflowPath, "utf8");
  assert.match(
    workflow,
    /node scripts\/g72-trusted-publishing-selection\.mjs --github-output/,
    "the release workflow must execute the product selection module",
  );
  assert.match(
    workflow,
    /steps\.publish-selection\.outputs\.auth_mode/,
    "the selection output must be consumed by the release step",
  );
  assert.match(workflow, /AUTH_MODE.*trusted-publishing|trusted-publishing.*AUTH_MODE/s);
  assert.match(workflow, /env -u NODE_AUTH_TOKEN/, "trusted publishing must not silently use the token");
  assert.match(workflow, /NPM_TRUSTED_PUBLISHING/, "the trusted-publishing variable must reach the workflow");
  assert.match(workflow, /NODE_AUTH_TOKEN/, "the token fallback must remain wired");
  assert.match(workflow, /NPM_CONFIG_PROVENANCE=false/, "private provenance must remain disabled");
  assert.match(
    workflow,
    /gh api "repos\/\$\{GITHUB_REPOSITORY\}" --jq '\.private'/,
    "visibility must come from the live GitHub repository response",
  );
  assert.match(workflow, /no package was published/, "the no-auth outcome must be visible in the run log");
}

function assertCliTrustedBranch() {
  const environment = { ...process.env, NPM_TRUSTED_PUBLISHING: "true", REPO_IS_PRIVATE: "true" };
  delete environment.NODE_AUTH_TOKEN;
  const result = spawnSync(process.execPath, [selectionPath], {
    cwd: root,
    env: environment,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.authMode, AUTH_MODES.TRUSTED_PUBLISHING);
  assert.equal(output.tokenConfigured, false);
  assert.equal(output.unsetNodeAuthToken, true);
  assert.equal(output.willPublish, true);
  return output;
}

function main() {
  const authentication = assertAuthenticationMatrix();
  const provenance = assertProvenanceMatrix();
  assertWorkflowUsesProductSelection();
  const cliTrustedBranch = assertCliTrustedBranch();
  const planSummary = {
    trusted: buildPublishPlan({ trustedPublishing: "true", tokenConfigured: false, repositoryPrivate: "false" }),
    token: buildPublishPlan({ trustedPublishing: "false", tokenConfigured: true, repositoryPrivate: "false" }),
    fallback: buildPublishPlan({ trustedPublishing: "false", tokenConfigured: false, repositoryPrivate: "true" }),
  };
  console.log(JSON.stringify({
    guard: "sdt-g72-trusted-publishing",
    status: "PASS",
    authentication,
    provenance,
    cliTrustedBranch,
    planSummary,
  }, null, 2));
}

main();
