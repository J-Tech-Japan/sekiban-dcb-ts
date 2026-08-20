import {
  CosmosEventStore,
  type CosmosDocumentClient,
  type CosmosStoreOptions,
} from "./store/CosmosEventStore";
import type { StoreProvider } from "./store/provider";
import { bootstrapEventIdentityMatches, createBootstrapStoreAdapter, type BootstrapStoreAdapter } from "./bootstrap/BootstrapStoreAdapter";

export {
  CosmosClientError,
  CosmosEventStore,
  CosmosRestClient,
  DEFAULT_COSMOS_CONTAINERS,
  compareCosmosSuid,
} from "./store/CosmosEventStore";
export type {
  CosmosContainerNames,
  CosmosDocumentClient,
  CosmosDocumentRecord,
  CosmosStoreOptions,
  CosmosWriteBoundary,
} from "./store/CosmosEventStore";

export interface CosmosStoreProviderConfig extends Omit<CosmosStoreOptions, "client"> {
  readonly client?: CosmosDocumentClient;
}

/** Explicit opt-in provider; the default runtime composition never reads Cosmos config. */
export function createCosmosStoreProvider(config: CosmosStoreProviderConfig): StoreProvider {
  return Object.freeze({
    name: "cosmos",
    isConfigured: () => true,
    create: () => new CosmosEventStore(config),
    createBootstrapAdapter: () => createCosmosBootstrapAdapter(new CosmosEventStore(config)),
  });
}

export function createCosmosBootstrapAdapter(store: CosmosEventStore): BootstrapStoreAdapter {
  return createBootstrapStoreAdapter("cosmos", store, (event, record) => bootstrapEventIdentityMatches(event, record));
}
