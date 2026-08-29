#!/usr/bin/env node
/**
 * Independent AC7 verifier. It intentionally does not import EventDigest.ts:
 * the runtime encoder and this Node/crypto implementation must disagree if
 * either serializes the packet-owned byte contract incorrectly.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const spec = JSON.parse(readFileSync(resolve(root, "contracts/g43-digest-spec.json"), "utf8"));
const vectors = JSON.parse(readFileSync(resolve(root, "contracts/g43-event-digest-vectors.json"), "utf8"));
const encoder = new TextEncoder();

function fail(message) {
  throw new Error(`G43 digest contract failed: ${message}`);
}

function bytes(value) {
  return Buffer.from(value);
}

function utf8(value) {
  return Buffer.from(encoder.encode(value));
}

function lengthPrefix(length) {
  if (!Number.isSafeInteger(length) || length < 0 || length > 0xffff_ffff) fail(`invalid uint32 length ${length}`);
  const result = Buffer.alloc(4);
  result.writeUInt32BE(length);
  return result;
}

function hasOwn(value, name) {
  return Object.prototype.hasOwnProperty.call(value, name);
}

function canonicalTags(tags) {
  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string")) fail("declaredTagSet is not a string array");
  const byBytes = new Map();
  for (const tag of tags) byBytes.set(utf8(tag).toString("hex"), tag);
  return [...byBytes.values()].sort((left, right) => Buffer.compare(utf8(left), utf8(right)));
}

function encodeTagSet(tags) {
  return Buffer.concat(canonicalTags(tags).map((tag) => {
    const encoded = utf8(tag);
    return Buffer.concat([lengthPrefix(encoded.byteLength), encoded]);
  }));
}

function encodeField(name, value) {
  const nameBytes = utf8(name);
  const present = value === undefined ? 0x00 : 0x01;
  const valueBytes = value === undefined ? Buffer.alloc(0) : bytes(value);
  return Buffer.concat([
    Buffer.from([present]),
    lengthPrefix(nameBytes.byteLength),
    nameBytes,
    lengthPrefix(valueBytes.byteLength),
    valueBytes,
  ]);
}

function allowedRecordKeys() {
  return new Set([
    ...spec.fieldOrder.map((field) => field.name),
    ...spec.excludedFields.map((field) => field.name),
  ]);
}

function independentDigest(record) {
  const allowed = allowedRecordKeys();
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(`unknown record field ${key} was silently omitted`);
  }
  const encodedFields = spec.fieldOrder.map((field) => {
    const present = hasOwn(record, field.name);
    if (field.required && !present) fail(`required field ${field.name} is absent`);
    const raw = record[field.name];
    if (!present) return encodeField(field.name, undefined);
    if (field.valueBytes === "utf8") {
      if (typeof raw !== "string") fail(`${field.name} is not utf8 text`);
      return encodeField(field.name, utf8(raw));
    }
    if (field.valueBytes === "tagSetEncoding") return encodeField(field.name, encodeTagSet(raw));
    if (field.valueBytes === "rawBytes") {
      if (!Buffer.isBuffer(raw) && !(raw instanceof Uint8Array)) fail(`${field.name} is not raw bytes`);
      return encodeField(field.name, raw);
    }
    fail(`unsupported spec valueBytes ${field.valueBytes}`);
  });
  return createHash(spec.algorithm.replace("-", "").toLowerCase())
    .update(Buffer.concat([utf8(spec.domainSeparator), Buffer.from([0x00]), ...encodedFields]))
    .digest("hex");
}

function recordFromFixture(input) {
  const { payloadHex, ...record } = input;
  if (typeof payloadHex !== "string" || !/^(?:[0-9a-f]{2})*$/i.test(payloadHex)) fail("fixture payloadHex is invalid");
  return { ...record, payload: Buffer.from(payloadHex, "hex") };
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) fail(`${label}: expected ${expected}, got ${actual}`);
}

export function verifyDigestContract() {
  if (spec.schemaVersion !== 2 || spec.owner !== "SDT-G43") fail("wrong packet-owned digest spec identity");
  if (spec.domainSeparator !== "sekiban-dcb-ts/eventDigest/v2") fail("unexpected domain separator");
  if (vectors.owner !== "SDT-G43" || vectors.spec !== "contracts/g43-digest-spec.json") fail("vector ownership is wrong");
  if (!Array.isArray(vectors.vectors) || vectors.vectors.length !== spec.goldenVectors.cases.length) {
    fail("golden vector count does not equal packet requirement");
  }
  const ids = new Set();
  for (const vector of vectors.vectors) {
    if (ids.has(vector.id)) fail(`duplicate golden vector ${vector.id}`);
    ids.add(vector.id);
    if (vector.input !== undefined) {
      expectEqual(independentDigest(recordFromFixture(vector.input)), vector.expectedDigest, vector.id);
      continue;
    }
    if (vector.left !== undefined && vector.right !== undefined) {
      const left = independentDigest(recordFromFixture(vector.left));
      const right = independentDigest(recordFromFixture(vector.right));
      expectEqual(left, vector.expectedLeftDigest, `${vector.id}.left`);
      expectEqual(right, vector.expectedRightDigest, `${vector.id}.right`);
      if (vector.expectDistinct && left === right) fail(`${vector.id} expected distinct digests`);
      continue;
    }
    if (vector.absent !== undefined && vector.presentEmpty !== undefined) {
      const absent = independentDigest(recordFromFixture(vector.absent));
      const presentEmpty = independentDigest(recordFromFixture(vector.presentEmpty));
      expectEqual(absent, vector.expectedAbsentDigest, `${vector.id}.absent`);
      expectEqual(presentEmpty, vector.expectedPresentEmptyDigest, `${vector.id}.presentEmpty`);
      if (vector.expectDistinct && absent === presentEmpty) fail(`${vector.id} expected distinct digests`);
      continue;
    }
    fail(`vector ${vector.id} has no supported input form`);
  }
  return { vectors: vectors.vectors.map((vector) => vector.id), result: "independent-v2-golden-check-passed" };
}

function selfTest() {
  const baseline = recordFromFixture(vectors.vectors[0].input);
  try {
    independentDigest({ ...baseline, unsealedExtra: "must-reject" });
    fail("closed-projection self-test was vacuous");
  } catch (error) {
    if (error instanceof Error && error.message.includes("unknown record field")) {
      process.stdout.write(`${JSON.stringify({ selfTest: "closed-projection-red", ...verifyDigestContract() })}\n`);
      return;
    }
    throw error;
  }
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  process.stdout.write(`${JSON.stringify(verifyDigestContract())}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
