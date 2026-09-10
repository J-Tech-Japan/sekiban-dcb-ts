import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    includeTaskLocation: process.env.SDT_G79_HOSTED_MEASURE === "1" ? true : undefined,
    reporters: process.env.SDT_G79_HOSTED_MEASURE === "1"
      ? ["default", "./scripts/g79-vitest-hosted-reporter.mjs"]
      : undefined,
  },
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./samples/meeting-room/wrangler.cloudflare-only.jsonc",
      },
    }),
  ],
});
