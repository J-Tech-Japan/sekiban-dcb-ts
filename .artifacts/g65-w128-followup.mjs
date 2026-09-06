import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const inputPath = resolve(args.get("--input"));
const outputPath = resolve(args.get("--output"));
const baseUrl = args.get("--base-url").replace(/\/$/, "");
const boundMs = Number(args.get("--bound-ms") ?? "120000");
const pollMs = Number(args.get("--poll-ms") ?? "1000");
const pageSize = 1000;

function parseJson(raw) { try { return JSON.parse(raw); } catch { return { code: "non_json_response", raw }; } }
function persist(value) { mkdirSync(dirname(outputPath), { recursive: true }); writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
function sleep(ms) { return new Promise((resolveSleep) => setTimeout(resolveSleep, ms)); }
async function page(pageNumber) {
  const startedAtMs = Date.now();
  try {
    const response = await fetch(`${baseUrl}/api/read/reservations?pageNumber=${pageNumber}&pageSize=${pageSize}&newestFirst=true`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
    const rawBody = await response.text();
    const receivedAtMs = Date.now();
    const body = parseJson(rawBody);
    const items = typeof body.itemsJson === "string" ? parseJson(body.itemsJson) : body.items;
    return { status: response.status, startedAtMs, receivedAtMs, responseMs: receivedAtMs - startedAtMs, rawBody, body, items: Array.isArray(items) ? items : [], pageNumber };
  } catch (error) {
    const receivedAtMs = Date.now();
    return { status: null, startedAtMs, receivedAtMs, responseMs: receivedAtMs - startedAtMs, rawBody: "", body: null, items: [], pageNumber, transportError: String(error) };
  }
}
async function scan(reservationId) {
  const pages = [];
  let planned = 1;
  for (let pageNumber = 1; pageNumber <= planned; pageNumber += 1) {
    const result = await page(pageNumber);
    pages.push(result);
    const total = Number(result.body?.totalCount);
    const declared = Number(result.body?.totalPages);
    planned = Math.max(planned, Number.isSafeInteger(declared) && declared > 0 ? declared : Number.isFinite(total) ? Math.max(1, Math.ceil(total / pageSize)) : 1);
  }
  const item = pages.flatMap((candidate) => candidate.items).find((candidate) => candidate?.reservationId === reservationId) ?? null;
  return { observedAtMs: Date.now(), pages, visible: item !== null, item };
}

const source = JSON.parse(readFileSync(inputPath, "utf8"));
const samples = source.reservations.map((sample) => ({ ordinal: sample.ordinal, reservationId: sample.reservationId, suid: sample.suid, commitReceivedAtMs: sample.commit.receivedAtMs, observations: [], firstVisibleAtMs: null }));
const report = { schema: "sdt-g65-w128-restored-queue-followup/v1", task: "SDT-G65-W128", sourceInput: inputPath, baseUrl, boundMs, pollMs, pageSize, samples, status: "running", startedAt: new Date().toISOString() };
persist(report);
for (const sample of report.samples) {
  const deadline = Date.now() + boundMs;
  while (Date.now() < deadline && sample.firstVisibleAtMs === null) {
    const observation = await scan(sample.reservationId);
    sample.observations.push(observation);
    if (observation.visible) sample.firstVisibleAtMs = observation.observedAtMs;
    persist(report);
    if (sample.firstVisibleAtMs !== null) break;
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  sample.disposition = sample.firstVisibleAtMs === null ? "missing-after-restore" : "visible-after-restore";
  sample.commitToFirstVisibleMs = sample.firstVisibleAtMs === null ? null : sample.firstVisibleAtMs - sample.commitReceivedAtMs;
  persist(report);
}
report.status = "completed";
report.finishedAt = new Date().toISOString();
persist(report);
process.stdout.write(JSON.stringify({ status: report.status, samples: report.samples.map(({ ordinal, reservationId, firstVisibleAtMs, disposition, commitToFirstVisibleMs }) => ({ ordinal, reservationId, firstVisibleAtMs, disposition, commitToFirstVisibleMs })) }) + "\n");
