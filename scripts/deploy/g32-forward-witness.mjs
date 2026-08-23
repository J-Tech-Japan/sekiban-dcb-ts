#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { assertG32Config } from "./g32-witness.mjs";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function required(name, value) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name, value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function nonNegativeInteger(name, value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
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

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function equal(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function parseJson(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function items(body) {
  const value = parseJson(body?.itemsJson ?? body?.items);
  if (!Array.isArray(value)) throw new Error("G32 reservation list is missing items");
  return value;
}

function mapBy(rows, key, label) {
  const map = new Map();
  for (const row of rows) {
    const value = row?.[key];
    if (typeof value !== "string" || value.length === 0) throw new Error(`G32 ${label} has no ${key}`);
    if (map.has(value)) throw new Error(`G32 ${label} duplicates ${key}: ${value}`);
    map.set(value, row);
  }
  return map;
}

function omitAggregateCounts(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["count", "totalCount", "totalPages", "pageNumber", "pageSize"].includes(key)));
}

function roomQuerySemantic(witness) {
  const body = witness?.roomQuery?.body;
  if (body === null || typeof body !== "object") throw new Error("G32 room-query witness is invalid");
  return { status: witness.roomQuery.status, body: omitAggregateCounts(parseJson(body.resultJson ?? body)) };
}

function observedCounts(data) {
  const room = parseJson(data?.roomQuery?.body?.resultJson);
  return {
    rooms: typeof room?.count === "number" ? room.count : null,
    reservations: typeof data?.reservationList?.totalCount === "number" ? data.reservationList.totalCount : null,
  };
}

function assertSubset(before, after, label) {
  for (const [key, value] of before) {
    const observed = after.get(key);
    if (observed === undefined) throw new Error(`G32 pre-witness ${label} missing ${key}`);
    if (!equal(value, observed)) throw new Error(`G32 pre-witness ${label} changed ${key}`);
  }
}

/** The C2 witness preserves the pre-captured set; it never relies on global counts being static. */
export function assertPreWitnessSetPreserved(before, after) {
  if (before?.reservationList?.status !== 200 || after?.reservationList?.status !== 200) throw new Error("G32 reservation list witness status changed");
  if (!equal(roomQuerySemantic(before), roomQuerySemantic(after))) throw new Error("G32 pre-witness room query changed outside aggregate counts");
  const beforeReservations = mapBy(items(before.reservationList.body), "reservationId", "reservation list");
  const afterReservations = mapBy(items(after.reservationList.body), "reservationId", "reservation list");
  assertSubset(beforeReservations, afterReservations, "reservation list");
  const beforeRooms = mapBy(before.knownRooms ?? [], "roomId", "known rooms");
  const afterRooms = mapBy(after.knownRooms ?? [], "roomId", "known rooms");
  assertSubset(beforeRooms, afterRooms, "known room");
  const beforeRows = mapBy(before.knownReservations ?? [], "reservationId", "known reservations");
  const afterRows = mapBy(after.knownReservations ?? [], "reservationId", "known reservations");
  assertSubset(beforeRows, afterRows, "known reservation");
  if (before?.eventHeads === null || typeof before?.eventHeads !== "object" || Array.isArray(before.eventHeads)) throw new Error("G32 pre-witness heads are invalid");
  if (after?.eventHeads === null || typeof after?.eventHeads !== "object" || Array.isArray(after.eventHeads)) throw new Error("G32 post-witness heads are invalid");
  const observedHeads = Object.fromEntries(Object.entries(after.eventHeads).filter(([key]) => Object.hasOwn(before.eventHeads, key)));
  if (!equal(before.eventHeads, observedHeads)) throw new Error("G32 pre-witness event heads changed");
  const beforeCounts = observedCounts(before);
  const afterCounts = observedCounts(after);
  return {
    stable: true,
    rule: "every pre-captured list row, detail row, and head is a required preserved subset; aggregate counts are observed but intentionally not an equality gate",
    preSetDigest: digest({
      roomQuery: roomQuerySemantic(before),
      reservations: [...beforeReservations.entries()].sort(([left], [right]) => left.localeCompare(right)),
      rooms: [...beforeRooms.entries()].sort(([left], [right]) => left.localeCompare(right)),
      reservationDetails: [...beforeRows.entries()].sort(([left], [right]) => left.localeCompare(right)),
      eventHeads: before.eventHeads,
    }),
    preserved: { reservationListEntries: beforeReservations.size, knownRooms: beforeRooms.size, knownReservations: beforeRows.size },
    counts: { before: beforeCounts, after: afterCounts },
    countDelta: {
      rooms: beforeCounts.rooms === null || afterCounts.rooms === null ? null : afterCounts.rooms - beforeCounts.rooms,
      reservations: beforeCounts.reservations === null || afterCounts.reservations === null ? null : afterCounts.reservations - beforeCounts.reservations,
    },
  };
}

async function reservationList(baseUrl) {
  const pageSize = 100;
  const first = await requestJson(baseUrl, `/api/read/reservations?pageNumber=1&pageSize=${pageSize}&newestFirst=false&g32_witness=${crypto.randomUUID()}`);
  if (first.status !== 200) throw new Error(`G32 reservation witness failed: ${first.status}`);
  const total = typeof first.body?.totalCount === "number" ? first.body.totalCount : items(first.body).length;
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("G32 reservation witness totalCount is invalid");
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages > 100) throw new Error("G32 reservation witness refuses an unbounded page scan");
  const all = [...items(first.body)];
  for (let page = 2; page <= pages; page += 1) {
    const next = await requestJson(baseUrl, `/api/read/reservations?pageNumber=${page}&pageSize=${pageSize}&newestFirst=false&g32_witness=${crypto.randomUUID()}`);
    if (next.status !== 200) throw new Error(`G32 reservation witness page ${page} failed: ${next.status}`);
    all.push(...items(next.body));
  }
  if (all.length !== total) throw new Error(`G32 reservation witness is incomplete: expected ${total}, captured ${all.length}`);
  return { status: first.status, body: { ...first.body, items: all, itemsJson: undefined, pageNumber: 1, pageSize: total, totalCount: total }, totalCount: total };
}

export async function captureDataWitness(baseUrl) {
  const [roomQuery, list] = await Promise.all([
    requestJson(baseUrl, `/api/read/room-query?g32_witness=${crypto.randomUUID()}`),
    reservationList(baseUrl),
  ]);
  if (roomQuery.status !== 200) throw new Error(`G32 room-query witness failed: ${roomQuery.status}`);
  const rows = items(list.body);
  const roomIds = [...new Set(rows.map((row) => row?.roomId).filter((value) => typeof value === "string" && value.length > 0))];
  const reservationIds = rows.map((row) => row?.reservationId).filter((value) => typeof value === "string" && value.length > 0);
  const [knownRooms, knownReservations] = await Promise.all([
    Promise.all(roomIds.map(async (roomId) => {
      const response = await requestJson(baseUrl, `/api/read/room?roomId=${encodeURIComponent(roomId)}&g32_witness=${crypto.randomUUID()}`);
      if (response.status !== 200) throw new Error(`G32 room detail witness failed for ${roomId}: ${response.status}`);
      return { roomId, status: response.status, body: response.body };
    })),
    Promise.all(reservationIds.map(async (reservationId) => {
      const response = await requestJson(baseUrl, `/api/read/reservation?reservationId=${encodeURIComponent(reservationId)}&g32_witness=${crypto.randomUUID()}`);
      if (response.status !== 200) throw new Error(`G32 reservation detail witness failed for ${reservationId}: ${response.status}`);
      return { reservationId, status: response.status, body: response.body };
    })),
  ]);
  const data = {
    roomQuery: { status: roomQuery.status, body: roomQuery.body },
    reservationList: list,
    knownRooms,
    knownReservations,
    eventHeads: {
      rooms: Object.fromEntries(knownRooms.map((row) => [row.roomId, row.body?.lastSortedUniqueId ?? null])),
      reservations: Object.fromEntries(knownReservations.map((row) => [row.reservationId, row.body?.lastSortedUniqueId ?? null])),
    },
  };
  return { ...data, digest: digest(data) };
}

async function captureRawV1(baseUrl) {
  const raw = await requestJson(baseUrl, `/api/sekiban/serialized?g32_witness=${crypto.randomUUID()}`);
  if (raw.status !== 404) throw new Error(`G32 raw V1 endpoint must be 404, got ${raw.status}`);
  return { status: raw.status, body: raw.body };
}

export async function capturePublicPreWitness(baseUrl) {
  const [data, rawV1] = await Promise.all([captureDataWitness(baseUrl), captureRawV1(baseUrl)]);
  return {
    task: "SDT-G32",
    phase: "c2-pre-forward-deploy-public",
    capturedAt: new Date().toISOString(),
    identityVerified: false,
    identitySource: "public-pre-deploy-data",
    sourceCommit: null,
    data,
    rawV1,
  };
}

async function retryConformance(work, { attempts, delayMs }) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await work();
    if (last.status === 200) return last;
    if (attempt < attempts && (last.status === 403 || last.status === 404)) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    } else break;
  }
  throw new Error(`G32 forward conformance endpoint failed: HTTP ${last?.status ?? "unknown"}`);
}

export async function capturePostWitness({ contract, baseUrl, receiverBaseUrl, token, sourceCommit, configDigest, retry }) {
  const auth = { headers: { authorization: `Bearer ${token}` } };
  const [primary, receiver] = await Promise.all([
    retryConformance(() => requestJson(baseUrl, `/conformance/v1/g32-config?g32_witness=${crypto.randomUUID()}`, auth), retry),
    retryConformance(() => requestJson(receiverBaseUrl, `/conformance/v1/g32-config?g32_witness=${crypto.randomUUID()}`, auth), retry),
  ]);
  const [store, rawV1, staleBridge, data] = await Promise.all([
    requestJson(baseUrl, `/conformance/v1/g32-store-state?g32_witness=${crypto.randomUUID()}`, auth),
    captureRawV1(baseUrl),
    requestJson(baseUrl, `/conformance/v1/g32-bridge?g32_witness=${crypto.randomUUID()}`, auth),
    captureDataWitness(baseUrl),
  ]);
  if (store.status !== 200 || staleBridge.status !== 404) {
    throw new Error(`G32 forward post-witness endpoint status failure: store=${store.status} bridge=${staleBridge.status}`);
  }
  const primaryAck = assertG32Config(primary.body, contract, "primary", sourceCommit, configDigest);
  const receiverAck = assertG32Config(receiver.body, contract, "receiver", sourceCommit, configDigest);
  if (primary.body.cutoverFenceFingerprint !== receiver.body.cutoverFenceFingerprint) throw new Error("G32 C2 primary/receiver fence fingerprints differ");
  if (
    store.body?.task !== "SDT-G32" || store.body?.serviceId !== contract.final.serviceId ||
    !Number.isSafeInteger(Number(store.body?.eventCount)) || Number(store.body.eventCount) < 1 ||
    !Number.isSafeInteger(Number(store.body?.eventOpsCount)) || Number(store.body.eventOpsCount) < 1 ||
    store.body?.legacySerializedEventTablePresent !== false
  ) throw new Error("G32 C2 store-state does not describe an existing legacy-free G32 store");
  return {
    task: "SDT-G32",
    phase: "c2-post-forward-deploy",
    capturedAt: new Date().toISOString(),
    identityVerified: true,
    identitySource: "remote-g32-conformance",
    sourceCommit,
    primary: primary.body,
    receiver: receiver.body,
    componentAcks: [primaryAck, receiverAck],
    newStoreState: store.body,
    rawV1,
    staleBridgeRoute: { status: staleBridge.status, body: staleBridge.body },
    data,
  };
}

export function assertForwardWitness(pre, post, sourceCommit) {
  if (pre?.identityVerified !== false || pre?.identitySource !== "public-pre-deploy-data") throw new Error("G32 C2 pre-witness must be public and captured before token rotation");
  if (post?.identityVerified !== true || post?.identitySource !== "remote-g32-conformance" || post?.sourceCommit !== sourceCommit) {
    throw new Error("G32 C2 post-witness source identity mismatch");
  }
  if (pre?.rawV1?.status !== 404 || post?.rawV1?.status !== 404 || post?.staleBridgeRoute?.status !== 404) {
    throw new Error("G32 C2 old surface closure changed");
  }
  return assertPreWitnessSetPreserved(pre.data, post.data);
}

function main() {
  const mode = argument("--mode", "post");
  const output = argument("--output", ".artifacts/g32-forward-post-witness.json");
  if (mode === "compare") {
    const pre = JSON.parse(readFileSync(required("--before", argument("--before")), "utf8"));
    const post = JSON.parse(readFileSync(required("--after", argument("--after")), "utf8"));
    console.log(JSON.stringify(assertForwardWitness(pre, post, required("--source-commit", argument("--source-commit"))), null, 2));
    return;
  }
  const baseUrl = required("--base-url", argument("--base-url", process.env.G32_BASE_URL));
  if (mode === "pre-deploy-public") {
    capturePublicPreWitness(baseUrl).then((witness) => {
      writeFileSync(output, `${JSON.stringify(witness, null, 2)}\n`, "utf8");
      console.log(JSON.stringify({ phase: witness.phase, reservations: witness.data.reservationList.totalCount }, null, 2));
    }).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
    return;
  }
  const token = readFileSync(required("--token-file", argument("--token-file", process.env.G32_CONFORMANCE_TOKEN_FILE)), "utf8").trim();
  if (token.length === 0) throw new Error("G32 conformance token is empty");
  const contract = JSON.parse(readFileSync(argument("--contract", "contracts/g32-cutover.json"), "utf8"));
  capturePostWitness({
    contract,
    baseUrl,
    receiverBaseUrl: required("--receiver-base-url", argument("--receiver-base-url", process.env.G32_RECEIVER_BASE_URL)),
    token,
    sourceCommit: required("--source-commit", argument("--source-commit", process.env.G32_SOURCE_COMMIT)),
    configDigest: required("--config-digest", argument("--config-digest", process.env.G32_CONFIG_DIGEST)),
    retry: {
      attempts: positiveInteger("--conformance-retry-attempts", argument("--conformance-retry-attempts", "1"), 1),
      delayMs: nonNegativeInteger("--conformance-retry-delay-ms", argument("--conformance-retry-delay-ms", "0"), 0),
    },
  }).then((witness) => {
    writeFileSync(output, `${JSON.stringify(witness, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ phase: witness.phase, sourceCommit: witness.sourceCommit, eventCount: witness.newStoreState.eventCount }, null, 2));
  }).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
