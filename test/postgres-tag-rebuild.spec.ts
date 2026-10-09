// @ts-expect-error Node-only imports are used by this PostgreSQL integration lane.
import { createHash, randomBytes } from "node:crypto";
// @ts-expect-error Node-only imports are used by this PostgreSQL integration lane.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error Use the Node postgres transport in the worker-backed test harness.
import postgres from "../node_modules/postgres/cjs/src/index.js";
import {
  canonicalJson,
  eventDigestForRecord,
  runCommand,
  setReceiptWriteHookForTests,
} from "../tools/derive-dcb-tags/postgres-rebuild.mjs";
// @ts-expect-error Vitest raw fixture import.
import inputSource from "./fixtures/postgres-tag-rebuild/partial-sealed.json?raw";
// @ts-expect-error Vitest raw fixture import.
import correctionSource from "./fixtures/postgres-tag-rebuild/partial-correction.json?raw";
// @ts-expect-error Vitest raw source import.
import contractSource from "../contracts/postgres-tag-rebuild.json?raw";

const baseUrl = process.env.POSTGRES_URL;
const fixture = `/tmp/sdt-g121-fixture-${randomBytes(5).toString("hex")}.json`;
const correction = `/tmp/sdt-g121-correction-${randomBytes(5).toString("hex")}.json`;
const inputBytes = Buffer.from(inputSource as string, "utf8");
const correctionBytes = Buffer.from(correctionSource as string, "utf8");
const inputSha = digestBytes(inputBytes);
const correctionSha = digestBytes(correctionBytes);
type FixtureRecord = {
  serviceId: string;
  id: string;
  sortableUniqueId: string;
  eventType: string;
  payload: string;
  tags: string[];
  timestamp: string;
  causationId: string | null;
  correlationId: string | null;
  executedUser: string | null;
};
type FixtureEvent = {
  record: FixtureRecord;
  digest: Record<string, string>;
  declaredTagSet: string[];
  committedMembership: string[];
};
type FixtureInput = {
  format: string;
  version: number;
  serviceId: string;
  seal: { state: string; canonicalization: string; contentDigest: string; sealedAtMs: number };
  health: {
    status: string;
    scannerVersion: string;
    lastFullScanAtMs: number;
    staleAfterMs: number;
    openFindingCount: number;
    lastSettledFrontierSuid: string | null;
    coveredEventCount: number;
    coveredMembershipCount: number;
  };
  summary: { eventCount: number; declaredMembershipCount: number; committedMembershipCount: number };
  events: FixtureEvent[];
  [key: string]: unknown;
};
type FixtureCorrection = {
  format: string;
  version: number;
  correctionId: string;
  serviceId: string;
  inputContentDigest: string;
  reason: string;
  addMembership: Array<{ eventId: string; eventDigest: string; tag: string }>;
  [key: string]: unknown;
};
type ContractSchema = {
  requiredKeys?: string[];
  optionalKeys?: string[];
  requiredColumns?: string[];
  optionalColumns?: string[];
  requiredNotNullColumns?: string[];
  nullableColumns?: string[];
  nullable?: boolean;
  nested?: Record<string, ContractSchema>;
};
type Contract = { schemas: Record<string, ContractSchema>; provenanceDdl: string };
const input = JSON.parse(inputBytes.toString("utf8")) as FixtureInput;
const correctionValue = JSON.parse(correctionBytes.toString("utf8")) as FixtureCorrection;
const contract = JSON.parse(contractSource as string) as Contract;
let databaseUrl: string;
let databaseName: string;
let db: ReturnType<typeof postgres>;
const temporaryFiles: string[] = [];

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function adminUrl(value: string): string {
  const url = new URL(value);
  url.pathname = "/postgres";
  return url.toString();
}

async function run(args: string[]): Promise<string> {
  const previous = process.env.POSTGRES_URL;
  process.env.POSTGRES_URL = databaseUrl;
  try {
    return await runCommand(args);
  } finally {
    if (previous === undefined) {
      delete process.env.POSTGRES_URL;
    } else {
      process.env.POSTGRES_URL = previous;
    }
  }
}

function writeTemporaryJson(prefix: string, value: unknown): { path: string; bytes: Uint8Array } {
  const path = `/tmp/${prefix}-${randomBytes(5).toString("hex")}.json`;
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  writeFileSync(path, bytes);
  temporaryFiles.push(path);
  return { path, bytes };
}

function makeInput(change: (value: FixtureInput) => void): {
  path: string;
  bytes: Uint8Array;
  value: FixtureInput;
} {
  const value = structuredClone(input) as FixtureInput;
  change(value);
  for (const event of value.events) {
    const calculated = eventDigestForRecord(
      event.record,
      event.digest,
      event.declaredTagSet,
    );
    event.digest.canonicalBytesBase64 = calculated.canonicalBytesBase64;
    event.digest.eventDigest = calculated.eventDigest;
  }
  if (value.health.lastSettledFrontierSuid === input.health.lastSettledFrontierSuid) {
    value.health.lastSettledFrontierSuid =
      value.events.at(-1)?.record.sortableUniqueId ?? null;
  }
  value.seal.contentDigest = "";
  value.seal.contentDigest = digestBytes(Buffer.from(canonicalJson(value), "utf8"));
  const written = writeTemporaryJson("sdt-g121-mutated", value);
  return { ...written, value };
}

function makeRawInput(change: (value: FixtureInput) => void): {
  path: string;
  bytes: Uint8Array;
  value: FixtureInput;
} {
  const value = structuredClone(input) as FixtureInput;
  change(value);
  const written = writeTemporaryJson("sdt-g121-raw", value);
  return { ...written, value };
}

function makeCorrection(change: (value: FixtureCorrection) => void): {
  path: string;
  bytes: Uint8Array;
  value: FixtureCorrection;
} {
  const value = structuredClone(correctionValue) as FixtureCorrection;
  change(value);
  const written = writeTemporaryJson("sdt-g121-correction", value);
  return { ...written, value };
}

function addReceiptPath(): string {
  const path = `/tmp/sdt-g121-receipt-${randomBytes(5).toString("hex")}.json`;
  temporaryFiles.push(path);
  return path;
}

function applyArgs(inputPath: string, fileSha: string, receiptPath: string): string[] {
  return ["--input", inputPath, "--apply", "--input-sha256", fileSha, "--receipt", receiptPath];
}

async function resetTarget(): Promise<void> {
  await db.unsafe("DROP TABLE IF EXISTS dcb_tag_rebuild_provenance");
  await db`DELETE FROM dcb_tags`;
  await db`DELETE FROM dcb_events WHERE "ServiceId" = ${input.serviceId}`;
  await insertEvent(input.events[0].record);
}

async function insertEvent(event: FixtureRecord): Promise<void> {
  await db.unsafe(
    `INSERT INTO dcb_events
      ("ServiceId", "Id", "SortableUniqueId", "EventType", "Payload",
       "Tags", "Timestamp", "CausationId", "CorrelationId", "ExecutedUser")
     VALUES
      ('${event.serviceId}', '${event.id}', '${event.sortableUniqueId}', '${event.eventType}',
       '${event.payload}'::json, '${JSON.stringify(event.tags)}'::jsonb, '${event.timestamp}',
       ${event.causationId === null ? "NULL" : `'${event.causationId}'`},
       ${event.correlationId === null ? "NULL" : `'${event.correlationId}'`},
       ${event.executedUser === null ? "NULL" : `'${event.executedUser}'`})`,
  );
}

async function rebuildWrites(): Promise<{ tags: number; provenance: number }> {
  const tags = await db`
    SELECT COUNT(*)::int AS count
    FROM dcb_tags
    WHERE "ServiceId" = ${input.serviceId}
  `;
  const provenance = await db`
    SELECT COUNT(*)::int AS count
    FROM dcb_tag_rebuild_provenance
    WHERE service_id = ${input.serviceId}
  `.catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "42P01") {
      return [{ count: 0 }];
    }
    throw error;
  });
  return { tags: Number(tags[0].count), provenance: Number(provenance[0].count) };
}

async function expectRedCase(
  label: string,
  args: string[],
  expected: string | RegExp,
  unchanged: { tags: number; provenance: number } = {
    tags: 0,
    provenance: 0,
  },
): Promise<void> {
  await resetTarget();
  await expectRebuildWrites(label, unchanged);
  await expect(run(args), label).rejects.toThrow(expected);
  await expectRebuildWrites(`${label} leaves state unchanged`, unchanged);
}

async function expectRebuildWrites(
  label: string,
  expected: { tags: number; provenance: number },
): Promise<void> {
  const actual = await rebuildWrites();
  expect(actual, label).toEqual(expected);
}

async function createProvenanceTable(): Promise<void> {
  await db.unsafe(contract.provenanceDdl.replace("IF NOT EXISTS ", ""));
}

async function waitForLock(
  predicate: (rows: Array<Record<string, unknown>>) => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = (await db.unsafe(`
      SELECT l.pid, l.locktype, l.mode, l.granted, a.wait_event_type, a.query
      FROM pg_locks l
      JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE a.datname = current_database()
    `)) as Array<Record<string, unknown>>;
    if (predicate(rows)) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("timed out waiting for pg_locks stage");
}

function assertClosedSchema(schema: ContractSchema, path: string): void {
  const required = schema.requiredKeys ?? schema.requiredColumns;
  const optional = schema.optionalKeys ?? schema.optionalColumns;
  expect(required, `${path} required keys`).toBeTruthy();
  expect(optional, `${path} optional keys`).toBeTruthy();
  expect(typeof schema.nullable, `${path} nullability`).toBe("boolean");
  const requiredSet = new Set(required);
  for (const key of optional ?? []) {
    expect(requiredSet.has(key), `${path} overlaps at ${key}`).toBe(false);
  }
  for (const [nestedPath, nested] of Object.entries(schema.nested ?? {})) {
    assertClosedSchema(nested, `${path}.${nestedPath}`);
  }
}

describe("SDT-G121 PostgreSQL tag rebuild", () => {
  beforeAll(async () => {
    if (!baseUrl) {
      throw new Error("POSTGRES_URL is required");
    }
    writeFileSync(fixture, inputBytes);
    writeFileSync(correction, correctionBytes);
    databaseName = `sdt_g121_${randomBytes(5).toString("hex")}`;
    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    await admin.end();
    const url = new URL(baseUrl);
    url.pathname = `/${databaseName}`;
    databaseUrl = url.toString();
    db = postgres(databaseUrl, { max: 1, fetch_types: false });
    await db.unsafe(`
      CREATE TABLE dcb_events (
        "ServiceId" varchar(64) NOT NULL,
        "Id" uuid NOT NULL,
        "SortableUniqueId" varchar(100) NOT NULL,
        "EventType" text NOT NULL,
        "Payload" json NOT NULL,
        "Tags" jsonb NOT NULL,
        "Timestamp" timestamptz NOT NULL,
        "CausationId" text NULL,
        "CorrelationId" text NULL,
        "ExecutedUser" text NULL,
        CONSTRAINT "PK_dcb_events" PRIMARY KEY ("ServiceId", "Id")
      );
      CREATE TABLE dcb_tags (
        "Id" bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        "ServiceId" varchar(64) NOT NULL,
        "Tag" text NOT NULL,
        "TagGroup" text NOT NULL,
        "EventType" text NOT NULL,
        "SortableUniqueId" varchar(100) NOT NULL,
        "EventId" uuid NOT NULL,
        "CreatedAt" timestamptz NOT NULL
      );
    `);
    await insertEvent(input.events[0].record);
  });

  afterAll(async () => {
    setReceiptWriteHookForTests(undefined);
    for (const path of [fixture, correction, ...temporaryFiles]) {
      if (existsSync(path)) {
        unlinkSync(path);
      }
    }
    await db?.end({ timeout: 5 });
    if (baseUrl && databaseName) {
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      await admin.unsafe(`DROP DATABASE ${databaseName} WITH (FORCE)`);
      await admin.end({ timeout: 5 });
    }
  });

  it("consumes complete closed schemas and provenance DDL from the contract", () => {
    for (const [name, schema] of Object.entries(contract.schemas)) {
      assertClosedSchema(schema, `schemas.${name}`);
    }
    const digestSchema = contract.schemas.input.nested!["events[].digest"];
    expect(digestSchema.optionalKeys).toEqual(["allocatorLineageId"]);
    const healthSchema = contract.schemas.receipt.nested!["input.health"];
    expect(healthSchema.requiredKeys).toHaveLength(8);
    expect(contract.schemas.dryRunReport.nested!.correction!.nullable).toBe(true);
    expect(contract.schemas.receipt.nested!.correction!.nullable).toBe(true);
    expect(contract.provenanceDdl).toContain("dcb_tag_rebuild_provenance");
  });

  it("keeps a partial declared set partial in a read-only dry run", async () => {
    await resetTarget();
    const receipt = addReceiptPath();
    const result = await run(["--input", fixture, "--receipt", receipt]);
    expect(result).toContain('"membershipCount":0');
    expect(result).toContain('"tag":"room:room-1"');
    expect(result).not.toContain("reservation:res-1");
    await expect(db`SELECT COUNT(*)::int AS count FROM dcb_tags`).resolves.toEqual([{ count: 0 }]);
    expect(existsSync(receipt)).toBe(false);
  });

  it("applies only committed membership, reads back the receipt, then reruns byte-for-byte", async () => {
    await resetTarget();
    const receipt = addReceiptPath();
    const args = applyArgs(fixture, inputSha, receipt);
    await run(args);
    const firstBytes = readFileSync(receipt);
    expect(JSON.parse(firstBytes.toString()).target.membershipCount).toBe(1);
    expect(firstBytes.toString()).not.toContain("reservation:res-1");
    console.log(`SDT-G121 default receipt ${digestBytes(firstBytes)}`);
    const count = await db`SELECT COUNT(*)::int AS count FROM dcb_tags`;
    expect(count[0].count).toBe(1);
    const stored = await db`
      SELECT receipt_json, receipt_sha256
      FROM dcb_tag_rebuild_provenance
      WHERE service_id = ${input.serviceId}
    `;
    expect(Buffer.from(stored[0].receipt_json, "utf8")).toEqual(firstBytes);
    expect(stored[0].receipt_sha256).toBe(digestBytes(firstBytes));
    await run(args);
    expect(readFileSync(receipt)).toEqual(firstBytes);
    const rerunCount = await db`SELECT COUNT(*)::int AS count FROM dcb_tags`;
    expect(rerunCount[0].count).toBe(1);
  });

  it("accepts the second tag only through a matching correction digest", async () => {
    await resetTarget();
    const receipt = addReceiptPath();
    await run([
      ...applyArgs(fixture, inputSha, receipt),
      "--correction-manifest",
      correction,
      "--correction-sha256",
      correctionSha,
    ]);
    const receiptBytes = readFileSync(receipt);
    console.log(`SDT-G121 correction receipt ${digestBytes(receiptBytes)}`);
    const rows = await db`SELECT "Tag" AS tag FROM dcb_tags ORDER BY "Tag"`;
    expect(rows.map((row: { tag: string }) => row.tag)).toEqual([
      "reservation:res-1",
      "room:room-1",
    ]);
  });

  it("rejects the complete input validation matrix with specific errors and zero writes", async () => {
    const unknownKey = makeRawInput((value) => {
      value.unexpected = true;
    });
    const missingKey = makeRawInput((value) => {
      Reflect.deleteProperty(value, "health");
    });
    const missingServiceId = makeRawInput((value) => {
      Reflect.deleteProperty(value, "serviceId");
    });
    const duplicateEventId = makeInput((value) => {
      const duplicate = structuredClone(value.events[0]);
      duplicate.record.sortableUniqueId = "063923011636102000000000000002";
      value.events.push(duplicate);
      value.summary.eventCount = 2;
      value.summary.declaredMembershipCount = 4;
      value.summary.committedMembershipCount = 2;
      value.health.coveredEventCount = 2;
      value.health.coveredMembershipCount = 2;
    });
    const duplicateSuid = makeInput((value) => {
      const duplicate = structuredClone(value.events[0]);
      duplicate.record.id = "018f9c51-6b74-7f5e-8ca1-0123456789ac";
      value.events.push(duplicate);
      value.summary.eventCount = 2;
      value.summary.declaredMembershipCount = 4;
      value.summary.committedMembershipCount = 2;
      value.health.coveredEventCount = 2;
      value.health.coveredMembershipCount = 2;
    });
    const emptyMembership = makeRawInput((value) => {
      value.events[0].committedMembership = [];
    });
    const outsideMembership = makeRawInput((value) => {
      value.events[0].committedMembership = ["not-declared"];
    });
    const duplicateMembership = makeRawInput((value) => {
      value.events[0].committedMembership.push("room:room-1");
    });
    const countMismatch = makeInput((value) => {
      value.summary.committedMembershipCount = 2;
    });
    const frontierMismatch = makeInput((value) => {
      value.health.lastSettledFrontierSuid = "063923011636102000000000000009";
    });
    const contentDigestMismatch = makeRawInput((value) => {
      value.seal.contentDigest = "sha256:" + "0".repeat(64);
    });
    const invalidBase64 = makeRawInput((value) => {
      value.events[0].digest.canonicalBytesBase64 = "!";
    });
    const canonicalMismatch = makeRawInput((value) => {
      value.events[0].record.payload = '{"roomId":"changed"}';
    });
    const eventDigestMismatch = makeRawInput((value) => {
      value.events[0].digest.eventDigest = "0".repeat(64);
    });
    const cases = [
      ["unknown keys", unknownKey, /unknown or missing keys/],
      ["missing health", missingKey, /unknown or missing keys/],
      ["missing serviceId", missingServiceId, /unknown or missing keys/],
      ["duplicate event identity", duplicateEventId, /duplicate event identity/],
      ["duplicate SUID", duplicateSuid, /duplicate SUID/],
      ["duplicate committed membership", duplicateMembership, /duplicate committed membership/],
      ["empty committed membership", emptyMembership, /must be non-empty strings/],
      ["membership outside declared set", outsideMembership, /outside declaredTagSet/],
      ["count mismatch", countMismatch, /summary counts do not match/],
      ["frontier mismatch", frontierMismatch, /health coverage does not match/],
      ["content digest mismatch", contentDigestMismatch, /content digest mismatch/],
      ["invalid base64", invalidBase64, /canonicalBytesBase64 is not valid base64/],
      ["canonical event bytes mismatch", canonicalMismatch, /canonical event bytes do not match/],
      ["event digest mismatch", eventDigestMismatch, /event digest does not match/],
    ] as const;
    for (const [label, value, expected] of cases) {
      const fileSha = digestBytes(value.bytes);
      await expectRedCase(label, applyArgs(value.path, fileSha, addReceiptPath()), expected);
    }
  });

  it("rejects every unhealthy, stale, and finding seal with its specific reason", async () => {
    for (const status of ["UNKNOWN", "FAILED", "STALE", "BLOCK", "UNSETTLED"]) {
      const value = makeInput((inputValue) => {
        inputValue.health.status = status;
      });
      await expectRedCase(
        `health status ${status}`,
        ["--input", value.path],
        new RegExp(`status ${status} is not HEALTHY`),
      );
    }
    const stale = makeInput((value) => {
      value.health.lastFullScanAtMs =
        value.seal.sealedAtMs - value.health.staleAfterMs - 1;
    });
    await expectRedCase("stale evidence", ["--input", stale.path], /stale at seal time/);
    const findings = makeInput((value) => {
      value.health.openFindingCount = 1;
    });
    await expectRedCase("open findings", ["--input", findings.path], /open findings/);
  });

  it("rejects every correction validation case with its specific error and zero writes", async () => {
    const missing = `/tmp/sdt-g121-missing-${randomBytes(4).toString("hex")}.json`;
    const missingDigest = makeCorrection(() => {});
    const unknownKey = makeCorrection((value) => {
      value.unexpected = true;
    });
    const removal = makeCorrection((value) => {
      value.removeMembership = [value.addMembership[0]];
    });
    const wrongVersion = makeCorrection((value) => {
      value.version = 2;
    });
    const wrongService = makeCorrection((value) => {
      value.serviceId = "other-service";
    });
    const wrongInput = makeCorrection((value) => {
      value.inputContentDigest = "sha256:" + "0".repeat(64);
    });
    const emptyId = makeCorrection((value) => {
      value.correctionId = "";
    });
    const emptyReason = makeCorrection((value) => {
      value.reason = "";
    });
    const duplicate = makeCorrection((value) => {
      value.addMembership.push(structuredClone(value.addMembership[0]));
    });
    const unknownEvent = makeCorrection((value) => {
      value.addMembership[0].eventId = "018f9c51-6b74-7f5e-8ca1-0123456789ac";
    });
    const wrongEventDigest = makeCorrection((value) => {
      value.addMembership[0].eventDigest = "0".repeat(64);
    });
    const committed = makeCorrection((value) => {
      value.addMembership[0].tag = "room:room-1";
    });
    const undeclared = makeCorrection((value) => {
      value.addMembership[0].tag = "not-declared";
    });
    const cases = [
      [
        "missing correction file",
        missing,
        undefined,
        /correction file cannot be read/,
      ],
      ["missing correction digest", missingDigest.path, undefined, /requires --correction-sha256/],
      [
        "correction unknown key",
        unknownKey.path,
        digestBytes(unknownKey.bytes),
        /unknown or missing keys/,
      ],
      [
        "correction removal",
        removal.path,
        digestBytes(removal.bytes),
        /unknown or missing keys/,
      ],
      ["correction version", wrongVersion.path, digestBytes(wrongVersion.bytes), /format\/version/],
      ["correction service", wrongService.path, digestBytes(wrongService.bytes), /serviceId differs/],
      ["correction input digest", wrongInput.path, digestBytes(wrongInput.bytes), /inputContentDigest differs/],
      ["empty correction id", emptyId.path, digestBytes(emptyId.bytes), /correctionId must be/],
      ["empty correction reason", emptyReason.path, digestBytes(emptyReason.bytes), /reason must be/],
      ["duplicate correction addition", duplicate.path, digestBytes(duplicate.bytes), /duplicate addition/],
      ["unknown correction event", unknownEvent.path, digestBytes(unknownEvent.bytes), /unknown event/],
      [
        "correction event digest",
        wrongEventDigest.path,
        digestBytes(wrongEventDigest.bytes),
        /digest does not match event/,
      ],
      ["already committed", committed.path, digestBytes(committed.bytes), /already committed/],
      ["undeclared tag", undeclared.path, digestBytes(undeclared.bytes), /not declared/],
    ] as const;
    for (const [label, path, fileSha, expected] of cases) {
      const args = applyArgs(fixture, inputSha, addReceiptPath());
      args.push("--correction-manifest", path);
      if (fileSha !== undefined) {
        args.push("--correction-sha256", fileSha);
      }
      await expectRedCase(label, args, expected);
    }
  });

  it("rejects changed input or correction digests and prior provenance for another input", async () => {
    const wrongInputDigest = applyArgs(fixture, "sha256:" + "0".repeat(64), addReceiptPath());
    await expectRedCase("changed input digest", wrongInputDigest, /input file digest mismatch/);
    const wrongCorrectionDigest = [
      ...applyArgs(fixture, inputSha, addReceiptPath()),
      "--correction-manifest",
      correction,
      "--correction-sha256",
      "sha256:" + "0".repeat(64),
    ];
    await expectRedCase("changed correction digest", wrongCorrectionDigest, /correction file digest mismatch/);
    await resetTarget();
    await createProvenanceTable();
    await db.unsafe(`
      INSERT INTO dcb_tag_rebuild_provenance
        (rebuild_id, service_id, contract_version, input_file_sha256, input_content_digest,
         applied_at, receipt_sha256, receipt_json)
      VALUES
        ('sha256:${"1".repeat(64)}', '${input.serviceId}', 1, 'sha256:${"2".repeat(64)}',
         'sha256:${"3".repeat(64)}', transaction_timestamp(), 'sha256:${"4".repeat(64)}', '{}')
    `);
    const args = applyArgs(fixture, inputSha, addReceiptPath());
    await expect(run(args)).rejects.toThrow(/prior provenance belongs to different input/);
    await expect(rebuildWrites()).resolves.toEqual({ tags: 0, provenance: 1 });
  });

  it("rejects all listed target and post-provenance drift cases", async () => {
    const driftCases = [
      [
        "SUID",
        async () =>
          db`UPDATE dcb_events SET "SortableUniqueId" = '063923011636102000000000000009'`,
        /sortableUniqueId/,
      ],
      ["event type", async () => db`UPDATE dcb_events SET "EventType" = 'OtherEvent'`, /eventType/],
      [
        "ordered tags",
        async () =>
          db`UPDATE dcb_events SET "Tags" = '["reservation:res-1","room:room-1"]'::jsonb`,
        /ordered declared tags/,
      ],
      [
        "nullable metadata",
        async () => db`UPDATE dcb_events SET "CausationId" = 'drifted'`,
        /nullable event metadata/,
      ],
      [
        "timestamp",
        async () =>
          db`UPDATE dcb_events SET "Timestamp" = "Timestamp" + interval '1 second'`,
        /timestamp instant/,
      ],
      [
        "tag provider fields",
        async () => db`UPDATE dcb_tags SET "TagGroup" = 'drifted'`,
        /provider fields/,
      ],
      [
        "CreatedAt",
        async () =>
          db`UPDATE dcb_tags SET "CreatedAt" = "CreatedAt" + interval '1 second'`,
        /CreatedAt mismatch/,
      ],
      ["provenance-only partial state", async () => db`DELETE FROM dcb_tags`, /membership count/],
      [
        "membership count",
        async () =>
          db`INSERT INTO dcb_tags
             ("ServiceId", "Tag", "TagGroup", "EventType", "SortableUniqueId", "EventId", "CreatedAt")
             SELECT "ServiceId", 'extra:tag', 'extra', "EventType", "SortableUniqueId", "EventId", "CreatedAt"
             FROM dcb_tags`,
        /membership count/,
      ],
      ["membership set", async () => db`UPDATE dcb_tags SET "Tag" = 'wrong:tag'`, /membership differs/],
    ] as const;
    for (const [label, mutate, expected] of driftCases) {
      await resetTarget();
      const receipt = addReceiptPath();
      const args = applyArgs(fixture, inputSha, receipt);
      await run(args);
      await mutate();
      await expect(run(args), label).rejects.toThrow(expected);
      const expectedCounts =
        label === "provenance-only partial state"
          ? { tags: 0, provenance: 1 }
          : { tags: label === "membership count" ? 2 : 1, provenance: 1 };
      await expectRebuildWrites(`${label} retains row counts`, expectedCounts);
    }
  });

  it("rejects malformed UTF-8 and duplicate object keys before opening PostgreSQL", async () => {
    const badUtf8 = `/tmp/sdt-g121-invalid-${randomBytes(4).toString("hex")}.json`;
    const duplicate = `/tmp/sdt-g121-duplicate-${randomBytes(4).toString("hex")}.json`;
    writeFileSync(badUtf8, Buffer.from([0x7b, 0xff, 0x7d]));
    writeFileSync(
      duplicate,
      inputBytes.toString().replace('"version": 1,\n  "serviceId"', '"version": 1,\n  "version": 1,\n  "serviceId"'),
    );
    temporaryFiles.push(badUtf8, duplicate);
    await expectRedCase("malformed UTF-8", ["--input", badUtf8], /not valid UTF-8/);
    await expectRedCase("duplicate object key", ["--input", duplicate], /duplicate object key version/);
  });

  it("rolls back tag rows and provenance when the insert is rejected", async () => {
    await resetTarget();
    await db`ALTER TABLE dcb_tags ADD CONSTRAINT sdt_g121_force_rollback CHECK (false)`;
    await expect(
      run(applyArgs(fixture, inputSha, addReceiptPath())),
    ).rejects.toThrow(/sdt_g121_force_rollback|check constraint/);
    await db`ALTER TABLE dcb_tags DROP CONSTRAINT sdt_g121_force_rollback`;
    await expect(rebuildWrites()).resolves.toEqual({ tags: 0, provenance: 0 });
  });

  it("recovers an injected post-commit receipt failure on an exact same-path rerun", async () => {
    await resetTarget();
    const receipt = addReceiptPath();
    const args = applyArgs(fixture, inputSha, receipt);
    setReceiptWriteHookForTests(async () => {
      setReceiptWriteHookForTests(undefined);
      throw new Error("injected post-commit receipt failure");
    });
    await expect(run(args)).rejects.toThrow(/injected post-commit receipt failure/);
    await expect(rebuildWrites()).resolves.toEqual({ tags: 1, provenance: 1 });
    expect(existsSync(receipt)).toBe(false);
    await run(args);
    expect(existsSync(receipt)).toBe(true);
    await expect(rebuildWrites()).resolves.toEqual({ tags: 1, provenance: 1 });
  });

  it("refuses a different same-path receipt without changing the committed state", async () => {
    await resetTarget();
    const receipt = addReceiptPath();
    writeFileSync(receipt, Buffer.from("different\n"));
    await expect(
      run(applyArgs(fixture, inputSha, receipt)),
    ).rejects.toThrow(/receipt path already exists before first apply/);
    await expect(rebuildWrites()).resolves.toEqual({ tags: 0, provenance: 0 });
  });

  it("observes a writer committed across the advisory-to-table-lock fence", async () => {
    await resetTarget();
    await createProvenanceTable();
    const writer = postgres(databaseUrl, { max: 1, fetch_types: false });
    let applying: Promise<string>;
    await writer.begin(async (transaction: ReturnType<typeof postgres>) => {
      await transaction.unsafe("LOCK TABLE dcb_events IN ROW EXCLUSIVE MODE");
      applying = run(applyArgs(fixture, inputSha, addReceiptPath()));
      await waitForLock((rows) =>
        rows.some(
          (row) =>
            row.locktype === "relation" &&
            row.mode === "ShareRowExclusiveLock" &&
            row.granted === false,
        ),
      );
      const event = input.events[0].record;
      await transaction.unsafe(
        `INSERT INTO dcb_events
          ("ServiceId", "Id", "SortableUniqueId", "EventType", "Payload", "Tags", "Timestamp")
         VALUES
          ('${event.serviceId}', '018f9c51-6b74-7f5e-8ca1-0123456789ac',
           '063923011636102000000000000002', 'RoomReserved', '${event.payload}'::json,
           '${JSON.stringify(event.tags)}'::jsonb, '${event.timestamp}')`,
      );
    });
    await expect(applying!).rejects.toThrow(/target event count 2 differs/);
    await writer.end({ timeout: 5 });
    await expect(rebuildWrites()).resolves.toEqual({ tags: 0, provenance: 0 });
  });

  it("waits for an existing table lock without deadlock", async () => {
    await resetTarget();
    await createProvenanceTable();
    const writer = postgres(databaseUrl, { max: 1, fetch_types: false });
    let applying: Promise<string>;
    await writer.begin(async (transaction: ReturnType<typeof postgres>) => {
      await transaction.unsafe("LOCK TABLE dcb_events IN ROW EXCLUSIVE MODE");
      applying = run(applyArgs(fixture, inputSha, addReceiptPath()));
      await waitForLock((rows) =>
        rows.some(
          (row) =>
            row.locktype === "relation" &&
            row.mode === "ShareRowExclusiveLock" &&
            row.granted === false,
        ),
      );
    });
    await writer.end({ timeout: 5 });
    await expect(applying!).resolves.toMatch(/mode=apply/);
    await expect(rebuildWrites()).resolves.toEqual({ tags: 1, provenance: 1 });
  });

  it("serializes two services racing initial provenance-table creation using pg_locks", async () => {
    await resetTarget();
    const second = makeInput((value) => {
      value.serviceId = "sdt-g121-second";
      value.events[0].record.serviceId = value.serviceId;
      value.events[0].record.id = "018f9c51-6b74-7f5e-8ca1-0123456789ac";
      value.events[0].record.sortableUniqueId = "063923011636102000000000000002";
    });
    await insertEvent(second.value.events[0].record);
    const secondReceipt = addReceiptPath();
    const firstReceipt = addReceiptPath();
    const firstArgs = applyArgs(fixture, inputSha, firstReceipt);
    const secondArgs = applyArgs(second.path, digestBytes(second.bytes), secondReceipt);
    const gate = postgres(databaseUrl, { max: 1, fetch_types: false });
    await gate`SELECT pg_advisory_lock(1274121274)`;
    const previousUrl = process.env.POSTGRES_URL;
    process.env.POSTGRES_URL = databaseUrl;
    const firstRun = runCommand(firstArgs);
    const secondRun = runCommand(secondArgs);
    await waitForLock((rows) =>
      rows.filter(
        (row) => row.locktype === "advisory" && row.mode === "ExclusiveLock" && row.granted === false,
      ).length >= 2,
    );
    await gate`SELECT pg_advisory_unlock(1274121274)`;
    await Promise.all([firstRun, secondRun]);
    if (previousUrl === undefined) {
      delete process.env.POSTGRES_URL;
    } else {
      process.env.POSTGRES_URL = previousUrl;
    }
    await gate.end({ timeout: 5 });
    const rows = await db`SELECT COUNT(*)::int AS count FROM dcb_tag_rebuild_provenance`;
    expect(rows[0].count).toBe(2);
  });

});
