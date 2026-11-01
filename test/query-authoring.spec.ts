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
import { composeRuntime, type RuntimeQueryDefinition, type RuntimeWorkerConfig } from "../packages/dcb-runtime/src/composition";

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

    expectAuthoring(
      () => defineListQuery({
        id: "promised",
        version: 1,
        source: orders,
        params,
        item: z.promise(z.string()),
        handleFilter: () => [],
        handleSort: (items) => items,
      }),
      "QUERY_CODEC_OUTPUT_UNCOPYABLE",
      "Query codec output must support portable detached copies.",
    );

    const refined = defineQueryView({
      id: "refined",
      version: 1,
      row: z.string().refine(async () => true),
    });
    expect(expectAuthoring(() => refined.rowCodec.decode("a"), "QUERY_CODEC_ASYNC_UNSUPPORTED", asyncMessage).cause).toBeInstanceOf(z.core.$ZodAsyncError);

    const defaulted = defineQueryView({
      id: "defaulted",
      version: 1,
      row: z.string().default((async () => "from-default") as unknown as () => string),
    });
    const defaultError = expectAuthoring(() => defaulted.rowCodec.decode(undefined), "QUERY_CODEC_ASYNC_UNSUPPORTED", asyncMessage);
    expect(defaultError.cause).toBeInstanceOf(Promise);
    expect(defaulted.rowCodec.encode("kept")).toBe("kept");
    const caught = defineQueryView({
      id: "caught",
      version: 1,
      row: z.string().catch((async () => "from-catch") as unknown as () => string),
    });
    const catchError = expectAuthoring(() => caught.rowCodec.decode(1), "QUERY_CODEC_ASYNC_UNSUPPORTED", asyncMessage);
    expect(catchError.cause).toBeInstanceOf(Promise);
    expect(caught.rowCodec.encode("kept")).toBe("kept");
    const thenable = { then(resolve: (value: string) => void) { resolve("later"); } };
    const open = defineQueryView({
      id: "thenable",
      version: 1,
      row: z.string().default(() => thenable as unknown as string),
    });
    expect(expectAuthoring(() => open.rowCodec.decode(undefined), "QUERY_CODEC_ASYNC_UNSUPPORTED", asyncMessage).cause).toBe(thenable);
    const encodedThenable = z.codec(z.unknown(), z.string(), {
      decode: (value) => value as string,
      encode: () => thenable as unknown as string,
    });
    const encodedView = defineQueryView({ id: "thenable-encode", version: 1, row: encodedThenable });
    expect(expectAuthoring(() => encodedView.rowCodec.encode("later"), "QUERY_CODEC_ASYNC_UNSUPPORTED", asyncMessage).cause).toBe(thenable);

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
    ];
    for (const [position, run] of cases) {
      const error = expectAuthoring(run, "QUERY_CODEC_NOT_JSON_SAFE", message);
      expect(error.message).toBe(message);
      expect(error.message).not.toContain(position);
      expect(error.cause).toBeUndefined();
    }
    const cyclic = z.codec(z.unknown(), z.string(), {
      decode: (value) => value as string,
      encode: () => {
        const record: Record<string, unknown> = {};
        record.self = record;
        return record as unknown as string;
      },
    });
    expectAuthoring(
      () => defineQueryView({ id: "cycle", version: 1, row: cyclic }).rowCodec.encode("ok"),
      "QUERY_CODEC_NOT_JSON_SAFE",
      message,
    );

    const sparse: number[] = [];
    sparse[1] = 1;
    const extra = [1] as number[] & { extra?: boolean };
    extra.extra = true;
    const proto = Object.create(null);
    Object.defineProperty(proto, "__proto__", {
      value: { admin: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    proto.name = "room";
    const returning = (value: unknown) => z.codec(z.unknown(), z.string(), {
      decode: (input) => input as string,
      encode: () => value as string,
    });
    const nested = (value: unknown) => ({ profile: value });
    const positions: Array<readonly [string, () => unknown]> = [
      ["params-sparse", () => defineQuery({
        id: "params-sparse",
        version: 1,
        source: orders,
        params: z.strictObject({ profile: returning(nested(sparse)) }),
        result,
        handleQuery: () => ({ count: 1 }),
      }).contract.params.encode({ profile: "ok" })],
      ["row-extra", () => defineQueryView({
        id: "row-extra",
        version: 1,
        row: z.strictObject({ profile: returning(nested(extra)) }),
      }).rowCodec.encode({ profile: "ok" })],
      ["result-sparse", () => defineQuery({
        id: "result-sparse",
        version: 1,
        source: orders,
        params,
        result: z.strictObject({ profile: returning(nested(sparse)) }),
        handleQuery: () => ({ profile: "ok" }),
      }).contract.result.encode({ profile: "ok" })],
      ["item-extra", () => defineListQuery({
        id: "item-extra",
        version: 1,
        source: orders,
        params,
        item: z.strictObject({ profile: returning(nested(extra)) }),
        handleFilter: () => [],
        handleSort: (items) => items,
      }).contract.item.encode({ profile: "ok" })],
    ];
    for (const [position, run] of positions) {
      const error = expectAuthoring(run, "QUERY_CODEC_NOT_JSON_SAFE", message);
      expect(error.message).not.toContain(position);
    }
    const ownProto = (value: unknown) => {
      const profile = (value as { profile: { profile: object } }).profile.profile;
      expect(Object.getOwnPropertyDescriptor(profile, "__proto__")?.value).toEqual({ admin: true });
      expect(Object.getPrototypeOf(profile)).toBe(null);
    };
    ownProto(defineQueryView({
      id: "proto-row",
      version: 1,
      row: z.strictObject({ profile: returning(nested(proto)) }),
    }).rowCodec.encode({ profile: "ok" }));
    expect(Object.prototype).not.toHaveProperty("admin");
    ownProto(defineQuery({
      id: "proto-params",
      version: 1,
      source: orders,
      params: z.strictObject({ profile: returning(nested(proto)) }),
      result,
      handleQuery: () => ({ count: 1 }),
    }).contract.params.encode({ profile: "ok" }));
    ownProto(defineQuery({
      id: "proto-result",
      version: 1,
      source: orders,
      params,
      result: z.strictObject({ profile: returning(nested(proto)) }),
      handleQuery: () => ({ profile: "ok" }),
    }).contract.result.encode({ profile: "ok" }));
    ownProto(defineListQuery({
      id: "proto-item",
      version: 1,
      source: orders,
      params,
      item: z.strictObject({ profile: returning(nested(proto)) }),
      handleFilter: () => [],
      handleSort: (items) => items,
    }).contract.item.encode({ profile: "ok" }));
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

  it("admits copyable outputs and refuses values that cannot be detached", () => {
    const message = "Query codec output must support portable detached copies.";
    const dateCodec = z.codec(z.string(), z.date(), {
      decode: (value) => new Date(value),
      encode: (value) => value.toISOString(),
    });
    const dated = defineQueryView({ id: "dated", version: 1, row: dateCodec });
    expect(dated.rowCodec.decode("2020-01-01T00:00:00.000Z").toISOString()).toBe("2020-01-01T00:00:00.000Z");
    expect(dated.rowCodec.encode(new Date("2020-01-01T00:00:00.000Z"))).toBe("2020-01-01T00:00:00.000Z");
    defineQueryView({
      id: "nested-copyable",
      version: 1,
      row: z.strictObject({
        tags: z.map(z.string(), z.set(z.date())),
        when: z.lazy(() => z.date()),
      }),
    });
    const refused = [
      z.any(),
      z.unknown(),
      z.nan(),
      z.symbol(),
      z.custom<unknown>(),
      z.function(),
      z.promise(z.string()),
      z.codec(z.string(), z.custom<unknown>(), { decode: (value) => value, encode: () => "x" }),
    ];
    for (const row of refused) {
      expectAuthoring(
        () => defineQueryView({ id: "uncopyable", version: 1, row }),
        "QUERY_CODEC_OUTPUT_UNCOPYABLE",
        message,
      );
    }
    defineQuery({
      id: "async-handler",
      version: 1,
      source: orders,
      params,
      result,
      // @ts-expect-error query handlers are synchronous
      handleQuery: async () => ({ count: 1 }),
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

  it("bridges authored queries without calling handlers", () => {
    const input = [countQuery, listQuery];
    const authored = domain({
      events: [placed],
      projectors: [orderProjector],
      views: [{ id: "orders", source: orderProjector.id }],
      queries: input,
    });
    expect(authored.queries).not.toBe(input);
    expect(Object.isFrozen(authored.queries)).toBe(true);
    expect(authored.queries).toEqual([countQuery, listQuery]);
    const bridged = toRuntimeDomain(authored);
    expect(Object.isFrozen(bridged.queries)).toBe(true);
    expect(bridged.queries).toHaveLength(2);
    const scalar = bridged.queries[0]!;
    const list = bridged.queries[1]!;
    expect(Object.isFrozen(scalar)).toBe(true);
    expect(Object.isFrozen(scalar.execution)).toBe(true);
    expect(Object.isFrozen(list.execution)).toBe(true);
    expect(scalar).toMatchObject({
      queryType: "reservation-count",
      endpoint: "query",
      tagGroup: "order",
      tagProjector: "order-projector",
      materializedViewId: "orders",
      version: 1,
      enabled: true,
    });
    expect(list).toMatchObject({
      queryType: "reservation-list",
      endpoint: "list-query",
      tagGroup: "order",
      tagProjector: "order-projector",
      materializedViewId: "orders",
      version: 2,
      enabled: true,
    });
    expect(scalar.execution.kind).toBe("scalar");
    expect(list.execution.kind).toBe("list");
    expect(Object.keys(scalar.execution).sort()).toEqual(["handleQuery", "kind", "paramsCodec", "resultCodec", "rowCodec"]);
    expect(Object.keys(list.execution).sort()).toEqual(["handleFilter", "handleSort", "itemCodec", "kind", "paramsCodec", "rowCodec"]);
    expect(scalar).not.toHaveProperty("params");
    expect(scalar).not.toHaveProperty("result");
    expect(scalar).not.toHaveProperty("contract");
    expect(scalar).not.toHaveProperty("source");
    expect(list).not.toHaveProperty("item");
    expect(calls).toEqual({ scalar: 0, filter: 0, sort: 0 });
    const queryFree = toRuntimeDomain(domain({ events: [placed], projectors: [orderProjector] }));
    expect(queryFree.queries).toEqual([]);
    expect(calls).toEqual({ scalar: 0, filter: 0, sort: 0 });

    const other = tagFamily("other");
    const otherPlaced = event("OtherPlaced", z.object({ orderId: z.string() }), {
      tags: (payload) => [other.of(payload.orderId)],
    });
    const otherProjector = projector({
      id: "other-projector",
      tag: other,
      events: [otherPlaced],
      initialState: { kind: "placed" as const },
      handlers: { OtherPlaced: () => ({ kind: "placed" as const }) },
    });
    const selected = toRuntimeDomain(domain({
      events: [placed, otherPlaced],
      projectors: [orderProjector, otherProjector],
      views: [{ id: "orders", source: orderProjector.id, projector: otherProjector.id }],
      queries: [countQuery],
    }));
    expect(selected.queries[0]).toMatchObject({ tagGroup: "other", tagProjector: "other-projector", materializedViewId: "orders" });

    const orphan = {
      queries: [{ id: "orphan", kind: "query", version: 1, source: { id: "missing" } }],
    } as unknown as Parameters<typeof toRuntimeDomain>[0];
    expect(() => toRuntimeDomain(orphan)).toThrow(DomainAuthoringError);
    try {
      toRuntimeDomain(orphan);
    } catch (error) {
      expect(error).toMatchObject({
        name: "DomainAuthoringError",
        code: "QUERY_SOURCE_INVALID",
        message: "Query source view cannot be mapped to a runtime projector.",
      });
      expect((error as Error).message).not.toContain("missing");
      expect((error as Error).message).not.toContain("orphan");
    }

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
  });

  it("registers executable definitions and rejects malformed or shadowed input before precedence", () => {
    const bridged = toRuntimeDomain(domain({
      events: [placed],
      projectors: [orderProjector],
      views: [{ id: "orders", source: orderProjector.id }],
      queries: [countQuery, listQuery],
    }));
    const fromDomain = composeRuntime(bridged);
    expect(fromDomain.queries.resolve("reservation-count")?.endpoint).toBe("query");
    expect(fromDomain.queries.resolve("reservation-list")?.endpoint).toBe("list-query");
    expect(fromDomain.maxScanRows).toBe(1_000);
    expect(calls).toEqual({ scalar: 0, filter: 0, sort: 0 });

    const codec = {
      encode: (value: unknown) => value,
      decode: (value: unknown) => value,
    };
    let scalarCalls = 0;
    let listCalls = 0;
    const scalar = {
      queryType: "composed-scalar",
      endpoint: "query" as const,
      tagGroup: "room",
      tagProjector: "room-projector",
      version: 1,
      enabled: true,
      execution: {
        kind: "scalar" as const,
        rowCodec: codec,
        paramsCodec: codec,
        resultCodec: codec,
        handleQuery: () => {
          scalarCalls += 1;
          return { count: 1 };
        },
      },
    };
    const list = {
      queryType: "composed-list",
      endpoint: "list-query" as const,
      tagGroup: "room",
      tagProjector: "room-projector",
      version: 2,
      enabled: true,
      execution: {
        kind: "list" as const,
        rowCodec: codec,
        paramsCodec: codec,
        itemCodec: codec,
        handleFilter: () => {
          listCalls += 1;
          return [{ id: "a" }];
        },
        handleSort: (items: readonly { id: string }[]) => {
          listCalls += 1;
          return items;
        },
      },
    };
    const onQueries = composeRuntime(undefined, { queries: [scalar, list] });
    expect(onQueries.queries.resolve("composed-scalar")?.endpoint).toBe("query");
    expect(onQueries.queries.resolve("composed-list")?.endpoint).toBe("list-query");
    const onDefinitions = composeRuntime(undefined, { queryDefinitions: [scalar, list] });
    expect(onDefinitions.queries.resolve("composed-list")?.tagProjector).toBe("room-projector");
    const precedence = composeRuntime(undefined, {
      queries: [scalar],
      queryDefinitions: [list],
    });
    expect(precedence.queries.resolve("composed-list")?.endpoint).toBe("list-query");
    expect(precedence.queries.resolve("composed-scalar")).toBeUndefined();
    expect(scalarCalls).toBe(0);
    expect(listCalls).toBe(0);

    const broken = { ...scalar, queryType: "shadow-broken", execution: { kind: "scalar" as const } };
    expect(() => composeRuntime(undefined, {
      queries: [broken as RuntimeQueryDefinition],
      queryDefinitions: [list],
    })).toThrow(Error);
    try {
      composeRuntime(undefined, {
        queries: [broken as RuntimeQueryDefinition],
        queryDefinitions: [list],
      });
    } catch (error) {
      expect(error).toMatchObject({
        name: "RuntimeQueryDefinitionError",
        code: "QUERY_DEFINITION_INVALID",
        message: "Runtime query definition is invalid.",
      });
    }
    expect(listCalls).toBe(0);

    const malformed = [
      { ...scalar, execution: undefined },
      { ...scalar, execution: { kind: "scalar", rowCodec: codec } },
      { ...scalar, execution: { ...scalar.execution, paramsCodec: { encode: codec.encode } } },
      { ...scalar, execution: { ...scalar.execution, handleQuery: undefined } },
      { ...scalar, endpoint: "list-query" as const },
      { ...list, endpoint: "query" as const },
      { ...scalar, version: 0 },
      { ...scalar, version: 1.5 },
      { ...scalar, queryType: "one", id: "two" },
      { ...scalar, handleQuery: () => ({ count: 1 }) },
      { ...list, contract: { kind: "list-query", id: "composed-list", version: 2 } },
      { ...scalar, execution: { ...scalar.execution, handleFilter: () => [] } },
    ];
    expect(malformed.length).toBeGreaterThanOrEqual(12);
    for (const value of malformed) {
      let failure: unknown;
      try {
        composeRuntime(undefined, { queries: [value as RuntimeQueryDefinition] });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        name: "RuntimeQueryDefinitionError",
        code: "QUERY_DEFINITION_INVALID",
        message: "Runtime query definition is invalid.",
      });
    }
    expect(() => composeRuntime(undefined, { queries: [scalar, { ...scalar }] })).toThrow(Error);
    const roomQuery = { id: "rooms", version: 1, tagGroup: "room", tagProjector: "room-projector" };
    const metadata = composeRuntime(undefined, { queries: [roomQuery] });
    expect(metadata.queries.resolve("rooms")?.tagGroup).toBe("room");
    expect(metadata.maxScanRows).toBe(1_000);
  });

  it("normalizes maxScanRows and rejects values outside the deploy ceiling", () => {
    const roomQuery = { id: "rooms", tagGroup: "room", tagProjector: "room-projector" };
    expect(composeRuntime(undefined, { queries: [roomQuery] }).maxScanRows).toBe(1_000);
    expect(composeRuntime(undefined).maxScanRows).toBe(1_000);
    for (const value of [1, 1_000, 10_000]) {
      expect(composeRuntime(undefined, { queries: [roomQuery], maxScanRows: value }).maxScanRows).toBe(value);
    }
    const invalid = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 10_001];
    expect(invalid).toHaveLength(8);
    for (const maxScanRows of invalid) {
      let failure: unknown;
      try {
        composeRuntime(undefined, { maxScanRows });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        name: "RuntimeWorkerConfigurationError",
        code: "QUERY_MAX_SCAN_ROWS_INVALID",
        message: "RuntimeWorkerConfig.maxScanRows must be a positive safe integer no greater than 10000.",
      });
    }
    let stringFailure: unknown;
    try {
      composeRuntime(undefined, { maxScanRows: "1000" as unknown as number });
    } catch (error) {
      stringFailure = error;
    }
    expect(stringFailure).toMatchObject({ code: "QUERY_MAX_SCAN_ROWS_INVALID" });
    const restricted: RuntimeWorkerConfig = {
      // @ts-expect-error maxScanRows accepts only a number
      maxScanRows: "1000",
    };
    void restricted;
  });
});
