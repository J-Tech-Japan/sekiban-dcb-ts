#!/usr/bin/env node
/** Ensures G42's authenticated primary probe never leaks into G38 surfaces. */
import { readFileSync } from "node:fs";

const PATH_LITERAL = "/conformance/v1/g42/journal-first-touch";
const PRIMARY = "samples/meeting-room/src/worker.cloudflare-only.ts";
const FORBIDDEN = Object.freeze([
  "samples/meeting-room/src/worker.g38-receiver.ts",
  "samples/meeting-room/src/worker.g38-tombstone.ts",
  "samples/meeting-room/src/worker.cloudflare-receiver-support.ts",
  "samples/meeting-room/wrangler.g38-receiver.jsonc",
  "samples/meeting-room/wrangler.g38-old-receiver-tombstone.jsonc",
]);

function fail(message) {
  throw new Error(`g42-surface:${message}`);
}

export function assertG42Surface(read = (path) => readFileSync(path, "utf8")) {
  const primary = read(PRIMARY);
  if (!primary.includes("G42_JOURNAL_PROBE_PATH") || !primary.includes("g42ProbeRouteInput")) {
    fail("primary Worker does not own the exact G42 conformance route");
  }
  for (const path of FORBIDDEN) {
    const content = read(path);
    if (content.includes("G42_JOURNAL_PROBE") || content.includes(PATH_LITERAL) || content.includes("g42Probe")) {
      fail(`${path} exposes a G42 probe route or binding`);
    }
  }
  return Object.freeze({ primary: PRIMARY, absentFrom: FORBIDDEN });
}

export function selfTest() {
  const files = new Map([PRIMARY, ...FORBIDDEN].map((path) => [path, readFileSync(path, "utf8")]));
  assertG42Surface((path) => files.get(path));
  files.set(FORBIDDEN[0], `${files.get(FORBIDDEN[0])}\n${PATH_LITERAL}`);
  let forcedRed = false;
  try {
    assertG42Surface((path) => files.get(path));
  } catch {
    forcedRed = true;
  }
  if (!forcedRed) fail("receiver exposure mutation unexpectedly passed");
  return Object.freeze({ forcedRed: "receiver-path-exposure", absentFileCount: FORBIDDEN.length });
}

if (process.argv.includes("--self-test")) {
  console.log(JSON.stringify(selfTest(), null, 2));
} else {
  console.log(JSON.stringify(assertG42Surface(), null, 2));
}
