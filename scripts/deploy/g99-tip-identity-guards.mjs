#!/usr/bin/env node
/**
 * SDT-G99 tip identity gate for Cloudflare speed/latency work.
 *
 * Speed tests must target sekiban-dcb-meeting-room-cloudflare-only only when the
 * active deployment message proves an npm-consumer tip deploy (g99 script).
 */
import {
  evaluateTipIdentity,
  G99_NPM_CONSUMER_TIP_MARKER,
  G99_TIP_SERVICE,
} from "./g99-tip-identity.mjs";

function fail(message) {
  throw new Error(`g99-tip-identity-guards:${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

const tipCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const tipVersion = "11111111-1111-1111-1111-111111111111";

function baseline() {
  return {
    deployments: [
      {
        created_on: "2026-09-07T11:02:20.225Z",
        versions: [{ version_id: "00000000-0000-0000-0000-000000000000", percentage: 100 }],
        annotations: { "workers/message": "old deploy" },
      },
      {
        created_on: "2026-09-17T21:05:59.631Z",
        versions: [{ version_id: tipVersion, percentage: 100 }],
        annotations: { "workers/message": `${G99_NPM_CONSUMER_TIP_MARKER} ${tipCommit}` },
      },
    ],
    expectedCommit: tipCommit,
    service: G99_TIP_SERVICE,
  };
}

const matching = evaluateTipIdentity(baseline());
assert(matching.ok, "matching npm-consumer tip should pass");

const wrongWorker = evaluateTipIdentity({
  ...baseline(),
  service: "some-other-worker",
});
assert(!wrongWorker.ok, "non-meeting-room worker must fail");

const missingMarker = evaluateTipIdentity({
  ...baseline(),
  deployments: [
    {
      versions: [{ version_id: tipVersion, percentage: 100 }],
      annotations: { "workers/message": `monorepo tip ${tipCommit}` },
    },
  ],
});
assert(!missingMarker.ok, "missing npm-consumer marker must fail");

const wrongCommit = evaluateTipIdentity({
  ...baseline(),
  expectedCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
});
assert(!wrongCommit.ok, "commit mismatch must fail");

const wrongVersion = evaluateTipIdentity({
  ...baseline(),
  expectedVersionId: "22222222-2222-2222-2222-222222222222",
});
assert(!wrongVersion.ok, "version id mismatch must fail");

const matchingVersion = evaluateTipIdentity({
  ...baseline(),
  expectedVersionId: tipVersion,
});
assert(matchingVersion.ok, "matching tip version id should pass");

process.stdout.write(`${JSON.stringify({
  matching: { ok: matching.ok },
  wrongWorker: { ok: wrongWorker.ok, reason: wrongWorker.reason },
  missingMarker: { ok: missingMarker.ok, reason: missingMarker.reason },
  wrongCommit: { ok: wrongCommit.ok, reason: wrongCommit.reason },
  wrongVersion: { ok: wrongVersion.ok, reason: wrongVersion.reason },
  matchingVersion: { ok: matchingVersion.ok },
}, null, 2)}\n`);
