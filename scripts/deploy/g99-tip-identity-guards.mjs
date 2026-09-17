#!/usr/bin/env node
/**
 * SDT-G99 tip identity gate for Cloudflare speed/latency work.
 *
 * Speed tests must target sekiban-dcb-meeting-room-cloudflare-only only when the
 * active deployment message proves an npm-consumer tip deploy (g99 script).
 */
import { evaluateTipIdentity } from "./g99-tip-identity.mjs";

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
        versions: [{ version_id: tipVersion, percentage: 100 }],
        annotations: { "workers/message": `SDT-G99 npm-consumer tip ${tipCommit}` },
      },
    ],
    expectedCommit: tipCommit,
    service: "sekiban-dcb-meeting-room-cloudflare-only",
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

process.stdout.write(`${JSON.stringify({
  matching: { ok: matching.ok },
  wrongWorker: { ok: wrongWorker.ok, reason: wrongWorker.reason },
  missingMarker: { ok: missingMarker.ok, reason: missingMarker.reason },
  wrongCommit: { ok: wrongCommit.ok, reason: wrongCommit.reason },
}, null, 2)}\n`);
