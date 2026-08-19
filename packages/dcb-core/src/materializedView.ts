import { assertJsonValue, type JsonValue } from "./index";

/** The only scalar representations that may be persisted in an MV index. */
export type MaterializedViewIndexValueType = "text" | "integer" | "real";

export type MaterializedViewIndexValue = string | number;

/** A finite, deploy-time index descriptor.  Its callback is pure by contract. */
export interface MaterializedViewIndexDescriptor<TEvent = unknown> {
  readonly id: string;
  readonly valueType: MaterializedViewIndexValueType;
  readonly value: (row: JsonValue, event: TEvent) => unknown;
}

export interface MaterializedViewRowUpsert {
  readonly rowKey: string;
  readonly value: JsonValue;
  readonly rowVersion: number;
  readonly sourceSuid: string;
}

export interface MaterializedViewRowDelete {
  readonly rowKey: string;
}

/**
 * A declarative partial-row mutation. The runtime applies `patch` with a
 * database JSON function; it must not read/merge the row in TypeScript.
 * When index entries are supplied, they replace this row's index entries in
 * the same atomic batch. An empty list preserves existing entries.
 */
export interface MaterializedViewRowPatch {
  readonly kind: "json_patch";
  readonly rowKey: string;
  readonly patch: JsonValue;
  readonly rowVersion: number;
  readonly sourceSuid: string;
  readonly indexEntries: readonly MaterializedViewIndexEntryMutation[];
}

export interface MaterializedViewIndexEntryMutation {
  readonly indexId: string;
  readonly valueType: MaterializedViewIndexValueType;
  readonly value: MaterializedViewIndexValue;
  readonly rowKey: string;
}

export interface MaterializedViewIndexEntryDelete {
  readonly indexId?: string;
  readonly rowKey: string;
}

/**
 * A complete deterministic write plan for one source event.  The runtime
 * turns this value into prepared statements; no request-derived value is ever
 * used as a SQL identifier.
 */
export interface MaterializedViewMutationPlan {
  readonly rowUpserts: readonly MaterializedViewRowUpsert[];
  readonly rowDeletes: readonly MaterializedViewRowDelete[];
  readonly rowPatches: readonly MaterializedViewRowPatch[];
  readonly indexEntries: readonly MaterializedViewIndexEntryMutation[];
  readonly indexDeletes: readonly MaterializedViewIndexEntryDelete[];
}

export interface MaterializedViewRowMaterializerOptions<TEvent = unknown> {
  readonly id: string;
  readonly version?: number;
  readonly indexDescriptors?: readonly MaterializedViewIndexDescriptor<TEvent>[];
  readonly indexes?: readonly MaterializedViewIndexDescriptor<TEvent>[];
  /** Return row upserts/deletes, or a complete plan when custom indexes are needed. */
  readonly materialize?: (event: TEvent) => MaterializedViewMaterializeResult;
  readonly plan?: (event: TEvent) => MaterializedViewMaterializeResult;
}

export type MaterializedViewMaterializeResult =
  | {
      readonly rowUpserts?: readonly MaterializedViewRowInput[];
      readonly upserts?: readonly MaterializedViewRowInput[];
      readonly rowDeletes?: readonly (string | MaterializedViewRowDelete)[];
      readonly deletes?: readonly (string | MaterializedViewRowDelete)[];
      readonly rowPatches?: readonly MaterializedViewRowPatchInput[];
      readonly patches?: readonly MaterializedViewRowPatchInput[];
      readonly indexEntries?: readonly MaterializedViewIndexEntryInput[];
      readonly indexDeletes?: readonly MaterializedViewIndexEntryDelete[];
    }
  | MaterializedViewMutationPlan;

export interface MaterializedViewRowInput {
  readonly rowKey: string;
  readonly value: unknown;
  readonly rowVersion?: number;
  readonly sourceSuid?: string;
}

export interface MaterializedViewRowPatchInput {
  readonly kind: "json_patch";
  readonly rowKey: string;
  readonly patch: unknown;
  readonly rowVersion?: number;
  readonly sourceSuid?: string;
  readonly indexEntries?: readonly MaterializedViewIndexEntryInput[];
}

export interface MaterializedViewIndexEntryInput {
  readonly indexId: string;
  readonly valueType?: MaterializedViewIndexValueType;
  readonly value: unknown;
  readonly rowKey: string;
}

export interface MaterializedViewRowMaterializer<TEvent = unknown> {
  readonly id: string;
  readonly version: number;
  readonly indexDescriptors: readonly MaterializedViewIndexDescriptor<TEvent>[];
  readonly plan: (event: TEvent) => MaterializedViewMutationPlan;
  readonly planFor: (event: TEvent) => MaterializedViewMutationPlan;
  readonly mutationPlan: (event: TEvent) => MaterializedViewMutationPlan;
}

export type RowMaterializerDefinition<TEvent = unknown> = MaterializedViewRowMaterializer<TEvent>;

function nonEmpty(value: unknown, code: string, message: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${code}: ${message}`);
}

function descriptorValue<TEvent>(
  descriptor: MaterializedViewIndexDescriptor<TEvent>,
  value: unknown,
): MaterializedViewIndexValue {
  if (descriptor.valueType === "text") {
    if (typeof value !== "string") throw new Error(`MV index ${descriptor.id} expected a text value`);
    return value;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`MV index ${descriptor.id} expected a finite numeric value`);
  }
  if (descriptor.valueType === "integer" && (!Number.isSafeInteger(value) || !Number.isInteger(value))) {
    throw new Error(`MV index ${descriptor.id} expected a safe integer value`);
  }
  return value;
}

function validateDescriptors<TEvent>(
  descriptors: readonly MaterializedViewIndexDescriptor<TEvent>[],
): readonly MaterializedViewIndexDescriptor<TEvent>[] {
  const seen = new Set<string>();
  for (const descriptor of descriptors) {
    nonEmpty(descriptor.id, "MV_INDEX_ID_REQUIRED", "Index descriptor id is required");
    if (seen.has(descriptor.id)) throw new Error(`MV_INDEX_DUPLICATE: ${descriptor.id}`);
    seen.add(descriptor.id);
    if (!["text", "integer", "real"].includes(descriptor.valueType)) {
      throw new Error(`MV_INDEX_VALUE_TYPE_INVALID: ${descriptor.id}`);
    }
    if (typeof descriptor.value !== "function") throw new Error(`MV_INDEX_VALUE_REQUIRED: ${descriptor.id}`);
  }
  return Object.freeze(descriptors.map((descriptor) => Object.freeze({ ...descriptor })));
}

function normalizeRowInput<TEvent>(input: MaterializedViewRowInput, event: TEvent): MaterializedViewRowUpsert {
  nonEmpty(input.rowKey, "MV_ROW_KEY_REQUIRED", "Row key is required");
  const value = assertJsonValue(input.value, "state-persistence");
  const rowVersion = input.rowVersion ?? 1;
  if (!Number.isSafeInteger(rowVersion) || rowVersion < 0) throw new Error(`MV_ROW_VERSION_INVALID: ${input.rowKey}`);
  const sourceSuid = input.sourceSuid ?? (
    typeof event === "object" && event !== null && "suid" in event && typeof (event as { suid?: unknown }).suid === "string"
      ? (event as { suid: string }).suid
      : ""
  );
  nonEmpty(sourceSuid, "MV_SOURCE_SUID_REQUIRED", `Source SUID is required for ${input.rowKey}`);
  return Object.freeze({ rowKey: input.rowKey, value, rowVersion, sourceSuid });
}

function normalizeRowDeletes(values: readonly (string | MaterializedViewRowDelete)[] = []): readonly MaterializedViewRowDelete[] {
  const keys = new Set<string>();
  for (const value of values) {
    const rowKey = typeof value === "string" ? value : value.rowKey;
    nonEmpty(rowKey, "MV_ROW_KEY_REQUIRED", "Row delete key is required");
    keys.add(rowKey);
  }
  return Object.freeze([...keys].map((rowKey) => Object.freeze({ rowKey })));
}

function normalizeIndexEntries<TEvent>(
  values: readonly MaterializedViewIndexEntryInput[],
  descriptors: readonly MaterializedViewIndexDescriptor<TEvent>[],
  rowKey?: string,
): readonly MaterializedViewIndexEntryMutation[] {
  const descriptorById = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  return Object.freeze(values.map((entry) => {
    nonEmpty(entry.indexId, "MV_INDEX_ID_REQUIRED", "Index entry id is required");
    const descriptor = descriptorById.get(entry.indexId);
    if (descriptor === undefined) throw new Error(`MV_INDEX_UNDECLARED: ${entry.indexId}`);
    nonEmpty(entry.rowKey, "MV_ROW_KEY_REQUIRED", "Index entry row key is required");
    if (rowKey !== undefined && entry.rowKey !== rowKey) {
      throw new Error(`MV_INDEX_ROW_KEY_MISMATCH: ${entry.indexId}`);
    }
    const valueType = entry.valueType ?? descriptor.valueType;
    if (valueType !== descriptor.valueType) throw new Error(`MV_INDEX_VALUE_TYPE_MISMATCH: ${entry.indexId}`);
    return Object.freeze({
      indexId: entry.indexId,
      valueType,
      value: descriptorValue(descriptor, entry.value),
      rowKey: entry.rowKey,
    });
  }));
}

function normalizeRowPatches<TEvent>(
  values: readonly MaterializedViewRowPatchInput[],
  descriptors: readonly MaterializedViewIndexDescriptor<TEvent>[],
  event: TEvent,
): readonly MaterializedViewRowPatch[] {
  return Object.freeze(values.map((input) => {
    nonEmpty(input.rowKey, "MV_ROW_KEY_REQUIRED", "Row patch key is required");
    if (input.kind !== "json_patch") throw new Error(`MV_PATCH_KIND_INVALID: ${input.rowKey}`);
    const patch = assertJsonValue(input.patch, "state-persistence");
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      throw new Error(`MV_PATCH_OBJECT_REQUIRED: ${input.rowKey}`);
    }
    const rowVersion = input.rowVersion ?? 1;
    if (!Number.isSafeInteger(rowVersion) || rowVersion < 0) throw new Error(`MV_ROW_VERSION_INVALID: ${input.rowKey}`);
    const sourceSuid = input.sourceSuid ?? (
      typeof event === "object" && event !== null && "suid" in event && typeof (event as { suid?: unknown }).suid === "string"
        ? (event as { suid: string }).suid
        : ""
    );
    nonEmpty(sourceSuid, "MV_SOURCE_SUID_REQUIRED", `Source SUID is required for ${input.rowKey}`);
    return Object.freeze({
      kind: "json_patch" as const,
      rowKey: input.rowKey,
      patch,
      rowVersion,
      sourceSuid,
      indexEntries: normalizeIndexEntries(input.indexEntries ?? [], descriptors, input.rowKey),
    });
  }));
}

function normalizePlan<TEvent>(
  result: MaterializedViewMaterializeResult,
  descriptors: readonly MaterializedViewIndexDescriptor<TEvent>[],
  event: TEvent,
): MaterializedViewMutationPlan {
  const value = result as Record<string, unknown>;
  const rawUpserts = (value.rowUpserts ?? value.upserts ?? []) as readonly MaterializedViewRowInput[];
  const rawDeletes = (value.rowDeletes ?? value.deletes ?? []) as readonly (string | MaterializedViewRowDelete)[];
  const rawPatches = (value.rowPatches ?? value.patches ?? []) as readonly MaterializedViewRowPatchInput[];
  const rowUpserts = rawUpserts.map((row) => normalizeRowInput(row, event));
  const rowDeletes = normalizeRowDeletes(rawDeletes);
  const rowPatches = normalizeRowPatches(rawPatches, descriptors, event);
  const descriptorById = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  const explicitEntries = (value.indexEntries ?? []) as readonly MaterializedViewIndexEntryInput[];
  const generatedEntries: MaterializedViewIndexEntryMutation[] = [];
  for (const row of rowUpserts) {
    for (const descriptor of descriptors) {
      let candidate: unknown;
      try {
        candidate = descriptor.value(row.value, event);
      } catch (error) {
        throw new Error(`MV_INDEX_VALUE_FAILED: ${descriptor.id}: ${String(error)}`);
      }
      if (candidate === undefined || candidate === null) continue;
      generatedEntries.push(Object.freeze({
        indexId: descriptor.id,
        valueType: descriptor.valueType,
        value: descriptorValue(descriptor, candidate),
        rowKey: row.rowKey,
      }));
    }
  }
  generatedEntries.push(...normalizeIndexEntries(explicitEntries, descriptors));
  const indexDeletes = Object.freeze(((value.indexDeletes ?? []) as readonly MaterializedViewIndexEntryDelete[]).map((entry) => {
    nonEmpty(entry.rowKey, "MV_ROW_KEY_REQUIRED", "Index delete row key is required");
    if (entry.indexId !== undefined) {
      nonEmpty(entry.indexId, "MV_INDEX_ID_REQUIRED", "Index delete id is required");
      if (!descriptorById.has(entry.indexId)) throw new Error(`MV_INDEX_UNDECLARED: ${entry.indexId}`);
    }
    return Object.freeze({ indexId: entry.indexId, rowKey: entry.rowKey });
  }));
  return Object.freeze({
    rowUpserts: Object.freeze(rowUpserts),
    rowDeletes,
    rowPatches,
    indexEntries: Object.freeze(generatedEntries),
    indexDeletes,
  });
}

/** Define a finite, JSON-validating, deterministic row materializer. */
export function defineRowMaterializer<TEvent = unknown>(
  options: MaterializedViewRowMaterializerOptions<TEvent>,
): MaterializedViewRowMaterializer<TEvent> {
  nonEmpty(options.id, "MV_ID_REQUIRED", "Materialized-view id is required");
  const version = options.version ?? 1;
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("MV_VERSION_INVALID: version must be positive");
  const descriptors = validateDescriptors(options.indexDescriptors ?? options.indexes ?? []);
  const materialize = options.materialize ?? options.plan;
  if (typeof materialize !== "function") throw new Error(`MV_MATERIALIZER_REQUIRED: ${options.id}`);
  const plan = (event: TEvent): MaterializedViewMutationPlan => normalizePlan(materialize(event), descriptors, event);
  return Object.freeze({
    id: options.id,
    version,
    indexDescriptors: descriptors,
    plan,
    planFor: plan,
    mutationPlan: plan,
  });
}

export const defineMaterializedView = defineRowMaterializer;
export const defineMaterializedViewRowMaterializer = defineRowMaterializer;
