import type {
  DomainDefinition,
  JsonValue,
  ProjectorDefinition,
} from "@sekiban/dcb-core";
import {
  DEPLOYED_PROJECTOR_REGISTRY,
  ProjectorRegistry,
  type ProjectionEvent,
  type TagStateProjector,
} from "./projection/ProjectorRegistry";
import {
  DEPLOYED_QUERY_REGISTRY,
  QueryRegistry,
  type QueryDefinition,
  type QueryEndpoint,
} from "./query/QueryRegistry";

/** A query value accepted by the public runtime composition surface. */
export interface RuntimeQueryDefinition {
  readonly queryType?: string;
  readonly id?: string;
  readonly name?: string;
  readonly endpoint?: QueryEndpoint;
  readonly tagGroup: string;
  readonly tagProjector: string;
  readonly enabled?: boolean;
}

/** Values which affect registration, never the serialized V1 wire format. */
export interface RuntimeWorkerConfig {
  readonly queries?: readonly RuntimeQueryDefinition[];
  readonly queryDefinitions?: readonly RuntimeQueryDefinition[];
  readonly projectorPayloadNames?: Readonly<Record<string, string>>;
  readonly tagPayloadNames?: Readonly<Record<string, string>>;
}

export interface RuntimeComposition {
  readonly projectors: ProjectorRegistry;
  readonly queries: QueryRegistry;
}

function decodeBase64Json(value: string): unknown {
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return value;
  }
}

function eventNameFromPayload(value: unknown, projector: ProjectorDefinition): string | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ["eventType", "eventName", "eventPayloadName", "type"]) {
      if (typeof record[key] === "string" && record[key].length > 0) return record[key];
    }
  }
  return projector.subscribedEventNames.length === 1 ? projector.subscribedEventNames[0] : undefined;
}

function jsonBytes(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function projectorFromDefinition(
  definition: ProjectorDefinition,
  config: RuntimeWorkerConfig,
): TagStateProjector {
  const payloadNames = config.projectorPayloadNames ?? config.tagPayloadNames ?? {};
  const payloadName = payloadNames[definition.id] ?? `${definition.id}State`;
  const apply = (state: JsonValue, event: ProjectionEvent): JsonValue => {
    const payload = decodeBase64Json(event.payload);
    const eventName = eventNameFromPayload(payload, definition);
    if (eventName === undefined) return state;
    return definition.apply(state, {
      eventName,
      eventPayloadName: eventName,
      payload: payload as JsonValue,
    });
  };
  return {
    id: definition.id,
    tagPayloadName: payloadName,
    projectorVersion: String(definition.version),
    initialState: () => definition.initialState,
    apply,
    serializeState: (state) => definition.serializeState(state as JsonValue),
    deserializeState: (serialized) => definition.deserializeState(serialized),
    payload: (state) => jsonBytes(state),
    version: (state) => {
      if (typeof state === "object" && state !== null && !Array.isArray(state)) {
        const candidate = (state as Record<string, unknown>).version;
        if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0) return candidate;
      }
      return 0;
    },
  };
}

function queryFromDefinition(value: RuntimeQueryDefinition): QueryDefinition {
  const queryType = value.queryType ?? value.id ?? value.name;
  if (queryType === undefined || queryType.length === 0) {
    throw new Error("Runtime query definitions require queryType or id");
  }
  return {
    queryType,
    endpoint: value.endpoint ?? "query",
    tagGroup: value.tagGroup,
    tagProjector: value.tagProjector,
    enabled: value.enabled ?? true,
  };
}

/**
 * Build the two private registries used by the HTTP runtime. The registries
 * intentionally never cross the package entrypoint; consumers provide only
 * immutable dcb-core definition values and registration metadata.
 */
export function composeRuntime(
  domain: DomainDefinition | undefined,
  config: RuntimeWorkerConfig = {},
): RuntimeComposition {
  if (domain === undefined && config.queries === undefined && config.queryDefinitions === undefined) {
    return { projectors: DEPLOYED_PROJECTOR_REGISTRY, queries: DEPLOYED_QUERY_REGISTRY };
  }
  const projectors = new ProjectorRegistry(
    (domain?.projectors ?? []).map((value) => projectorFromDefinition(value as ProjectorDefinition, config)),
  );
  const configuredQueries = config.queryDefinitions ?? config.queries;
  const domainQueries = (domain?.queries ?? []) as readonly RuntimeQueryDefinition[];
  const queries = new QueryRegistry(
    (configuredQueries ?? domainQueries).map(queryFromDefinition),
  );
  return { projectors, queries };
}
