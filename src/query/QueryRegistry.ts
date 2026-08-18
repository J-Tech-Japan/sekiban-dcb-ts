import { WEATHER_FORECAST_PROJECTOR } from "../projection/ProjectorRegistry";

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

/** The deployed V1 query mapping used by the compatibility fixture. */
export const DEPLOYED_QUERY_REGISTRY = new QueryRegistry([
  {
    queryType: "GetWeatherForecastCountQuery",
    endpoint: "query",
    tagGroup: "weather",
    tagProjector: WEATHER_FORECAST_PROJECTOR,
    enabled: true,
  },
  {
    queryType: "GetWeatherForecastListQuery",
    endpoint: "list-query",
    tagGroup: "weather",
    tagProjector: WEATHER_FORECAST_PROJECTOR,
    enabled: true,
  },
]);
