import { describe, expect, it } from "vitest";

import {
  type CommitEnvelope,
  type QueryResponse,
  type ReadonlyTagStateResponse,
} from "../packages/dcb-client/src/index";
import { validateCommitEnvelope } from "../packages/dcb-runtime/src/commit/CommitWorker";
import { createV1Transport } from "../samples/meeting-room/src/transport";

// @ts-expect-error Vite raw imports keep these copied, no-final-newline bytes
// available inside the workerd test isolate as well as to the Node runner.
import officialV1 from "./fixtures/g54-sekiban-interop/interop_official_v1_populated.json?raw";
// @ts-expect-error Vite raw import.
import tsClientModel from "./fixtures/g54-sekiban-interop/interop_ts_client_model.json?raw";
// @ts-expect-error Vite raw import.
import r2Canonical from "./fixtures/g54-sekiban-interop/interop_r2_canonical_positive.json?raw";
// @ts-expect-error Vite raw import.
import r2CanonicalV1 from "./fixtures/g54-sekiban-interop/interop_r2_canonical_positive_v1.json?raw";
// @ts-expect-error Vite raw import.
import r3Bom from "./fixtures/g54-sekiban-interop/interop_r3_bom_payload.json?raw";
// @ts-expect-error Vite raw import.
import r3NonJson from "./fixtures/g54-sekiban-interop/interop_r3_non_json_payload.json?raw";
// @ts-expect-error Vite raw import.
import r3InvalidUtf8 from "./fixtures/g54-sekiban-interop/interop_r3_invalid_utf8_payload.json?raw";
// @ts-expect-error Vite raw import.
import emptyTag from "./fixtures/g54-sekiban-interop/interop_client_empty_tag.json?raw";
// @ts-expect-error Vite raw import.
import duplicateConsistency from "./fixtures/g54-sekiban-interop/interop_client_duplicate_consistency.json?raw";
// @ts-expect-error Vite raw import.
import responseVocabulary from "./fixtures/g54-sekiban-interop/interop_response_member_vocabulary.json?raw";

type Equal<Actual, Expected> =
  (<Value>() => Value extends Actual ? 1 : 2) extends
    (<Value>() => Value extends Expected ? 1 : 2) ? true : false;
type Assert<Condition extends true> = Condition;

type G54ProjectorVersionIsRuntimeString = Assert<
  Equal<NonNullable<ReadonlyTagStateResponse["projectorVersion"]>, string>
>;

function fixture(name: string): string {
  const copied = {
    "interop_official_v1_populated.json": officialV1,
    "interop_ts_client_model.json": tsClientModel,
    "interop_r2_canonical_positive.json": r2Canonical,
    "interop_r2_canonical_positive_v1.json": r2CanonicalV1,
    "interop_r3_bom_payload.json": r3Bom,
    "interop_r3_non_json_payload.json": r3NonJson,
    "interop_r3_invalid_utf8_payload.json": r3InvalidUtf8,
    "interop_client_empty_tag.json": emptyTag,
    "interop_client_duplicate_consistency.json": duplicateConsistency,
    "interop_response_member_vocabulary.json": responseVocabulary,
  } as const;
  const value = copied[name as keyof typeof copied];
  if (value === undefined) throw new Error(`Unknown G54 fixture ${name}`);
  return value;
}

function parseFixture(name: string): Record<string, unknown> {
  return JSON.parse(fixture(name)) as Record<string, unknown>;
}

async function runtimeError(value: unknown): Promise<{ readonly code?: string; readonly error?: string }> {
  const result = validateCommitEnvelope(value);
  expect("error" in result).toBe(true);
  if (!("error" in result)) throw new Error("Expected a typed runtime envelope rejection");
  return result.error.json() as Promise<{ readonly code?: string; readonly error?: string }>;
}

async function wireFromClientFixture(name: string): Promise<string> {
  let captured: string | undefined;
  const transport = createV1Transport({
    async fetch(_input, init): Promise<Response> {
      captured = typeof init?.body === "string" ? init.body : undefined;
      return Response.json({ writtenEvents: [], tagWriteResults: [], duration: "PT0S" });
    },
  });
  await transport.commit(parseFixture(name) as unknown as CommitEnvelope);
  expect(captured).toBeDefined();
  return captured!;
}

describe("SDT-G54 copied Sekiban interop goldens", () => {
  it("R1 admits official V1 and preserves each payload's exact UTF-8 bytes", () => {
    const official = parseFixture("interop_official_v1_populated.json");
    const result = validateCommitEnvelope(official);
    expect("value" in result).toBe(true);
    if (!("value" in result)) throw new Error("Official V1 fixture must be accepted");

    const sourceCandidates = official.eventCandidates as Array<{ readonly payload: string }>;
    expect(result.value.eventCandidates.map((candidate) => candidate.payload)).toEqual(
      sourceCandidates.map((candidate) => Buffer.from(candidate.payload, "base64").toString("utf8")),
    );
  });

  it("R2 rejects the raw client model at the runtime, then the unchanged transport adapter creates official V1 bytes", async () => {
    const rejection = await runtimeError(parseFixture("interop_ts_client_model.json"));
    expect(rejection).toMatchObject({ code: "malformed_commit_envelope" });
    expect(rejection.error).toContain("eventCandidates");
    expect(rejection.error).toContain("consistencyTags");
    expect(rejection.error).toContain("candidates");
    expect(rejection.error).toContain("consistency");

    expect(await wireFromClientFixture("interop_ts_client_model.json")).toBe(fixture("interop_official_v1_populated.json"));
    expect(await wireFromClientFixture("interop_r2_canonical_positive.json")).toBe(fixture("interop_r2_canonical_positive_v1.json"));
  });

  it("R3 runtime payload witnesses remain typed failures", async () => {
    await expect(runtimeError(parseFixture("interop_r3_bom_payload.json"))).resolves.toMatchObject({
      code: "invalid_payload_utf8",
      error: expect.stringContaining("BOM"),
    });
    await expect(runtimeError(parseFixture("interop_r3_non_json_payload.json"))).resolves.toMatchObject({
      code: "invalid_payload_json",
    });
    await expect(runtimeError(parseFixture("interop_r3_invalid_utf8_payload.json"))).resolves.toMatchObject({
      code: "invalid_payload_utf8",
    });
  });

  it("routes empty-tag and duplicate-consistency client fixtures to the existing typed runtime validation failures", async () => {
    const emptyTagWire = JSON.parse(await wireFromClientFixture("interop_client_empty_tag.json"));
    const duplicateConsistencyWire = JSON.parse(await wireFromClientFixture("interop_client_duplicate_consistency.json"));

    await expect(runtimeError(emptyTagWire)).resolves.toMatchObject({ code: "validation_error", error: expect.stringContaining("tags") });
    await expect(runtimeError(duplicateConsistencyWire)).resolves.toMatchObject({ code: "validation_error", error: expect.stringContaining("Consistency") });
  });

  it("keeps the copied response vocabulary aligned to runtime tag-state and query DTOs", () => {
    const vocabulary = parseFixture("interop_response_member_vocabulary.json");
    const tagStateSurface: Pick<ReadonlyTagStateResponse, "payload" | "version" | "lastSortedUniqueId" | "projectorVersion"> = {
      payload: vocabulary.payload as never,
      version: vocabulary.version as number,
      lastSortedUniqueId: vocabulary.lastSortedUniqueId as string,
      projectorVersion: vocabulary.projectorVersion as string,
    };
    const querySurface: QueryResponse = { resultJson: JSON.stringify({ writtenEvents: vocabulary.writtenEvents, tagWriteResults: vocabulary.tagWriteResults }) };
    const projectorVersionProof: G54ProjectorVersionIsRuntimeString = true;

    expect(typeof tagStateSurface.projectorVersion).toBe("string");
    expect(typeof tagStateSurface.lastSortedUniqueId).toBe("string");
    expect(JSON.parse(querySurface.resultJson)).toMatchObject({ writtenEvents: expect.any(Array), tagWriteResults: expect.any(Array) });
    expect(projectorVersionProof).toBe(true);
  });
});
