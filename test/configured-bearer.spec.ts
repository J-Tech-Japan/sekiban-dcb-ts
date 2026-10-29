import { describe, expect, it, vi } from "vitest";
// @ts-expect-error Vite raw asset import.
import source from "../packages/dcb-runtime/src/http/ConfiguredBearer.ts?raw";
// @ts-expect-error Vite raw asset import.
import indexSource from "../packages/dcb-runtime/src/index.ts?raw";
// @ts-expect-error Vite raw asset import.
import cloudflareSource from "../packages/dcb-runtime/src/cloudflare.ts?raw";
import packageJson from "../packages/dcb-runtime/package.json";
import {
  checkConfiguredBearer,
  type ConfiguredBearerTokenNormalization,
} from "../packages/dcb-runtime/src/http/ConfiguredBearer";

const LEADING = "  spaced-token";
const SURROUNDED = "  spaced-token  ";

const rows: ReadonlyArray<{
  readonly label: string;
  readonly binding: unknown;
  readonly header?: string;
  readonly normalization?: ConfiguredBearerTokenNormalization;
  readonly result: "unconfigured" | "missing" | "invalid" | "authorized";
}> = [
  { label: "undefined binding", binding: undefined, header: "Bearer undefined", result: "unconfigured" },
  { label: "null binding", binding: null, header: "Bearer null", result: "unconfigured" },
  { label: "numeric binding", binding: 0, header: "Bearer 0", result: "unconfigured" },
  { label: "object binding", binding: { token: "exact-token" }, header: "Bearer exact-token", result: "unconfigured" },
  { label: "array binding", binding: ["exact-token"], header: "Bearer exact-token", result: "unconfigured" },
  { label: "empty binding", binding: "", header: "Bearer ", result: "unconfigured" },
  { label: "spaces binding", binding: "   ", header: "Bearer    ", result: "unconfigured" },
  { label: "tab binding", binding: "\t\t", header: "Bearer \t\t", result: "unconfigured" },
  { label: "newline binding", binding: "\n", header: "Bearer \n", result: "unconfigured" },
  { label: "whitespace binding without a header", binding: " \n\t ", result: "unconfigured" },
  { label: "missing header", binding: "exact-token", result: "missing" },
  { label: "lower-case scheme", binding: "exact-token", header: "bearer exact-token", result: "invalid" },
  { label: "alternate scheme", binding: "exact-token", header: "Token exact-token", result: "invalid" },
  { label: "missing space", binding: "exact-token", header: "Bearerexact-token", result: "invalid" },
  { label: "extra space", binding: "exact-token", header: "Bearer  exact-token", result: "invalid" },
  { label: "wrong credential", binding: "exact-token", header: "Bearer wrong-token", result: "invalid" },
  { label: "exact credential", binding: "exact-token", header: "Bearer exact-token", result: "authorized" },
  { label: "exact mode keeps leading whitespace", binding: LEADING, header: `Bearer ${LEADING}`, result: "authorized" },
  { label: "exact mode rejects a trimmed header", binding: LEADING, header: "Bearer spaced-token", result: "invalid" },
  { label: "exact mode rejects surrounding whitespace trimmed by the header", binding: SURROUNDED, header: `Bearer ${SURROUNDED}`, result: "invalid" },
  { label: "trim mode accepts a trimmed header", binding: SURROUNDED, header: "Bearer spaced-token", normalization: "trim", result: "authorized" },
];

describe("configured bearer check", () => {
  it.each(rows)("$label", async (row) => {
    const headers = row.header === undefined ? undefined : { authorization: row.header };
    const request = new Request("https://bearer.test/", { headers });
    const options = row.normalization === undefined ? undefined : { tokenNormalization: row.normalization };
    await expect(checkConfiguredBearer(request, row.binding, options), row.label).resolves.toBe(row.result);
  });

  it("hashes both complete credentials before comparing digest bytes", async () => {
    const hashed: string[] = [];
    const original = crypto.subtle.digest.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
      hashed.push(new TextDecoder().decode(data as BufferSource));
      return original(algorithm, data as BufferSource);
    });
    try {
      const request = new Request("https://bearer.test/", {
        headers: { authorization: "Bearer exact-token" },
      });
      await expect(checkConfiguredBearer(request, "exact-token")).resolves.toBe("authorized");
      expect(hashed).toHaveLength(2);
      expect(hashed.every((value) => value === "Bearer exact-token")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps the digest loop free of early exits and Node crypto", () => {
    const start = source.indexOf("for (let index = 0; index < length; index += 1)");
    const end = source.indexOf("return difference === 0", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const loop = source.slice(start, end);
    expect(loop).not.toMatch(/\breturn\b/);
    expect(loop).not.toMatch(/\bbreak\b/);
    expect(loop).not.toMatch(/\bcontinue\b/);
    expect(source).toContain('crypto.subtle.digest("SHA-256"');
    expect(source).not.toContain("node:crypto");
    expect(source).not.toContain("timingSafeEqual");
    expect(source).not.toContain("Buffer");
    expect(indexSource).toContain("export { checkConfiguredBearer }");
    expect(indexSource).toContain("ConfiguredBearerResult");
    expect(indexSource).toContain("CheckConfiguredBearerOptions");
    expect(indexSource).toContain("ConfiguredBearerTokenNormalization");
    expect(cloudflareSource).toContain("export { checkConfiguredBearer }");
    expect(cloudflareSource).toContain("ConfiguredBearerResult");
    expect(JSON.stringify(packageJson.exports)).not.toContain("configured-bearer");
  });
});
