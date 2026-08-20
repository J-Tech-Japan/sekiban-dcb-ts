import { PostgresEventStore } from "./PostgresEventStore";
import type { PipelineStore } from "./types";
import { bootstrapEventIdentityMatches, createBootstrapStoreAdapter, type BootstrapStoreAdapter } from "../bootstrap/BootstrapStoreAdapter";

/** The storage bindings visible to a provider; no provider may inspect request headers. */
export interface StoreProviderEnvironment {
  readonly POSTGRES_URL?: string;
  readonly HYPERDRIVE?: { readonly connectionString?: string };
  /** Explicit opt-in D1 binding; the default provider never requires it. */
  readonly D1?: D1Database;
  /** Separate opt-in MV D1 binding; never used by the PipelineStore provider. */
  readonly D1_MV?: D1Database;
}

/** Typed composition seam shared by the default Postgres and opt-in adapters. */
export interface StoreProvider {
  readonly name: string;
  readonly isConfigured?: (env: StoreProviderEnvironment) => boolean;
  create(env: StoreProviderEnvironment): PipelineStore;
  createBootstrapAdapter?(env: StoreProviderEnvironment): BootstrapStoreAdapter;
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
  createBootstrapAdapter(env: StoreProviderEnvironment): BootstrapStoreAdapter {
    return createPostgresBootstrapAdapter(this.create(env));
  },
});

export function createPostgresStoreProvider(): StoreProvider {
  return POSTGRES_STORE_PROVIDER;
}

/** Explicit bootstrap adapter for the concrete Postgres PipelineStore. */
export function createPostgresBootstrapAdapter(store: PipelineStore): BootstrapStoreAdapter {
  // Kept in the Postgres composition module so its guard cannot leak into the
  // Cloudflare-only bundle.
  return createBootstrapStoreAdapter("postgres", store, (event, record) => bootstrapEventIdentityMatches(event, record));
}
