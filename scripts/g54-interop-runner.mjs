#!/usr/bin/env node
/**
 * Dependency-free SDT-G54 frozen-wire runner. It uses Node built-ins only:
 * SHA pins are verified before the catalogue's V1, adapter, and payload
 * witnesses are evaluated. The paired Vitest file executes the same cases
 * against the shipped runtime and dcb-client implementations.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const fixtures = resolve(root, "test/fixtures/g54-sekiban-interop");
const pinsFile = "SHA256SUMS";
const acceptedPositivesFile = resolve(root, "test/fixtures/g54-accepted-positives.json");
const unexpectedAcceptanceMutant = process.argv.includes("--unexpected-acceptance-mutant");

const EXPECTED_MANIFEST_OUTCOMES = new Map([
  ["interop_official_v1_populated.json", "r1-byte-identical"],
  ["interop_legacy_populated.json", "legacy-compatible"],
  ["interop_legacy_explicit_empty.json", "legacy-empty-compatible"],
  ["interop_ts_client_model.json", "r1-r2-paired-positive"],
  ["interop_r2_canonical_positive.json", "r2-byte-exact-positive"],
  ["interop_r2_canonical_positive_v1.json", "r2-byte-exact-expected-v1"],
  ["interop_r2_integer_like_key.json", "r2-key-order-loss"],
  ["interop_r2_numeric_lexical_loss.json", "r2-numeric-lexical-loss"],
  ["interop_r2_duplicate_key.json", "r2-duplicate-key-error"],
  ["interop_r3_bom_payload.json", "r3-bom-payload-error"],
  ["interop_r3_non_json_payload.json", "r3-non-json-payload-error"],
  ["interop_r3_invalid_utf8_payload.json", "r3-invalid-utf8-payload-error"],
  ["interop_client_empty_tag.json", "r2-empty-tag-error"],
  ["interop_client_duplicate_consistency.json", "r2-duplicate-consistency-error"],
  ["interop_response_member_vocabulary.json", "response-vocabulary"],
]);
const EXPECTED_ACCEPTED_INPUTS = new Set([
  "interop_official_v1_populated.json",
  "interop_r2_canonical_positive_v1.json",
  "interop_ts_client_model.json",
  "interop_r2_canonical_positive.json",
]);

class InteropError extends Error {
  constructor(code, message, httpStatus = 400) {
    super(message);
    this.name = "InteropError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function fail(message) {
  throw new Error(`SDT-G54 interop runner: ${message}`);
}

function bytes(file) {
  return readFileSync(resolve(fixtures, file));
}

function text(file) {
  return bytes(file).toString("utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function expect(condition, message) {
  if (!condition) fail(message);
}

function pinMap() {
  const pins = new Map();
  for (const [index, line] of text(pinsFile).trim().split("\n").entries()) {
    const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9_.-]+)$/.exec(line);
    expect(match !== null, `invalid ${pinsFile} line ${index + 1}`);
    expect(!pins.has(match[2]), `duplicate ${pinsFile} entry ${match[2]}`);
    pins.set(match[2], match[1]);
  }
  return pins;
}

function verifyPins() {
  const pins = pinMap();
  const copied = readdirSync(fixtures).filter((file) => file !== pinsFile).sort();
  expect(pins.size === 17, `expected 17 frozen source pins, found ${pins.size}`);
  expect(copied.length === 17, `expected 17 frozen source files, found ${copied.length}`);
  for (const file of copied) {
    const expected = pins.get(file);
    expect(expected !== undefined, `missing pin for ${file}`);
    expect(sha256(bytes(file)) === expected, `SHA-256 mismatch for ${file}`);
  }
  for (const file of pins.keys()) expect(copied.includes(file), `pin names absent copied source ${file}`);

  const manifest = JSON.parse(text("interop_manifest.json"));
  expect(Array.isArray(manifest.fixtures) && manifest.fixtures.length === 15, "manifest must enumerate fifteen interop witnesses");
  for (const fixture of manifest.fixtures) {
    expect(typeof fixture.file === "string", "manifest fixture is missing file");
    expect(pins.has(fixture.file), `manifest fixture is not pinned: ${fixture.file}`);
    expect(bytes(fixture.file).byteLength === fixture.byteLength, `manifest byte length mismatch for ${fixture.file}`);
    expect(sha256(bytes(fixture.file)) === fixture.sha256, `manifest SHA-256 mismatch for ${fixture.file}`);
  }
  return manifest;
}

function manifestFixtureMap(manifest) {
  const entries = new Map();
  for (const fixture of manifest.fixtures) {
    expect(!entries.has(fixture.file), `manifest has duplicate fixture ${fixture.file}`);
    entries.set(fixture.file, fixture);
  }
  return entries;
}

function verifyManifestOutcomes(manifest) {
  const entries = manifestFixtureMap(manifest);
  expect(entries.size === EXPECTED_MANIFEST_OUTCOMES.size, "manifest fixture outcomes changed count");
  for (const [file, expectedOutcome] of EXPECTED_MANIFEST_OUTCOMES) {
    const fixture = entries.get(file);
    expect(fixture !== undefined, `manifest missing expected fixture ${file}`);
    expect(fixture.expectedOutcome === expectedOutcome, `${file} expected manifest outcome ${expectedOutcome}, received ${fixture.expectedOutcome}`);
  }
  return entries;
}

function acceptedPositiveExpectations(manifestEntries) {
  const document = JSON.parse(readFileSync(acceptedPositivesFile, "utf8"));
  expect(document !== null && typeof document === "object" && !Array.isArray(document), "accepted-positive expectations must be an object");
  expect(document.schema === "sdt-g54-accepted-positives/v1", "accepted-positive expectations schema changed");
  expect(document.classification === "accepted-positive", "accepted-positive expectations classification changed");
  expect(Array.isArray(document.acceptances) && document.acceptances.length === EXPECTED_ACCEPTED_INPUTS.size, "accepted-positive expectations must name exactly four fixtures");

  const seen = new Set();
  for (const entry of document.acceptances) {
    expect(entry !== null && typeof entry === "object" && !Array.isArray(entry), "accepted-positive entry must be an object");
    expect(typeof entry.inputFixture === "string" && EXPECTED_ACCEPTED_INPUTS.has(entry.inputFixture), `unexpected accepted-positive input ${entry.inputFixture}`);
    expect(!seen.has(entry.inputFixture), `duplicate accepted-positive input ${entry.inputFixture}`);
    seen.add(entry.inputFixture);
    expect(entry.inputKind === "v1-wire" || entry.inputKind === "client-model", `${entry.inputFixture} must declare a supported input kind`);
    expect(typeof entry.expectedV1Fixture === "string" && manifestEntries.has(entry.expectedV1Fixture), `${entry.inputFixture} must name a pinned expected V1 fixture`);
    expect(typeof entry.manifestExpectedOutcome === "string", `${entry.inputFixture} is missing its manifest expectation`);
    expect(manifestEntries.get(entry.inputFixture)?.expectedOutcome === entry.manifestExpectedOutcome, `${entry.inputFixture} manifest expectation was reclassified`);
    expect(entry.resolvingUnit === "SDT-G56", `${entry.inputFixture} must name SDT-G56 as the resolving unit`);
    if (entry.inputKind === "v1-wire") {
      expect(entry.inputFixture === entry.expectedV1Fixture, `${entry.inputFixture} must retain its exact V1 source bytes`);
    }
  }
  expect(seen.size === EXPECTED_ACCEPTED_INPUTS.size && [...EXPECTED_ACCEPTED_INPUTS].every((file) => seen.has(file)), "accepted-positive expectations omitted a required fixture");
  return document.acceptances;
}

class JsonScanner {
  constructor(source) {
    this.source = source;
    this.index = 0;
  }

  whitespace() {
    while (/\s/.test(this.source[this.index] ?? "")) this.index += 1;
  }

  value() {
    this.whitespace();
    const start = this.index;
    const first = this.source[this.index];
    let node;
    if (first === "{") node = this.object();
    else if (first === "[") node = this.array();
    else if (first === '"') node = this.string();
    else if (first === "-" || /[0-9]/.test(first ?? "")) node = this.number();
    else node = this.literal();
    return { ...node, raw: this.source.slice(start, this.index) };
  }

  string() {
    const start = this.index;
    this.index += 1;
    let escaped = false;
    while (this.index < this.source.length) {
      const current = this.source[this.index++];
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === '"') {
        const raw = this.source.slice(start, this.index);
        return { kind: "string", value: JSON.parse(raw) };
      } else if (current < " ") {
        fail("unescaped control character in JSON string");
      }
    }
    fail("unterminated JSON string");
  }

  number() {
    const match = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    match.lastIndex = this.index;
    const found = match.exec(this.source);
    expect(found !== null, "invalid JSON number");
    this.index += found[0].length;
    return { kind: "number", value: JSON.parse(found[0]), numericRaw: found[0] };
  }

  literal() {
    for (const [literal, value] of [["true", true], ["false", false], ["null", null]]) {
      if (this.source.startsWith(literal, this.index)) {
        this.index += literal.length;
        return { kind: "literal", value };
      }
    }
    fail(`invalid JSON token at byte ${this.index}`);
  }

  object() {
    const entries = new Map();
    const seen = new Set();
    this.index += 1;
    this.whitespace();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return { kind: "object", value: {}, entries };
    }
    while (true) {
      this.whitespace();
      expect(this.source[this.index] === '"', `object key must be a string at byte ${this.index}`);
      const key = this.string().value;
      if (seen.has(key)) throw new InteropError("client_payload_duplicate_key", `duplicate raw JSON key ${key}`);
      seen.add(key);
      this.whitespace();
      expect(this.source[this.index] === ":", `object member ${key} lacks colon`);
      this.index += 1;
      const child = this.value();
      entries.set(key, child);
      this.whitespace();
      if (this.source[this.index] === "}") {
        this.index += 1;
        break;
      }
      expect(this.source[this.index] === ",", `object member ${key} lacks comma`);
      this.index += 1;
    }
    return { kind: "object", value: Object.fromEntries([...entries].map(([key, child]) => [key, child.value])), entries };
  }

  array() {
    const items = [];
    this.index += 1;
    this.whitespace();
    if (this.source[this.index] === "]") {
      this.index += 1;
      return { kind: "array", value: [], items };
    }
    while (true) {
      items.push(this.value());
      this.whitespace();
      if (this.source[this.index] === "]") {
        this.index += 1;
        break;
      }
      expect(this.source[this.index] === ",", `array item lacks comma at byte ${this.index}`);
      this.index += 1;
    }
    return { kind: "array", value: items.map((item) => item.value), items };
  }
}

function parseRawJson(source) {
  const scanner = new JsonScanner(source);
  const node = scanner.value();
  scanner.whitespace();
  expect(scanner.index === source.length, `trailing JSON content at byte ${scanner.index}`);
  return node;
}

function objectMember(node, member) {
  expect(node.kind === "object", "JSON object expected");
  return node.entries.get(member);
}

function standardBase64(value) {
  return value.length === 0 || (value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value));
}

function decodePayload(value) {
  if (typeof value !== "string" || !standardBase64(value)) {
    throw new InteropError("invalid_payload_utf8", "payload must be standard base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded[0] === 0xef && decoded[1] === 0xbb && decoded[2] === 0xbf) {
    throw new InteropError("invalid_payload_utf8", "payload must not begin with UTF-8 BOM");
  }
  let result;
  try {
    result = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    throw new InteropError("invalid_payload_utf8", "payload must be valid UTF-8 JSON text");
  }
  try {
    JSON.parse(result);
  } catch {
    throw new InteropError("invalid_payload_json", "payload must be syntactically valid JSON");
  }
  return result;
}

function runtimeValidate(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InteropError("malformed_commit_envelope", "Commit envelope must contain numeric version 1");
  }
  const record = value;
  const aliases = ["candidates", "consistency"].filter((member) => Object.hasOwn(record, member));
  if (typeof record.version !== "number") {
    if (aliases.length > 0) {
      throw new InteropError(
        "malformed_commit_envelope",
        `Client-model member(s) ${aliases.join(", ")} require the transport adapter; use version 1 with eventCandidates and consistencyTags on the V1 wire.`,
      );
    }
    throw new InteropError("malformed_commit_envelope", "Commit envelope must contain numeric version 1");
  }
  if (record.version !== 1) {
    throw new InteropError("unsupported_commit_envelope_version", "Only serialized commit envelope version 1 is supported");
  }
  const missing = ["eventCandidates", "consistencyTags"].filter((member) => !Object.hasOwn(record, member));
  if (missing.length > 0 || aliases.length > 0) {
    throw new InteropError(
      "malformed_commit_envelope",
      `${missing.length === 0 ? "" : `Missing required V1 member(s): ${missing.join(", ")}. `}${aliases.length === 0 ? "" : `Client-model member(s) ${aliases.join(", ")} require the transport adapter.`}`.trim(),
    );
  }
  if (!Array.isArray(record.eventCandidates)) throw new InteropError("malformed_commit_envelope", "eventCandidates must be an array");
  if (!Array.isArray(record.consistencyTags)) throw new InteropError("malformed_commit_envelope", "consistencyTags must be an array");
  const tags = new Set();
  for (const candidate of record.eventCandidates) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new InteropError("malformed_commit_envelope", "event candidate must be an object");
    }
    if (typeof candidate.payload !== "string" || typeof candidate.eventPayloadName !== "string" || !Array.isArray(candidate.tags)) {
      throw new InteropError("malformed_commit_envelope", "event candidate must have V1 payload, eventPayloadName, and tags");
    }
    if (candidate.tags.length === 0 || candidate.tags.some((tag) => typeof tag !== "string" || tag.length === 0) || new Set(candidate.tags).size !== candidate.tags.length) {
      throw new InteropError("validation_error", "candidate tags must be unique non-empty strings");
    }
    decodePayload(candidate.payload);
    for (const tag of candidate.tags) tags.add(tag);
  }
  const consistency = new Set();
  for (const entry of record.consistencyTags) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry) || typeof entry.tag !== "string" || !Object.hasOwn(entry, "lastSortableUniqueId")) {
      throw new InteropError("malformed_commit_envelope", "consistency tag must have V1 shape");
    }
    if (entry.lastSortableUniqueId === null || typeof entry.lastSortableUniqueId !== "string") {
      throw new InteropError("malformed_commit_envelope", "lastSortableUniqueId must be a non-null string");
    }
    if (entry.lastSortableUniqueId !== "" && !/^[0-9]{30}$/.test(entry.lastSortableUniqueId)) {
      throw new InteropError("invalid_sortable_unique_id", "lastSortableUniqueId must be a 30-digit SortableUniqueId");
    }
    if (consistency.has(entry.tag)) throw new InteropError("validation_error", "consistency tags must be unique");
    if (!tags.has(entry.tag)) throw new InteropError("validation_error", "consistency tag must occur in an event candidate");
    consistency.add(entry.tag);
  }
  return value;
}

function clientToV1(rawClientEnvelope) {
  const rootNode = parseRawJson(rawClientEnvelope);
  const candidatesNode = objectMember(rootNode, "candidates");
  const consistencyNode = objectMember(rootNode, "consistency");
  expect(candidatesNode?.kind === "array", "client candidates must be an array");
  expect(consistencyNode?.kind === "array", "client consistency must be an array");
  const eventCandidates = candidatesNode.items.map((candidateNode) => {
    expect(candidateNode.kind === "object", "client candidate must be an object");
    const payload = objectMember(candidateNode, "payload");
    const eventPayloadName = objectMember(candidateNode, "eventPayloadName");
    const tags = objectMember(candidateNode, "tags");
    expect(payload !== undefined && eventPayloadName?.kind === "string" && tags?.kind === "array", "client candidate has incomplete shape");
    const canonicalPayload = JSON.stringify(payload.value);
    if (canonicalPayload !== payload.raw) {
      const code = payload.raw.includes(".") || payload.raw.includes("e") || payload.raw.includes("E") || payload.raw.includes("-0")
        ? "client_payload_numeric_lexical_loss"
        : "client_payload_key_order_loss";
      throw new InteropError(code, "client JSON cannot preserve this raw payload spelling through the adapter");
    }
    return {
      payload: Buffer.from(canonicalPayload, "utf8").toString("base64"),
      eventPayloadName: eventPayloadName.value,
      tags: tags.value,
    };
  });
  return { version: 1, eventCandidates, consistencyTags: consistencyNode.value };
}

function verifyCandidatePartR1(actualWire, expectedWire, fixture) {
  const actual = JSON.parse(actualWire);
  const expected = JSON.parse(expectedWire);
  expect(Array.isArray(actual.eventCandidates), `${fixture} omitted eventCandidates`);
  expect(Array.isArray(expected.eventCandidates), `${fixture} expected V1 wire omitted eventCandidates`);
  expect(JSON.stringify(actual.eventCandidates) === JSON.stringify(expected.eventCandidates), `${fixture} candidate part diverged from the expected V1 bytes`);
  for (const [index, candidate] of actual.eventCandidates.entries()) {
    const expectedCandidate = expected.eventCandidates[index];
    expect(typeof candidate?.payload === "string", `${fixture} candidate ${index} omitted its base64 payload`);
    expect(typeof expectedCandidate?.payload === "string", `${fixture} expected V1 candidate ${index} omitted its base64 payload`);
    const admitted = Buffer.from(candidate.payload, "base64");
    const expectedAdmitted = Buffer.from(expectedCandidate.payload, "base64");
    expect(admitted.equals(expectedAdmitted), `${fixture} candidate ${index} R1 payload bytes changed`);
    expect(admitted.toString("base64") === candidate.payload, `${fixture} candidate ${index} payload is not canonical base64`);
  }
  return actual;
}

function expectedAcceptedPositive(entry, envelope) {
  try {
    if (unexpectedAcceptanceMutant) {
      if (envelope.consistencyTags.some((candidate) => candidate.lastSortableUniqueId === "")) {
        throw new InteropError("invalid_sortable_unique_id", "lastSortableUniqueId must be a 30-digit SortableUniqueId");
      }
    }
    runtimeValidate(envelope);
  } catch (caught) {
    if (!(caught instanceof InteropError)) {
      throw new Error(`SDT-G54 interop runner: ${entry.inputFixture} accepted-positive threw an unexpected error`);
    }
    if (!unexpectedAcceptanceMutant) {
      throw new Error(`SDT-G54 interop runner: ${entry.inputFixture} accepted-positive rejected unexpectedly: ${caught.code}`);
    }
    fail(`${entry.inputFixture} accepted-positive unexpectedly rejected by the empty-head omission mutant`);
  }
  return Object.freeze({
    fixture: entry.inputFixture,
    expectedV1Fixture: entry.expectedV1Fixture,
    classification: "accepted-positive",
    httpStatus: 200,
    resolvingUnit: entry.resolvingUnit,
  });
}

function verifyAcceptedPositives(entries) {
  return entries.map((entry) => {
    const expectedWire = text(entry.expectedV1Fixture);
    const actualWire = entry.inputKind === "client-model"
      ? JSON.stringify(clientToV1(text(entry.inputFixture)))
      : text(entry.inputFixture);
    expect(actualWire === expectedWire, `${entry.inputFixture} did not preserve the expected V1 bytes exactly`);
    const envelope = verifyCandidatePartR1(actualWire, expectedWire, entry.inputFixture);
    return expectedAcceptedPositive(entry, envelope);
  });
}

function expectedError(action, code, fixture) {
  try {
    action();
  } catch (caught) {
    if (caught instanceof InteropError && caught.code === code) return;
    throw new Error(`SDT-G54 interop runner: ${fixture} expected ${code}, received ${caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)}`);
  }
  fail(`${fixture} expected ${code}, but completed successfully`);
}

function verifyOutcomes(manifest) {
  const manifestEntries = verifyManifestOutcomes(manifest);
  const acceptedPositives = verifyAcceptedPositives(acceptedPositiveExpectations(manifestEntries));
  // These two upstream witnesses remain frozen evidence of the former C#
  // compatibility surface. The TypeScript runtime's shared boundary is V1,
  // so the runner deliberately classifies them as typed unversioned rejects
  // instead of inventing a second wire dialect.
  expectedError(() => runtimeValidate(JSON.parse(text("interop_legacy_populated.json"))), "malformed_commit_envelope", "interop_legacy_populated.json");
  expectedError(() => runtimeValidate(JSON.parse(text("interop_legacy_explicit_empty.json"))), "malformed_commit_envelope", "interop_legacy_explicit_empty.json");

  const tsClient = text("interop_ts_client_model.json");
  expectedError(() => runtimeValidate(JSON.parse(tsClient)), "malformed_commit_envelope", "interop_ts_client_model.json runtime");
  expectedError(() => clientToV1(text("interop_r2_integer_like_key.json")), "client_payload_key_order_loss", "interop_r2_integer_like_key.json");
  expectedError(() => clientToV1(text("interop_r2_numeric_lexical_loss.json")), "client_payload_numeric_lexical_loss", "interop_r2_numeric_lexical_loss.json");
  expectedError(() => clientToV1(text("interop_r2_duplicate_key.json")), "client_payload_duplicate_key", "interop_r2_duplicate_key.json");
  expectedError(() => runtimeValidate(JSON.parse(text("interop_r3_bom_payload.json"))), "invalid_payload_utf8", "interop_r3_bom_payload.json");
  expectedError(() => runtimeValidate(JSON.parse(text("interop_r3_non_json_payload.json"))), "invalid_payload_json", "interop_r3_non_json_payload.json");
  expectedError(() => runtimeValidate(JSON.parse(text("interop_r3_invalid_utf8_payload.json"))), "invalid_payload_utf8", "interop_r3_invalid_utf8_payload.json");
  expectedError(() => runtimeValidate(clientToV1(text("interop_client_empty_tag.json"))), "validation_error", "interop_client_empty_tag.json");
  expectedError(() => runtimeValidate(clientToV1(text("interop_client_duplicate_consistency.json"))), "validation_error", "interop_client_duplicate_consistency.json");

  const vocabulary = JSON.parse(text("interop_response_member_vocabulary.json"));
  expect(typeof vocabulary.projectorVersion === "string", "response vocabulary requires string projectorVersion");
  expect(typeof vocabulary.lastSortedUniqueId === "string", "response vocabulary requires tag-state lastSortedUniqueId");
  expect(Array.isArray(vocabulary.writtenEvents) && Array.isArray(vocabulary.tagWriteResults), "response vocabulary requires commit response members");
  return Object.freeze({
    acceptedPositives,
    legacy: "catalogued-as-typed-unversioned-rejects",
    r1: "candidate-bytes-preserved-and-empty-head-accepted",
    r2: "adapter-byte-identical-and-empty-head-accepted",
    r3: "payload-errors-typed",
    response: "projector-version-string-and-last-sorted-unique-id",
  });
}

function main() {
  const manifest = verifyPins();
  const outcomes = verifyOutcomes(manifest);
  process.stdout.write(`${JSON.stringify({ result: "g54-interop-catalogue-verified-with-accepted-positives", sourceFiles: 17, manifestFixtures: manifest.fixtures.length, acceptedPositiveCount: outcomes.acceptedPositives.length, outcomes })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
