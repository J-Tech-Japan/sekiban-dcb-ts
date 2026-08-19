import { D1EventStore, type D1StoreOptions } from "./store/D1EventStore";
import type { StoreProvider, StoreProviderEnvironment } from "./store/provider";

export {
  D1EventStore,
  D1IdentityConflictError,
  type D1BatchOperation,
  type D1StoreOptions,
  type D1WriteOperation,
} from "./store/D1EventStore";

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
  });
}
