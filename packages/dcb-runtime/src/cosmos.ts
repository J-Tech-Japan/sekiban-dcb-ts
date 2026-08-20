import {
  CosmosEventStore,
  type CosmosDocumentClient,
  type CosmosStoreOptions,
} from "./store/CosmosEventStore";
import type { StoreProvider } from "./store/provider";
import { createBootstrapStoreAdapter, type BootstrapStoreAdapter } from "./bootstrap/BootstrapStoreAdapter";

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
  });
}

export function createCosmosBootstrapAdapter(config: CosmosStoreProviderConfig): BootstrapStoreAdapter {
  return createBootstrapStoreAdapter("cosmos", new CosmosEventStore(config));
}
