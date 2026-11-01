import type { QueryCodec, QueryHandlerContext, QueryJsonValue, QueryProjection } from "@sekiban/dcb-core";

export const PORTABLE_QUERY_MAXIMUM = 10_000;

export const INTENDED_PUBLIC_QUERY_FAILURE_MAPPING = {
  "projection-unavailable": "projection_unavailable",
  "row-invalid": "query_row_invalid",
} as const;

export type PortableQueryFailureKind =
  | "params-invalid"
  | "scan-limit-exceeded"
  | "row-invalid"
  | "result-invalid"
  | "handler-failed"
  | "projection-unavailable";

const FAILURE_MESSAGE: Record<PortableQueryFailureKind, string> = {
  "params-invalid": "Query params are invalid.",
  "scan-limit-exceeded": "Query scan limit was exceeded.",
  "row-invalid": "Query row is invalid.",
  "result-invalid": "Query result is invalid.",
  "handler-failed": "Query handler failed.",
  "projection-unavailable": "Query projection is unavailable.",
};

export interface PortableQueryFailure {
  readonly ok: false;
  readonly kind: PortableQueryFailureKind;
  readonly message: string;
}

export interface PortableScalarSuccess {
  readonly ok: true;
  readonly kind: "scalar";
  readonly result: QueryJsonValue;
  readonly readHead?: string;
}

export interface PortableListSuccess {
  readonly ok: true;
  readonly kind: "list";
  readonly items: readonly QueryJsonValue[];
  readonly totalCount: number;
  readonly totalPages: number;
  readonly currentPage: number;
  readonly pageSize: number;
  readonly readHead?: string;
}

export type PortableQuerySuccess = PortableScalarSuccess | PortableListSuccess;

export interface PortableCanonicalRow {
  readonly key: string;
  readonly value: unknown;
  readonly sourceSuid: string;
}

export interface PortableScanBatch {
  readonly candidates: readonly unknown[];
  readonly readHead?: string;
}

export interface PortableListControls {
  readonly pageNumber: number;
  readonly pageSize: number;
  readonly descending: boolean;
}

export interface PortableScalarDefinition<Row, Params, Result> {
  readonly kind: "scalar";
  readonly rowCodec: QueryCodec<Row>;
  readonly paramsCodec: QueryCodec<Params>;
  readonly resultCodec: QueryCodec<Result>;
  readonly handleQuery: (
    projection: QueryProjection<Row>,
    params: Params,
    context: QueryHandlerContext,
  ) => Result;
}

export interface PortableListDefinition<Row, Params, Item> {
  readonly kind: "list";
  readonly rowCodec: QueryCodec<Row>;
  readonly paramsCodec: QueryCodec<Params>;
  readonly itemCodec: QueryCodec<Item>;
  readonly handleFilter: (
    projection: QueryProjection<Row>,
    params: Params,
    context: QueryHandlerContext,
  ) => readonly Item[];
  readonly handleSort: (
    items: readonly Item[],
    params: Params,
    context: QueryHandlerContext,
  ) => readonly Item[];
}

export type PortableQueryDefinition<Row, Params, Result, Item> =
  | PortableScalarDefinition<Row, Params, Result>
  | PortableListDefinition<Row, Params, Item>;

export interface PortableQueryInput<Row, Params, Result, Item> {
  readonly definition: PortableQueryDefinition<Row, Params, Result, Item>;
  readonly params: unknown;
  readonly maximum: number;
  readonly scan: (limit: number) => Promise<PortableScanBatch>;
  readonly canonicalize: (candidate: unknown) => PortableCanonicalRow;
  readonly admit?: () => void | Promise<void>;
  readonly page?: PortableListControls;
}

class RowInvalid extends Error {
  constructor() {
    super(FAILURE_MESSAGE["row-invalid"]);
    this.name = "RowInvalid";
  }
}

class DetachedCopyError extends Error {
  constructor() {
    super("Value cannot be copied.");
    this.name = "DetachedCopyError";
  }
}

const failureObjects = new WeakSet<object>();

function failure(kind: PortableQueryFailureKind): PortableQueryFailure {
  const value: PortableQueryFailure = { ok: false, kind, message: FAILURE_MESSAGE[kind] };
  failureObjects.add(value);
  return value;
}

function isThenable(value: unknown): boolean {
  return (typeof value === "object" || typeof value === "function")
    && value !== null
    && typeof (value as { then?: unknown }).then === "function";
}

export function compareUtf8(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const shared = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function dataPropertyNames(value: object): string[] | undefined {
  if (Object.getOwnPropertySymbols(value).length > 0) return undefined;
  const names = Object.getOwnPropertyNames(value);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined || !("value" in descriptor)) {
      return undefined;
    }
  }
  return names;
}

function denseArray(value: readonly unknown[]): boolean {
  const names = dataPropertyNames(value);
  if (names === undefined || !names.includes("length") || names.length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!names.includes(String(index))) return false;
  }
  return true;
}

export function detachedCopy(value: unknown, seen: WeakMap<object, unknown> = new WeakMap()): unknown {
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type === "boolean" || type === "number" || type === "string" || type === "bigint") return value;
  if (type !== "object") throw new DetachedCopyError();
  if (seen.has(value)) return seen.get(value);
  if (isThenable(value)) throw new DetachedCopyError();
  const prototype = Object.getPrototypeOf(value);
  const names = dataPropertyNames(value);
  if (names === undefined) throw new DetachedCopyError();
  if (prototype === Date.prototype) {
    if (names.length !== 0 || !(value instanceof Date)) throw new DetachedCopyError();
    const copy = new Date(value.getTime());
    seen.set(value, copy);
    return copy;
  }
  if (prototype === Map.prototype) {
    if (names.length !== 0 || !(value instanceof Map)) throw new DetachedCopyError();
    const copy = new Map<unknown, unknown>();
    seen.set(value, copy);
    for (const [key, entry] of value) {
      copy.set(detachedCopy(key, seen), detachedCopy(entry, seen));
    }
    return copy;
  }
  if (prototype === Set.prototype) {
    if (names.length !== 0 || !(value instanceof Set)) throw new DetachedCopyError();
    const copy = new Set<unknown>();
    seen.set(value, copy);
    for (const entry of value) copy.add(detachedCopy(entry, seen));
    return copy;
  }
  if (prototype === Array.prototype) {
    if (!Array.isArray(value) || !denseArray(value)) throw new DetachedCopyError();
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (let index = 0; index < value.length; index += 1) copy.push(detachedCopy(value[index], seen));
    return copy;
  }
  if (prototype !== Object.prototype && prototype !== null) throw new DetachedCopyError();
  const copy: Record<string, unknown> = prototype === null ? Object.create(null) : {};
  seen.set(value, copy);
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) throw new DetachedCopyError();
    Object.defineProperty(copy, key, {
      value: detachedCopy(descriptor.value, seen),
      enumerable: descriptor.enumerable === true,
      configurable: true,
      writable: true,
    });
  }
  return copy;
}

function tagContent(projectionId: string, tagGroup: string, tagProjector: string): string | undefined {
  const parts = projectionId.split(":");
  if (parts.length !== 4) return undefined;
  const [marker, group, content, projector] = parts;
  if (marker !== "tag-state" || group !== tagGroup || projector !== tagProjector) return undefined;
  if (group.length === 0 || content.length === 0 || projector.length === 0) return undefined;
  return content;
}

function decodeRowValue(stateJson: string, decodeRow: (value: unknown) => unknown): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stateJson);
  } catch {
    throw new RowInvalid();
  }
  try {
    const decoded = decodeRow(parsed);
    if (isThenable(decoded)) throw new RowInvalid();
    return detachedCopy(decoded);
  } catch (error) {
    if (error instanceof RowInvalid) throw error;
    throw new RowInvalid();
  }
}

export function canonicalizeCheckpointCandidate(
  candidate: unknown,
  decodeRow: (value: unknown) => unknown,
  identity: { readonly tagGroup: string; readonly tagProjector: string },
): PortableCanonicalRow {
  if (typeof candidate !== "object" || candidate === null) throw new RowInvalid();
  const record = candidate as { readonly projectionId?: unknown; readonly lastSuid?: unknown; readonly stateJson?: unknown };
  if (typeof record.projectionId !== "string" || typeof record.lastSuid !== "string" || typeof record.stateJson !== "string") {
    throw new RowInvalid();
  }
  const key = tagContent(record.projectionId, identity.tagGroup, identity.tagProjector);
  if (key === undefined) throw new RowInvalid();
  return { key, value: decodeRowValue(record.stateJson, decodeRow), sourceSuid: record.lastSuid };
}

export function canonicalizeMaterializedCandidate(
  candidate: unknown,
  decodeRow: (value: unknown) => unknown,
): PortableCanonicalRow {
  if (typeof candidate !== "object" || candidate === null) throw new RowInvalid();
  const record = candidate as { readonly rowKey?: unknown; readonly valueJson?: unknown; readonly sourceSuid?: unknown };
  if (typeof record.rowKey !== "string" || typeof record.valueJson !== "string" || typeof record.sourceSuid !== "string") {
    throw new RowInvalid();
  }
  if (record.rowKey.length === 0 || record.sourceSuid.length === 0) throw new RowInvalid();
  return { key: record.rowKey, value: decodeRowValue(record.valueJson, decodeRow), sourceSuid: record.sourceSuid };
}

function orderRows(rows: readonly PortableCanonicalRow[]): PortableCanonicalRow[] | PortableQueryFailure {
  const decorated = rows.map((row, index) => ({ row, index }));
  decorated.sort((left, right) => {
    const byKey = compareUtf8(left.row.key, right.row.key);
    if (byKey !== 0) return byKey;
    const bySuid = compareUtf8(left.row.sourceSuid, right.row.sourceSuid);
    if (bySuid !== 0) return bySuid;
    return left.index - right.index;
  });
  const ordered = decorated.map((entry) => entry.row);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.key === ordered[index - 1]!.key) return failure("row-invalid");
  }
  return ordered;
}

function asRows(value: PortableCanonicalRow[] | PortableQueryFailure): PortableCanonicalRow[] | PortableQueryFailure {
  return value;
}

function snapshot(value: unknown, kind: PortableQueryFailureKind): unknown | PortableQueryFailure {
  try {
    if (isThenable(value)) return failure(kind);
    return detachedCopy(value);
  } catch {
    return failure(kind);
  }
}

function isFailure(value: unknown): value is PortableQueryFailure {
  return typeof value === "object" && value !== null && failureObjects.has(value);
}

function invoke<T>(operation: () => T): T | PortableQueryFailure {
  try {
    const value = operation();
    if (isThenable(value)) return failure("handler-failed");
    return value;
  } catch {
    return failure("handler-failed");
  }
}

function encodeValue(encode: (value: unknown) => unknown, value: unknown): QueryJsonValue | PortableQueryFailure {
  try {
    const encoded = encode(value);
    if (isThenable(encoded)) return failure("result-invalid");
    return encoded as QueryJsonValue;
  } catch {
    return failure("result-invalid");
  }
}

function projectionSnapshot(rows: readonly PortableCanonicalRow[], readHead: string | undefined): QueryProjection<unknown> {
  const projection: QueryProjection<unknown> = {
    rows: rows.map((row) => ({
      key: row.key,
      value: row.value as Readonly<unknown>,
      sourceSuid: row.sourceSuid,
    })),
    ...(readHead === undefined ? {} : { readHead }),
  };
  return projection;
}

function contextSnapshot(readHead: string | undefined): QueryHandlerContext {
  return readHead === undefined ? {} : { readHead };
}

function validMaximum(maximum: number): boolean {
  return Number.isSafeInteger(maximum) && maximum >= 1 && maximum <= PORTABLE_QUERY_MAXIMUM;
}

function validPage(page: PortableListControls | undefined, kind: "scalar" | "list"): page is PortableListControls | undefined {
  if (kind === "scalar") return true;
  if (page === undefined) return false;
  return Number.isSafeInteger(page.pageNumber) && page.pageNumber >= 1
    && Number.isSafeInteger(page.pageSize) && page.pageSize >= 1
    && typeof page.descending === "boolean";
}

export async function executePortableQuery<Row, Params, Result, Item>(
  input: PortableQueryInput<Row, Params, Result, Item>,
): Promise<PortableQuerySuccess | PortableQueryFailure> {
  if (!validMaximum(input.maximum)) return failure("scan-limit-exceeded");
  if (!validPage(input.page, input.definition.kind)) return failure("result-invalid");

  let paramsSnapshot: unknown;
  try {
    const decoded = input.definition.paramsCodec.decode(input.params);
    if (isThenable(decoded)) return failure("params-invalid");
    paramsSnapshot = detachedCopy(decoded);
  } catch {
    return failure("params-invalid");
  }

  if (input.admit !== undefined) await input.admit();

  let batch: PortableScanBatch;
  try {
    batch = await input.scan(input.maximum + 1);
  } catch {
    return failure("projection-unavailable");
  }
  if (batch === null || typeof batch !== "object" || !Array.isArray(batch.candidates)) return failure("projection-unavailable");
  if (batch.readHead !== undefined && typeof batch.readHead !== "string") return failure("projection-unavailable");
  if (batch.candidates.length > input.maximum) return failure("scan-limit-exceeded");

  const decodedRows: PortableCanonicalRow[] = [];
  for (const candidate of batch.candidates) {
    let produced: PortableCanonicalRow;
    try {
      produced = input.canonicalize(candidate);
    } catch {
      return failure("row-invalid");
    }
    if (produced === null || typeof produced !== "object" || typeof produced.key !== "string" || typeof produced.sourceSuid !== "string") {
      return failure("row-invalid");
    }
    const value = snapshot(produced.value, "row-invalid");
    if (isFailure(value)) return value;
    decodedRows.push({ key: produced.key, value, sourceSuid: produced.sourceSuid });
  }

  const ordered = asRows(orderRows(decodedRows));
  if (isFailure(ordered)) return ordered;
  const readHead = batch.readHead;
  const projection = projectionSnapshot(ordered, readHead);
  const context = contextSnapshot(readHead);

  if (input.definition.kind === "scalar") {
    const returned = invoke(() => input.definition.kind === "scalar"
      ? input.definition.handleQuery(
        detachedCopy(projection) as QueryProjection<Row>,
        detachedCopy(paramsSnapshot) as Params,
        detachedCopy(context) as QueryHandlerContext,
      )
      : undefined);
    if (isFailure(returned)) return returned;
    const snapped = snapshot(returned, "result-invalid");
    if (isFailure(snapped)) return snapped;
    const encoded = encodeValue(
      input.definition.resultCodec.encode as (value: unknown) => unknown,
      snapped,
    );
    if (isFailure(encoded)) return encoded;
    return { ok: true, kind: "scalar", result: encoded, ...(readHead === undefined ? {} : { readHead }) };
  }

  const filtered = invoke(() => input.definition.kind === "list"
    ? input.definition.handleFilter(
      detachedCopy(projection) as QueryProjection<Row>,
      detachedCopy(paramsSnapshot) as Params,
      detachedCopy(context) as QueryHandlerContext,
    )
    : undefined);
  if (isFailure(filtered)) return filtered;
  if (!Array.isArray(filtered)) return failure("result-invalid");
  const filteredSnapshot = snapshot(filtered, "result-invalid");
  if (isFailure(filteredSnapshot)) return filteredSnapshot;
  if (!Array.isArray(filteredSnapshot)) return failure("result-invalid");

  const sorted = invoke(() => input.definition.kind === "list"
    ? input.definition.handleSort(
      detachedCopy(filteredSnapshot) as readonly Item[],
      detachedCopy(paramsSnapshot) as Params,
      detachedCopy(context) as QueryHandlerContext,
    )
    : undefined);
  if (isFailure(sorted)) return sorted;
  if (!Array.isArray(sorted) || sorted.length !== filteredSnapshot.length) return failure("result-invalid");
  const sortedSnapshot = snapshot(sorted, "result-invalid");
  if (isFailure(sortedSnapshot) || !Array.isArray(sortedSnapshot)) {
    return isFailure(sortedSnapshot) ? sortedSnapshot : failure("result-invalid");
  }
  if (sortedSnapshot.length !== filteredSnapshot.length) return failure("result-invalid");

  const page = input.page!;
  const totalCount = filteredSnapshot.length;
  const directed = page.descending ? [...sortedSnapshot].reverse() : sortedSnapshot;
  const start = (page.pageNumber - 1) * page.pageSize;
  const visible = directed.slice(start, start + page.pageSize);
  const items: QueryJsonValue[] = [];
  for (const item of visible) {
    const snapped = snapshot(item, "result-invalid");
    if (isFailure(snapped)) return snapped;
    const encoded = encodeValue(input.definition.itemCodec.encode as (value: unknown) => unknown, snapped);
    if (isFailure(encoded)) return encoded;
    items.push(encoded);
  }
  return {
    ok: true,
    kind: "list",
    items,
    totalCount,
    totalPages: totalCount === 0 ? 0 : Math.ceil(totalCount / page.pageSize),
    currentPage: page.pageNumber,
    pageSize: page.pageSize,
    ...(readHead === undefined ? {} : { readHead }),
  };
}
