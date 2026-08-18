import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const postgresUrl = process.env.POSTGRES_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/serialized_dcb";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
      miniflare: {
        bindings: {
          POSTGRES_URL: postgresUrl,
        },
      },
    }),
  ],
});
