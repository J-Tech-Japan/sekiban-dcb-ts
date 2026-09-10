import { defineConfig } from "vitest/config";

// The deploy preflight is a host-shell contract, not a Worker contract. Keep
// it outside the Cloudflare pool so it can execute the real bash entrypoint.
export default defineConfig({
  test: {
    environment: "node",
    ...(process.env.SDT_G79_HOSTED_MEASURE === "1"
      ? {
          includeTaskLocation: true,
          reporters: ["default", "./scripts/g79-vitest-hosted-reporter.mjs"],
        }
      : {}),
  },
});
