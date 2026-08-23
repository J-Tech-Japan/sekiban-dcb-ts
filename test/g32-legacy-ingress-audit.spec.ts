import { describe, expect, it } from "vitest";
import {
  assertNoLegacyPositiveFixtureText,
  positiveEnvelopeBlock,
  runSelfTest,
} from "../scripts/g32-legacy-ingress-audit.mjs";
// @ts-expect-error Vite raw source fixture
import cosmosSource from "../scripts/g22-bootstrap-cosmos-contract.mjs?raw";

describe("SDT-G32 legacy ingress fixture audit", () => {
  it("keeps all executable positive fixtures G32-shaped and historical forms negative-only", () => {
    expect(() => assertNoLegacyPositiveFixtureText(positiveEnvelopeBlock(cosmosSource), "real-Cosmos positive fixture")).not.toThrow();
    expect(cosmosSource).toContain("old-37-character-suid");
    expect(cosmosSource).toContain("legacy-provenance");
    expect(cosmosSource).toContain("identity-less");
    expect(runSelfTest({ includeAudit: false }).mutations).toEqual(["eventPayloadVersion", "legacy-provenance"]);
  });

  it("turns a positive caller-selected version or legacy provenance mutation red", () => {
    const valid = "function message(){ return { suid: g32Suid(1), eventId: g32EventId('one'), eventType: 'OrderPlaced', provenance: 'g32' }; }";
    expect(() => assertNoLegacyPositiveFixtureText(`${valid}\nconst eventPayloadVersion = 2;`)).toThrow("eventPayloadVersion");
    expect(() => assertNoLegacyPositiveFixtureText(valid.replace("'g32'", "'pre-g27-queue'"))).toThrow("legacy provenance");
  });
});
