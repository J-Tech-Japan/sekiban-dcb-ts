import { D1EventStore, type D1StoreOptions } from "./store/D1EventStore";
import { D1MaterializedViewStore } from "./mv/MaterializedViewStore";
import type { StoreProvider, StoreProviderEnvironment } from "./store/provider";
import { bootstrapEventIdentityMatches, createBootstrapStoreAdapter, type BootstrapStoreAdapter } from "./bootstrap/BootstrapStoreAdapter";

export {
  D1EventStore,
  D1IdentityConflictError,
  type D1BatchOperation,
  type D1StoreOptions,
  type D1WriteOperation,
} from "./store/D1EventStore";
// The D1/Cloudflare sample health surface needs the published SafeWindow
// calculations without importing the default runtime entrypoint (which owns
// the Postgres graph).
export {
  safeWindowCeilingExceeded,
  safeWindowMs,
} from "./safeWindow";
export {
  D1MaterializedViewStore,
  MaterializedViewCasError,
  MaterializedViewPatchError,
  MaterializedViewPromotionCasError,
  MaterializedViewStoreError,
} from "./mv/MaterializedViewStore";
export type {
  MaterializedViewApplyInput,
  MaterializedViewApplyResult,
  MaterializedViewCandidateInput,
  MaterializedViewCreateInput,
  MaterializedViewIndexEntry,
  MaterializedViewInstance,
  MaterializedViewOrderingQuarantine,
  MaterializedViewOrderingQuarantineClassification,
  MaterializedViewPromoteInput,
  MaterializedViewQueryOptions,
  MaterializedViewRow,
  MaterializedViewWaitForState,
  MaterializedViewStore,
  MaterializedViewStoreErrorCode,
  MaterializedViewStoreOperation,
} from "./mv/MaterializedViewStore";

export interface D1StoreProviderConfig {
  /** Optional test seam; production composition should leave this unset. */
  readonly storeOptions?: D1StoreOptions;
}

/** Explicit opt-in D1 provider. It never changes the default Postgres provider. */
export function createD1StoreProvider(config: D1StoreProviderConfig = {}): StoreProvider {
  return Object.freeze({
    name: "d1",
    isConfigured: (env: StoreProviderEnvironment) => env.D1 !== undefined,
    create: (env: StoreProviderEnvironment) => {
      if (env.D1 === undefined) throw new Error("A D1 binding is required for the D1 store");
      return new D1EventStore(env.D1, config.storeOptions);
    },
    createBootstrapAdapter: (env: StoreProviderEnvironment) => {
      if (env.D1 === undefined) throw new Error("A D1 binding is required for the D1 store");
      return createD1BootstrapAdapter(new D1EventStore(env.D1, config.storeOptions));
    },
  });
}

export function createD1MaterializedViewStore(database: D1Database): D1MaterializedViewStore {
  return new D1MaterializedViewStore(database);
}

export function createD1BootstrapAdapter(store: D1EventStore): BootstrapStoreAdapter {
  return createBootstrapStoreAdapter("d1", store, (event, record) => bootstrapEventIdentityMatches(event, record));
}
