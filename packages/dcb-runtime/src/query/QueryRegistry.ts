export type QueryEndpoint = "query" | "list-query";

/**
 * Query types are deployed values, just like tag-state projectors. HTTP input
 * selects one of these definitions; it cannot provide a reducer or query
 * implementation of its own.
 */
export interface QueryDefinition {
  readonly queryType: string;
  readonly endpoint: QueryEndpoint;
  readonly tagGroup: string;
  readonly tagProjector: string;
  /** MV view id used when the query backing is d1-mv; defaults to the projector id. */
  readonly materializedViewId?: string;
  readonly enabled: boolean;
}

export class QueryRegistry {
  private readonly definitions: ReadonlyMap<string, QueryDefinition>;

  constructor(definitions: readonly QueryDefinition[]) {
    const mapped = new Map<string, QueryDefinition>();
    for (const definition of definitions) {
      if (definition.queryType.length === 0 || definition.tagGroup.length === 0 || definition.tagProjector.length === 0) {
        throw new Error("Query definitions require non-empty queryType, tagGroup, and tagProjector");
      }
      if (mapped.has(definition.queryType)) {
        throw new Error(`Query ${definition.queryType} was registered more than once`);
      }
      mapped.set(definition.queryType, definition);
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
