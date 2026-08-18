import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const postgresUrl = process.env.POSTGRES_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/serialized_dcb";
// A real HYPERDRIVE binding is required by the deployed Worker. Miniflare
// needs the same local Docker URL explicitly when that binding is present.
process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ??= postgresUrl;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
      miniflare: {
        bindings: {
          POSTGRES_URL: postgresUrl,
          AUTO_DRAIN_OUTBOX: "false",
        },
      },
    }),
  ],
});
