import { describe, expect, it } from "vitest";

import type { CommitEnvelope } from "../packages/dcb-client/src/index";
import { validateCommitEnvelope } from "../packages/dcb-runtime/src/commit/CommitWorker";
import { createV1Transport } from "../samples/meeting-room/src/transport";

// @ts-expect-error Vite raw imports retain the frozen source bytes.
import acceptedPositivesRaw from "./fixtures/g54-accepted-positives.json?raw";
// @ts-expect-error Vite raw imports retain the frozen source bytes.
import officialV1 from "./fixtures/g54-sekiban-interop/interop_official_v1_populated.json?raw";
// @ts-expect-error Vite raw imports retain the frozen source bytes.
import canonicalV1 from "./fixtures/g54-sekiban-interop/interop_r2_canonical_positive_v1.json?raw";
// @ts-expect-error Vite raw imports retain the frozen source bytes.
import tsClientModel from "./fixtures/g54-sekiban-interop/interop_ts_client_model.json?raw";
// @ts-expect-error Vite raw imports retain the frozen source bytes.
import canonicalClientModel from "./fixtures/g54-sekiban-interop/interop_r2_canonical_positive.json?raw";

interface Acceptance {
  readonly inputFixture: string;
  readonly inputKind: "v1-wire" | "client-model";
  readonly expectedV1Fixture: string;
  readonly manifestExpectedOutcome: string;
  readonly resolvingUnit: string;
}

interface AcceptanceDocument {
  readonly schema: string;
  readonly classification: string;
  readonly acceptances: readonly Acceptance[];
}

const acceptances = JSON.parse(acceptedPositivesRaw) as AcceptanceDocument;
const expectedInputs = [
  "interop_official_v1_populated.json",
  "interop_r2_canonical_positive_v1.json",
  "interop_ts_client_model.json",
  "interop_r2_canonical_positive.json",
];

function fixture(name: string): string {
  const copied = {
    "interop_official_v1_populated.json": officialV1,
    "interop_r2_canonical_positive_v1.json": canonicalV1,
    "interop_ts_client_model.json": tsClientModel,
    "interop_r2_canonical_positive.json": canonicalClientModel,
  } as const;
  const value = copied[name as keyof typeof copied];
  if (value === undefined) throw new Error(`Unknown SDT-G54 accepted-positive fixture ${name}`);
  return value;
}

async function adapterWire(rawClientModel: string): Promise<string> {
  let captured: string | undefined;
  const transport = createV1Transport({
    async fetch(_input, init): Promise<Response> {
      captured = typeof init?.body === "string" ? init.body : undefined;
      return Response.json({ writtenEvents: [], tagWriteResults: [], duration: "PT0S" });
    },
  });
  await transport.commit(JSON.parse(rawClientModel) as CommitEnvelope);
  expect(captured).toBeDefined();
  return captured!;
}

function assertCandidatePart(actualWire: string, expectedWire: string, fixtureName: string): void {
  const actual = JSON.parse(actualWire) as { readonly eventCandidates?: Array<{ readonly payload?: string }> };
  const expected = JSON.parse(expectedWire) as { readonly eventCandidates?: Array<{ readonly payload?: string }> };
  expect(actual.eventCandidates).toEqual(expected.eventCandidates);
  expect(actual.eventCandidates, `${fixtureName} must retain candidate rows`).toBeDefined();
  for (const [index, candidate] of actual.eventCandidates!.entries()) {
    const expectedCandidate = expected.eventCandidates![index];
    expect(typeof candidate.payload, `${fixtureName} candidate ${index} must retain a base64 payload`).toBe("string");
    expect(typeof expectedCandidate?.payload, `${fixtureName} expected candidate ${index} must retain a base64 payload`).toBe("string");
    const bytes = Buffer.from(candidate.payload!, "base64");
    const expectedBytes = Buffer.from(expectedCandidate.payload!, "base64");
    expect(bytes.equals(expectedBytes), `${fixtureName} candidate ${index} payload bytes changed`).toBe(true);
    expect(bytes.toString("base64")).toBe(candidate.payload);
  }
}

describe("SDT-G54 accepted empty-head interop positives", () => {
  it("records exactly the four SDT-G56 acceptances without a known-divergence result", () => {
    expect(acceptances.schema).toBe("sdt-g54-accepted-positives/v1");
    expect(acceptances.classification).toBe("accepted-positive");
    expect(acceptances.acceptances.map((entry) => entry.inputFixture)).toEqual(expectedInputs);
    expect(acceptances.acceptances.every((entry) => entry.resolvingUnit === "SDT-G56")).toBe(true);
  });

  for (const entry of acceptances.acceptances) {
    it(`${entry.inputFixture} preserves exact V1 bytes and is accepted by the runtime validator`, async () => {
      const expectedWire = fixture(entry.expectedV1Fixture);
      const actualWire = entry.inputKind === "client-model"
        ? await adapterWire(fixture(entry.inputFixture))
        : fixture(entry.inputFixture);

      expect(actualWire).toBe(expectedWire);
      assertCandidatePart(actualWire, expectedWire, entry.inputFixture);
      expect(validateCommitEnvelope(JSON.parse(actualWire))).toHaveProperty("value");
    });
  }
});
