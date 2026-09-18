#!/usr/bin/env node
/** Non-live guards for the SDT-G50 reuse-versus-redeploy identity decision. */
import { evaluateIdentity, G99_NPM_CONSUMER_TIP_MARKER } from "./g50-deployed-identity.mjs";

function fail(message) {
  throw new Error(`g50-deployed-identity-guards:${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

const version = "6dd811dd-8b3d-450b-b884-55e6b9095b1d";
const configCommit = "7fcd2dbeb18d9841823c101badf8bcc28d3d99bf";
const mainCommit = "e4707fdef800e1c2f84c8bebfb7225607861d0c9";

function baseline() {
  return {
    versions: [{
      id: version,
      annotations: { "workers/message": `${G99_NPM_CONSUMER_TIP_MARKER} ${configCommit}` },
    }],
    expectedVersion: version,
    expectedConfigCommit: configCommit,
    mainCommit,
    observedMainCommit: mainCommit,
    expectedConfig: '{"name":"normal-config"}\n',
    mainConfig: '{"name":"normal-config"}\n',
    runtimeDiffPaths: [],
  };
}

function matchingIdentityReusesDeployment() {
  const result = evaluateIdentity(baseline());
  assert(result.reuseExistingDeployment, "matching deployed version/config/runtime was not reusable");
  assert(result.tipMatches, "matching tip marker must pass");
  return { result: "green", decision: "reuse-existing-deployment-no-redeploy" };
}

function assertMutantIsRed(label, mutate) {
  const input = baseline();
  mutate(input);
  const result = evaluateIdentity(input);
  assert(!result.reuseExistingDeployment, `${label} identity mutant was incorrectly reusable`);
  return "red";
}

const results = {
  matchingIdentity: matchingIdentityReusesDeployment(),
  wrongVersionAnnotationMutant: assertMutantIsRed("wrong version annotation", (input) => {
    input.versions[0].annotations["workers/message"] = `${G99_NPM_CONSUMER_TIP_MARKER} another commit`;
  }),
  missingTipMarkerMutant: assertMutantIsRed("missing npm-consumer tip marker", (input) => {
    input.versions[0].annotations["workers/message"] = `monorepo tip ${configCommit}`;
  }),
  configDriftMutant: assertMutantIsRed("config drift", (input) => {
    input.mainConfig = '{"name":"changed-normal-config"}\n';
  }),
  runtimeDriftMutant: assertMutantIsRed("runtime drift", (input) => {
    input.runtimeDiffPaths = ["packages/sekiban/src/runtime.ts"];
  }),
};

process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
