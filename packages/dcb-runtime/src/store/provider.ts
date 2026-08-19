import { PostgresEventStore } from "./PostgresEventStore";
import type { PipelineStore } from "./types";

/** The storage bindings visible to a provider; no provider may inspect request headers. */
export interface StoreProviderEnvironment {
  readonly POSTGRES_URL?: string;
  readonly HYPERDRIVE?: { readonly connectionString?: string };
}

/** Typed composition seam shared by the default Postgres and opt-in adapters. */
export interface StoreProvider {
  readonly name: string;
  readonly isConfigured?: (env: StoreProviderEnvironment) => boolean;
  create(env: StoreProviderEnvironment): PipelineStore;
}

function postgresConnectionString(env: StoreProviderEnvironment): string {
  const connectionString = env.HYPERDRIVE?.connectionString ?? env.POSTGRES_URL;
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error("A Hyperdrive binding or POSTGRES_URL is required for the Postgres store");
  }
  return connectionString;
}

/** The unchanged default composition. It never requires Cosmos bindings or secrets. */
export const POSTGRES_STORE_PROVIDER: StoreProvider = Object.freeze({
  name: "postgres",
  isConfigured: (env: StoreProviderEnvironment) => {
    const connectionString = env.HYPERDRIVE?.connectionString ?? env.POSTGRES_URL;
    return connectionString !== undefined && connectionString.length > 0;
  },
  create(env: StoreProviderEnvironment): PipelineStore {
    return new PostgresEventStore(postgresConnectionString(env));
  },
});

export function createPostgresStoreProvider(): StoreProvider {
  return POSTGRES_STORE_PROVIDER;
}
