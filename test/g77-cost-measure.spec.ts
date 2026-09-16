/**
 * @deprecated SDT-G91 superseded this portable whole-process wall-clock proxy.
 * Use test/g77-ac6-measurement.spec.ts via `npm run measure:g77`.
 */
import { describe, expect, it } from "vitest";

describe("G77 AC6 portable cost proxy (retired)", () => {
  it("redirects operators to the decision-grade harness", () => {
    expect("test/g77-ac6-measurement.spec.ts").toContain("g77-ac6-measurement");
  });
});
