#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const targets = [
  "samples/meeting-room/src/worker.cloudflare-only.ts",
  "samples/meeting-room/src/worker.cloudflare-receiver-support.ts",
];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function checkSources(entries) {
  const missing = [];
  for (const [relativePath, source] of entries) {
    if (!source.includes("deliveryPolicyFromDomain")) {
      missing.push(`${relativePath} must derive doorbell policy from deliveryPolicyFromDomain`);
    }
    if (source.match(/readDirectDoorbellConfig\([^)]*,\s*\{[^}]*RoomProjector/)) {
      missing.push(`${relativePath} must not pass a hand-kept per-view policy map to readDirectDoorbellConfig`);
    }
  }
  if (missing.length > 0) throw new Error(missing.join("; "));
}

function assertRed(label, operation) {
  try {
    operation();
    return { label, status: "green", detail: "expected failure did not occur" };
  } catch (error) {
    return { label, status: "red", detail: String(error) };
  }
}

function mutantEntries() {
  return targets.map((relativePath) => {
    const source = read(relativePath).replace(
      "deliveryPolicyFromDomain(meetingRoomDomain)",
      '{ RoomProjector: "immediate-preferred", ReservationProjector: "immediate-preferred" }',
    );
    return [relativePath, source];
  });
}

checkSources(targets.map((relativePath) => [relativePath, read(relativePath)]));
const mutant = assertRed("hand-kept doorbell policy map", () => {
  checkSources(mutantEntries());
});

const receipt = {
  status: mutant.status === "red" ? "pass" : "fail",
  positive: "deliveryPolicyFromDomain wiring present",
  mutant,
};

if (receipt.status !== "pass") {
  console.error(JSON.stringify(receipt, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(receipt, null, 2));
