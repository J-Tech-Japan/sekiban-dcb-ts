import { describe, expect, it, vi } from "vitest";
import { defineEvent, type EventDefinition, type JsonValue } from "../packages/dcb-core/src/index";
import { failureKindForCode } from "../packages/dcb-client/src/classification";
import {
  commitPreparedConditionallyThroughTransport,
  prepareConditionalCommit,
  type PreparedConditionalCommit,
} from "../packages/dcb-client/src/conditionalCommit";
import { ClientError, sanitizeTransportError } from "../packages/dcb-client/src/errors";
import {
  SerializedDcbClient,
  createHttpTransport,
  createInProcessTransport,
  createSekibanExecutor,
  type SerializedDcbTransport,
} from "../packages/dcb-client/src/index";

const WINNER = "01890a5d-ac96-774b-bcce-b302099a8057";
const CAUSE = "01890a5d-ac96-7c3e-8f2a-b302099a8058";
const SUID = "000000000000000000000000000001";
const FINGERPRINT = "d42ee2bee3ace179f06f3f46a9dbd5a1556a6e71b0be8e5559222293714f54f6";
const PAYLOAD = "e30=";

const VALIDATION: Readonly<Record<string, string>> = {
  conditional_commit_invalid_json: "The request body is not valid JSON.",
  conditional_commit_unknown_member: "The request contains an unknown member.",
  conditional_commit_invalid_version: "The conditional commit version is not supported.",
  conditional_commit_invalid_envelope: "The conditional commit envelope is invalid.",
  conditional_commit_invalid_key: "The idempotency key is invalid.",
  conditional_commit_invalid_candidate: "The event candidate is invalid.",
  conditional_commit_invalid_base64: "The event payload is not valid base64.",
  conditional_commit_invalid_utf8: "The event payload is not valid UTF-8.",
  conditional_commit_invalid_payload_json: "The event payload is not valid JSON.",
  conditional_commit_payload_root_not_object: "The event payload root must be a plain object.",
  conditional_commit_payload_not_canonicalizable: "The event payload cannot be canonicalized.",
  conditional_commit_event_not_registered: "The event payload name is not registered.",
  conditional_commit_invalid_tag_count: "Conditional commit requires exactly one tag.",
  conditional_commit_size_limit_exceeded: "The conditional commit request exceeds a size limit.",
};

const REASONS = [
  "winner_unreadable",
  "ambiguous_after_append",
  "committed_state_unverified",
  "live_precondition_blocked",
  "bootstrap_epoch_changed",
] as const;

function eventReturning(parse: (payload: unknown) => JsonValue): EventDefinition {
  return {
    name: "Evt",
    eventName: "Evt",
    eventPayloadName: "Evt",
    eventType: "Evt",
    create: () => { throw new Error("unused"); },
    construct: () => { throw new Error("unused"); },
    parse,
  };
}

function prepare(parse: (payload: unknown) => JsonValue = () => ({ roomId: "1" }), idempotencyKey = "key") {
  return prepareConditionalCommit({
    idempotencyKey,
    event: eventReturning(parse),
    payload: { roomId: "raw" },
    tag: "T:1",
  });
}

function transport(member?: SerializedDcbTransport["conditionalCommit"]): SerializedDcbTransport & { commit: ReturnType<typeof vi.fn> } {
  const commit = vi.fn(async () => { throw new Error("v1-commit"); });
  return {
    readTagState: async () => { throw new Error("unused"); },
    commit,
    query: async () => ({ resultJson: "{}" }),
    listQuery: async () => ({ itemsJson: "[]", totalCount: 0, totalPages: 0, currentPage: 1, pageSize: 20 }),
    ...(member === undefined ? {} : { conditionalCommit: member }),
  };
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    winnerEventId: WINNER,
    winnerSortableUniqueId: SUID,
    operationFingerprint: FINGERPRINT,
    ...overrides,
  };
}

function written(overrides: Record<string, unknown> = {}) {
  return {
    payload: PAYLOAD,
    sortableUniqueIdValue: SUID,
    id: WINNER,
    eventMetadata: {
      causationId: CAUSE,
      correlationId: "SerializedCommit",
      executedUser: "SerializedSekibanExecutor",
    },
    tags: ["T:1"],
    eventPayloadName: "Evt",
    ...overrides,
  };
}

function appended(overrides: Record<string, unknown> = {}) {
  return { version: 1, outcome: "Appended", receipt: receipt(), writtenEvents: [written()], ...overrides };
}

function already() {
  return { version: 1, outcome: "AlreadyCommittedSameOperation", receipt: receipt(), writtenEvents: [] };
}

function conflict() {
  return {
    version: 1,
    outcome: "KeyReuseConflict",
    code: "conditional_commit_key_reuse_conflict",
    error: "The idempotency key is already bound to a different operation.",
    retryable: false,
  };
}

function unsupported() {
  return {
    version: 1,
    outcome: "Unsupported",
    code: "conditional_commit_unsupported",
    error: "Conditional commit is not supported by this deployment.",
    retryable: false,
  };
}

function validationBody(code: string) {
  return { version: 1, code, error: VALIDATION[code], retryable: false };
}

function inDoubt(reason: string) {
  return {
    version: 1,
    code: "conditional_commit_in_doubt",
    error: "The conditional commit outcome is not yet verified; resend the same prepared request.",
    retryable: true,
    reason,
  };
}

function corrupt() {
  return {
    version: 1,
    code: "conditional_commit_committed_state_corrupt",
    error: "The durable conditional commit state could not be verified.",
    retryable: false,
  };
}

async function clientError(action: () => Promise<unknown>): Promise<ClientError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(ClientError);
    return error as ClientError;
  }
  throw new Error("expected ClientError");
}

describe("conditional commit preparation", () => {
  it("canonicalizes the single parser result before encoding and freezes the branded graph", () => {
    let parses = 0;
    let reads = 0;
    const prepared = prepareConditionalCommit({
      idempotencyKey: "\u0085 key \u0085",
      event: eventReturning((payload) => {
        parses += 1;
        expect(payload).toEqual({ roomId: "raw" });
        return { "10": 1, "2": 2 };
      }),
      payload: { roomId: "raw" },
      tag: { get group() { reads += 1; return "T"; }, get content() { reads += 1; return "1"; } },
    });
    expect(parses).toBe(1);
    expect(reads).toBe(2);
    expect(prepared.idempotencyKey).toBe("key");
    expect(prepared.eventCandidate.tags).toEqual(["T:1"]);
    expect(Buffer.from(prepared.eventCandidate.payload, "base64").toString("utf8")).toBe('{"10":1,"2":2}');
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.eventCandidate)).toBe(true);
    expect(Object.isFrozen(prepared.eventCandidate.tags)).toBe(true);
    expect(() => { (prepared as { idempotencyKey: string }).idempotencyKey = "other"; }).toThrow(TypeError);
  });

  it("adds the brand while the core result is still extensible", () => {
    const defineProperty = Object.defineProperty;
    const freeze = Object.freeze;
    const seen: string[] = [];
    Object.defineProperty = function (target: object, key: PropertyKey, descriptor: PropertyDescriptor) {
      if (typeof key === "symbol") seen.push(Object.isExtensible(target) ? "brand-extensible" : "brand-sealed");
      return defineProperty(target, key, descriptor);
    } as typeof Object.defineProperty;
    Object.freeze = function <T>(target: T) {
      seen.push("freeze");
      return freeze(target);
    } as typeof Object.freeze;
    try {
      prepare();
    } finally {
      Object.defineProperty = defineProperty;
      Object.freeze = freeze;
    }
    const brandAt = seen.indexOf("brand-extensible");
    expect(brandAt).toBeGreaterThanOrEqual(0);
    expect(seen.includes("brand-sealed")).toBe(false);
    expect(seen.slice(brandAt + 1).includes("freeze")).toBe(true);
  });

  it("does not invoke a parser-output getter and rejects symbol, non-enumerable, and accessor members", () => {
    let gets = 0;
    const accessor = { ok: true };
    Object.defineProperty(accessor, "secret", { enumerable: true, get() { gets += 1; return "x"; } });
    expect(() => prepare(() => accessor)).toThrow(ClientError);
    expect(gets).toBe(0);
    const symbolic: Record<PropertyKey, unknown> = { ok: true };
    symbolic[Symbol("s")] = 1;
    expect(() => prepare(() => symbolic as JsonValue)).toThrow(ClientError);
    const hidden = {};
    Object.defineProperty(hidden, "secret", { value: 1, enumerable: false });
    expect(() => prepare(() => hidden)).toThrow(ClientError);
    try {
      prepare(() => { throw new Error("secret-parser-boom"); });
      throw new Error("accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(ClientError);
      const client = error as ClientError;
      expect(client.code).toBe("conditional_commit_invalid_candidate");
      expect(client.message).toBe(VALIDATION.conditional_commit_invalid_candidate);
      expect(client.cause).toBeUndefined();
      expect(client.retryable).toBeUndefined();
      expect(JSON.stringify(client)).not.toContain("secret-parser-boom");
    }
    expect(() => prepareConditionalCommit({
      idempotencyKey: "key",
      event: eventReturning(() => ({ ok: true })),
      payload: {},
      tag: "not-a-tag",
    })).toThrow(ClientError);
  });

  it("prepares a defineEvent payload and exposes no rebrand function", async () => {
    const event = defineEvent<{ readonly roomId: string }>("RoomOpened");
    const prepared = prepareConditionalCommit({
      idempotencyKey: "key",
      event,
      payload: { roomId: "room-1" },
      tag: "room:room-1",
    });
    expect(Buffer.from(prepared.eventCandidate.payload, "base64").toString("utf8")).toBe('{"roomId":"room-1"}');
    const client = await import("../packages/dcb-client/src/index");
    expect(client).not.toHaveProperty("deserializePreparedConditionalCommit");
    expect(client).not.toHaveProperty("serializePreparedConditionalCommit");
    const cast = {
      version: 1,
      idempotencyKey: prepared.idempotencyKey,
      eventCandidate: prepared.eventCandidate,
    } as PreparedConditionalCommit;
    const member = vi.fn();
    await expect(commitPreparedConditionallyThroughTransport(transport(member), cast)).rejects.toBeInstanceOf(ClientError);
    expect(member).not.toHaveBeenCalled();
  });
});

describe("dormant conditional transport", () => {
  it("returns one frozen Unsupported result without fetch or V1 commit", async () => {
    const fetchImpl = vi.fn();
    const client = new SerializedDcbClient("https://example.test", fetchImpl);
    const http = createHttpTransport({ baseUrl: "https://example.test", fetch: fetchImpl });
    const inProcess = createInProcessTransport({ fetch: fetchImpl });
    const executor = createSekibanExecutor(http);
    const clientTransport: SerializedDcbTransport = client;
    expect(clientTransport.conditionalCommit).toBeUndefined();
    expect(http.conditionalCommit).toBeUndefined();
    expect(inProcess.conditionalCommit).toBeUndefined();
    expect("prepareConditionalCommit" in executor).toBe(false);
    expect("commitPreparedConditionally" in executor).toBe(false);
    const target = transport();
    const prepared = prepare();
    const first = await commitPreparedConditionallyThroughTransport(target, prepared);
    const second = await commitPreparedConditionallyThroughTransport(target, prepared);
    expect(first).toBe(second);
    expect(first).toEqual({
      version: 1,
      outcome: "Unsupported",
      code: "conditional_commit_unsupported",
      error: "Conditional commit is not supported by this deployment.",
      retryable: false,
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(target.commit).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("passes the same prepared object and signal once per explicit call", async () => {
    let parses = 0;
    const prepared = prepare(() => { parses += 1; return { ok: true }; });
    const signal = new AbortController().signal;
    const seen: Array<{ request: unknown; signal: AbortSignal | undefined }> = [];
    const member = vi.fn(async (request: unknown, received?: AbortSignal) => {
      seen.push({ request, signal: received });
      return seen.length === 1
        ? { status: 503, body: inDoubt("winner_unreadable") }
        : { status: 200, body: already() };
    });
    const target = transport(member);
    await expect(commitPreparedConditionallyThroughTransport(target, prepared, { signal })).rejects.toMatchObject({
      code: "conditional_commit_in_doubt",
      retryable: true,
      reason: "winner_unreadable",
    });
    const second = await commitPreparedConditionallyThroughTransport(target, prepared, { signal });
    expect(second.outcome).toBe("AlreadyCommittedSameOperation");
    expect(member).toHaveBeenCalledTimes(2);
    expect(Object.is(seen[0]?.request, prepared)).toBe(true);
    expect(Object.is(seen[1]?.request, prepared)).toBe(true);
    expect(seen[0]?.signal).toBe(signal);
    expect(parses).toBe(1);
    expect(target.commit).not.toHaveBeenCalled();
  });

  it("keeps a custom transport 404 on the ordinary error path", async () => {
    const member = vi.fn(async () => ({
      status: 404,
      headers: { authorization: "secret-header" },
      body: { error: "secret-payload", retryable: true, reason: "winner_unreadable" },
    }));
    const target = transport(member);
    const error = await clientError(() => commitPreparedConditionallyThroughTransport(target, prepare()));
    expect(error.code).toBe("http_error");
    expect(error.retryable).toBeUndefined();
    expect(error.reason).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("secret");
    expect(error.message).not.toContain("secret");
    expect(target.commit).not.toHaveBeenCalled();
    expect(member).toHaveBeenCalledTimes(1);
  });
});

describe("conditional commit responses", () => {
  it("accepts exact 201 and 200 bodies and checks receipt coherence", async () => {
    const member = vi.fn()
      .mockResolvedValueOnce({ status: 201, body: appended() })
      .mockResolvedValueOnce({ status: 200, body: already() })
      .mockResolvedValueOnce({ status: 409, body: conflict() })
      .mockResolvedValueOnce({ status: 501, body: unsupported() });
    const target = transport(member);
    const prepared = prepare();
    const appendedResult = await commitPreparedConditionallyThroughTransport(target, prepared);
    expect(appendedResult.outcome).toBe("Appended");
    if (appendedResult.outcome === "Appended") {
      expect(appendedResult.writtenEvents[0].id).toBe(appendedResult.receipt.winnerEventId);
      expect(appendedResult.writtenEvents[0].sortableUniqueIdValue).toBe(appendedResult.receipt.winnerSortableUniqueId);
    }
    await expect(commitPreparedConditionallyThroughTransport(target, prepared)).resolves.toMatchObject({ outcome: "AlreadyCommittedSameOperation", writtenEvents: [] });
    await expect(commitPreparedConditionallyThroughTransport(target, prepared)).resolves.toMatchObject({ outcome: "KeyReuseConflict", retryable: false });
    await expect(commitPreparedConditionallyThroughTransport(target, prepared)).resolves.toMatchObject({ outcome: "Unsupported", code: "conditional_commit_unsupported" });
  });

  it.each(Object.entries(VALIDATION))("maps 400 %s with absent retry fields", async (code, message) => {
    const error = await clientError(() => commitPreparedConditionallyThroughTransport(
      transport(async () => ({ status: 400, body: validationBody(code) })),
      prepare(),
    ));
    expect(error.code).toBe(code);
    expect(error.message).toBe(message);
    expect(error.status).toBe(400);
    expect(error.retryable).toBeUndefined();
    expect(error.reason).toBeUndefined();
    expect(failureKindForCode(code)).toBe("invalid");
  });

  it.each(REASONS)("maps 503 reason %s", async (reason) => {
    const error = await clientError(() => commitPreparedConditionallyThroughTransport(
      transport(async () => ({ status: 503, body: inDoubt(reason) })),
      prepare(),
    ));
    expect(error.code).toBe("conditional_commit_in_doubt");
    expect(error.message).toBe("The conditional commit outcome is not yet verified; resend the same prepared request.");
    expect(error.status).toBe(503);
    expect(error.retryable).toBe(true);
    expect(error.reason).toBe(reason);
    expect(failureKindForCode(error.code)).toBe("unavailable");
  });

  it("maps exact 500 with absent retry fields", async () => {
    const error = await clientError(() => commitPreparedConditionallyThroughTransport(
      transport(async () => ({ status: 500, body: corrupt() })),
      prepare(),
    ));
    expect(error.code).toBe("conditional_commit_committed_state_corrupt");
    expect(error.message).toBe("The durable conditional commit state could not be verified.");
    expect(error.status).toBe(500);
    expect(error.retryable).toBeUndefined();
    expect(error.reason).toBeUndefined();
    expect(failureKindForCode(error.code)).toBe("unavailable");
  });

  it("rejects unknown members, wrong literals, cardinality, and malformed identifiers", async () => {
    const cases = [
      { status: 201, body: { ...appended(), extra: true } },
      { status: 201, body: appended({ receipt: { ...receipt(), extra: true } }) },
      { status: 201, body: appended({ writtenEvents: [{ ...written(), extra: true }] }) },
      { status: 201, body: appended({ writtenEvents: [written({ eventMetadata: { causationId: CAUSE, correlationId: "SerializedCommit", executedUser: "SerializedSekibanExecutor", extra: true } })] }) },
      { status: 201, body: appended({ writtenEvents: [written({ eventMetadata: { causationId: CAUSE, correlationId: "Other", executedUser: "SerializedSekibanExecutor" } })] }) },
      { status: 201, body: appended({ writtenEvents: [] }) },
      { status: 200, body: { ...already(), writtenEvents: [written()] } },
      { status: 201, body: appended({ receipt: receipt({ winnerEventId: CAUSE }) }) },
      { status: 201, body: appended({ receipt: receipt({ operationFingerprint: FINGERPRINT.toUpperCase() }) }) },
      { status: 201, body: appended({ writtenEvents: [written({ id: "not-a-uuid" })] }) },
      { status: 201, body: appended({ writtenEvents: [written({ payload: "e30" })] }) },
      { status: 202, body: appended() },
      { status: 400, body: { ...validationBody("conditional_commit_invalid_key"), extra: true } },
      { status: 400, body: { ...validationBody("conditional_commit_invalid_key"), error: "nope" } },
      { status: 409, body: { ...conflict(), extra: true } },
      { status: 501, body: { ...unsupported(), extra: true } },
      { status: 500, body: { ...corrupt(), retryable: true } },
      { status: 503, body: { ...inDoubt("winner_unreadable"), reason: "other" } },
    ];
    for (const http of cases) {
      const error = await clientError(() => commitPreparedConditionallyThroughTransport(
        transport(async () => http),
        prepare(),
      ));
      expect(["conditional_commit_invalid_response", "conditional_commit_invalid_error_response"]).toContain(error.code);
      expect(error.retryable).toBeUndefined();
      expect(error.reason).toBeUndefined();
      expect(failureKindForCode(error.code)).toBe("transport");
      expect(JSON.stringify(error)).not.toContain("secret");
    }
  });
});

describe("conditional commit classification", () => {
  it("classifies every conditional code", () => {
    for (const code of Object.keys(VALIDATION)) expect(failureKindForCode(code)).toBe("invalid");
    expect(failureKindForCode("conditional_commit_key_reuse_conflict")).toBe("conflict");
    expect(failureKindForCode("conditional_commit_unsupported")).toBe("invalid");
    expect(failureKindForCode("conditional_commit_in_doubt")).toBe("unavailable");
    expect(failureKindForCode("conditional_commit_committed_state_corrupt")).toBe("unavailable");
    expect(failureKindForCode("conditional_commit_invalid_response")).toBe("transport");
    expect(failureKindForCode("conditional_commit_invalid_error_response")).toBe("transport");
  });

  it("invalid-key stays invalid with the canonical safe message", async () => {
    await Promise.resolve();
    const error = sanitizeTransportError({ code: "conditional_commit_invalid_key", message: "secret-key-value" });
    expect(error.code).toBe("conditional_commit_invalid_key");
    expect(error.message).toBe("The idempotency key is invalid.");
    expect(failureKindForCode(error.code)).toBe("invalid");
    expect(error.message).not.toContain("secret-key-value");
  });

  it("in-doubt stays unavailable with the validated reason", async () => {
    const error = await clientError(() => commitPreparedConditionallyThroughTransport(
      transport(async () => ({ status: 503, body: inDoubt("ambiguous_after_append") })),
      prepare(),
    ));
    expect(error.reason).toBe("ambiguous_after_append");
    expect(error.retryable).toBe(true);
    expect(failureKindForCode(error.code)).toBe("unavailable");
    const sanitized = sanitizeTransportError({ code: "conditional_commit_in_doubt", message: "foreign" });
    expect(sanitized.message).toBe("The conditional commit outcome is not yet verified; resend the same prepared request.");
  });

  it("corrupt stays unavailable without public retry fields", async () => {
    const error = await clientError(() => commitPreparedConditionallyThroughTransport(
      transport(async () => ({ status: 500, body: corrupt() })),
      prepare(),
    ));
    expect(error.retryable).toBeUndefined();
    expect(error.reason).toBeUndefined();
    expect(failureKindForCode(error.code)).toBe("unavailable");
    const sanitized = sanitizeTransportError({ code: "conditional_commit_committed_state_corrupt", message: "foreign" });
    expect(sanitized.code).toBe("conditional_commit_committed_state_corrupt");
    expect(sanitized.message).toBe("The durable conditional commit state could not be verified.");
  });

  it("malformed response stays transport", async () => {
    const error = await clientError(() => commitPreparedConditionallyThroughTransport(
      transport(async () => ({ status: 201, body: { version: 1 } })),
      prepare(),
    ));
    expect(error.code).toBe("conditional_commit_invalid_response");
    expect(failureKindForCode(error.code)).toBe("transport");
    const sanitized = sanitizeTransportError({ code: "conditional_commit_invalid_response", message: "foreign" });
    expect(sanitized.code).toBe("conditional_commit_invalid_response");
    expect(sanitized.message).toBe("The conditional commit response is invalid.");
  });

  it("retryable/reason stay absent when sanitizing foreign transport errors", async () => {
    await Promise.resolve();
    const error = sanitizeTransportError({
      status: 404,
      retryable: true,
      reason: "winner_unreadable",
      message: "secret",
      body: { retryable: true, reason: "winner_unreadable" },
    });
    expect(error.retryable).toBeUndefined();
    expect(error.reason).toBeUndefined();
  });

  it("foreign-detail redaction omits raw key payload header and cause", async () => {
    await Promise.resolve();
    const error = sanitizeTransportError({
      code: "conditional_commit_invalid_key",
      message: "secret-key-value",
      headers: { authorization: "secret-header" },
      cause: new Error("secret-cause"),
      body: { code: "conditional_commit_invalid_key", error: "secret-payload", key: "secret-key-value" },
    });
    expect(error.message).toBe("The idempotency key is invalid.");
    expect(error.message).not.toContain("secret");
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("secret");
  });
});
