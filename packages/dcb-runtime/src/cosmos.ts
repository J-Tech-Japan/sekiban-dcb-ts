/**
 * @experimental Cosmos support is an explicit opt-in provider and carries no
 * production-support or availability promise.
 */
import {
  CosmosEventStore,
  type CosmosDocumentClient,
  type CosmosStoreOptions,
} from "./store/CosmosEventStore";
import type { StoreProvider, StoreProviderEnvironment } from "./store/provider";
import { bootstrapEventIdentityMatches, createBootstrapStoreAdapter, type BootstrapStoreAdapter } from "./bootstrap/BootstrapStoreAdapter";

/** @experimental */
export { CosmosClientError } from "./store/CosmosEventStore";
/** @experimental */
export { CosmosEventStore } from "./store/CosmosEventStore";
/** @experimental */
export { CosmosRestClient } from "./store/CosmosEventStore";
/** @experimental */
export { DEFAULT_COSMOS_CONTAINERS } from "./store/CosmosEventStore";
/** @experimental */
export { compareCosmosSuid } from "./store/CosmosEventStore";
/** @experimental */
export type { CosmosContainerNames } from "./store/CosmosEventStore";
/** @experimental */
export type { CosmosDocumentClient } from "./store/CosmosEventStore";
/** @experimental */
export type { CosmosDocumentRecord } from "./store/CosmosEventStore";
/** @experimental */
export type { CosmosStoreOptions } from "./store/CosmosEventStore";
/** @experimental */
export type { CosmosWriteBoundary } from "./store/CosmosEventStore";

/** @experimental Cosmos is an explicit, opt-in provider. */
export class CosmosConfigurationError extends Error {
  readonly code = "COSMOS_CONFIGURATION_INVALID" as const;

  constructor(readonly missingBindings: readonly string[], message: string) {
    super(message);
    this.name = "CosmosConfigurationError";
  }
}

/** @experimental Configuration for the optional Cosmos provider. */
export interface CosmosStoreProviderConfig extends Omit<CosmosStoreOptions, "client"> {
  readonly client?: CosmosDocumentClient;
}

function bindingValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function invalidConfiguration(missingBindings: readonly string[]): CosmosConfigurationError {
  return new CosmosConfigurationError(
    missingBindings,
    `Cosmos configuration is incomplete; missing bindings: ${missingBindings.join(", ")}`,
  );
}

function resolveCosmosOptions(
  config: CosmosStoreProviderConfig,
  env: StoreProviderEnvironment,
): CosmosStoreOptions {
  const staticValues = {
    COSMOS_ENDPOINT: config.endpoint,
    COSMOS_DATABASE: config.database,
    COSMOS_KEY: config.key,
  } as const;
  const hasStaticValues = Object.values(staticValues).some((value) => value !== undefined);

  if (config.client !== undefined) {
    if (hasStaticValues) {
      throw invalidConfiguration(["client cannot be combined with COSMOS_ENDPOINT, COSMOS_DATABASE, or COSMOS_KEY"]);
    }
    return { ...config };
  }

  const values = hasStaticValues
    ? staticValues
    : {
        COSMOS_ENDPOINT: env.COSMOS_ENDPOINT,
        COSMOS_DATABASE: env.COSMOS_DATABASE,
        COSMOS_KEY: env.COSMOS_KEY,
      };
  const missingBindings = Object.entries(values)
    .filter(([, value]) => bindingValue(value) === undefined)
    .map(([name]) => name);
  if (missingBindings.length > 0) throw invalidConfiguration(missingBindings);

  return {
    ...config,
    endpoint: bindingValue(values.COSMOS_ENDPOINT),
    database: bindingValue(values.COSMOS_DATABASE),
    key: bindingValue(values.COSMOS_KEY),
  };
}

/** @experimental Explicit opt-in provider; environment values alone never select it. */
export function createCosmosStoreProvider(config: CosmosStoreProviderConfig = {}): StoreProvider {
  const hasStaticConfiguration = [config.endpoint, config.database, config.key].some((value) => value !== undefined);
  if (config.client !== undefined || hasStaticConfiguration) resolveCosmosOptions(config, {});
  return Object.freeze({
    name: "cosmos",
    isConfigured: (env: StoreProviderEnvironment) => {
      resolveCosmosOptions(config, env);
      return true;
    },
    create: (env: StoreProviderEnvironment) => new CosmosEventStore(resolveCosmosOptions(config, env)),
    createBootstrapAdapter: (env: StoreProviderEnvironment) => createCosmosBootstrapAdapter(
      new CosmosEventStore(resolveCosmosOptions(config, env)),
    ),
  });
}

/** @experimental Explicit bootstrap adapter for the opt-in Cosmos provider. */
export function createCosmosBootstrapAdapter(store: CosmosEventStore): BootstrapStoreAdapter {
  return createBootstrapStoreAdapter("cosmos", store, (event, record) => bootstrapEventIdentityMatches(event, record));
}
