export type QueryEndpoint = "query" | "list-query";

export interface QueryRegistrationMetadata {
  readonly queryType: string;
  readonly endpoint: QueryEndpoint;
  readonly tagGroup: string;
  readonly tagProjector: string;
  /** MV view id used when the query backing is d1-mv; defaults to the projector id. */
  readonly materializedViewId?: string;
  readonly enabled: boolean;
}

export interface RuntimeQueryCodec<Value = unknown> {
  readonly encode: (value: Value) => unknown;
  readonly decode: (value: unknown) => Value;
}

export interface RuntimeScalarQueryExecution {
  readonly kind: "scalar";
  readonly rowCodec: RuntimeQueryCodec;
  readonly paramsCodec: RuntimeQueryCodec;
  readonly resultCodec: RuntimeQueryCodec;
  handleQuery(projection: unknown, params: unknown, context: unknown): unknown;
}

export interface RuntimeListQueryExecution {
  readonly kind: "list";
  readonly rowCodec: RuntimeQueryCodec;
  readonly paramsCodec: RuntimeQueryCodec;
  readonly itemCodec: RuntimeQueryCodec;
  handleFilter(projection: unknown, params: unknown, context: unknown): unknown;
  handleSort(items: unknown, params: unknown, context: unknown): unknown;
}

export interface LegacyQueryDefinition extends QueryRegistrationMetadata {
  readonly execution?: undefined;
}

export interface ExecutableScalarQueryDefinition extends QueryRegistrationMetadata {
  readonly endpoint: "query";
  readonly version: number;
  readonly execution: RuntimeScalarQueryExecution;
}

export interface ExecutableListQueryDefinition extends QueryRegistrationMetadata {
  readonly endpoint: "list-query";
  readonly version: number;
  readonly execution: RuntimeListQueryExecution;
}

export type ExecutableQueryDefinition = ExecutableScalarQueryDefinition | ExecutableListQueryDefinition;

/**
 * Query types are deployed values, just like tag-state projectors. HTTP input
 * selects one of these definitions; it cannot provide a reducer or query
 * implementation of its own.
 */
export type QueryDefinition = LegacyQueryDefinition | ExecutableQueryDefinition;

export class RuntimeQueryDefinitionError extends Error {
  readonly code = "QUERY_DEFINITION_INVALID";

  constructor() {
    super("Runtime query definition is invalid.");
    this.name = "RuntimeQueryDefinitionError";
  }
}

const TYPED_MARKERS = ["kind", "contract", "handleQuery", "handleFilter", "handleSort"] as const;

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCodec(value: unknown): value is RuntimeQueryCodec {
  if (!isRecord(value)) return false;
  return typeof value.encode === "function" && typeof value.decode === "function";
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function positiveVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function invalid(): never {
  throw new RuntimeQueryDefinitionError();
}

function rejectTypedMarkers(value: object): void {
  for (const marker of TYPED_MARKERS) {
    if (hasOwn(value, marker)) invalid();
  }
}

function scalarExecution(value: Record<string, unknown>): RuntimeScalarQueryExecution {
  if (value.kind !== "scalar") invalid();
  if (!isCodec(value.rowCodec) || !isCodec(value.paramsCodec) || !isCodec(value.resultCodec)) invalid();
  if (typeof value.handleQuery !== "function") invalid();
  if (hasOwn(value, "itemCodec") || hasOwn(value, "handleFilter") || hasOwn(value, "handleSort") || hasOwn(value, "result")) invalid();
  return value as unknown as RuntimeScalarQueryExecution;
}

function listExecution(value: Record<string, unknown>): RuntimeListQueryExecution {
  if (value.kind !== "list") invalid();
  if (!isCodec(value.rowCodec) || !isCodec(value.paramsCodec) || !isCodec(value.itemCodec)) invalid();
  if (typeof value.handleFilter !== "function" || typeof value.handleSort !== "function") invalid();
  if (hasOwn(value, "resultCodec") || hasOwn(value, "handleQuery") || hasOwn(value, "result")) invalid();
  return value as unknown as RuntimeListQueryExecution;
}

function validateDefinition(definition: QueryDefinition): QueryDefinition {
  if (!isRecord(definition)) invalid();
  rejectTypedMarkers(definition);
  if (!nonEmpty(definition.queryType) || !nonEmpty(definition.tagGroup) || !nonEmpty(definition.tagProjector)) invalid();
  if (definition.endpoint !== "query" && definition.endpoint !== "list-query") invalid();
  if (typeof definition.enabled !== "boolean") invalid();
  if (definition.materializedViewId !== undefined && !nonEmpty(definition.materializedViewId)) invalid();
  const executable = hasOwn(definition, "execution");
  if (!executable) return definition;
  if (!isRecord(definition.execution)) invalid();
  if (!positiveVersion(definition.version)) invalid();
  if (definition.endpoint === "query") {
    scalarExecution(definition.execution);
    return definition;
  }
  listExecution(definition.execution);
  return definition;
}

export function isExecutableQueryDefinition(definition: QueryDefinition): definition is ExecutableQueryDefinition {
  return hasOwn(definition, "execution") && isRecord((definition as { readonly execution?: unknown }).execution);
}

export class QueryRegistry {
  private readonly definitions: ReadonlyMap<string, QueryDefinition>;

  constructor(definitions: readonly QueryDefinition[]) {
    const mapped = new Map<string, QueryDefinition>();
    for (const definition of definitions) {
      const validated = validateDefinition(definition);
      if (mapped.has(validated.queryType)) invalid();
      mapped.set(validated.queryType, validated);
    }
    this.definitions = mapped;
  }

  resolve(queryType: string): QueryDefinition | undefined {
    return this.definitions.get(queryType);
  }
}

/** The test-only default query mapping; production consumers compose their own domain. */
export const DEPLOYED_QUERY_REGISTRY = new QueryRegistry([
  {
    queryType: "GetTestCountQuery",
    endpoint: "query",
    tagGroup: "test",
    tagProjector: "test-projector",
    enabled: true,
  },
  {
    queryType: "GetTestListQuery",
    endpoint: "list-query",
    tagGroup: "test",
    tagProjector: "test-projector",
    enabled: true,
  },
]);
