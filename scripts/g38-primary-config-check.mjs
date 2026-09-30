import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(`${root}/contracts/g38-primary-config-allowlist.json`, "utf8"));

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function clone(value) {
  return structuredClone(value);
}

function atPointer(value, pointer) {
  return pointer.split("/").slice(1).reduce((current, key) => current?.[key], value);
}

function differences(before, after, pointer = "") {
  if (Object.is(before, after)) return [];
  if (Array.isArray(before) && Array.isArray(after)) {
    const rows = [];
    for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
      rows.push(...differences(before[index], after[index], `${pointer}/${index}`));
    }
    return rows;
  }
  if (before !== null && after !== null && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((key) => differences(before[key], after[key], `${pointer}/${key}`));
  }
  return [pointer || "/"];
}

function verify(beforeBytes, currentBytes) {
  assert.equal(manifest.schemaVersion, "1", "G38 primary allowlist schemaVersion must be 1");
  assert.equal(sha256(beforeBytes), manifest.baselineSha256, "G38 primary pre-change file digest differs from the sealed baseline");
  const before = JSON.parse(beforeBytes.toString("utf8"));
  const current = JSON.parse(currentBytes.toString("utf8"));
  const allowedChanges = manifest.allowedChanges;
  assert.ok(Array.isArray(allowedChanges) && allowedChanges.length > 0, "G38 primary allowlist must enumerate allowed changes");
  const expectedPointers = allowedChanges.map((change) => change.pointer).sort();
  assert.deepEqual(differences(before, current).sort(), expectedPointers, "G38 primary config changed outside the sealed allowlist");
  for (const change of allowedChanges) {
    if (Object.hasOwn(change, "from")) {
      assert.equal(atPointer(before, change.pointer), change.from, `G38 primary baseline mismatch at ${change.pointer}`);
    }
    assert.equal(atPointer(current, change.pointer), change.to, `G38 primary current value mismatch at ${change.pointer}`);
  }
}

function expectFailure(action, label) {
  assert.throws(action, undefined, `G38 primary config mutation must fail: ${label}`);
}

if (process.argv.includes("--self-test")) {
  const beforeBytes = Buffer.from(execFileSync("git", ["show", `${manifest.baselineCommit}:${manifest.configPath}`], { cwd: root }));
  const currentBytes = await readFile(`${root}/${manifest.configPath}`);
  verify(beforeBytes, currentBytes);
  const current = JSON.parse(currentBytes.toString("utf8"));
  const queueMutation = clone(current);
  queueMutation.queues.consumers[0].max_retries = 4;
  expectFailure(() => verify(beforeBytes, Buffer.from(JSON.stringify(queueMutation))), "queue binding mutation");
  const receiverModeMutation = clone(current);
  receiverModeMutation.vars.DIRECT_DOORBELL_RECEIVER_MODE = "self";
  expectFailure(() => verify(beforeBytes, Buffer.from(JSON.stringify(receiverModeMutation))), "receiver mode mutation");
  const widenedAllowlist = clone(current);
  widenedAllowlist.services[0].entrypoint = "OtherEntrypoint";
  expectFailure(() => verify(beforeBytes, Buffer.from(JSON.stringify(widenedAllowlist))), "service entrypoint mutation");
  console.log("G38 primary config allowlist self-test passed");
} else {
  const beforeBytes = Buffer.from(execFileSync("git", ["show", `${manifest.baselineCommit}:${manifest.configPath}`], { cwd: root }));
  const currentBytes = await readFile(`${root}/${manifest.configPath}`);
  verify(beforeBytes, currentBytes);
  console.log("G38 primary config allowlist verified");
}
