import { describe, expect, it } from "vitest";
import vectorsJson from "../contracts/g43-event-digest-vectors.json";

import {
  EventDigestValidationError,
  eventDigestHex,
  type EventDigestInput,
} from "../packages/dcb-runtime/src/tag/EventDigest";

interface FixtureInput {
  readonly serviceId: string;
  readonly eventId: string;
  readonly sortableUniqueId: string;
  readonly eventType: string;
  readonly timestamp: string;
  readonly allocatorLineageId?: string;
  readonly attemptId: string;
  readonly declaredTagSet: readonly string[];
  readonly payloadHex: string;
}

interface DigestVectors {
  readonly vectors: ReadonlyArray<{
    readonly id: string;
    readonly input?: FixtureInput;
    readonly expectedDigest?: string;
    readonly left?: FixtureInput;
    readonly right?: FixtureInput;
    readonly expectedLeftDigest?: string;
    readonly expectedRightDigest?: string;
    readonly absent?: FixtureInput;
    readonly presentEmpty?: FixtureInput;
    readonly expectedAbsentDigest?: string;
    readonly expectedPresentEmptyDigest?: string;
  }>;
}

const vectors = vectorsJson as DigestVectors;

function inputFrom(fixture: FixtureInput): EventDigestInput {
  const { payloadHex, ...fields } = fixture;
  return { ...fields, payload: Uint8Array.from(Buffer.from(payloadHex, "hex")) };
}

describe("SDT-G43 eventDigest v2 runtime", () => {
  it("matches every packet-owned golden digest while the Node checker verifies an independent implementation", async () => {
    expect(vectors.vectors).toHaveLength(7);
    for (const vector of vectors.vectors) {
      if (vector.input !== undefined) {
        await expect(eventDigestHex(inputFrom(vector.input))).resolves.toBe(vector.expectedDigest);
      } else if (vector.left !== undefined && vector.right !== undefined) {
        await expect(eventDigestHex(inputFrom(vector.left))).resolves.toBe(vector.expectedLeftDigest);
        await expect(eventDigestHex(inputFrom(vector.right))).resolves.toBe(vector.expectedRightDigest);
      } else if (vector.absent !== undefined && vector.presentEmpty !== undefined) {
        await expect(eventDigestHex(inputFrom(vector.absent))).resolves.toBe(vector.expectedAbsentDigest);
        await expect(eventDigestHex(inputFrom(vector.presentEmpty))).resolves.toBe(vector.expectedPresentEmptyDigest);
      } else {
        throw new Error(`Unsupported golden vector ${vector.id}`);
      }
    }
  });

  it("canonicalizes reordered and duplicate tag entries, but distinguishes an extra tag", async () => {
    const base = inputFrom(vectors.vectors[0]!.input!);
    const canonical = await eventDigestHex({ ...base, declaredTagSet: ["z", "a"] });
    await expect(eventDigestHex({ ...base, declaredTagSet: ["a", "z"] })).resolves.toBe(canonical);
    await expect(eventDigestHex({ ...base, declaredTagSet: ["z", "a", "z"] })).resolves.toBe(canonical);
    await expect(eventDigestHex({ ...base, declaredTagSet: ["a", "z", "extra"] })).resolves.not.toBe(canonical);
  });

  it("fails closed when an event record contains a non-projected, non-excluded field", async () => {
    const base = inputFrom(vectors.vectors[0]!.input!);
    await expect(eventDigestHex({ ...base, unknownEventRecordField: "must-not-disappear" } as unknown as EventDigestInput))
      .rejects.toBeInstanceOf(EventDigestValidationError);
  });

  it("keeps different event identities distinct even when all remaining values match", async () => {
    const base = inputFrom(vectors.vectors[0]!.input!);
    const second = { ...base, eventId: "event-0001-other" };
    await expect(eventDigestHex(second)).resolves.not.toBe(await eventDigestHex(base));
  });
});
