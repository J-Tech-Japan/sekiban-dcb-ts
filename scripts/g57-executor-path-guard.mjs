#!/usr/bin/env node
/** Red-capable source guard for the SDT-G57 AC5 sample migration. */
import { readFileSync } from "node:fs";

function fail(message) {
  throw new Error(`g57-executor-path-guard:${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function source(path) {
  return readFileSync(path, "utf8");
}

function check(transport, worker, cloudflare, app) {
  assert(transport.includes("createInProcessTransport"), "sample transport does not use the in-process transport");
  assert(transport.includes("createSekibanExecutor"), "sample transport does not construct the public executor");
  assert(worker.includes("parseMeetingRoomCommandRequest"), "local command route does not parse executor requests");
  assert(cloudflare.includes("parseMeetingRoomCommandRequest"), "Cloudflare command route does not parse executor requests");
  assert(app.includes("executorCommandBody"), "browser app does not send executor options");
  assert(app.includes('readMode: "snapshot-only"'), "browser app does not select snapshot-only mode");
  assert(app.includes('readMode: "read-through"'), "browser app does not retain read-through fallback");
  const createRoomStart = app.indexOf('if (commandId === "create-room"');
  const reserveStart = app.indexOf('if (commandId === "reserve-room"');
  assert(createRoomStart >= 0 && reserveStart > createRoomStart, "browser app lost create-room snapshot branch");
  assert(app.slice(createRoomStart, reserveStart).includes('readMode: "snapshot-only"'), "create-room does not use snapshot-only with its portable snapshot");
  assert(app.includes("rememberCommittedSnapshots"), "browser app does not retain committed portable snapshots");
  assert(app.includes("view.readHead"), "browser app does not retain list/query read heads");
  assert(!transport.includes("executeCommand(command"), "sample transport still owns the old domain executor call");
  return true;
}

const paths = {
  transport: "samples/meeting-room/src/transport.ts",
  worker: "samples/meeting-room/src/worker.ts",
  cloudflare: "samples/meeting-room/src/worker.cloudflare-only.ts",
  app: "samples/meeting-room/public/app.js",
};

const actual = check(...Object.values(paths).map(source));
const result = { result: actual ? "g57-executor-path-valid" : "invalid" };

if (process.argv.includes("--self-test")) {
  const sources = Object.values(paths).map(source);
  const mutant = [...sources];
  mutant[3] = mutant[3].replace("readMode: \"snapshot-only\"", "readMode: \"read-through\"");
  let red = false;
  try {
    check(...mutant);
  } catch {
    red = true;
  }
  assert(red, "snapshot-only omission mutant was accepted");
  result.mutant = "red";
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
