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

async function requestJson(baseUrl, path, init = {}) {
  const root = baseUrl.replace(/\/$/, "");
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-cache");
  const response = await fetch(`${root}${path}`, { ...init, cache: "no-store", headers });
  const raw = await response.text();
  let body;
  try { body = raw.length === 0 ? {} : JSON.parse(raw); } catch { body = { raw }; }
  return { status: response.status, body, raw };
}

async function readConformance(baseUrl, token) {
  for (const path of ["/conformance/v1/g29-config", "/conformance/v1/g26-config"]) {
    const result = await requestJson(baseUrl, `${path}?g29_witness=${crypto.randomUUID()}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (result.status === 200 && result.body !== null && typeof result.body === "object" && !Array.isArray(result.body)) return { endpoint: path, body: result.body };
  }
  throw new Error("authenticated G29/G26 conformance witness failed");
}

function parseItems(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("G29 reservation list body is invalid");
  if (!Object.prototype.hasOwnProperty.call(body, "itemsJson") && !Object.prototype.hasOwnProperty.call(body, "items")) {
    throw new Error("G29 reservation list items are missing");
  }
  let items = body.itemsJson ?? body.items;
  if (typeof items === "string") {
    try { items = JSON.parse(items); } catch { throw new Error("G29 reservation list itemsJson is invalid"); }
  }
  if (!Array.isArray(items)) throw new Error("G29 reservation list items are invalid");
  return items;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseJson(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
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

function itemMap(items, field, label) {
  const result = new Map();
  for (const item of items) {
    const key = item?.[field];
    if (typeof key !== "string" || key.length === 0) throw new Error(`G29 ${label} item has no ${field}`);
    if (result.has(key)) throw new Error(`G29 ${label} has duplicate ${field}: ${key}`);
    result.set(key, item);
  }
  return result;
}

function omitAggregateCounts(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "count" && key !== "totalCount" && key !== "totalPages"));
}

function listQuerySemanticValue(data) {
  const body = data?.listQuery?.body;
  if (body === null || typeof body !== "object") throw new Error("G29 pre-witness list query body is missing");
  const value = Object.prototype.hasOwnProperty.call(body, "resultJson") ? parseJson(body.resultJson) : body;
  return { status: data.listQuery?.status, body: omitAggregateCounts(value) };
}

function selectedRows(data, name, key) {
  const rows = data?.[name];
  if (!Array.isArray(rows)) throw new Error(`G29 pre-witness ${name} is missing`);
  return itemMap(rows, key, name);
}

function assertSubset(pre, post, label) {
  for (const [id, before] of pre) {
    const after = post.get(id);
    if (after === undefined) throw new Error(`G29 pre-witness ${label} missing ${id}`);
    if (!equalSemantically(before, after)) throw new Error(`G29 pre-witness ${label} changed ${id}`);
  }
}

export function observedDataCounts(data) {
  const query = parseJson(data?.listQuery?.body?.resultJson);
  const roomQuery = typeof query?.count === "number" ? query.count : null;
  const reservations = typeof data?.reservationList?.body?.totalCount === "number" ? data.reservationList.body.totalCount : null;
  return { roomQuery, reservations };
}

export function assertPreWitnessSetPreserved(before, after) {
  if (before?.reservationList?.status !== 200 || after?.reservationList?.status !== 200) throw new Error("G29 pre-witness reservation list status changed");
  const beforeItems = itemMap(parseItems(before?.reservationList?.body), "reservationId", "reservation list");
  const afterItems = itemMap(parseItems(after?.reservationList?.body), "reservationId", "reservation list");
  if (!equalSemantically(listQuerySemanticValue(before), listQuerySemanticValue(after))) throw new Error("G29 pre-witness list query changed outside aggregate counts");
  assertSubset(beforeItems, afterItems, "reservation list");
  const beforeRooms = selectedRows(before, "knownRooms", "roomId");
  const afterRooms = selectedRows(after, "knownRooms", "roomId");
  assertSubset(beforeRooms, afterRooms, "known room");
  const beforeReservations = selectedRows(before, "knownReservations", "reservationId");
  const afterReservations = selectedRows(after, "knownReservations", "reservationId");
  assertSubset(beforeReservations, afterReservations, "known reservation");
  if (before?.eventHeads === null || typeof before?.eventHeads !== "object" || Array.isArray(before.eventHeads) || after?.eventHeads === null || typeof after?.eventHeads !== "object" || Array.isArray(after.eventHeads)) {
    throw new Error("G29 pre-witness event heads are invalid");
  }
  if (!equalSemantically(before?.eventHeads, Object.fromEntries(Object.entries(after?.eventHeads ?? {}).filter(([key]) => Object.prototype.hasOwnProperty.call(before?.eventHeads ?? {}, key))))) {
    throw new Error("G29 pre-witness event heads changed");
  }
  const preSet = {
    listQuery: listQuerySemanticValue(before),
    reservationItems: [...beforeItems.entries()].sort(([left], [right]) => left.localeCompare(right)),
    knownRooms: [...beforeRooms.entries()].sort(([left], [right]) => left.localeCompare(right)),
    knownReservations: [...beforeReservations.entries()].sort(([left], [right]) => left.localeCompare(right)),
    eventHeads: before?.eventHeads,
  };
  const counts = { before: observedDataCounts(before), after: observedDataCounts(after) };
  return {
    stable: true,
    rule: "pre-captured rows, heads, and list entries are a required preserved subset; aggregate counts are observed but not an equality gate",
    preSetDigest: digest(canonical(preSet)),
    preserved: {
      reservationListEntries: beforeItems.size,
      knownRooms: beforeRooms.size,
      knownReservations: beforeReservations.size,
    },
    counts,
    countDelta: {
      roomQuery: counts.before.roomQuery === null || counts.after.roomQuery === null ? null : counts.after.roomQuery - counts.before.roomQuery,
      reservations: counts.before.reservations === null || counts.after.reservations === null ? null : counts.after.reservations - counts.before.reservations,
    },
  };
}

async function captureDataWitness(baseUrl) {
  const roomQuery = await requestJson(baseUrl, `/api/read/room-query?g29_witness=${crypto.randomUUID()}`);
  const reservationList = await requestJson(baseUrl, `/api/read/reservations?pageNumber=1&pageSize=100&g29_witness=${crypto.randomUUID()}`);
  if (roomQuery.status !== 200 || reservationList.status !== 200) throw new Error(`G29 data witness query failed: room=${roomQuery.status} reservations=${reservationList.status}`);
  const reservationItems = parseItems(reservationList.body);
  const roomIds = [...new Set(reservationItems.map((item) => item?.roomId).filter((value) => typeof value === "string" && value.length > 0))].slice(0, 5);
  const reservationIds = reservationItems.map((item) => item?.reservationId).filter((value) => typeof value === "string" && value.length > 0).slice(0, 5);
  const [rooms, reservations] = await Promise.all([
    Promise.all(roomIds.map(async (roomId) => ({ roomId, response: await requestJson(baseUrl, `/api/read/room?roomId=${encodeURIComponent(roomId)}&g29_witness=${crypto.randomUUID()}`) }))),
    Promise.all(reservationIds.map(async (reservationId) => ({ reservationId, response: await requestJson(baseUrl, `/api/read/reservation?reservationId=${encodeURIComponent(reservationId)}&g29_witness=${crypto.randomUUID()}`) }))),
  ]);
  const witness = {
    listQuery: { status: roomQuery.status, body: roomQuery.body },
    reservationList: { status: reservationList.status, body: reservationList.body },
    knownRooms: rooms.map(({ roomId, response }) => ({ roomId, status: response.status, body: response.body })),
    knownReservations: reservations.map(({ reservationId, response }) => ({ reservationId, status: response.status, body: response.body })),
    eventHeads: {
      rooms: Object.fromEntries(rooms.map(({ roomId, response }) => [roomId, response.body?.lastSortedUniqueId ?? null])),
      reservations: Object.fromEntries(reservations.map(({ reservationId, response }) => [reservationId, response.body?.lastSortedUniqueId ?? null])),
    },
  };
  return { ...witness, digest: digest(witness) };
}

async function captureRawV1Witness(baseUrl) {
  const result = await requestJson(baseUrl, "/api/sekiban/serialized?g29_witness=raw-v1");
  return { status: result.status };
}

export async function captureWitness(baseUrl, token, expected) {
  const captured = await readConformance(baseUrl, token);
  const body = captured.body;
  const requiredTopologyFields = ["worker", "serviceId", "pipelineDatabaseId", "materializedViewDatabaseId", "queue", "generation"];
  const identityVerified = captured.endpoint === "/conformance/v1/g29-config" && requiredTopologyFields.every((field) => typeof body[field] === "string" && body[field].length > 0);
  const data = await captureDataWitness(baseUrl);
  const rawV1 = await captureRawV1Witness(baseUrl);
  if (rawV1.status !== 404) throw new Error(`G29 raw V1 public surface expected 404, got ${rawV1.status}`);
  return Object.freeze({
    capturedAt: new Date().toISOString(),
    endpoint: captured.endpoint,
    identitySource: identityVerified ? "remote-g29-conformance" : "legacy-g26-conformance-fallback",
    identityVerified,
    worker: body.worker ?? expected.worker,
    sourceCommit: typeof body.sourceCommit === "string" ? body.sourceCommit : null,
    serviceId: body.serviceId ?? expected.serviceId,
    viewCount: body.viewCount,
    allowedViews: Array.isArray(body.allowedViews) ? body.allowedViews : [],
    domainDeliveryClass: body.domainDeliveryClass,
    resolvedDeliveryClass: body.resolvedDeliveryClass,
    domainViewDeliveryClasses: body.domainViewDeliveryClasses ?? expected.domainViewDeliveryClasses,
    directDoorbell: body.directDoorbell,
    receiverMode: body.receiverMode,
    degradation: body.degradation,
    maxServiceBindingInvocations: body.maxServiceBindingInvocations,
    pipelineDatabaseId: body.pipelineDatabaseId ?? expected.pipelineDatabaseId,
    materializedViewDatabaseId: body.materializedViewDatabaseId ?? expected.materializedViewDatabaseId,
    queue: body.queue ?? expected.queue,
    generation: body.generation ?? expected.generation,
    data,
    rawV1,
  });
}

function isVerifiedG29Witness(witness) {
  return witness?.identityVerified === true &&
    witness?.endpoint === "/conformance/v1/g29-config" &&
    witness?.identitySource === "remote-g29-conformance";
}

function isLegacyG26Witness(witness) {
  return witness?.identityVerified === false &&
    witness?.endpoint === "/conformance/v1/g26-config" &&
    witness?.identitySource === "legacy-g26-conformance-fallback";
}

function legacyG26Expected(expected) {
  return {
    ...expected,
    allowedViews: ["RoomProjector"],
    domainViewDeliveryClasses: { RoomProjector: "immediate-preferred", ReservationProjector: "queued" },
  };
}

function assertExpectedFields(witness, expected, phase) {
  for (const [field, value] of Object.entries(expected)) {
    if (JSON.stringify(witness[field]) !== JSON.stringify(value)) throw new Error(`G29 ${phase} witness identity/topology mismatch at ${field}`);
  }
}

export function assertCaptureWitnessProfile(witness, expected, allowLegacyG26Fallback = false) {
  if (isVerifiedG29Witness(witness)) {
    assertExpectedFields(witness, expected, "capture");
    return Object.freeze({ profile: "g29", identitySource: witness.identitySource });
  }
  if (allowLegacyG26Fallback && isLegacyG26Witness(witness)) {
    assertExpectedFields(witness, legacyG26Expected(expected), "legacy pre-capture");
    return Object.freeze({ profile: "legacy-g26", identitySource: witness.identitySource });
  }
  throw new Error("G29 witness requires /conformance/v1/g29-config unless the pre-witness explicitly permits the authenticated G26 fallback");
}

export function assertWitnessStable(before, after, expected, beforeExpected = expected) {
  // A pre-deploy C3 Worker exposes only the authenticated G26 topology
  // endpoint. Its declared C3 delivery profile is the sole permitted legacy
  // shape; a full G29 pre-witness instead uses the final profile directly.
  assertExpectedFields(before, isLegacyG26Witness(before) ? beforeExpected : expected, "before");
  assertExpectedFields(after, expected, "after");
  if (!isVerifiedG29Witness(after) || (!isVerifiedG29Witness(before) && !isLegacyG26Witness(before))) throw new Error("G29 witness did not verify the permitted pre/post topology endpoints");
  if (before.worker !== after.worker || before.serviceId !== after.serviceId || before.pipelineDatabaseId !== after.pipelineDatabaseId || before.materializedViewDatabaseId !== after.materializedViewDatabaseId || before.queue !== after.queue || before.generation !== after.generation) {
    throw new Error("G29 witness detected a namespace, service, queue, or generation change");
  }
  if (before.rawV1?.status !== 404 || after.rawV1?.status !== 404) throw new Error("G29 public V1 surface is not closed");
  const dataPreservation = assertPreWitnessSetPreserved(before.data, after.data);
  return { stable: true, fields: Object.keys(expected), dataPreservation };
}

export function assertFinalWitnessIdentity(sourceCommit, pre, post) {
  if (typeof sourceCommit !== "string" || sourceCommit.length === 0) throw new Error("G29 final witness source commit is required");
  if (!isVerifiedG29Witness(post)) throw new Error("G29 final post-witness did not verify the G29 topology endpoint");
  if (!isVerifiedG29Witness(pre) && !isLegacyG26Witness(pre)) throw new Error("G29 final pre-witness did not verify an allowed topology endpoint");
  if (post.sourceCommit !== sourceCommit) throw new Error(`G29 deployed runtime sourceCommit mismatch: expected ${sourceCommit}, observed ${String(post.sourceCommit)}`);
  return Object.freeze({ preIdentitySource: pre.identitySource, postSourceCommit: post.sourceCommit, match: true });
}

export function assertSourceCommit(witness, sourceCommit) {
  if (typeof sourceCommit !== "string" || sourceCommit.length === 0) throw new Error("G29 source commit assertion requires a non-empty commit");
  if (witness?.sourceCommit !== sourceCommit) throw new Error(`G29 deployed runtime sourceCommit mismatch: expected ${sourceCommit}, observed ${String(witness?.sourceCommit)}`);
  return { sourceCommit, match: true };
}

async function main() {
  const mode = argument("--mode", "capture");
  const output = argument("--output", ".artifacts/g29-witness.json");
  if (mode === "compare") {
    const before = JSON.parse(readFileSync(required("--before", argument("--before")), "utf8"));
    const after = JSON.parse(readFileSync(required("--after", argument("--after")), "utf8"));
    const expected = JSON.parse(readFileSync(required("--expected", argument("--expected")), "utf8"));
    const beforeExpectedPath = argument("--before-expected", undefined);
    const beforeExpected = beforeExpectedPath === undefined ? expected : JSON.parse(readFileSync(beforeExpectedPath, "utf8"));
    const sourceCommit = argument("--source-commit", undefined);
    const stable = assertWitnessStable(before, after, expected, beforeExpected);
    const source = sourceCommit === undefined ? { sourceCommit: after.sourceCommit ?? null, sourceCommitChecked: false } : assertSourceCommit(after, sourceCommit);
    console.log(JSON.stringify({ ...stable, ...source }, null, 2));
    return;
  }
  if (mode === "assert-source") {
    const witness = JSON.parse(readFileSync(required("--witness", argument("--witness")), "utf8"));
    console.log(JSON.stringify(assertSourceCommit(witness, required("--source-commit", argument("--source-commit"))), null, 2));
    return;
  }
  const tokenFile = required("--token-file", argument("--token-file", process.env.G29_CONFORMANCE_TOKEN_FILE));
  const token = readFileSync(tokenFile, "utf8").trim();
  const allowLegacyG26Fallback = process.argv.includes("--allow-legacy-g26-fallback");
  const expected = {
    worker: required("--worker", argument("--worker", "sekiban-dcb-meeting-room-cloudflare-only")),
    serviceId: required("--service-id", argument("--service-id", process.env.G29_SERVICE_ID)),
    viewCount: 2,
    allowedViews: ["RoomProjector", "ReservationProjector"],
    domainDeliveryClass: "immediate-preferred",
    resolvedDeliveryClass: "immediate-preferred",
    domainViewDeliveryClasses: { RoomProjector: "immediate-preferred", ReservationProjector: "immediate-preferred" },
    directDoorbell: true,
    receiverMode: "separate",
    degradation: "queued-degraded",
    maxServiceBindingInvocations: 32,
    pipelineDatabaseId: "3c3b1641-7969-4d72-97a9-2ea65085c9bb",
    materializedViewDatabaseId: "5db45136-f1dd-4f4d-bfe3-b6328193a1ac",
    queue: "sekiban-dcb-meeting-room-cloudflare-outbox",
    generation: "v2",
  };
  const witness = await captureWitness(required("--base-url", argument("--base-url", process.env.G29_BASE_URL)), token, expected);
  assertCaptureWitnessProfile(witness, expected, allowLegacyG26Fallback);
  writeFileSync(output, `${JSON.stringify(witness, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(witness, null, 2));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
