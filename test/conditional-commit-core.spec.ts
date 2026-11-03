import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_COMMIT_CANONICALIZATION_VERSION,
  CONDITIONAL_COMMIT_DERIVATION_VERSION,
  CONDITIONAL_COMMIT_DOMAIN_SEPARATOR,
  CONDITIONAL_COMMIT_MAX_PAYLOAD_BYTES,
  CONDITIONAL_COMMIT_MAX_REQUEST_BYTES,
  CONDITIONAL_COMMIT_MAX_UTF8_FIELD_BYTES,
  CONDITIONAL_COMMIT_VERSION,
  ConditionalCommitProtocolError,
  canonicalizeConditionalCommitPayload,
  computeConditionalCommitFingerprint,
  conditionalCommitFingerprintPreimage,
  normalizeConditionalCommitKey,
  parseSerializedConditionalCommitRequest,
  parseSerializedConditionalCommitRequestBody,
  type ConditionalCommitFingerprintInput,
  type ConditionalCommitValidationCode,
} from "../packages/dcb-core/src/conditionalCommit";

const TS_PREIMAGE = "00000002000000010000002973656b6962616e2e6463622e636f6e646974696f6e616c2d617070656e642e756e697175652d6b657900000003737663000000036b657900000003457674000000027b7d0000000100000003543a31";
const DOTNET_PREIMAGE = "00000002000000010000002973656b6962616e2e6463622e636f6e646974696f6e616c2d617070656e642e756e697175652d6b6579000000057376632d31000000056b65792d31000000074d792e547970650000000f7b2261223a312c2262223a2278227d0000000200000003413a3100000003423a32";
const TS_DIGEST = "d42ee2bee3ace179f06f3f46a9dbd5a1556a6e71b0be8e5559222293714f54f6";
const DOTNET_DIGEST = "4ef47d7068f7a740f23cca54401ad9c14ba1d236a4a3965c8e1f0cd813c994d6";
const PAIR_DIGEST = "66fec16f08c6eb4ca5f72dedf3f437749b8242a537309c1184a97776dc4852e1";
const REPLACEMENT_DIGEST = "fc300d24e85cd3e8a1ce96467c2db1014fcd8d27511b0647308d5aa005d67168";

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function codeOf(error: unknown): ConditionalCommitValidationCode {
  expect(error).toBeInstanceOf(ConditionalCommitProtocolError);
  return (error as ConditionalCommitProtocolError).code;
}

function expectCode(action: () => unknown, code: ConditionalCommitValidationCode): void {
  try {
    action();
  } catch (error) {
    expect(codeOf(error)).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

const emptyPayload = (): Uint8Array => canonicalizeConditionalCommitPayload({});

function fingerprintInput(key: string, canonicalPayload = emptyPayload()): ConditionalCommitFingerprintInput {
  return { serviceId: "svc", idempotencyKey: key, eventPayloadName: "Evt", canonicalPayload, tag: "T:1" };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    idempotencyKey: "key",
    eventCandidate: {
      payload: base64("{}"),
      eventPayloadName: "Evt",
      tags: ["T:1"],
    },
    ...overrides,
  };
}

/** Test-only two-tag framing. The production helper admits one tag. */
function dotNetParityPreimage(): Uint8Array {
  const bytes: number[] = [];
  const int32 = (value: number) => {
    bytes.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  };
  const utf8 = (value: string) => {
    const encoded = new TextEncoder().encode(value);
    int32(encoded.byteLength);
    for (const byte of encoded) bytes.push(byte);
  };
  int32(2);
  int32(1);
  utf8("sekiban.dcb.conditional-append.unique-key");
  utf8("svc-1");
  utf8("key-1");
  utf8("My.Type");
  const payload = new TextEncoder().encode('{"a":1,"b":"x"}');
  int32(payload.byteLength);
  for (const byte of payload) bytes.push(byte);
  int32(2);
  utf8("A:1");
  utf8("B:2");
  return Uint8Array.from(bytes);
}

describe("conditional commit key normalization", () => {
  it("trims only the .NET set, including U+0085, and keeps U+FEFF", () => {
    expect(normalizeConditionalCommitKey("\u0085key\u0085")).toBe("key");
    expect(normalizeConditionalCommitKey("\t\n\u000b\u000c\r key \u00a0\u1680\u2003\u2028\u2029\u202f\u205f\u3000")).toBe("key");
    expect("\u0085key".trim()).toBe("\u0085key");
    expect(normalizeConditionalCommitKey("\uFEFFkey")).toBe("\uFEFFkey");
    expect("\uFEFFkey".trim()).toBe("key");
  });

  it("rejects blank keys, applies NFC after trimming, and preserves case", () => {
    expectCode(() => normalizeConditionalCommitKey(" \u0085 "), "conditional_commit_invalid_key");
    expectCode(() => normalizeConditionalCommitKey(""), "conditional_commit_invalid_key");
    expect(normalizeConditionalCommitKey(" e\u0301 ")).toBe("\u00e9");
    expect(normalizeConditionalCommitKey("e\u0301")).toBe(normalizeConditionalCommitKey("\u00e9"));
    expect(normalizeConditionalCommitKey("Key")).toBe("Key");
  });

  it("measures UTF-8 bytes after NFC at the 512 boundary", () => {
    expect(normalizeConditionalCommitKey("a".repeat(512))).toHaveLength(512);
    expectCode(() => normalizeConditionalCommitKey("a".repeat(513)), "conditional_commit_invalid_key");
    expect(normalizeConditionalCommitKey("\u00e9".repeat(256))).toBe("\u00e9".repeat(256));
    expectCode(() => normalizeConditionalCommitKey("\u00e9".repeat(257)), "conditional_commit_invalid_key");
    expectCode(() => normalizeConditionalCommitKey("\u00e9".repeat(512)), "conditional_commit_invalid_key");
    expect(CONDITIONAL_COMMIT_MAX_UTF8_FIELD_BYTES).toBe(512);
  });

  it("rejects ill-formed UTF-16 before trim, NFC, or encoding", () => {
    const encode = TextEncoder.prototype.encode;
    let encoded = false;
    TextEncoder.prototype.encode = function (input?: string) {
      encoded = true;
      return encode.call(this, input);
    };
    try {
      for (const key of ["\uD800", "\uDC00", "\uD800A", "\uD800\uD800\uDC00", " \uD800 ", "\uDC00\uD83D\uDE00"]) {
        encoded = false;
        expectCode(() => normalizeConditionalCommitKey(key), "conditional_commit_invalid_key");
        expect(encoded).toBe(false);
      }
    } finally {
      TextEncoder.prototype.encode = encode;
    }
    expect(normalizeConditionalCommitKey("\uD83D\uDE00")).toBe("\uD83D\uDE00");
    expect(normalizeConditionalCommitKey("\uFFFD")).toBe("\uFFFD");
    expect(normalizeConditionalCommitKey("\uD83D\uDE00")).not.toBe(normalizeConditionalCommitKey("\uFFFD"));
  });

  it("exposes only the closed protocol error", () => {
    try {
      normalizeConditionalCommitKey("secret-\uD800");
      throw new Error("accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(ConditionalCommitProtocolError);
      const protocol = error as ConditionalCommitProtocolError;
      expect(protocol.code).toBe("conditional_commit_invalid_key");
      expect(protocol.message).toBe("The idempotency key is invalid.");
      expect(protocol.retryable).toBe(false);
      expect(protocol.cause).toBeUndefined();
      expect(JSON.stringify(protocol)).not.toContain("secret");
      expect(Object.hasOwn(protocol, "path")).toBe(false);
    }
  });
});

describe("conditional commit canonical payload", () => {
  it("requires a plain root and sorts keys by UTF-16 order", () => {
    expect(text(canonicalizeConditionalCommitPayload({ b: 1, a: 2 }))).toBe('{"a":2,"b":1}');
    expect(text(canonicalizeConditionalCommitPayload({ "10": 1, "2": 2 }))).toBe('{"10":1,"2":2}');
    expect(JSON.stringify({ "10": 1, "2": 2 })).toBe('{"2":2,"10":1}');
    expect(text(canonicalizeConditionalCommitPayload({ z: [2, { b: 1, a: true }], a: null }))).toBe('{"a":null,"z":[2,{"a":true,"b":1}]}');
    const left = canonicalizeConditionalCommitPayload({ b: 1, a: [1, 2] });
    const right = canonicalizeConditionalCommitPayload({ a: [1, 2], b: 1 });
    expect(hex(left)).toBe(hex(right));
    expect(hex(canonicalizeConditionalCommitPayload({ a: [1, 2] }))).not.toBe(hex(canonicalizeConditionalCommitPayload({ a: [2, 1] })));
  });

  it("rejects non-plain, cyclic, sparse, symbol, and accessor values without invoking getters", () => {
    expectCode(() => canonicalizeConditionalCommitPayload([]), "conditional_commit_payload_root_not_object");
    expectCode(() => canonicalizeConditionalCommitPayload(null), "conditional_commit_payload_root_not_object");
    expectCode(() => canonicalizeConditionalCommitPayload(new Date()), "conditional_commit_payload_root_not_object");
    expectCode(() => canonicalizeConditionalCommitPayload({ when: new Date() }), "conditional_commit_payload_not_canonicalizable");
    expectCode(() => canonicalizeConditionalCommitPayload({ value: new Map() }), "conditional_commit_payload_not_canonicalizable");
    expectCode(() => canonicalizeConditionalCommitPayload({ value: new Set() }), "conditional_commit_payload_not_canonicalizable");
    expectCode(() => canonicalizeConditionalCommitPayload({ value: new Uint8Array() }), "conditional_commit_payload_not_canonicalizable");
    expectCode(() => canonicalizeConditionalCommitPayload({ value: () => 1 }), "conditional_commit_payload_not_canonicalizable");
    expectCode(() => canonicalizeConditionalCommitPayload({ value: undefined }), "conditional_commit_payload_not_canonicalizable");
    expectCode(() => canonicalizeConditionalCommitPayload({ value: 1n }), "conditional_commit_payload_not_canonicalizable");
    expectCode(() => canonicalizeConditionalCommitPayload({ value: Number.NaN }), "conditional_commit_payload_not_canonicalizable");
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expectCode(() => canonicalizeConditionalCommitPayload(cycle), "conditional_commit_payload_not_canonicalizable");
    const sparse = [1];
    delete sparse[0];
    expectCode(() => canonicalizeConditionalCommitPayload({ a: sparse }), "conditional_commit_payload_not_canonicalizable");
    const extra = [1];
    Object.defineProperty(extra, "hidden", { value: 1, enumerable: true });
    expectCode(() => canonicalizeConditionalCommitPayload({ a: extra }), "conditional_commit_payload_not_canonicalizable");
    const symbolic: Record<PropertyKey, unknown> = { a: 1 };
    symbolic[Symbol("s")] = 1;
    expectCode(() => canonicalizeConditionalCommitPayload(symbolic), "conditional_commit_payload_not_canonicalizable");
    const hidden = {};
    Object.defineProperty(hidden, "secret", { value: 1, enumerable: false });
    expectCode(() => canonicalizeConditionalCommitPayload(hidden), "conditional_commit_payload_not_canonicalizable");
    let reads = 0;
    const accessor = {};
    Object.defineProperty(accessor, "secret", { enumerable: true, get() { reads += 1; return 1; } });
    expectCode(() => canonicalizeConditionalCommitPayload(accessor), "conditional_commit_payload_not_canonicalizable");
    expect(reads).toBe(0);
    expect(text(canonicalizeConditionalCommitPayload(Object.create(null, { a: { value: 1, enumerable: true } })))).toBe('{"a":1}');
    const nested = Object.create({ inherited: 1 });
    expectCode(() => canonicalizeConditionalCommitPayload({ a: nested }), "conditional_commit_payload_not_canonicalizable");
  });

  it("enforces the canonical 192 KiB limit separately from caller identity", () => {
    const fit = "a".repeat(CONDITIONAL_COMMIT_MAX_PAYLOAD_BYTES - 8);
    const exact = { a: fit };
    expect(canonicalizeConditionalCommitPayload(exact).byteLength).toBe(CONDITIONAL_COMMIT_MAX_PAYLOAD_BYTES);
    expect(exact.a).toBe(fit);
    expectCode(() => canonicalizeConditionalCommitPayload({ a: `${fit}a` }), "conditional_commit_size_limit_exceeded");
  });
});

describe("conditional commit fingerprint", () => {
  it("pins signed Int32 big-endian field order and the single-tag vector", async () => {
    const preimage = conditionalCommitFingerprintPreimage(fingerprintInput("key"));
    expect(preimage.byteLength).toBe(91);
    expect(hex(preimage)).toBe(TS_PREIMAGE);
    expect([...preimage.subarray(0, 4)]).toEqual([0, 0, 0, 2]);
    expect([...preimage.subarray(0, 4)]).not.toEqual([2, 0, 0, 0]);
    expect(hex(preimage)).toContain(Buffer.from("svc").toString("hex"));
    expect(hex(preimage)).toContain(Buffer.from("T:1").toString("hex"));
    expect(await computeConditionalCommitFingerprint(fingerprintInput("key"))).toBe(TS_DIGEST);
    expect(await computeConditionalCommitFingerprint(fingerprintInput("other"))).not.toBe(TS_DIGEST);
    expect(CONDITIONAL_COMMIT_DERIVATION_VERSION).toBe(2);
    expect(CONDITIONAL_COMMIT_CANONICALIZATION_VERSION).toBe(1);
    expect(CONDITIONAL_COMMIT_DOMAIN_SEPARATOR).toBe("sekiban.dcb.conditional-append.unique-key");
  });

  it("pins the test-private two-tag .NET vector", async () => {
    const preimage = dotNetParityPreimage();
    expect(preimage.byteLength).toBe(119);
    expect(hex(preimage)).toBe(DOTNET_PREIMAGE);
    const buffer = new ArrayBuffer(preimage.byteLength);
    new Uint8Array(buffer).set(preimage);
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    expect(hex(new Uint8Array(digest))).toBe(DOTNET_DIGEST);
  });

  it("keeps a valid surrogate pair distinct from U+FFFD", async () => {
    expect(await computeConditionalCommitFingerprint(fingerprintInput("\uD83D\uDE00"))).toBe(PAIR_DIGEST);
    expect(await computeConditionalCommitFingerprint(fingerprintInput("\uFFFD"))).toBe(REPLACEMENT_DIGEST);
    await expect(computeConditionalCommitFingerprint(fingerprintInput("\uD800"))).rejects.toMatchObject({ code: "conditional_commit_invalid_key" });
    await expect(computeConditionalCommitFingerprint(fingerprintInput("\uDC00"))).rejects.toMatchObject({ code: "conditional_commit_invalid_key" });
  });

  it("rejects signed Int32 length overflow before copying payload bytes", () => {
    const payload = new Uint8Array(0);
    Object.defineProperty(payload, "byteLength", { value: 2_147_483_648 });
    expectCode(() => conditionalCommitFingerprintPreimage({ ...fingerprintInput("key"), canonicalPayload: payload }), "conditional_commit_size_limit_exceeded");
    expectCode(() => conditionalCommitFingerprintPreimage({ ...fingerprintInput("key"), serviceId: "" }), "conditional_commit_invalid_envelope");
    expectCode(() => conditionalCommitFingerprintPreimage({ ...fingerprintInput("key"), eventPayloadName: "" }), "conditional_commit_invalid_candidate");
    expectCode(() => conditionalCommitFingerprintPreimage({ ...fingerprintInput("key"), tag: "" }), "conditional_commit_invalid_candidate");
  });
});

describe("conditional commit request parser", () => {
  it("returns a fresh extensible request and normalizes the key", () => {
    const parsed = parseSerializedConditionalCommitRequest(request({ idempotencyKey: "\u0085 key \u0085" }));
    expect(parsed).toEqual({
      version: 1,
      idempotencyKey: "key",
      eventCandidate: { payload: base64("{}"), eventPayloadName: "Evt", tags: ["T:1"] },
    });
    expect(Object.isExtensible(parsed)).toBe(true);
    expect(Object.isExtensible(parsed.eventCandidate)).toBe(true);
    expect(Object.isFrozen(parsed)).toBe(false);
    expect(Object.isFrozen(parsed.eventCandidate.tags)).toBe(false);
    const body = parseSerializedConditionalCommitRequestBody(JSON.stringify(request()));
    expect(body.idempotencyKey).toBe("key");
    expect(Object.isExtensible(body)).toBe(true);
  });

  it("rejects closed-envelope, version, base64, UTF-8, JSON, root, and tag failures", () => {
    const cases: Array<[unknown, ConditionalCommitValidationCode]> = [
      ["{", "conditional_commit_invalid_json"],
      [{ version: 1, idempotencyKey: "key", extra: true, eventCandidate: request().eventCandidate }, "conditional_commit_unknown_member"],
      [{ version: 2, idempotencyKey: "key", eventCandidate: request().eventCandidate }, "conditional_commit_invalid_version"],
      [null, "conditional_commit_invalid_envelope"],
      [{ version: 1, eventCandidate: request().eventCandidate }, "conditional_commit_invalid_envelope"],
      [{ version: 1, idempotencyKey: "\uD800", eventCandidate: request().eventCandidate }, "conditional_commit_invalid_key"],
      [{ version: 1, idempotencyKey: "key", eventCandidate: [] }, "conditional_commit_invalid_candidate"],
      [request({ eventCandidate: { ...request().eventCandidate, payload: "e30" } }), "conditional_commit_invalid_base64"],
      [request({ eventCandidate: { ...request().eventCandidate, payload: Buffer.from([0xff]).toString("base64") } }), "conditional_commit_invalid_utf8"],
      [request({ eventCandidate: { ...request().eventCandidate, payload: base64("{") } }), "conditional_commit_invalid_payload_json"],
      [request({ eventCandidate: { ...request().eventCandidate, payload: base64("[]") } }), "conditional_commit_payload_root_not_object"],
      [request({ eventCandidate: { ...request().eventCandidate, tags: [] } }), "conditional_commit_invalid_tag_count"],
      [request({ eventCandidate: { ...request().eventCandidate, tags: ["A:1", "B:2"] } }), "conditional_commit_invalid_tag_count"],
      [request({ eventCandidate: { ...request().eventCandidate, eventPayloadName: "a".repeat(513) } }), "conditional_commit_size_limit_exceeded"],
    ];
    for (const [value, code] of cases) {
      if (typeof value === "string") expectCode(() => parseSerializedConditionalCommitRequestBody(value), code);
      else expectCode(() => parseSerializedConditionalCommitRequest(value), code);
    }
    const symbolic = request();
    Object.defineProperty(symbolic, Symbol("extra"), { value: 1, enumerable: true });
    expectCode(() => parseSerializedConditionalCommitRequest(symbolic), "conditional_commit_unknown_member");
  });

  it("checks raw body, raw JSON, and canonical payload limits independently", () => {
    expect(CONDITIONAL_COMMIT_VERSION).toBe(1);
    expect(CONDITIONAL_COMMIT_MAX_REQUEST_BYTES).toBe(320 * 1024);
    expect(CONDITIONAL_COMMIT_MAX_PAYLOAD_BYTES).toBe(192 * 1024);
    const tooLarge = new Uint8Array(CONDITIONAL_COMMIT_MAX_REQUEST_BYTES + 1);
    expectCode(() => parseSerializedConditionalCommitRequestBody(tooLarge), "conditional_commit_size_limit_exceeded");
    const raw = `{"a":"x",${" ".repeat(CONDITIONAL_COMMIT_MAX_PAYLOAD_BYTES)}"b":1}`;
    expect(Buffer.byteLength(raw)).toBeGreaterThan(CONDITIONAL_COMMIT_MAX_PAYLOAD_BYTES);
    expectCode(
      () => parseSerializedConditionalCommitRequest(request({ eventCandidate: { ...request().eventCandidate, payload: base64(raw) } })),
      "conditional_commit_size_limit_exceeded",
    );
    expect(text(canonicalizeConditionalCommitPayload(JSON.parse(raw)))).toBe('{"a":"x","b":1}');
  });
});
