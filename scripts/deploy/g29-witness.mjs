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
  let items = body?.itemsJson ?? body?.items;
  if (typeof items === "string") {
    try { items = JSON.parse(items); } catch { throw new Error("G29 reservation list itemsJson is invalid"); }
  }
  return Array.isArray(items) ? items : [];
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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

export function assertWitnessStable(before, after, expected) {
  for (const [field, value] of Object.entries(expected)) {
    if (JSON.stringify(before[field]) !== JSON.stringify(value) || JSON.stringify(after[field]) !== JSON.stringify(value)) throw new Error(`G29 witness identity/topology mismatch at ${field}`);
  }
  if (!before.identityVerified || !after.identityVerified) throw new Error("G29 witness did not verify the full G29 topology endpoint");
  if (before.worker !== after.worker || before.serviceId !== after.serviceId || before.pipelineDatabaseId !== after.pipelineDatabaseId || before.materializedViewDatabaseId !== after.materializedViewDatabaseId || before.queue !== after.queue || before.generation !== after.generation) {
    throw new Error("G29 witness detected a namespace, service, queue, or generation change");
  }
  if (before.rawV1?.status !== 404 || after.rawV1?.status !== 404) throw new Error("G29 public V1 surface is not closed");
  if (before.data?.digest !== after.data?.digest) throw new Error("G29 data witness changed across redeploy");
  return { stable: true, fields: Object.keys(expected), dataDigest: before.data.digest };
}

async function main() {
  const mode = argument("--mode", "capture");
  const output = argument("--output", ".artifacts/g29-witness.json");
  if (mode === "compare") {
    const before = JSON.parse(readFileSync(required("--before", argument("--before")), "utf8"));
    const after = JSON.parse(readFileSync(required("--after", argument("--after")), "utf8"));
    const expected = JSON.parse(readFileSync(required("--expected", argument("--expected")), "utf8"));
    console.log(JSON.stringify(assertWitnessStable(before, after, expected), null, 2));
    return;
  }
  const tokenFile = required("--token-file", argument("--token-file", process.env.G29_CONFORMANCE_TOKEN_FILE));
  const token = readFileSync(tokenFile, "utf8").trim();
  const expected = {
    worker: required("--worker", argument("--worker", "sekiban-dcb-meeting-room-cloudflare-only")),
    serviceId: required("--service-id", argument("--service-id", process.env.G29_SERVICE_ID)),
    viewCount: 2,
    allowedViews: ["RoomProjector"],
    domainDeliveryClass: "immediate-preferred",
    resolvedDeliveryClass: "immediate-preferred",
    domainViewDeliveryClasses: { RoomProjector: "immediate-preferred", ReservationProjector: "queued" },
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
  if (!witness.identityVerified) throw new Error("G29 live witness requires /conformance/v1/g29-config, not the legacy fallback");
  writeFileSync(output, `${JSON.stringify(witness, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(witness, null, 2));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
