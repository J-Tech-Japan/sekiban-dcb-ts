import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));
const local = (packageName: string, fileName: string): string =>
  fileURLToPath(new URL(`./packages/${packageName}/src/${fileName}`, import.meta.url));
const postgresUrl = process.env.POSTGRES_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/serialized_dcb";
process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ??= postgresUrl;

/**
 * The isolated worktree shares the parent checkout's node_modules symlinks.
 * G69 must exercise this worktree's source, especially the strict-order
 * detector, rather than the parent's published runtime dist. The normal
 * repository config remains unchanged for ordinary lanes.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: "@sekiban/dcb-runtime/cloudflare", replacement: local("dcb-runtime", "cloudflare.ts") },
      { find: "@sekiban/dcb-runtime/d1-mv", replacement: local("dcb-runtime", "d1-mv.ts") },
      { find: "@sekiban/dcb-runtime/d1", replacement: local("dcb-runtime", "d1.ts") },
      { find: "@sekiban/dcb-runtime/mv", replacement: local("dcb-runtime", "mv/index.ts") },
      { find: "@sekiban/dcb-runtime", replacement: local("dcb-runtime", "index.ts") },
      { find: "@sekiban/dcb-core", replacement: local("dcb-core", "index.ts") },
      { find: "@sekiban/dcb-domain", replacement: local("dcb-domain", "index.ts") },
      { find: "@sekiban/dcb-client", replacement: local("dcb-client", "index.ts") },
    ],
  },
  define: {
    __G32_PARITY_ARTIFACT_B64__: JSON.stringify(process.env.G32_PARITY_ARTIFACT_B64 ?? ""),
  },
  test: {
    exclude: ["**/node_modules/**", "**/.git/**", "test/g24-deploy-preflight.spec.mjs", "test/g26-topology.spec.mjs"],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: `${root}wrangler.jsonc` },
      miniflare: {
        bindings: {
          POSTGRES_URL: postgresUrl,
          AUTO_DRAIN_OUTBOX: "false",
        },
      },
    }),
  ],
});
