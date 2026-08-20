import { defineConfig } from "vitest/config";

// The deploy preflight is a host-shell contract, not a Worker contract. Keep
// it outside the Cloudflare pool so it can execute the real bash entrypoint.
export default defineConfig({
  test: { environment: "node" },
});
