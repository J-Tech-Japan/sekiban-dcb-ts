import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const packetPath = `${root}/contracts/g38-packet-contract.json`;
const domain = "sekiban-dcb-ts/g38-packet-contract/v1";

// These are the published A/S identity from issue 72. They are deliberately
// constants, not values derived from the target-side mirror.
const sealedIdentity = Object.freeze({
  authorityCommit: "cad3e6dc401ef217404f0442d5679316c843d2ec",
  selfDigest: "sha256:c2d3f2d35ae3fd1980eb0de1b7916b271c55e33ac58939d9b6ca1eef8fdca37b",
});

const topLevelKeys = Object.freeze([
  "acceptanceCriteria",
  "authorityCommit",
  "deploymentPermissionEnum",
  "digestProjection",
  "g34Handoff",
  "ledgerStateMachine",
  "liveInertConjunction",
  "mManifestRows",
  "oldWorkerLifecycle",
  "phaseSelector",
  "postCEvidenceGlob",
  "profileFields",
  "quiescence",
  "retentionOps",
  "rollbackPhases",
  "schemaVersion",
  "selfDigest",
  "targetMirrorPath",
  "tombstoneAlarmRule",
  "unit",
]);

function fail(message) {
  throw new Error(`G38 packet contract: ${message}`);
}

function equalSet(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

/** RFC 8785 ordering is JavaScript UTF-16 ordering for string keys. */
function canonical(value, pointer = "$") {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry, index) => canonical(entry, `${pointer}/${index}`)).join(",")}]`;
  if (value === null || typeof value !== "object") fail(`non-string scalar at ${pointer}`);
  const record = value;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key], `${pointer}/${key}`)}`).join(",")}}`;
}

function canonicalDigest(projected) {
  const hash = createHash("sha256");
  hash.update(Buffer.from(domain, "utf8"));
  hash.update(Buffer.from([0]));
  hash.update(Buffer.from(canonical(projected), "utf8"));
  return `sha256:${hash.digest("hex")}`;
}

function requireExactArray(actual, expected, label) {
  if (!Array.isArray(actual) || !equalSet(actual, expected)) {
    fail(`${label} differs from the sealed literal`);
  }
}

function verifyPacket(packet) {
  if (packet === null || typeof packet !== "object" || Array.isArray(packet)) fail("root must be an object");
  const keys = Object.keys(packet).sort();
  const expectedKeys = [...topLevelKeys].sort();
  if (!equalSet(keys, expectedKeys)) fail("top-level key set differs from the sealed contract");
  // Walk the entire object first: the host schema forbids every non-string
  // scalar, including schemaVersion. This is intentionally independent of
  // the digest check so a numeric mutation cannot hide behind a fresh hash.
  canonical(packet);
  if (packet.schemaVersion !== "1" || packet.unit !== "SDT-G38") fail("schemaVersion or unit is invalid");
  if (packet.targetMirrorPath !== "contracts/g38-packet-contract.json") fail("targetMirrorPath is invalid");
  if (packet.authorityCommit !== sealedIdentity.authorityCommit) fail("authorityCommit does not equal published A");
  if (packet.selfDigest !== sealedIdentity.selfDigest) fail("selfDigest does not equal published sealed identity");
  if (!Array.isArray(packet.acceptanceCriteria) || packet.acceptanceCriteria.length !== 10 || packet.acceptanceCriteria.some((entry) => typeof entry !== "string")) {
    fail("acceptanceCriteria must be the sealed ten-string list");
  }
  requireExactArray(packet.profileFields, ["configPath", "workerName", "main", "component", "deploymentPermission", "reachableLanes"], "profileFields");
  requireExactArray(packet.deploymentPermissionEnum, ["permitted", "forbidden-after-g30-closeout", "forbidden"], "deploymentPermissionEnum");
  if (!Array.isArray(packet.mManifestRows) || packet.mManifestRows.length !== 7 || packet.mManifestRows.map((row) => row?.[0]).join(",") !== "M1,M2,M3,M4,M5,M6,M7") {
    fail("M manifest rows must be the sealed M1-M7 sequence");
  }
  if (packet.phaseSelector?.none !== "pre-cutover" || packet.phaseSelector?.a !== "post-a" || packet.phaseSelector?.b !== "post-b" || packet.phaseSelector?.c !== "post-b" || packet.phaseSelector?.d !== "post-b" || packet.phaseSelector?.e !== "post-e") {
    fail("phase selector differs from the sealed total mapping");
  }
  if (packet.ledgerStateMachine?.casAuthority !== "git-branch-ref-fast-forward" || packet.quiescence?.telemetry !== "advisoryOnly") {
    fail("ledger or advisory telemetry rule differs from the sealed contract");
  }
  const projected = { ...packet };
  delete projected.selfDigest;
  delete projected.authorityCommit;
  if (canonicalDigest(projected) !== sealedIdentity.selfDigest) fail("selfDigest does not match delete-not-null projection");
}

async function readPacket() {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(packetPath, "utf8"));
  } catch (error) {
    fail(`cannot parse target mirror: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parsed;
}

function expectFailure(action, label) {
  try {
    action();
  } catch {
    return;
  }
  fail(`self-test mutation did not fail: ${label}`);
}

async function selfTest() {
  const packet = await readPacket();
  verifyPacket(packet);
  const alteredSelector = structuredClone(packet);
  alteredSelector.phaseSelector.d = "post-e";
  expectFailure(() => verifyPacket(alteredSelector), "selector drift");
  const unknownKey = structuredClone(packet);
  unknownKey.unknown = "value";
  expectFailure(() => verifyPacket(unknownKey), "unknown top-level key");
  const nullProjection = structuredClone(packet);
  nullProjection.selfDigest = null;
  expectFailure(() => verifyPacket(nullProjection), "null selfDigest replacement");
  const numericScalar = structuredClone(packet);
  numericScalar.schemaVersion = 1;
  expectFailure(() => verifyPacket(numericScalar), "non-string scalar");
  console.log("G38 packet contract self-test passed");
}

if (process.argv.includes("--self-test")) {
  await selfTest();
} else {
  verifyPacket(await readPacket());
  console.log(`G38 packet contract verified A=${sealedIdentity.authorityCommit.slice(0, 9)}`);
}
