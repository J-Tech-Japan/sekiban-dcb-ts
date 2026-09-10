import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    ...(process.env.SDT_G79_HOSTED_MEASURE === "1"
      ? {
          includeTaskLocation: true,
          reporters: ["default", "./scripts/g79-vitest-hosted-reporter.mjs"],
        }
      : {}),
  },
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./samples/meeting-room/wrangler.cloudflare-only.jsonc",
      },
    }),
  ],
});
