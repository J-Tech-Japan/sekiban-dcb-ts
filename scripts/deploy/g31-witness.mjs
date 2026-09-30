#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function required(name, value) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name, value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function nonNegativeInteger(name, value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

async function requestJson(baseUrl, path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-cache");
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, { ...init, cache: "no-store", headers });
  const raw = await response.text();
  let body;
  try { body = raw.length === 0 ? {} : JSON.parse(raw); } catch { body = { raw }; }
  return { status: response.status, body, raw };
}

export function shouldRetryConformanceStatus(status) {
  return status === 403 || status === 404;
}

async function readConformance(baseUrl, token, { attempts = 1, delayMs = 0 } = {}) {
  let lastStatus = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await requestJson(baseUrl, `/conformance/v1/g31-config?g31_witness=${crypto.randomUUID()}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (result.status === 200 && result.body !== null && typeof result.body === "object" && !Array.isArray(result.body)) {
      return { endpoint: "/conformance/v1/g31-config", body: result.body };
    }
    lastStatus = result.status;
    if (attempt < attempts && shouldRetryConformanceStatus(result.status)) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    break;
  }
  throw new Error(`authenticated G31 conformance witness failed (HTTP ${String(lastStatus)})`);
}

function parseItems(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("G31 reservation list body is invalid");
  if (!Object.hasOwn(body, "itemsJson") && !Object.hasOwn(body, "items")) throw new Error("G31 reservation list items are missing");
  let items = body.itemsJson ?? body.items;
  if (typeof items === "string") {
    try { items = JSON.parse(items); } catch { throw new Error("G31 reservation list itemsJson is invalid"); }
  }
  if (!Array.isArray(items)) throw new Error("G31 reservation list items are invalid");
  return items;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function equalSemantically(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function itemMap(items, field, label) {
  const result = new Map();
  for (const item of items) {
    const key = item?.[field];
    if (typeof key !== "string" || key.length === 0) throw new Error(`G31 ${label} item has no ${field}`);
    if (result.has(key)) throw new Error(`G31 ${label} has duplicate ${field}: ${key}`);
    result.set(key, item);
  }
  return result;
}

function selectedRows(data, name, key) {
  const rows = data?.[name];
  if (!Array.isArray(rows)) throw new Error(`G31 ${name} is missing`);
  return itemMap(rows, key, name);
}

function assertSubset(before, after, label) {
  for (const [id, value] of before) {
    const observed = after.get(id);
    if (observed === undefined) throw new Error(`G31 pre-witness ${label} missing ${id}`);
    if (!equalSemantically(value, observed)) throw new Error(`G31 pre-witness ${label} changed ${id}`);
  }
}

function omitAggregateCounts(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "count" && key !== "totalCount" && key !== "totalPages"));
}

function parseJson(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function roomQuerySemanticValue(data) {
  const body = data?.roomQuery?.body;
  if (body === null || typeof body !== "object") throw new Error("G31 pre-witness room query body is missing");
  return { status: data.roomQuery?.status, body: omitAggregateCounts(Object.hasOwn(body, "resultJson") ? parseJson(body.resultJson) : body) };
}

export function observedDataCounts(data) {
  const room = parseJson(data?.roomQuery?.body?.resultJson);
  const reservations = typeof data?.reservationList?.body?.totalCount === "number" ? data.reservationList.body.totalCount : null;
  return { roomQuery: typeof room?.count === "number" ? room.count : null, reservations };
}

/** The deployment gate preserves every entry sampled before deploy, not an unstable global total. */
export function assertPreWitnessSetPreserved(before, after) {
  if (before?.reservationList?.status !== 200 || after?.reservationList?.status !== 200) throw new Error("G31 pre-witness reservation list status changed");
  if (!equalSemantically(roomQuerySemanticValue(before), roomQuerySemanticValue(after))) throw new Error("G31 pre-witness room query changed outside aggregate counts");
  const beforeItems = itemMap(parseItems(before.reservationList.body), "reservationId", "reservation list");
  const afterItems = itemMap(parseItems(after.reservationList.body), "reservationId", "reservation list");
  assertSubset(beforeItems, afterItems, "reservation list");
  const beforeRooms = selectedRows(before, "knownRooms", "roomId");
  const afterRooms = selectedRows(after, "knownRooms", "roomId");
  assertSubset(beforeRooms, afterRooms, "known room");
  const beforeReservations = selectedRows(before, "knownReservations", "reservationId");
  const afterReservations = selectedRows(after, "knownReservations", "reservationId");
  assertSubset(beforeReservations, afterReservations, "known reservation");
  if (before?.eventHeads === null || typeof before?.eventHeads !== "object" || Array.isArray(before.eventHeads)) throw new Error("G31 pre-witness event heads are invalid");
  if (after?.eventHeads === null || typeof after?.eventHeads !== "object" || Array.isArray(after.eventHeads)) throw new Error("G31 post-witness event heads are invalid");
  const projectedAfterHeads = Object.fromEntries(Object.entries(after.eventHeads).filter(([key]) => Object.hasOwn(before.eventHeads, key)));
  if (!equalSemantically(before.eventHeads, projectedAfterHeads)) throw new Error("G31 pre-witness event heads changed");
  const beforeCounts = observedDataCounts(before);
  const afterCounts = observedDataCounts(after);
  return {
    stable: true,
    rule: "pre-captured rows, heads, and list entries are a required preserved subset; aggregate counts are observed but not an equality gate",
    preSetDigest: digest({
      roomQuery: roomQuerySemanticValue(before),
      reservationItems: [...beforeItems.entries()].sort(([left], [right]) => left.localeCompare(right)),
      knownRooms: [...beforeRooms.entries()].sort(([left], [right]) => left.localeCompare(right)),
      knownReservations: [...beforeReservations.entries()].sort(([left], [right]) => left.localeCompare(right)),
      eventHeads: before.eventHeads,
    }),
    preserved: { reservationListEntries: beforeItems.size, knownRooms: beforeRooms.size, knownReservations: beforeReservations.size },
    counts: { before: beforeCounts, after: afterCounts },
    countDelta: {
      roomQuery: beforeCounts.roomQuery === null || afterCounts.roomQuery === null ? null : afterCounts.roomQuery - beforeCounts.roomQuery,
      reservations: beforeCounts.reservations === null || afterCounts.reservations === null ? null : afterCounts.reservations - beforeCounts.reservations,
    },
  };
}

async function captureDataWitness(baseUrl) {
  const roomQuery = await requestJson(baseUrl, `/api/read/room-query?g31_witness=${crypto.randomUUID()}`);
  // Deployment witness rows must use the stable historical ordering. `newestFirst`
  // is itself a G31 behavior change, so using it here would turn an intended
  // ordering change into a false data-preservation failure between pre and post.
  const reservationList = await requestJson(baseUrl, `/api/read/reservations?pageNumber=1&pageSize=100&newestFirst=false&g31_witness=${crypto.randomUUID()}`);
  if (roomQuery.status !== 200 || reservationList.status !== 200) throw new Error(`G31 data witness query failed: room=${roomQuery.status} reservations=${reservationList.status}`);
  const reservations = parseItems(reservationList.body);
  const roomIds = [...new Set(reservations.map((item) => item?.roomId).filter((value) => typeof value === "string" && value.length > 0))].slice(0, 5);
  const reservationIds = reservations.map((item) => item?.reservationId).filter((value) => typeof value === "string" && value.length > 0).slice(0, 5);
  const [rooms, reservationRows] = await Promise.all([
    Promise.all(roomIds.map(async (roomId) => ({ roomId, response: await requestJson(baseUrl, `/api/read/room?roomId=${encodeURIComponent(roomId)}&g31_witness=${crypto.randomUUID()}`) }))),
    Promise.all(reservationIds.map(async (reservationId) => ({ reservationId, response: await requestJson(baseUrl, `/api/read/reservation?reservationId=${encodeURIComponent(reservationId)}&g31_witness=${crypto.randomUUID()}`) }))),
  ]);
  const witness = {
    roomQuery: { status: roomQuery.status, body: roomQuery.body },
    reservationList: { status: reservationList.status, body: reservationList.body },
    knownRooms: rooms.map(({ roomId, response }) => ({ roomId, status: response.status, body: response.body })),
    knownReservations: reservationRows.map(({ reservationId, response }) => ({ reservationId, status: response.status, body: response.body })),
    eventHeads: {
      rooms: Object.fromEntries(rooms.map(({ roomId, response }) => [roomId, response.body?.lastSortedUniqueId ?? null])),
      reservations: Object.fromEntries(reservationRows.map(({ reservationId, response }) => [reservationId, response.body?.lastSortedUniqueId ?? null])),
    },
  };
  return { ...witness, digest: digest(witness) };
}

async function captureRawV1Witness(baseUrl) {
  const result = await requestJson(baseUrl, "/api/sekiban/serialized?g31_witness=raw-v1");
  return { status: result.status };
}

export function expectedTopology(serviceId) {
  return {
    worker: "sekiban-dcb-meeting-room-cloudflare-only",
    serviceId,
    pipelineDatabaseId: "REPLACE_WITH_SAMPLE_DOORBELL_PIPELINE_D1_ID",
    materializedViewDatabaseId: "REPLACE_WITH_SAMPLE_DOORBELL_MV_D1_ID",
    queue: "sekiban-dcb-meeting-room-cloudflare-outbox",
    generation: "v2",
    waitFor: {
      sourceTarget: "unique-indexed-point-read",
      activeReceipt: "generation-definition-bound",
      safeHead: "unique-source-required",
      maxPointReads: 254,
    },
    directDoorbell: true,
    allowedViews: ["RoomProjector", "ReservationProjector"],
  };
}

function expectedFields(witness, expected, phase) {
  for (const [field, value] of Object.entries(expected)) {
    if (JSON.stringify(witness[field]) !== JSON.stringify(value)) throw new Error(`G31 ${phase} witness identity/topology mismatch at ${field}`);
  }
}

function isPublicPreWitness(witness) {
  return witness?.identityVerified === false && witness?.identitySource === "public-pre-deploy-data" && witness?.endpoint === null;
}

function isVerifiedWitness(witness) {
  return witness?.identityVerified === true && witness?.identitySource === "remote-g31-conformance" && witness?.endpoint === "/conformance/v1/g31-config";
}

export async function captureWitness(baseUrl, token, expected, retry = {}) {
  const captured = await readConformance(baseUrl, token, retry);
  const body = captured.body;
  const data = await captureDataWitness(baseUrl);
  const rawV1 = await captureRawV1Witness(baseUrl);
  if (rawV1.status !== 404) throw new Error(`G31 raw V1 public surface expected 404, got ${rawV1.status}`);
  const witness = Object.freeze({
    capturedAt: new Date().toISOString(),
    endpoint: captured.endpoint,
    identitySource: "remote-g31-conformance",
    identityVerified: true,
    sourceCommit: typeof body.sourceCommit === "string" ? body.sourceCommit : null,
    worker: body.worker,
    serviceId: body.serviceId,
    pipelineDatabaseId: body.pipelineDatabaseId,
    materializedViewDatabaseId: body.materializedViewDatabaseId,
    queue: body.queue,
    generation: body.generation,
    waitFor: body.waitFor,
    directDoorbell: body.directDoorbell,
    allowedViews: body.allowedViews,
    data,
    rawV1,
  });
  expectedFields(witness, expected, "capture");
  return witness;
}

export async function capturePublicPreWitness(baseUrl) {
  const data = await captureDataWitness(baseUrl);
  const rawV1 = await captureRawV1Witness(baseUrl);
  if (rawV1.status !== 404) throw new Error(`G31 raw V1 public surface expected 404, got ${rawV1.status}`);
  return Object.freeze({
    capturedAt: new Date().toISOString(),
    endpoint: null,
    identitySource: "public-pre-deploy-data",
    identityVerified: false,
    sourceCommit: null,
    data,
    rawV1,
  });
}

export function assertWitnessStable(before, after, expected) {
  if (!isPublicPreWitness(before) && !isVerifiedWitness(before)) throw new Error("G31 pre-witness is not a permitted public or authenticated witness");
  if (!isVerifiedWitness(after)) throw new Error("G31 post-witness did not verify the G31 topology endpoint");
  if (!isPublicPreWitness(before)) expectedFields(before, expected, "before");
  expectedFields(after, expected, "after");
  if (before.rawV1?.status !== 404 || after.rawV1?.status !== 404) throw new Error("G31 public V1 surface is not closed");
  return { stable: true, fields: Object.keys(expected), dataPreservation: assertPreWitnessSetPreserved(before.data, after.data) };
}

export function assertSourceCommit(witness, sourceCommit) {
  if (typeof sourceCommit !== "string" || sourceCommit.length === 0) throw new Error("G31 source commit assertion requires a non-empty commit");
  if (witness?.sourceCommit !== sourceCommit) throw new Error(`G31 deployed runtime sourceCommit mismatch: expected ${sourceCommit}, observed ${String(witness?.sourceCommit)}`);
  return { sourceCommit, match: true };
}

export function assertFinalWitnessIdentity(sourceCommit, pre, post) {
  if (!isPublicPreWitness(pre) && !isVerifiedWitness(pre)) throw new Error("G31 final pre-witness is invalid");
  if (!isVerifiedWitness(post)) throw new Error("G31 final post-witness did not verify the G31 topology endpoint");
  assertSourceCommit(post, sourceCommit);
  return Object.freeze({ preIdentitySource: pre.identitySource, postSourceCommit: post.sourceCommit, match: true });
}

async function main() {
  const mode = argument("--mode", "capture");
  const output = argument("--output", ".artifacts/g31-witness.json");
  if (mode === "compare") {
    const before = JSON.parse(readFileSync(required("--before", argument("--before")), "utf8"));
    const after = JSON.parse(readFileSync(required("--after", argument("--after")), "utf8"));
    const expected = JSON.parse(readFileSync(required("--expected", argument("--expected")), "utf8"));
    const sourceCommit = argument("--source-commit", undefined);
    const stable = assertWitnessStable(before, after, expected);
    const source = sourceCommit === undefined ? { sourceCommit: after.sourceCommit ?? null, sourceCommitChecked: false } : assertSourceCommit(after, sourceCommit);
    console.log(JSON.stringify({ ...stable, ...source }, null, 2));
    return;
  }
  if (mode === "assert-source") {
    const witness = JSON.parse(readFileSync(required("--witness", argument("--witness")), "utf8"));
    console.log(JSON.stringify(assertSourceCommit(witness, required("--source-commit", argument("--source-commit"))), null, 2));
    return;
  }
  const baseUrl = required("--base-url", argument("--base-url", process.env.G31_BASE_URL));
  if (mode === "pre-deploy-public") {
    const witness = await capturePublicPreWitness(baseUrl);
    writeFileSync(output, `${JSON.stringify(witness, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(witness, null, 2));
    return;
  }
  const token = readFileSync(required("--token-file", argument("--token-file", process.env.G31_CONFORMANCE_TOKEN_FILE)), "utf8").trim();
  if (token.length === 0) throw new Error("G31 conformance token file is empty");
  const expected = expectedTopology(required("--service-id", argument("--service-id", process.env.G31_SERVICE_ID)));
  const witness = await captureWitness(baseUrl, token, expected, {
    attempts: positiveInteger("--conformance-retry-attempts", argument("--conformance-retry-attempts", "1"), 1),
    delayMs: nonNegativeInteger("--conformance-retry-delay-ms", argument("--conformance-retry-delay-ms", "0"), 0),
  });
  writeFileSync(output, `${JSON.stringify(witness, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(witness, null, 2));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
