import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DomainAuthoringError,
  DomainRegistrationError,
  defineListQuery,
  defineQuery,
  defineQueryView,
  domain,
  event,
  projector,
  tagFamily,
  toRuntimeDomain,
} from "@sekiban/dcb-domain";
import { composeRuntime, type RuntimeQueryDefinition } from "../packages/dcb-runtime/src/composition";

const RESERVED_PARAM_NAMES = [
  "PageNumber",
  "PageSize",
  "NewestFirst",
  "consistency",
  "pageNumber",
  "pageSize",
  "newestFirst",
  "descending",
  "waitForSortableUniqueId",
  "signal",
] as const;

function authoringError(run: () => unknown): DomainAuthoringError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainAuthoringError);
    return error as DomainAuthoringError;
  }
  throw new Error("expected DomainAuthoringError");
}

function expectAuthoring(run: () => unknown, code: string, message: string): DomainAuthoringError {
  const error = authoringError(run);
  expect(error.name).toBe("DomainAuthoringError");
  expect(error.code).toBe(code);
  expect(error.message).toBe(message);
  return error;
}

describe("typed query authoring", () => {
  const order = tagFamily("order");
  const placed = event("OrderPlaced", z.object({ orderId: z.string() }), {
    tags: (payload) => [order.of(payload.orderId)],
  });
  const orderProjector = projector({
    id: "order-projector",
    tag: order,
    events: [placed],
    initialState: { kind: "placed" as const },
    handlers: { OrderPlaced: () => ({ kind: "placed" as const }) },
  });
  const rowSchema = z.strictObject({ orderId: z.string() });
  const orders = defineQueryView({ id: "orders", version: 1, row: rowSchema });
  const params = z.strictObject({ roomId: z.string() });
  const result = z.strictObject({ count: z.number() });
  const item = z.strictObject({ id: z.string() });
  const calls = { scalar: 0, filter: 0, sort: 0 };
  const countQuery = defineQuery({
    id: "reservation-count",
    version: 1,
    source: orders,
    params,
    result,
    handleQuery: () => {
      calls.scalar += 1;
      return { count: 1 };
    },
  });
  const listQuery = defineListQuery({
    id: "reservation-list",
    version: 2,
    source: orders,
    params,
    item,
    handleFilter: () => {
      calls.filter += 1;
      return [{ id: "a" }];
    },
    handleSort: (items) => {
      calls.sort += 1;
      return items;
    },
  });

  it("freezes definitions and codecs and keeps caller schemas mutable", () => {
    expect(Object.isFrozen(orders)).toBe(true);
    expect(Object.isFrozen(orders.rowCodec)).toBe(true);
    expect(Object.isFrozen(rowSchema)).toBe(false);
    expect(Object.keys(orders.rowCodec)).toEqual(["encode", "decode"]);
    expect(Object.isFrozen(countQuery)).toBe(true);
    expect(Object.isFrozen(countQuery.contract)).toBe(true);
    expect(Object.isFrozen(countQuery.contract.params)).toBe(true);
    expect(Object.isFrozen(countQuery.contract.result)).toBe(true);
    expect(Object.keys(countQuery.contract)).toEqual(["kind", "id", "version", "params", "result"]);
    expect(Object.keys(countQuery.contract.params)).toEqual(["encode", "decode"]);
    expect(countQuery.contract).not.toHaveProperty("source");
    expect(countQuery.contract).not.toHaveProperty("handleQuery");
    expect(Object.isFrozen(listQuery.contract)).toBe(true);
    expect(Object.keys(listQuery.contract)).toEqual(["kind", "id", "version", "params", "item"]);
    expect(Object.keys(listQuery.contract.item)).toEqual(["encode", "decode"]);
    expect(listQuery.contract).not.toHaveProperty("handleFilter");
    expect(listQuery.contract).not.toHaveProperty("handleSort");
    expect(orders.rowCodec.decode(orders.rowCodec.encode({ orderId: "a" }))).toEqual({ orderId: "a" });
    expect(countQuery.contract.params.decode(countQuery.contract.params.encode({ roomId: "r" }))).toEqual({ roomId: "r" });
    expect(countQuery.contract.result.decode(countQuery.contract.result.encode({ count: 3 }))).toEqual({ count: 3 });
    expect(listQuery.contract.item.decode(listQuery.contract.item.encode({ id: "a" }))).toEqual({ id: "a" });
  });

  it("round-trips coercion, nested codecs, and a rich built-in schema", () => {
    const coerced = defineQuery({
      id: "coerced",
      version: 1,
      source: orders,
      params: z.strictObject({ n: z.coerce.number() }),
      result: z.strictObject({ n: z.number() }),
      handleQuery: (_projection, queryParams) => ({ n: queryParams.n }),
    });
    expect(coerced.contract.params.decode({ n: "12" })).toEqual({ n: 12 });
    expect(coerced.contract.params.encode({ n: 12 })).toEqual({ n: 12 });

    const nested = z.codec(z.string(), z.number(), {
      decode: (value) => Number(value),
      encode: (value) => String(value),
    });
    const nestedView = defineQueryView({
      id: "nested",
      version: 1,
      row: z.strictObject({ n: nested }),
    });
    expect(nestedView.rowCodec.encode({ n: 12 })).toEqual({ n: "12" });
    expect(nestedView.rowCodec.decode({ n: "12" })).toEqual({ n: 12 });

    const rich = z.strictObject({
      name: z.string(),
      tags: z.array(z.string()),
      pair: z.tuple([z.literal("a"), z.number()]),
      choice: z.union([z.string(), z.null()]),
      label: z.enum(["x", "y"]),
      note: z.string().optional(),
      nick: z.string().nullable(),
      fallback: z.string().default("n"),
      bag: z.record(z.string(), z.number()),
      both: z.intersection(z.strictObject({ left: z.string() }), z.strictObject({ right: z.number() })),
    }).readonly();
    const richView = defineQueryView({ id: "rich", version: 1, row: rich });
    const value = {
      name: "room",
      tags: ["a"],
      pair: ["a", 1] as ["a", number],
      choice: null,
      label: "x" as const,
      nick: null,
      fallback: "n",
      bag: { seats: 2 },
      both: { left: "L", right: 1 },
    };
    expect(richView.rowCodec.decode(richView.rowCodec.encode(value))).toEqual(value);
  });

  it("accepts a synchronous codec that is not a semantic inverse", () => {
    const skewed = z.codec(z.string(), z.number(), {
      decode: () => 1,
      encode: () => "nope",
    });
    const view = defineQueryView({ id: "skewed", version: 1, row: skewed });
    expect(view.rowCodec.decode("anything")).toBe(1);
    expect(view.rowCodec.encode(99)).toBe("nope");
    expect(view.rowCodec.encode(view.rowCodec.decode("anything"))).not.toBe("anything");
  });

  it("terminates recursive lazy schemas and rejects a lazy-hidden transform", () => {
    let getterCalls = 0;
    const tree: z.ZodType<{ name: string; child?: { name: string; child?: unknown } }> = z.lazy(() => {
      getterCalls += 1;
      return z.strictObject({
        name: z.string(),
        child: tree.optional(),
      });
    });
    const view = defineQueryView({ id: "tree", version: 1, row: tree });
    expect(getterCalls).toBe(1);
    expect(view.rowCodec.decode(view.rowCodec.encode({ name: "a", child: { name: "b" } }))).toEqual({
      name: "a",
      child: { name: "b" },
    });
    expectAuthoring(
      () => defineQueryView({ id: "hidden", version: 1, row: z.lazy(() => z.string().transform((value) => value.length)) }),
      "QUERY_CODEC_UNIDIRECTIONAL",
      "Query codecs do not support one-way Zod transforms.",
    );
  });

  it("rejects a one-way transform on either side of a nested codec", () => {
    const message = "Query codecs do not support one-way Zod transforms.";
    expectAuthoring(
      () => defineQueryView({ id: "plain", version: 1, row: z.string().transform((value) => value.length) }),
      "QUERY_CODEC_UNIDIRECTIONAL",
      message,
    );
    expectAuthoring(
      () => defineQueryView({ id: "pre", version: 1, row: z.preprocess((value) => value, z.string()) }),
      "QUERY_CODEC_UNIDIRECTIONAL",
      message,
    );
    expectAuthoring(
      () => defineQuery({
        id: "in-side",
        version: 1,
        source: orders,
        params: z.strictObject({
          n: z.codec(z.string().transform((value) => value.trim()), z.number(), {
            decode: () => 1,
            encode: () => "1",
          }),
        }),
        result,
        handleQuery: () => ({ count: 1 }),
      }),
      "QUERY_CODEC_UNIDIRECTIONAL",
      message,
    );
    expectAuthoring(
      () => defineListQuery({
        id: "out-side",
        version: 1,
        source: orders,
        params,
        item: z.codec(z.string(), z.number().transform((value) => value + 1), {
          decode: () => 1,
          encode: () => "1",
        }),
        handleFilter: () => [1],
        handleSort: (items) => items,
      }),
      "QUERY_CODEC_UNIDIRECTIONAL",
      message,
    );
  });

  it("rejects unknown and malformed schema nodes", () => {
    const unknownNode = z.string();
    (unknownNode._zod.def as { type: string }).type = "not-a-built-in";
    expectAuthoring(
      () => defineQueryView({ id: "unknown", version: 1, row: unknownNode }),
      "QUERY_CODEC_SCHEMA_UNSUPPORTED",
      "Query codecs do not support this Zod schema node.",
    );
    const malformed = z.array(z.string());
    (malformed._zod.def as { element?: unknown }).element = undefined;
    expectAuthoring(
      () => defineQuery({
        id: "malformed",
        version: 1,
        source: orders,
        params: z.strictObject({ values: malformed }),
        result,
        handleQuery: () => ({ count: 1 }),
      }),
      "QUERY_CODEC_SCHEMA_UNSUPPORTED",
      "Query codecs do not support this Zod schema node.",
    );
    const codec = z.codec(z.string(), z.number(), { decode: Number, encode: String });
    delete (codec._zod.def as { reverseTransform?: unknown }).reverseTransform;
    expectAuthoring(
      () => defineQueryView({ id: "codec-shape", version: 1, row: codec }),
      "QUERY_CODEC_SCHEMA_UNSUPPORTED",
      "Query codecs do not support this Zod schema node.",
    );
  });

  it("normalizes asynchronous codec failures and leaves Zod validation errors unchanged", () => {
    const asyncMessage = "Query codecs must encode and decode synchronously.";
    const decodeAsync = defineQueryView({
      id: "decode-async",
      version: 1,
      row: z.codec(z.string(), z.number(), {
        decode: async (value) => Number(value),
        encode: (value) => String(value),
      }),
    });
    const decodeError = expectAuthoring(() => decodeAsync.rowCodec.decode("1"), "QUERY_CODEC_ASYNC_UNSUPPORTED", asyncMessage);
    expect(decodeError.cause).toBeInstanceOf(z.core.$ZodAsyncError);
    const encodeAsync = defineQuery({
      id: "encode-async",
      version: 1,
      source: orders,
      params: z.strictObject({
        n: z.codec(z.string(), z.number(), {
          decode: (value) => Number(value),
          encode: async (value) => String(value),
        }),
      }),
      result,
      handleQuery: () => ({ count: 1 }),
    });
    const encodeError = expectAuthoring(() => encodeAsync.contract.params.encode({ n: 1 }), "QUERY_CODEC_ASYNC_UNSUPPORTED", asyncMessage);
    expect(encodeError.cause).toBeInstanceOf(z.core.$ZodAsyncError);

    const conditional = z.codec(z.string(), z.string(), {
      decode: (value) => value === "p" ? Promise.resolve(value) : value,
      encode: (value) => value === "p" ? Promise.resolve(value) : value,
    });
    const conditionalView = defineQueryView({ id: "conditional", version: 1, row: conditional });
    expect(conditionalView.rowCodec.decode("ok")).toBe("ok");
    expect(conditionalView.rowCodec.encode("ok")).toBe("ok");
    expect(expectAuthoring(() => conditionalView.rowCodec.decode("p"), "QUERY_CODEC_ASYNC_UNSUPPORTED", asyncMessage).cause).toBeInstanceOf(z.core.$ZodAsyncError);
    expect(expectAuthoring(() => conditionalView.rowCodec.encode("p"), "QUERY_CODEC_ASYNC_UNSUPPORTED", asyncMessage).cause).toBeInstanceOf(z.core.$ZodAsyncError);

    const promised = defineListQuery({
      id: "promised",
      version: 1,
      source: orders,
      params,
      item: z.promise(z.string()),
      handleFilter: () => [],
      handleSort: (items) => items,
    });
    expect(expectAuthoring(() => promised.contract.item.decode("a"), "QUERY_CODEC_ASYNC_UNSUPPORTED", asyncMessage).cause).toBeInstanceOf(z.core.$ZodAsyncError);
    expect(expectAuthoring(() => promised.contract.item.encode(Promise.resolve("a")), "QUERY_CODEC_ASYNC_UNSUPPORTED", asyncMessage).cause).toBeInstanceOf(z.core.$ZodAsyncError);

    const refined = defineQueryView({
      id: "refined",
      version: 1,
      row: z.string().refine(async () => true),
    });
    expect(expectAuthoring(() => refined.rowCodec.decode("a"), "QUERY_CODEC_ASYNC_UNSUPPORTED", asyncMessage).cause).toBeInstanceOf(z.core.$ZodAsyncError);

    expect(() => countQuery.contract.params.decode({ roomId: 1 })).toThrow(z.ZodError);
    try {
      countQuery.contract.params.decode({ roomId: 1 });
    } catch (error) {
      expect(error).toBeInstanceOf(z.ZodError);
      expect(error).not.toBeInstanceOf(DomainAuthoringError);
    }
  });

  it("normalizes a one-way encode failure exposed after definition", () => {
    const piped = z.string().pipe(z.string());
    const view = defineQueryView({ id: "pipe", version: 1, row: piped });
    (piped._zod.def as { out: unknown }).out = z.string().transform((value) => value.length)._zod.def.out;
    const error = expectAuthoring(
      () => view.rowCodec.encode("ab"),
      "QUERY_CODEC_UNIDIRECTIONAL",
      "Query codecs do not support one-way Zod transforms.",
    );
    expect(error.cause).toBeInstanceOf(z.core.$ZodEncodeError);
  });

  it("rejects encoded values that are not JSON", () => {
    const message = "Query codec output must be JSON-safe.";
    const cases: Array<readonly [string, () => unknown]> = [
      ["params", () => defineQuery({
        id: "bigint-params",
        version: 1,
        source: orders,
        params: z.strictObject({ n: z.bigint() }),
        result,
        handleQuery: () => ({ count: 1 }),
      }).contract.params.encode({ n: 1n })],
      ["row", () => defineQueryView({ id: "date-row", version: 1, row: z.date() }).rowCodec.encode(new Date(0))],
      ["result", () => defineQuery({
        id: "nan-result",
        version: 1,
        source: orders,
        params,
        result: z.nan(),
        handleQuery: () => Number.NaN,
      }).contract.result.encode(Number.NaN)],
      ["item", () => defineListQuery({
        id: "symbol-item",
        version: 1,
        source: orders,
        params,
        item: z.symbol(),
        handleFilter: () => [],
        handleSort: (items) => items,
      }).contract.item.encode(Symbol.for("a"))],
    ];
    for (const [position, run] of cases) {
      const error = expectAuthoring(run, "QUERY_CODEC_NOT_JSON_SAFE", message);
      expect(error.message).toBe(message);
      expect(error.message).not.toContain(position);
      expect(error.cause).toBeUndefined();
    }
    const cyclic = z.codec(z.unknown(), z.unknown(), {
      decode: (value) => value,
      encode: () => {
        const record: Record<string, unknown> = {};
        record.self = record;
        return record;
      },
    });
    expectAuthoring(
      () => defineQueryView({ id: "cycle", version: 1, row: cyclic }).rowCodec.encode({}),
      "QUERY_CODEC_NOT_JSON_SAFE",
      message,
    );
  });

  it("requires a non-empty id, a positive safe-integer version, and strict object params", () => {
    expectAuthoring(
      () => defineQueryView({ id: "", version: 1, row: z.string() }),
      "QUERY_ID_REQUIRED",
      "Query id must be a non-empty string.",
    );
    for (const version of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expectAuthoring(
        () => defineQueryView({ id: "orders", version, row: z.string() }),
        "QUERY_VERSION_INVALID",
        "Query version must be a positive safe integer.",
      );
    }
    const rejected = [
      z.object({ roomId: z.string() }),
      z.object({ roomId: z.string() }).strip(),
      z.object({ roomId: z.string() }).passthrough(),
      z.object({ roomId: z.string() }).catchall(z.string()),
      z.string(),
    ];
    for (const schema of rejected) {
      expectAuthoring(
        () => defineQuery({
          id: "loose",
          version: 1,
          source: orders,
          params: schema as z.ZodObject,
          result,
          handleQuery: () => ({ count: 1 }),
        }),
        "QUERY_PARAMS_SCHEMA_NOT_STRICT",
        "Query params must be a strict Zod object.",
      );
    }
    defineQuery({
      id: "strict-factory",
      version: 1,
      source: orders,
      params: z.strictObject({ roomId: z.string() }),
      result,
      handleQuery: () => ({ count: 1 }),
    });
    defineQuery({
      id: "strict-method",
      version: 1,
      source: orders,
      params: z.object({ roomId: z.string() }).strict(),
      result,
      handleQuery: () => ({ count: 1 }),
    });
  });

  it("rejects every reserved param spelling", () => {
    expect(RESERVED_PARAM_NAMES).toHaveLength(10);
    for (const name of RESERVED_PARAM_NAMES) {
      const error = expectAuthoring(
        () => defineQuery({
          id: `reserved-${name}`,
          version: 1,
          source: orders,
          params: z.strictObject({ [name]: z.string() }),
          result,
          handleQuery: () => ({ count: 1 }),
        }),
        "QUERY_PARAMS_RESERVED_NAME",
        "Query params must not declare a reserved control name.",
      );
      expect(error.message).not.toContain(name);
    }
  });

  it("keeps authored queries on the domain and refuses them at the bridge", () => {
    const input = [countQuery, listQuery];
    const authored = domain({
      events: [placed],
      projectors: [orderProjector],
      views: [{ id: "orders", source: orderProjector.id }],
      queries: input,
    });
    expect(authored.queries).not.toBe(input);
    expect(Object.isFrozen(authored.queries)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expect(authored.queries).toEqual([countQuery, listQuery]);
    const bridgeError = authoringError(() => toRuntimeDomain(authored));
    expect(bridgeError.code).toBe("QUERY_EXECUTION_UNAVAILABLE");
    expect(bridgeError.message).toBe("Typed query execution is not available in this runtime bridge.");
    expect(calls).toEqual({ scalar: 0, filter: 0, sort: 0 });
    expect(() => toRuntimeDomain(authored)).toThrow(DomainAuthoringError);

    const sameIdList = defineListQuery({
      id: countQuery.id,
      version: 2,
      source: orders,
      params,
      item,
      handleFilter: () => [{ id: "a" }],
      handleSort: (items) => items,
    });
    const duplicate = authoringError(() => domain({
      events: [placed],
      projectors: [orderProjector],
      views: [{ id: "orders", source: orderProjector.id }],
      queries: [countQuery, sameIdList],
    }));
    expect(duplicate).toBeInstanceOf(DomainRegistrationError);
    expect((duplicate as DomainRegistrationError).collisions).toEqual(["query:reservation-count (reservation-count, reservation-count)"]);

    const missing = authoringError(() => domain({
      events: [placed],
      projectors: [orderProjector],
      queries: [countQuery],
    }));
    expect(missing).toBeInstanceOf(DomainRegistrationError);
    expect(missing.message).toBe("Query source view orders is not registered");
    expect((missing as DomainRegistrationError).collisions).toEqual(["orders"]);

    const queryFree = toRuntimeDomain(domain({ events: [placed], projectors: [orderProjector] }));
    expect(queryFree.queries).toEqual([]);
    expect(calls).toEqual({ scalar: 0, filter: 0, sort: 0 });
  });

  it("rejects typed definitions at every runtime composition input", () => {
    const legacy: RuntimeQueryDefinition = {
      queryType: "legacy-rooms",
      tagGroup: "room",
      tagProjector: "room-projector",
      endpoint: "query",
    };
    const scalarCalls = { count: 0 };
    const listCalls = { count: 0 };
    const scalar = {
      ...legacy,
      ...defineQuery({
        id: "composed-scalar",
        version: 1,
        source: orders,
        params,
        result,
        handleQuery: () => {
          scalarCalls.count += 1;
          return { count: 1 };
        },
      }),
    };
    const list = {
      ...legacy,
      endpoint: "list-query" as const,
      ...defineListQuery({
        id: "composed-list",
        version: 1,
        source: orders,
        params,
        item,
        handleFilter: () => {
          listCalls.count += 1;
          return [{ id: "a" }];
        },
        handleSort: (items) => {
          listCalls.count += 1;
          return items;
        },
      }),
    };
    const cases = [
      { input: "domain.queries", kind: "query", value: scalar },
      { input: "domain.queries", kind: "list-query", value: list },
      { input: "config.queries", kind: "query", value: scalar },
      { input: "config.queries", kind: "list-query", value: list },
      { input: "config.queryDefinitions", kind: "query", value: scalar },
      { input: "config.queryDefinitions", kind: "list-query", value: list },
    ] as const;
    expect(cases).toHaveLength(6);
    for (const entry of cases) {
      const typed = entry.value as RuntimeQueryDefinition;
      const domainQueries = entry.input === "domain.queries" ? [typed] : [legacy];
      const configQueries = entry.input === "config.queries" ? [typed] : [legacy];
      const queryDefinitions = entry.input === "config.queryDefinitions" ? [typed] : [legacy];
      let composed: unknown;
      let failure: unknown;
      try {
        composed = composeRuntime({ queries: domainQueries }, { queries: configQueries, queryDefinitions });
      } catch (error) {
        failure = error;
      }
      expect(composed).toBeUndefined();
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({
        name: "TypedQueryExecutionUnavailableError",
        code: "QUERY_EXECUTION_UNAVAILABLE",
        message: "Typed query execution is not available in runtime composition.",
      });
      expect((failure as Error).name).toBe("TypedQueryExecutionUnavailableError");
    }
    expect(scalarCalls.count).toBe(0);
    expect(listCalls.count).toBe(0);

    const roomQuery = { id: "rooms", version: 1, tagGroup: "room", tagProjector: "room-projector" };
    const metadata = composeRuntime(undefined, { queries: [roomQuery] });
    expect(metadata.queries.resolve("rooms")?.tagGroup).toBe("room");
    const precedence = composeRuntime(undefined, {
      queries: [{ queryType: "ignored", tagGroup: "room", tagProjector: "room-projector" }],
      queryDefinitions: [{ queryType: "chosen", tagGroup: "room", tagProjector: "room-projector" }],
    });
    expect(precedence.queries.resolve("chosen")?.tagProjector).toBe("room-projector");
    expect(precedence.queries.resolve("ignored")).toBeUndefined();
  });
});
