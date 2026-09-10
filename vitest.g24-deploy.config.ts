import { defineConfig } from "vitest/config";

// The deploy preflight is a host-shell contract, not a Worker contract. Keep
// it outside the Cloudflare pool so it can execute the real bash entrypoint.
export default defineConfig({
  test: {
    environment: "node",
    includeTaskLocation: process.env.SDT_G79_HOSTED_MEASURE === "1" ? true : undefined,
    reporters: process.env.SDT_G79_HOSTED_MEASURE === "1"
      ? ["default", "./scripts/g79-vitest-hosted-reporter.mjs"]
      : undefined,
  },
});
