// eslint-disable-next-line no-restricted-imports -- type-only structural contracts from the matched core package
import type {
  ListQueryContract,
  QueryCodec,
  QueryContract,
  QueryHandlerContext,
  QueryJsonValue,
  QueryProjection,
} from "@sekiban/dcb-core";
import { z } from "zod";
import { DomainAuthoringError } from "./types";

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

type ReservedParamName = (typeof RESERVED_PARAM_NAMES)[number];

const QUERY_CODEC_UNIDIRECTIONAL = "Query codecs do not support one-way Zod transforms.";
const QUERY_CODEC_SCHEMA_UNSUPPORTED = "Query codecs do not support this Zod schema node.";
const QUERY_CODEC_ASYNC_UNSUPPORTED = "Query codecs must encode and decode synchronously.";
const QUERY_CODEC_NOT_JSON_SAFE = "Query codec output must be JSON-safe.";

const LEAF_SCHEMA_TYPES = new Set([
  "any",
  "bigint",
  "boolean",
  "custom",
  "date",
  "enum",
  "file",
  "literal",
  "nan",
  "never",
  "null",
  "number",
  "string",
  "symbol",
  "undefined",
  "unknown",
  "void",
]);

const INNER_SCHEMA_TYPES = new Set([
  "catch",
  "default",
  "nonoptional",
  "nullable",
  "optional",
  "prefault",
  "promise",
  "readonly",
  "success",
]);

interface ZodDef {
  readonly type: string;
  readonly element?: unknown;
  readonly items?: unknown;
  readonly rest?: unknown;
  readonly shape?: unknown;
  readonly catchall?: unknown;
  readonly options?: unknown;
  readonly left?: unknown;
  readonly right?: unknown;
  readonly keyType?: unknown;
  readonly valueType?: unknown;
  readonly innerType?: unknown;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly parts?: unknown;
  readonly in?: unknown;
  readonly out?: unknown;
  readonly transform?: unknown;
  readonly reverseTransform?: unknown;
  readonly getter?: unknown;
}

interface ZodInternal {
  readonly _zod: {
    readonly def: ZodDef;
    readonly traits: Set<unknown>;
    readonly innerType?: unknown;
  };
}

function unidirectional(): DomainAuthoringError {
  return new DomainAuthoringError("QUERY_CODEC_UNIDIRECTIONAL", QUERY_CODEC_UNIDIRECTIONAL);
}

function unsupported(): DomainAuthoringError {
  return new DomainAuthoringError("QUERY_CODEC_SCHEMA_UNSUPPORTED", QUERY_CODEC_SCHEMA_UNSUPPORTED);
}

function isZodInternal(value: unknown): value is ZodInternal {
  if (typeof value !== "object" || value === null) return false;
  const internal = (value as { readonly _zod?: { readonly def?: { readonly type?: unknown }; readonly traits?: unknown } })._zod;
  return typeof internal?.def?.type === "string" && internal.traits instanceof Set;
}

function requireSchema(value: unknown): ZodInternal {
  if (!isZodInternal(value)) throw unsupported();
  return value;
}

function assertSupportedSchema(root: z.ZodTypeAny): void {
  const visited = new WeakSet<object>();
  const lazyChildren = new WeakMap<object, ZodInternal>();

  const walk = (value: unknown): void => {
    const node = requireSchema(value);
    if (visited.has(node)) return;
    visited.add(node);
    const def = node._zod.def;
    if (node._zod.traits.has("$ZodTransform") || def.type === "transform") throw unidirectional();
    if (node._zod.traits.has("$ZodCodec")) {
      if (typeof def.transform !== "function" || typeof def.reverseTransform !== "function") throw unsupported();
      walk(requireSchema(def.in));
      walk(requireSchema(def.out));
      return;
    }
    if (LEAF_SCHEMA_TYPES.has(def.type)) return;
    if (INNER_SCHEMA_TYPES.has(def.type)) {
      walk(requireSchema(def.innerType));
      return;
    }
    switch (def.type) {
      case "array":
        walk(requireSchema(def.element));
        return;
      case "tuple": {
        if (!Array.isArray(def.items)) throw unsupported();
        for (const item of def.items) walk(requireSchema(item));
        if (def.rest !== undefined && def.rest !== null) walk(requireSchema(def.rest));
        return;
      }
      case "object": {
        if (typeof def.shape !== "object" || def.shape === null || Array.isArray(def.shape)) throw unsupported();
        for (const child of Object.values(def.shape)) walk(requireSchema(child));
        if (def.catchall !== undefined) walk(requireSchema(def.catchall));
        return;
      }
      case "union": {
        if (!Array.isArray(def.options)) throw unsupported();
        for (const option of def.options) walk(requireSchema(option));
        return;
      }
      case "intersection":
        walk(requireSchema(def.left));
        walk(requireSchema(def.right));
        return;
      case "record":
      case "map":
        walk(requireSchema(def.keyType));
        walk(requireSchema(def.valueType));
        return;
      case "set":
        walk(requireSchema(def.valueType));
        return;
      case "function":
        walk(requireSchema(def.input));
        walk(requireSchema(def.output));
        return;
      case "template_literal": {
        if (!Array.isArray(def.parts)) throw unsupported();
        for (const part of def.parts) {
          if (isZodInternal(part)) walk(part);
          else if (typeof part !== "string" && typeof part !== "number" && typeof part !== "boolean" && typeof part !== "bigint" && part !== null) {
            throw unsupported();
          }
        }
        return;
      }
      case "lazy": {
        let child = lazyChildren.get(node);
        if (child === undefined) {
          child = requireSchema(node._zod.innerType);
          lazyChildren.set(node, child);
        }
        walk(child);
        return;
      }
      case "pipe":
        walk(requireSchema(def.in));
        walk(requireSchema(def.out));
        return;
      default:
        throw unsupported();
    }
  };

  walk(root);
}

function assertQueryJsonValue(value: unknown): QueryJsonValue {
  const ancestors = new Set<object>();
  const visit = (candidate: unknown): QueryJsonValue => {
    if (candidate === null || typeof candidate === "boolean" || typeof candidate === "string") return candidate;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new DomainAuthoringError("QUERY_CODEC_NOT_JSON_SAFE", QUERY_CODEC_NOT_JSON_SAFE);
      return candidate;
    }
    if (typeof candidate !== "object") throw new DomainAuthoringError("QUERY_CODEC_NOT_JSON_SAFE", QUERY_CODEC_NOT_JSON_SAFE);
    if (ancestors.has(candidate)) throw new DomainAuthoringError("QUERY_CODEC_NOT_JSON_SAFE", QUERY_CODEC_NOT_JSON_SAFE);
    if (Array.isArray(candidate)) {
      ancestors.add(candidate);
      try {
        if (Object.getOwnPropertySymbols(candidate).length > 0) {
          throw new DomainAuthoringError("QUERY_CODEC_NOT_JSON_SAFE", QUERY_CODEC_NOT_JSON_SAFE);
        }
        const names = Object.getOwnPropertyNames(candidate);
        const indexes = new Set<string>();
        for (let index = 0; index < candidate.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, index);
          if (descriptor === undefined || descriptor.enumerable !== true) {
            throw new DomainAuthoringError("QUERY_CODEC_NOT_JSON_SAFE", QUERY_CODEC_NOT_JSON_SAFE);
          }
          indexes.add(String(index));
        }
        if (names.length !== indexes.size + 1 || !names.includes("length")) {
          throw new DomainAuthoringError("QUERY_CODEC_NOT_JSON_SAFE", QUERY_CODEC_NOT_JSON_SAFE);
        }
        for (const name of names) {
          if (name !== "length" && !indexes.has(name)) {
            throw new DomainAuthoringError("QUERY_CODEC_NOT_JSON_SAFE", QUERY_CODEC_NOT_JSON_SAFE);
          }
        }
        const items: QueryJsonValue[] = [];
        for (let index = 0; index < candidate.length; index += 1) items.push(visit(candidate[index]));
        return items;
      } finally {
        ancestors.delete(candidate);
      }
    }
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new DomainAuthoringError("QUERY_CODEC_NOT_JSON_SAFE", QUERY_CODEC_NOT_JSON_SAFE);
    }
    if (Object.getOwnPropertySymbols(candidate).length > 0) {
      throw new DomainAuthoringError("QUERY_CODEC_NOT_JSON_SAFE", QUERY_CODEC_NOT_JSON_SAFE);
    }
    const names = Object.getOwnPropertyNames(candidate);
    const keys = Object.keys(candidate);
    if (names.length !== keys.length) throw new DomainAuthoringError("QUERY_CODEC_NOT_JSON_SAFE", QUERY_CODEC_NOT_JSON_SAFE);
    ancestors.add(candidate);
    try {
      const record: { [key: string]: QueryJsonValue } = Object.create(null);
      for (const key of keys) {
        Object.defineProperty(record, key, {
          value: visit((candidate as Record<string, unknown>)[key]),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return record;
    } finally {
      ancestors.delete(candidate);
    }
  };
  return visit(value);
}

function isThenable(value: unknown): boolean {
  return (typeof value === "object" || typeof value === "function")
    && value !== null
    && typeof (value as { then?: unknown }).then === "function";
}

function invokeCodec<T>(operation: () => T): T {
  try {
    const value = operation();
    if (isThenable(value)) {
      throw new DomainAuthoringError("QUERY_CODEC_ASYNC_UNSUPPORTED", QUERY_CODEC_ASYNC_UNSUPPORTED, { cause: value });
    }
    return value;
  } catch (error) {
    if (error instanceof DomainAuthoringError) throw error;
    if (error instanceof z.core.$ZodAsyncError) {
      throw new DomainAuthoringError("QUERY_CODEC_ASYNC_UNSUPPORTED", QUERY_CODEC_ASYNC_UNSUPPORTED, { cause: error });
    }
    if (error instanceof z.core.$ZodEncodeError) {
      throw new DomainAuthoringError("QUERY_CODEC_UNIDIRECTIONAL", QUERY_CODEC_UNIDIRECTIONAL, { cause: error });
    }
    throw error;
  }
}

function createCodec<Schema extends z.ZodTypeAny>(schema: Schema): QueryCodec<z.output<Schema>> {
  assertSupportedSchema(schema);
  return Object.freeze({
    encode: (value: z.output<Schema>): QueryJsonValue => {
      const encoded = invokeCodec(() => z.encode(schema, value));
      return assertQueryJsonValue(encoded);
    },
    decode: (value: unknown): z.output<Schema> => invokeCodec(() => z.decode(schema, value as z.input<Schema>)),
  });
}

function assertId(id: string): void {
  if (typeof id !== "string" || id.length === 0) {
    throw new DomainAuthoringError("QUERY_ID_REQUIRED", "Query id must be a non-empty string.");
  }
}

function assertVersion(version: number): void {
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version <= 0) {
    throw new DomainAuthoringError("QUERY_VERSION_INVALID", "Query version must be a positive safe integer.");
  }
}

function assertStrictParams(schema: z.ZodTypeAny): void {
  if (!isZodInternal(schema)) {
    throw new DomainAuthoringError("QUERY_PARAMS_SCHEMA_NOT_STRICT", "Query params must be a strict Zod object.");
  }
  const internal: ZodInternal = schema;
  if (internal._zod.def.type !== "object") {
    throw new DomainAuthoringError("QUERY_PARAMS_SCHEMA_NOT_STRICT", "Query params must be a strict Zod object.");
  }
  const catchall = internal._zod.def.catchall;
  if (!isZodInternal(catchall) || catchall._zod.def.type !== "never") {
    throw new DomainAuthoringError("QUERY_PARAMS_SCHEMA_NOT_STRICT", "Query params must be a strict Zod object.");
  }
}

function assertReservedParams(schema: z.ZodObject): void {
  for (const key of Object.keys(schema.shape)) {
    if ((RESERVED_PARAM_NAMES as readonly string[]).includes(key)) {
      throw new DomainAuthoringError("QUERY_PARAMS_RESERVED_NAME", "Query params must not declare a reserved control name.");
    }
  }
}

export interface QueryViewDefinition<
  Id extends string = string,
  Version extends number = number,
  RowSchema extends z.ZodTypeAny = z.ZodTypeAny,
> {
  readonly id: Id;
  readonly version: Version;
  readonly row: RowSchema;
  readonly rowCodec: QueryCodec<z.output<RowSchema>>;
}

export interface QueryDefinition<
  Id extends string = string,
  Version extends number = number,
  Source extends QueryViewDefinition = QueryViewDefinition,
  ParamsSchema extends z.ZodObject = z.ZodObject,
  ResultSchema extends z.ZodTypeAny = z.ZodTypeAny,
> {
  readonly kind: "query";
  readonly id: Id;
  readonly version: Version;
  readonly source: Source;
  readonly params: ParamsSchema;
  readonly result: ResultSchema;
  readonly handleQuery: (
    projection: QueryProjection<z.output<Source["row"]>>,
    params: Readonly<z.output<ParamsSchema>>,
    context: QueryHandlerContext,
  ) => z.output<ResultSchema>;
  readonly contract: QueryContract<z.output<ParamsSchema>, z.output<ResultSchema>>;
}

export interface ListQueryDefinition<
  Id extends string = string,
  Version extends number = number,
  Source extends QueryViewDefinition = QueryViewDefinition,
  ParamsSchema extends z.ZodObject = z.ZodObject,
  ItemSchema extends z.ZodTypeAny = z.ZodTypeAny,
> {
  readonly kind: "list-query";
  readonly id: Id;
  readonly version: Version;
  readonly source: Source;
  readonly params: ParamsSchema;
  readonly item: ItemSchema;
  readonly handleFilter: (
    projection: QueryProjection<z.output<Source["row"]>>,
    params: Readonly<z.output<ParamsSchema>>,
    context: QueryHandlerContext,
  ) => readonly Readonly<z.output<ItemSchema>>[];
  readonly handleSort: (
    items: readonly Readonly<z.output<ItemSchema>>[],
    params: Readonly<z.output<ParamsSchema>>,
    context: QueryHandlerContext,
  ) => readonly Readonly<z.output<ItemSchema>>[];
  readonly contract: ListQueryContract<z.output<ParamsSchema>, z.output<ItemSchema>>;
}

type ParamsField<ParamsSchema extends z.ZodObject> =
  Extract<keyof z.output<ParamsSchema>, ReservedParamName> extends never ? ParamsSchema : never;

interface QueryViewOptions<
  Id extends string,
  Version extends number,
  RowSchema extends z.ZodTypeAny,
> {
  readonly id: Id;
  readonly version: Version;
  readonly row: RowSchema;
}

interface QueryOptions<
  Id extends string,
  Version extends number,
  Source extends QueryViewDefinition,
  ParamsSchema extends z.ZodObject,
  ResultSchema extends z.ZodTypeAny,
> {
  readonly id: Id;
  readonly version: Version;
  readonly source: Source;
  readonly params: ParamsField<ParamsSchema>;
  readonly result: ResultSchema;
  readonly handleQuery: (
    projection: QueryProjection<z.output<Source["row"]>>,
    params: Readonly<z.output<ParamsSchema>>,
    context: QueryHandlerContext,
  ) => z.output<ResultSchema>;
}

interface ListQueryOptions<
  Id extends string,
  Version extends number,
  Source extends QueryViewDefinition,
  ParamsSchema extends z.ZodObject,
  ItemSchema extends z.ZodTypeAny,
> {
  readonly id: Id;
  readonly version: Version;
  readonly source: Source;
  readonly params: ParamsField<ParamsSchema>;
  readonly item: ItemSchema;
  readonly handleFilter: (
    projection: QueryProjection<z.output<Source["row"]>>,
    params: Readonly<z.output<ParamsSchema>>,
    context: QueryHandlerContext,
  ) => readonly Readonly<z.output<ItemSchema>>[];
  readonly handleSort: (
    items: readonly Readonly<z.output<ItemSchema>>[],
    params: Readonly<z.output<ParamsSchema>>,
    context: QueryHandlerContext,
  ) => readonly Readonly<z.output<ItemSchema>>[];
}

export function defineQueryView<
  const Id extends string,
  const Version extends number,
  const RowSchema extends z.ZodTypeAny,
>(options: QueryViewOptions<Id, Version, RowSchema>): QueryViewDefinition<Id, Version, RowSchema> {
  assertId(options.id);
  assertVersion(options.version);
  const rowCodec = createCodec(options.row);
  return Object.freeze({
    id: options.id,
    version: options.version,
    row: options.row,
    rowCodec,
  });
}

export function defineQuery<
  const Id extends string,
  const Version extends number,
  const Source extends QueryViewDefinition,
  const ParamsSchema extends z.ZodObject,
  const ResultSchema extends z.ZodTypeAny,
>(options: QueryOptions<Id, Version, Source, ParamsSchema, ResultSchema>): QueryDefinition<Id, Version, Source, ParamsSchema, ResultSchema> {
  assertId(options.id);
  assertVersion(options.version);
  const paramsSchema = options.params as ParamsSchema;
  assertStrictParams(paramsSchema);
  assertReservedParams(paramsSchema);
  const params = createCodec(paramsSchema);
  const result = createCodec(options.result);
  return Object.freeze({
    kind: "query" as const,
    id: options.id,
    version: options.version,
    source: options.source,
    params: paramsSchema,
    result: options.result,
    handleQuery: options.handleQuery,
    contract: Object.freeze({
      kind: "query" as const,
      id: options.id,
      version: options.version,
      params,
      result,
    }),
  });
}

export function defineListQuery<
  const Id extends string,
  const Version extends number,
  const Source extends QueryViewDefinition,
  const ParamsSchema extends z.ZodObject,
  const ItemSchema extends z.ZodTypeAny,
>(options: ListQueryOptions<Id, Version, Source, ParamsSchema, ItemSchema>): ListQueryDefinition<Id, Version, Source, ParamsSchema, ItemSchema> {
  assertId(options.id);
  assertVersion(options.version);
  const paramsSchema = options.params as ParamsSchema;
  assertStrictParams(paramsSchema);
  assertReservedParams(paramsSchema);
  const params = createCodec(paramsSchema);
  const item = createCodec(options.item);
  return Object.freeze({
    kind: "list-query" as const,
    id: options.id,
    version: options.version,
    source: options.source,
    params: paramsSchema,
    item: options.item,
    handleFilter: options.handleFilter,
    handleSort: options.handleSort,
    contract: Object.freeze({
      kind: "list-query" as const,
      id: options.id,
      version: options.version,
      params,
      item,
    }),
  });
}
