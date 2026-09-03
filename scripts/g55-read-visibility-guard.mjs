import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

function requireContains(value, expected, label) {
  if (!value.includes(expected)) throw new Error(`SDT-G55 ${label} is missing ${JSON.stringify(expected)}`);
}

export function assertG55ReadVisibilityContract(value) {
  requireContains(value.queryWorker, 'const consistency = value.consistency ?? "safe";', "safe selector default");
  requireContains(value.queryWorker, 'consistency: requestedPage.consistency', "explicit list consistency forwarding");
  requireContains(value.queryWorker, 'return resultResponse(endpoint, entries, requestedPage, page.totalCount, true, page.readHead);', "additive list readHead response");
  requireContains(value.mv, 'options.consistency === "unsafe"', "unsafe-only D1 overlay");
  requireContains(value.mv, 'source_suid COLLATE BINARY > ? COLLATE BINARY', "unsafe watermark fence");
  requireContains(value.mv, 'readHead: options.consistency === "unsafe" ? maxReflectedSuid(rows) : active.lastSuid', "safe versus reflected head rule");
  requireContains(value.sampleWorker, 'consistency: "unsafe"', "deployed sample unsafe list opt-in");
  requireContains(value.localWorker, 'consistency: "unsafe"', "local sample unsafe list opt-in");
  requireContains(value.app, 'setStatus(`Committed (${suid})`, "success")', "immediate committed status");
  requireContains(value.app, 'caught up to ${commitSuid}', "separate list catch-up state");
  requireContains(value.fixture, 'keeps the default list safe, opts into the unsafe overlay', "D1 safe/unsafe red-green fixture");
  requireContains(value.fixture, 'maps a fake D1 active watermark', "fake-D1 readHead fixture");
}

async function snapshot() {
  const [queryWorker, mv, sampleWorker, localWorker, app, fixture] = await Promise.all([
    source("packages/dcb-runtime/src/http/SerializedQueryWorker.ts"),
    source("packages/dcb-runtime/src/mv/MaterializedViewStore.ts"),
    source("samples/meeting-room/src/worker.cloudflare-only.ts"),
    source("samples/meeting-room/src/worker.ts"),
    source("samples/meeting-room/public/app.js"),
    source("test/g55-read-visibility.spec.ts"),
  ]);
  return { queryWorker, mv, sampleWorker, localWorker, app, fixture };
}

function expectRed(value, mutate, label) {
  const candidate = { ...value };
  mutate(candidate);
  try {
    assertG55ReadVisibilityContract(candidate);
  } catch {
    return;
  }
  throw new Error(`SDT-G55 mutation unexpectedly passed: ${label}`);
}

const value = await snapshot();
assertG55ReadVisibilityContract(value);
if (process.argv.includes("--self-test")) {
  expectRed(value, (candidate) => { candidate.queryWorker = candidate.queryWorker.replace('const consistency = value.consistency ?? "safe";', 'const consistency = "unsafe";'); }, "default list becomes unsafe");
  expectRed(value, (candidate) => { candidate.mv = candidate.mv.replace('source_suid COLLATE BINARY > ? COLLATE BINARY', 'source_suid COLLATE BINARY >= ? COLLATE BINARY'); }, "unsafe row can override the safe watermark");
  expectRed(value, (candidate) => { candidate.sampleWorker = candidate.sampleWorker.replace('consistency: "unsafe"', 'consistency: "safe"'); }, "sample loses unsafe opt-in");
  expectRed(value, (candidate) => { candidate.app = candidate.app.replace('setStatus(`Committed (${suid})`, "success")', 'setStatus("Sending…", "pending")'); }, "UI keeps claiming sending after commit");
  process.stdout.write(`${JSON.stringify({ selfTest: "g55-read-visibility-mutations-red" })}\n`);
}
process.stdout.write(`${JSON.stringify({ guard: "g55-read-visibility", status: "pass" })}\n`);
