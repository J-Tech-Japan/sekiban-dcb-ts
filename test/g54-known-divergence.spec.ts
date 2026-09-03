import { describe, expect, it } from "vitest";

import type { CommitEnvelope } from "../packages/dcb-client/src/index";
import {
  handleSerializedCommit,
  type CommitWorkerEnv,
} from "../packages/dcb-runtime/src/commit/CommitWorker";
import { createV1Transport } from "../samples/meeting-room/src/transport";

// @ts-expect-error Vite raw imports retain the local expectation contract.
import knownDivergencesRaw from "./fixtures/g54-known-divergences.json?raw";
// @ts-expect-error Vite raw imports retain the frozen source bytes.
import officialV1 from "./fixtures/g54-sekiban-interop/interop_official_v1_populated.json?raw";
// @ts-expect-error Vite raw imports retain the frozen source bytes.
import canonicalV1 from "./fixtures/g54-sekiban-interop/interop_r2_canonical_positive_v1.json?raw";
// @ts-expect-error Vite raw imports retain the frozen source bytes.
import tsClientModel from "./fixtures/g54-sekiban-interop/interop_ts_client_model.json?raw";
// @ts-expect-error Vite raw imports retain the frozen source bytes.
import canonicalClientModel from "./fixtures/g54-sekiban-interop/interop_r2_canonical_positive.json?raw";

interface NamespaceCalls {
  idFromName: number;
  get: number;
  fetch: number;
}

interface NamespaceCallSet {
  readonly allocator: NamespaceCalls;
  readonly bootstrap: NamespaceCalls;
  readonly tag: NamespaceCalls;
  readonly tagState: NamespaceCalls;
}

interface KnownDivergence {
  readonly inputFixture: string;
  readonly inputKind: "v1-wire" | "client-model";
  readonly expectedV1Fixture: string;
  readonly manifestExpectedOutcome: string;
  readonly reason: string;
  readonly runtime: {
    readonly httpStatus: number;
    readonly code: string;
    readonly messageIncludes: string;
  };
  readonly resolvingUnit: string;
}

interface KnownDivergenceDocument {
  readonly schema: string;
  readonly classification: string;
  readonly divergences: readonly KnownDivergence[];
}

const knownDivergences = JSON.parse(knownDivergencesRaw) as KnownDivergenceDocument;
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
  if (value === undefined) throw new Error(`Unknown SDT-G54 known-divergence fixture ${name}`);
  return value;
}

function calls(): NamespaceCalls {
  return { idFromName: 0, get: 0, fetch: 0 };
}

function namespace(counter: NamespaceCalls): DurableObjectNamespace {
  return {
    idFromName(name: string): DurableObjectId {
      counter.idFromName += 1;
      return name as unknown as DurableObjectId;
    },
    get(): DurableObjectStub {
      counter.get += 1;
      return {
        async fetch(): Promise<Response> {
          counter.fetch += 1;
          return Response.json({ error: "Known divergence must reject before a Durable Object call" }, { status: 500 });
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

function environment(): { readonly env: CommitWorkerEnv; readonly calls: NamespaceCallSet } {
  const allocator = calls();
  const bootstrap = calls();
  const tag = calls();
  const tagState = calls();
  return {
    env: {
      SDT_SERVICE_ID: "g54-known-divergence",
      ALLOCATOR: namespace(allocator),
      BOOTSTRAP: namespace(bootstrap),
      TAG: namespace(tag),
      TAG_STATE: namespace(tagState),
    } as CommitWorkerEnv,
    calls: { allocator, bootstrap, tag, tagState },
  };
}

function expectNoDurableObjectCalls(observed: NamespaceCallSet): void {
  for (const counter of Object.values(observed)) {
    expect(counter).toEqual({ idFromName: 0, get: 0, fetch: 0 });
  }
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

function assertCandidatePartR1(actualWire: string, expectedWire: string, fixtureName: string): void {
  const actual = JSON.parse(actualWire) as { readonly eventCandidates?: Array<{ readonly payload?: string }> };
  const expected = JSON.parse(expectedWire) as { readonly eventCandidates?: Array<{ readonly payload?: string }> };
  expect(actual.eventCandidates).toEqual(expected.eventCandidates);
  expect(actual.eventCandidates, `${fixtureName} must retain candidate rows`).toBeDefined();
  for (const [index, candidate] of actual.eventCandidates!.entries()) {
    const expectedCandidate = expected.eventCandidates![index];
    expect(typeof candidate.payload, `${fixtureName} candidate ${index} must retain a base64 payload`).toBe("string");
    expect(typeof expectedCandidate?.payload, `${fixtureName} expected V1 candidate ${index} must retain a base64 payload`).toBe("string");
    const bytes = Buffer.from(candidate.payload!, "base64");
    const expectedBytes = Buffer.from(expectedCandidate.payload!, "base64");
    expect(bytes.equals(expectedBytes), `${fixtureName} candidate ${index} must preserve R1 payload bytes`).toBe(true);
    expect(bytes.toString("base64")).toBe(candidate.payload);
  }
}

describe("SDT-G54 SDT-G56 known empty-head divergences", () => {
  it("keeps all four positive fixtures explicit, typed, and assigned to SDT-G56", () => {
    expect(knownDivergences.schema).toBe("sdt-g54-known-divergences/v1");
    expect(knownDivergences.classification).toBe("known-divergence");
    expect(knownDivergences.divergences.map((entry) => entry.inputFixture)).toEqual(expectedInputs);
    for (const entry of knownDivergences.divergences) {
      expect(entry.resolvingUnit).toBe("SDT-G56");
      expect(entry.reason).toBe("empty-lastSortableUniqueId-assertion-not-yet-supported");
      expect(entry.runtime).toEqual({
        httpStatus: 400,
        code: "invalid_sortable_unique_id",
        messageIncludes: "lastSortableUniqueId",
      });
    }
  });

  for (const entry of knownDivergences.divergences) {
    it(`${entry.inputFixture} remains an explicit SDT-G56 known divergence before every Durable Object call`, async () => {
      const expectedWire = fixture(entry.expectedV1Fixture);
      const actualWire = entry.inputKind === "client-model"
        ? await adapterWire(fixture(entry.inputFixture))
        : fixture(entry.inputFixture);

      expect(actualWire).toBe(expectedWire);
      assertCandidatePartR1(actualWire, expectedWire, entry.inputFixture);

      const observed = environment();
      const response = await handleSerializedCommit(new Request("https://commit.test/api/sekiban/serialized/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: actualWire,
      }), observed.env);
      const body = await response.json<{ readonly code?: string; readonly error?: string }>();

      expect(response.status).toBe(entry.runtime.httpStatus);
      expect(body.code).toBe(entry.runtime.code);
      expect(body.error).toContain(entry.runtime.messageIncludes);
      expectNoDurableObjectCalls(observed.calls);
    });
  }
});
