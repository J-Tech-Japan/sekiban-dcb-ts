import { describe, expect, it } from "vitest";
import type { ListQueryContract, QueryContract, QueryJsonValue } from "@sekiban/dcb-core";
import {
  ClientError,
  createSekibanExecutor,
  type ListQueryRequest,
  type ListQueryResponse,
  type QueryRequest,
  type QueryResponse,
  type SerializedDcbTransport,
} from "../packages/dcb-client/src/index.js";
import { classifyFailure } from "../packages/dcb-client/src/classification.js";

interface ScalarParams { readonly room: string }
interface ScalarResult { readonly count: number }
interface ListItem { readonly label: string }

function scalarContract(overrides: {
  readonly encode?: (value: ScalarParams) => QueryJsonValue;
  readonly decode?: (value: unknown) => ScalarResult;
} = {}): QueryContract<ScalarParams, ScalarResult> & { readonly version: number } {
  return {
    kind: "query",
    id: "count-query",
    version: 7,
    params: {
      encode: overrides.encode ?? ((value) => ({ room_id: value.room.trim().toUpperCase() })),
      decode: () => { throw new Error("params-decode-used"); },
    },
    result: {
      encode: () => { throw new Error("result-encode-used"); },
      decode: overrides.decode ?? ((value) => ({ count: Number((value as { count_text: string }).count_text) })),
    },
  };
}

function listContract(overrides: {
  readonly encode?: (value: { readonly roomId?: string }) => QueryJsonValue;
  readonly decode?: (value: unknown) => ListItem;
} = {}): ListQueryContract<{ readonly roomId?: string }, ListItem> {
  return {
    kind: "list-query",
    id: "list-query",
    version: 3,
    params: {
      encode: overrides.encode ?? ((value): QueryJsonValue => (value.roomId === undefined ? {} : { room_id: value.roomId })),
      decode: () => { throw new Error("params-decode-used"); },
    },
    item: {
      encode: () => { throw new Error("item-encode-used"); },
      decode: overrides.decode ?? ((value) => ({ label: (value as { label_text: string }).label_text })),
    },
  };
}

function transport(handlers: {
  readonly query?: SerializedDcbTransport["query"];
  readonly listQuery?: SerializedDcbTransport["listQuery"];
  readonly serviceId?: string;
} = {}): SerializedDcbTransport {
  return {
    serviceId: handlers.serviceId,
    readTagState: async () => { throw new Error("unused-read"); },
    commit: async () => { throw new Error("unused-commit"); },
    query: handlers.query ?? (async () => ({ resultJson: JSON.stringify({ count_text: "0" }) })),
    listQuery: handlers.listQuery ?? (async () => ({
      itemsJson: "[]",
      totalCount: 0,
      totalPages: 0,
      currentPage: 1,
      pageSize: 20,
    })),
  };
}

function publicFields(error: ClientError): Record<string, unknown> {
  return {
    name: error.name,
    code: error.code,
    message: error.message,
    status: error.status,
    partial: error.partial,
    cause: error.cause,
  };
}

describe("typed query client", () => {
  it("query_params_encode_failed stays a sanitized local client error", async () => {
    let calls = 0;
    const executor = createSekibanExecutor(transport({
      query: async () => {
        calls += 1;
        return { resultJson: "{}" };
      },
    }));
    const error = await executor.query(scalarContract({
      encode: () => { throw new Error("codec-secret-token"); },
    }), { room: "ab" }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ClientError);
    const clientError = error as ClientError;
    expect(publicFields(clientError)).toEqual({
      name: "ClientError",
      code: "query_params_encode_failed",
      message: "The query parameters could not be encoded.",
      status: undefined,
      partial: undefined,
      cause: undefined,
    });
    expect(JSON.stringify(publicFields(clientError))).not.toContain("codec-secret-token");
    expect(clientError.stack ?? "").not.toContain("codec-secret-token");
    expect(classifyFailure(clientError)).toMatchObject({ kind: "invalid", code: "query_params_encode_failed" });
    expect(calls).toBe(0);
  });

  it("query_result_decode_failed stays a sanitized local client error", async () => {
    const executor = createSekibanExecutor(transport({
      listQuery: async () => ({
        itemsJson: JSON.stringify([{ label_text: "kept" }, { label_text: "drop" }]),
        totalCount: 2,
        totalPages: 1,
        currentPage: 1,
        pageSize: 2,
        readHead: "head-secret",
      }),
    }));
    let decoded = 0;
    const error = await executor.listQuery(listContract({
      decode: (value) => {
        decoded += 1;
        if (decoded === 2) throw new Error("item-secret-token");
        return { label: (value as { label_text: string }).label_text };
      },
    }), {}).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ClientError);
    const clientError = error as ClientError;
    expect(publicFields(clientError)).toEqual({
      name: "ClientError",
      code: "query_result_decode_failed",
      message: "The query response could not be decoded.",
      status: undefined,
      partial: undefined,
      cause: undefined,
    });
    expect(JSON.stringify(publicFields(clientError))).not.toContain("item-secret-token");
    expect(JSON.stringify(publicFields(clientError))).not.toContain("head-secret");
    expect(classifyFailure(clientError)).toMatchObject({ kind: "unavailable", code: "query_result_decode_failed" });
    expect(decoded).toBe(2);
  });

  it("encodes params before transport and decodes the scalar result", async () => {
    const seen: QueryRequest[] = [];
    const signals: Array<AbortSignal | undefined> = [];
    const signal = new AbortController().signal;
    const executor = createSekibanExecutor(transport({
      query: async (request, requestSignal) => {
        seen.push(request);
        signals.push(requestSignal);
        return { resultJson: JSON.stringify({ count_text: "4" }) };
      },
    }));
    let encodes = 0;
    const result = await executor.query(scalarContract({
      encode: (value) => {
        encodes += 1;
        return { room_id: value.room.trim().toUpperCase() };
      },
    }), { room: " ab " }, { waitForSortableUniqueId: "wait-1", signal });
    expect(result).toEqual({ count: 4 });
    expect(encodes).toBe(1);
    expect(seen).toEqual([{
      queryType: "count-query",
      queryParamsJson: JSON.stringify({ room_id: "AB" }),
      waitForSortableUniqueId: "wait-1",
    }]);
    expect(signals).toEqual([signal]);
    expect(JSON.stringify(seen[0])).not.toContain("\"version\"");
    expect(JSON.stringify(seen[0])).not.toContain("signal");
  });

  it("maps list controls separately and decodes every item into one page", async () => {
    const seen: ListQueryRequest[] = [];
    const signal = new AbortController().signal;
    const signals: Array<AbortSignal | undefined> = [];
    const executor = createSekibanExecutor(transport({
      listQuery: async (request, requestSignal) => {
        seen.push(request);
        signals.push(requestSignal);
        return {
          itemsJson: JSON.stringify([{ label_text: "one" }, { label_text: "two" }]),
          totalCount: 9,
          totalPages: 3,
          currentPage: 2,
          pageSize: 2,
          readHead: "head-2",
        };
      },
    }));
    let decoded = 0;
    const page = await executor.listQuery(listContract({
      decode: (value) => {
        decoded += 1;
        return { label: (value as { label_text: string }).label_text };
      },
    }), { roomId: "room-1" }, {
      pageNumber: 2,
      pageSize: 2,
      descending: true,
      consistency: "unsafe",
      waitForSortableUniqueId: "wait-2",
      signal,
    });
    expect(decoded).toBe(2);
    expect(page).toEqual({
      items: [{ label: "one" }, { label: "two" }],
      totalCount: 9,
      totalPages: 3,
      currentPage: 2,
      pageSize: 2,
      readHead: "head-2",
    });
    expect(seen[0]).toEqual({
      queryType: "list-query",
      queryParamsJson: JSON.stringify({
        room_id: "room-1",
        PageNumber: 2,
        PageSize: 2,
        NewestFirst: true,
        consistency: "unsafe",
      }),
      waitForSortableUniqueId: "wait-2",
    });
    expect(signals).toEqual([signal]);
    expect(JSON.parse(seen[0]!.queryParamsJson)).not.toHaveProperty("signal");
    expect(JSON.parse(seen[0]!.queryParamsJson)).not.toHaveProperty("waitForSortableUniqueId");
  });

  it("omits list controls that the caller omitted", async () => {
    const seen: ListQueryRequest[] = [];
    const executor = createSekibanExecutor(transport({
      listQuery: async (request) => {
        seen.push(request);
        return { itemsJson: "[]", totalCount: 0, totalPages: 0, currentPage: 1, pageSize: 20 };
      },
    }));
    await executor.listQuery(listContract({ encode: () => ({ room_id: "room-9" }) }), {});
    expect(JSON.parse(seen[0]!.queryParamsJson)).toEqual({ room_id: "room-9" });
    expect(seen[0]).not.toHaveProperty("waitForSortableUniqueId");
  });

  it("rejects a reserved encoded key before transport", async () => {
    let calls = 0;
    const executor = createSekibanExecutor(transport({
      listQuery: async () => {
        calls += 1;
        return { itemsJson: "[]", totalCount: 0, totalPages: 0, currentPage: 1, pageSize: 20 };
      },
    }));
    await expect(executor.listQuery(listContract({ encode: () => ({ pageNumber: 1 }) }), {})).rejects.toMatchObject({
      code: "query_params_encode_failed",
      message: "The query parameters could not be encoded.",
    });
    expect(calls).toBe(0);
  });

  it("rejects a non-object, thenable, or unserializable encoded value", async () => {
    const executor = createSekibanExecutor(transport());
    await expect(executor.query(scalarContract({ encode: () => "text" }), { room: "a" })).rejects.toMatchObject({
      code: "query_params_encode_failed",
    });
    await expect(executor.query(scalarContract({ encode: () => Promise.resolve({ room_id: "A" }) as unknown as QueryJsonValue }), { room: "a" })).rejects.toMatchObject({
      code: "query_params_encode_failed",
    });
    const circular: { self?: QueryJsonValue } = {};
    circular.self = circular;
    await expect(executor.query(scalarContract({ encode: () => circular }), { room: "a" })).rejects.toMatchObject({
      code: "query_params_encode_failed",
    });
  });

  it("rejects malformed result JSON, a non-array page, and a thenable item", async () => {
    const badJson = createSekibanExecutor(transport({ query: async () => ({ resultJson: "{" }) }));
    await expect(badJson.query(scalarContract(), { room: "a" })).rejects.toMatchObject({ code: "query_result_decode_failed" });
    const badItems = createSekibanExecutor(transport({
      listQuery: async () => ({ itemsJson: "{}", totalCount: 0, totalPages: 0, currentPage: 1, pageSize: 1 }),
    }));
    await expect(badItems.listQuery(listContract(), {})).rejects.toMatchObject({ code: "query_result_decode_failed" });
    const thenable = createSekibanExecutor(transport({
      listQuery: async () => ({
        itemsJson: JSON.stringify([{ label_text: "one" }]),
        totalCount: 1,
        totalPages: 1,
        currentPage: 1,
        pageSize: 1,
      }),
    }));
    await expect(thenable.listQuery(listContract({
      decode: () => Promise.resolve({ label: "one" }) as unknown as ListItem,
    }), {})).rejects.toMatchObject({ code: "query_result_decode_failed" });
  });

  it("checks executor scope before encoding", async () => {
    let encodes = 0;
    const executor = createSekibanExecutor(transport({ serviceId: "left" }), { serviceId: "right" });
    await expect(executor.query(scalarContract({
      encode: () => {
        encodes += 1;
        return {};
      },
    }), { room: "a" })).rejects.toMatchObject({ code: "scope.mismatch" });
    expect(encodes).toBe(0);
  });

  it("rejects a value that is neither a raw request nor a contract without calling transport", async () => {
    let calls = 0;
    const executor = createSekibanExecutor(transport({
      query: async () => {
        calls += 1;
        return { resultJson: "{}" };
      },
    }));
    await expect(executor.query({ kind: "query", id: "x" } as unknown as QueryContract<ScalarParams, ScalarResult>, { room: "a" })).rejects.toMatchObject({
      code: "invalid_query_request",
      message: "The query request was invalid",
    });
    expect(calls).toBe(0);
  });

  it.each([
    ["query_params_invalid", 400, "The query parameters are invalid.", "invalid"],
    ["query_scan_limit_exceeded", 422, "The query scan limit was exceeded.", "rejected"],
    ["query_row_invalid", 500, "The query projection contains an invalid row.", "unavailable"],
    ["query_result_invalid", 500, "The query handler returned an invalid result.", "unavailable"],
    ["query_handler_failed", 500, "The query handler failed.", "unavailable"],
    ["projection_unavailable", 503, "The mapped query projection is unavailable", "unavailable"],
  ] as const)("keeps recognized server code %s ahead of result decoding", async (code, status, message, kind) => {
    let decoded = 0;
    const reply = async () => ({ status, body: { code, error: `secret-${code}` } });
    const executor = createSekibanExecutor(transport({ query: reply, listQuery: reply }));
    const scalar = await executor.query(scalarContract({
      decode: () => {
        decoded += 1;
        return { count: 1 };
      },
    }), { room: "a" }).catch((value: unknown) => value);
    const list = await executor.listQuery(listContract({
      decode: () => {
        decoded += 1;
        return { label: "x" };
      },
    }), {}).catch((value: unknown) => value);
    for (const error of [scalar, list]) {
      expect(error).toBeInstanceOf(ClientError);
      expect(publicFields(error as ClientError)).toMatchObject({ code, status, message, cause: undefined });
      expect(classifyFailure(error)).toMatchObject({ kind, code });
      expect(JSON.stringify(publicFields(error as ClientError))).not.toContain(`secret-${code}`);
    }
    expect(decoded).toBe(0);
  });

  it("sanitizes projection_ordering_quarantined before result decoding", async () => {
    let decoded = 0;
    const reply = async () => ({
      status: 503,
      body: { code: "projection_ordering_quarantined", error: "quarantine-secret" },
    });
    const executor = createSekibanExecutor(transport({ query: reply, listQuery: reply }));
    const scalar = await executor.query(scalarContract({
      decode: () => {
        decoded += 1;
        return { count: 1 };
      },
    }), { room: "a" }).catch((value: unknown) => value);
    const list = await executor.listQuery(listContract({
      decode: () => {
        decoded += 1;
        return { label: "x" };
      },
    }), {}).catch((value: unknown) => value);
    for (const error of [scalar, list]) {
      expect(publicFields(error as ClientError)).toMatchObject({
        code: "transport",
        status: 503,
        message: "Transport request failed",
        cause: undefined,
      });
      expect(classifyFailure(error)).toMatchObject({ kind: "transport", code: "transport" });
      expect(JSON.stringify(publicFields(error as ClientError))).not.toContain("quarantine-secret");
      expect(JSON.stringify(publicFields(error as ClientError))).not.toContain("projection_ordering_quarantined");
    }
    expect(decoded).toBe(0);
  });

  it("keeps a raw request, including an extra property, on the raw path", async () => {
    const seen: unknown[] = [];
    const executor = createSekibanExecutor(transport({
      query: async (request) => {
        seen.push(request);
        return { resultJson: "{\"raw\":true}" };
      },
      listQuery: async (request) => {
        seen.push(request);
        return { itemsJson: "[]", totalCount: 0, totalPages: 0, currentPage: 1, pageSize: 20, readHead: "raw-head" };
      },
    }));
    const rawQuery = {
      queryType: "legacy",
      queryParamsJson: "{}",
      kind: "query",
      params: { encode: () => ({ called: true }), decode: () => ({ called: true }) },
      result: { encode: () => ({ called: true }), decode: () => ({ called: true }) },
    };
    const queryResult: QueryResponse = await executor.query(rawQuery);
    expect(queryResult).toEqual({ resultJson: "{\"raw\":true}" });
    expect(seen[0]).toBe(rawQuery);
    const signal = new AbortController().signal;
    const listResult: ListQueryResponse = await executor.listQuery(
      { queryType: "legacy-list", queryParamsJson: JSON.stringify({ PageNumber: 1 }) },
      { consistency: "safe", signal },
    );
    expect(listResult).toMatchObject({ itemsJson: "[]", readHead: "raw-head" });
    expect(JSON.parse((seen[1] as ListQueryRequest).queryParamsJson).consistency).toBe("safe");
    await expect(executor.listQuery(
      { queryType: "legacy-list", queryParamsJson: JSON.stringify({ consistency: "safe" }) },
      { consistency: "unsafe" },
    )).rejects.toMatchObject({ code: "consistency_conflict", status: 400 });
  });
});
