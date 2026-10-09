// @ts-expect-error Node-only imports are used by this PostgreSQL integration lane.
import { createHash, randomBytes } from "node:crypto";
// @ts-expect-error Node-only imports are used by this PostgreSQL integration lane.
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error Use the Node postgres transport in the worker-backed test harness.
import postgres from "../node_modules/postgres/cjs/src/index.js";
import { canonicalJson, runCommand } from "../tools/derive-dcb-tags/postgres-rebuild.mjs";
// @ts-expect-error Vitest raw fixture import.
import inputSource from "./fixtures/postgres-tag-rebuild/partial-sealed.json?raw";
// @ts-expect-error Vitest raw fixture import.
import correctionSource from "./fixtures/postgres-tag-rebuild/partial-correction.json?raw";
// @ts-expect-error Vitest raw source import.
import legacySource from "../tools/derive-dcb-tags/index.mjs?raw";

const baseUrl = process.env.POSTGRES_URL;
const fixture = `/tmp/sdt-g121-fixture-${randomBytes(5).toString("hex")}.json`;
const correction = `/tmp/sdt-g121-correction-${randomBytes(5).toString("hex")}.json`;
const inputBytes = Buffer.from(inputSource as string, "utf8");
const correctionBytes = Buffer.from(correctionSource as string, "utf8");
const inputSha = `sha256:${createHash("sha256").update(inputBytes).digest("hex")}`;
const correctionSha = `sha256:${createHash("sha256").update(correctionBytes).digest("hex")}`;
type FixtureInput = {
  serviceId: string;
  seal: { contentDigest: string; sealedAtMs: number };
  health: { status: string; lastFullScanAtMs: number; openFindingCount: number; coveredMembershipCount: number };
  summary: { committedMembershipCount: number };
  events: Array<{ record: { serviceId: string; id: string; sortableUniqueId: string; eventType: string; payload: string; tags: string[]; timestamp: string; causationId: string | null; correlationId: string | null; executedUser: string | null }; digest: { eventDigest: string }; committedMembership: string[] }>;
};
const input = JSON.parse(inputBytes.toString("utf8")) as FixtureInput;
let databaseUrl: string;
let databaseName: string;
let db: ReturnType<typeof postgres>;
const temporaryFiles: string[] = [];

function adminUrl(value: string): string { const url = new URL(value); url.pathname = "/postgres"; return url.toString(); }
async function run(args: string[]) { const previous = process.env.POSTGRES_URL; process.env.POSTGRES_URL = databaseUrl; try { return await runCommand(args); } finally { if (previous === undefined) delete process.env.POSTGRES_URL; else process.env.POSTGRES_URL = previous; } }
async function resetTarget() { await db.unsafe("DROP TABLE IF EXISTS dcb_tag_rebuild_provenance; DELETE FROM dcb_tags;"); const event = input.events[0].record; await db`DELETE FROM dcb_events WHERE "ServiceId" = ${input.serviceId}`; await db.unsafe(`INSERT INTO dcb_events ("ServiceId","Id","SortableUniqueId","EventType","Payload","Tags","Timestamp","CausationId","CorrelationId","ExecutedUser") VALUES ('${event.serviceId}','${event.id}','${event.sortableUniqueId}','${event.eventType}','${event.payload}'::json,'${JSON.stringify(event.tags)}'::jsonb,'${event.timestamp}',NULL,NULL,NULL)`); }
function digestBytes(bytes: Uint8Array): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function makeInput(change: (value: FixtureInput) => void): { path: string; bytes: Uint8Array; value: FixtureInput } {
  const value = structuredClone(input); change(value); value.seal.contentDigest = ""; value.seal.contentDigest = digestBytes(Buffer.from(canonicalJson(value), "utf8"));
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"); const path = `/tmp/sdt-g121-mutated-${randomBytes(5).toString("hex")}.json`; writeFileSync(path, bytes); temporaryFiles.push(path); return { path, bytes, value };
}
function addReceiptPath(): string { const path = `/tmp/sdt-g121-receipt-${randomBytes(5).toString("hex")}.json`; temporaryFiles.push(path); return path; }
async function rebuildWrites(): Promise<{ tags: number; provenance: number }> { const tags = await db`SELECT COUNT(*)::int AS count FROM dcb_tags WHERE "ServiceId" = ${input.serviceId}`; const provenance = await db`SELECT COUNT(*)::int AS count FROM dcb_tag_rebuild_provenance WHERE service_id = ${input.serviceId}`.catch((error: unknown) => { if (typeof error === "object" && error !== null && "code" in error && error.code === "42P01") return [{ count: 0 }]; throw error; }); return { tags: Number(tags[0].count), provenance: Number(provenance[0].count) }; }
async function createProvenanceTable(): Promise<void> { await db.unsafe("CREATE TABLE dcb_tag_rebuild_provenance (rebuild_id TEXT PRIMARY KEY, service_id VARCHAR(64) NOT NULL UNIQUE, contract_version INTEGER NOT NULL CHECK (contract_version = 1), input_file_sha256 TEXT NOT NULL CHECK (input_file_sha256 ~ '^sha256:[0-9a-f]{64}$'), input_content_digest TEXT NOT NULL CHECK (input_content_digest ~ '^sha256:[0-9a-f]{64}$'), correction_manifest_sha256 TEXT NULL CHECK (correction_manifest_sha256 IS NULL OR correction_manifest_sha256 ~ '^sha256:[0-9a-f]{64}$'), correction_manifest_json TEXT NULL, applied_at TIMESTAMPTZ NOT NULL, receipt_sha256 TEXT NOT NULL CHECK (receipt_sha256 ~ '^sha256:[0-9a-f]{64}$'), receipt_json TEXT NOT NULL, CHECK ((correction_manifest_sha256 IS NULL) = (correction_manifest_json IS NULL)))"); }
async function waitForLock(predicate: (rows: Array<Record<string, unknown>>) => boolean): Promise<void> { for (let attempt = 0; attempt < 200; attempt += 1) { const rows = await db.unsafe(`SELECT l.pid, l.locktype, l.mode, l.granted, a.wait_event_type, a.query FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE a.datname = current_database()`) as Array<Record<string, unknown>>; if (predicate(rows)) return; await new Promise<void>((resolve) => setImmediate(resolve)); } throw new Error("timed out waiting for pg_locks stage"); }

describe("SDT-G121 PostgreSQL tag rebuild", () => {
  beforeAll(async () => {
    if (!baseUrl) throw new Error("POSTGRES_URL is required");
    writeFileSync(fixture, inputBytes); writeFileSync(correction, correctionBytes);
    databaseName = `sdt_g121_${randomBytes(5).toString("hex")}`;
    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${databaseName}`); await admin.end();
    const url = new URL(baseUrl); url.pathname = `/${databaseName}`; databaseUrl = url.toString(); db = postgres(databaseUrl, { max: 1, fetch_types: false });
    await db.unsafe(`
      CREATE TABLE dcb_events (
        "ServiceId" varchar(64) NOT NULL, "Id" uuid NOT NULL,
        "SortableUniqueId" varchar(100) NOT NULL, "EventType" text NOT NULL,
        "Payload" json NOT NULL, "Tags" jsonb NOT NULL, "Timestamp" timestamptz NOT NULL,
        "CausationId" text NULL, "CorrelationId" text NULL, "ExecutedUser" text NULL,
        CONSTRAINT "PK_dcb_events" PRIMARY KEY ("ServiceId", "Id")
      );
      CREATE TABLE dcb_tags (
        "Id" bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        "ServiceId" varchar(64) NOT NULL, "Tag" text NOT NULL, "TagGroup" text NOT NULL,
        "EventType" text NOT NULL, "SortableUniqueId" varchar(100) NOT NULL,
        "EventId" uuid NOT NULL, "CreatedAt" timestamptz NOT NULL
      );
    `);
    const event = input.events[0].record;
    await db.unsafe(`INSERT INTO dcb_events ("ServiceId","Id","SortableUniqueId","EventType","Payload","Tags","Timestamp","CausationId","CorrelationId","ExecutedUser") VALUES ('${event.serviceId}','${event.id}','${event.sortableUniqueId}','${event.eventType}','${event.payload}'::json,'${JSON.stringify(event.tags)}'::jsonb,'${event.timestamp}',NULL,NULL,NULL)`);
  });
  afterAll(async () => { await db?.end({ timeout: 5 }); if (baseUrl && databaseName) { const admin = postgres(adminUrl(baseUrl), { max: 1 }); await admin.unsafe(`DROP DATABASE ${databaseName} WITH (FORCE)`); await admin.end({ timeout: 5 }); } });

  it("keeps a partial declared set partial in a read-only dry run", async () => {
    await resetTarget(); const result = await run(["--input", fixture]); expect(result).toContain('"membershipCount":0'); expect(result).toContain('"tag":"room:room-1"'); expect(result).not.toContain("reservation:res-1");
    await expect(db`SELECT COUNT(*)::int AS count FROM dcb_tags`).resolves.toEqual([{ count: 0 }]);
  });

  it("applies only committed membership, then reruns byte-for-byte", async () => {
    await resetTarget(); const receipt = `/tmp/sdt-g121-${randomBytes(5).toString("hex")}.json`;
    const args = ["--input", fixture, "--apply", "--input-sha256", inputSha, "--receipt", receipt]; await run(args); const firstBytes = readFileSync(receipt); expect(JSON.parse(firstBytes.toString()).target.membershipCount).toBe(1); expect(firstBytes.toString()).not.toContain("reservation:res-1"); console.log(`SDT-G121 default receipt sha256:${createHash("sha256").update(firstBytes).digest("hex")}`);
    const count = await db`SELECT COUNT(*)::int AS count FROM dcb_tags`; expect(count[0].count).toBe(1); const stored = await db`SELECT receipt_json, receipt_sha256 FROM dcb_tag_rebuild_provenance WHERE service_id = ${input.serviceId}`; expect(Buffer.from(stored[0].receipt_json, "utf8")).toEqual(firstBytes); expect(stored[0].receipt_sha256).toBe(digestBytes(firstBytes));
    await run(args); expect(readFileSync(receipt)).toEqual(firstBytes); const rerunCount = await db`SELECT COUNT(*)::int AS count FROM dcb_tags`; expect(rerunCount[0].count).toBe(1);
  });

  it("accepts the second tag only through a matching correction digest", async () => {
    await resetTarget(); const receipt = `/tmp/sdt-g121-${randomBytes(5).toString("hex")}.json`; await run(["--input", fixture, "--apply", "--input-sha256", inputSha, "--receipt", receipt, "--correction-manifest", correction, "--correction-sha256", correctionSha]); const receiptBytes = readFileSync(receipt); console.log(`SDT-G121 correction receipt sha256:${createHash("sha256").update(receiptBytes).digest("hex")}`); const rows = await db`SELECT "Tag" AS tag FROM dcb_tags ORDER BY "Tag"`; expect(rows.map((row: { tag: string }) => row.tag)).toEqual(["reservation:res-1", "room:room-1"]);
  });

  it("fails specific digest and health errors before any write", async () => {
    await resetTarget(); await expect(run(["--input", fixture, "--apply", "--input-sha256", "sha256:" + "0".repeat(64), "--receipt", "/tmp/sdt-g121-wrong.json"])).rejects.toThrow(/input file digest mismatch/); await expect(run(["--input", fixture, "--apply", "--input-sha256", inputSha, "--receipt", "/tmp/sdt-g121-wrong-correction.json", "--correction-manifest", correction, "--correction-sha256", "sha256:" + "0".repeat(64)])).rejects.toThrow(/correction file digest mismatch/); expect((await db`SELECT COUNT(*)::int AS count FROM dcb_tags`)[0].count).toBe(0);
    const unhealthy = JSON.stringify({ ...input, health: { ...input.health, status: "UNKNOWN" } }); const path = `/tmp/sdt-g121-unhealthy-${randomBytes(4).toString("hex")}.json`; writeFileSync(path, unhealthy); await expect(run(["--input", path])).rejects.toThrow(/not HEALTHY/); expect((await db`SELECT COUNT(*)::int AS count FROM dcb_tags`)[0].count).toBe(0);
  });

  it("rejects malformed UTF-8 and duplicate object keys before opening PostgreSQL", async () => {
    await resetTarget(); const badUtf8 = `/tmp/sdt-g121-invalid-${randomBytes(4).toString("hex")}.json`; const duplicate = `/tmp/sdt-g121-duplicate-${randomBytes(4).toString("hex")}.json`;
    writeFileSync(badUtf8, Buffer.from([0x7b, 0xff, 0x7d])); writeFileSync(duplicate, inputBytes.toString().replace('"version": 1,\n  "serviceId"', '"version": 1,\n  "version": 1,\n  "serviceId"')); temporaryFiles.push(badUtf8, duplicate);
    await expect(run(["--input", badUtf8])).rejects.toThrow(/not valid UTF-8/); await expect(run(["--input", duplicate])).rejects.toThrow(/duplicate object key version/); await expect(rebuildWrites()).resolves.toEqual({ tags: 0, provenance: 0 });
  });

  it("rejects absent, outside-declared, and ambiguous membership", async () => {
    await resetTarget();
    const absent = makeInput((value) => { value.events[0].committedMembership = []; value.summary.committedMembershipCount = 0; value.health.coveredMembershipCount = 0; });
    const outside = makeInput((value) => { value.events[0].committedMembership = ["not-declared"]; });
    const duplicate = makeInput((value) => { value.events.push(structuredClone(value.events[0])); value.events[1].record.sortableUniqueId = "063923011636102000000000000002"; });
    await expect(run(["--input", absent.path])).rejects.toThrow(/committedMembership must be non-empty/); await expect(run(["--input", outside.path])).rejects.toThrow(/outside declaredTagSet/); await expect(run(["--input", duplicate.path])).rejects.toThrow(/duplicate event identity/); await expect(rebuildWrites()).resolves.toEqual({ tags: 0, provenance: 0 });
  });

  it("rejects every unhealthy or stale seal with its specific reason", async () => {
    for (const status of ["UNKNOWN", "FAILED", "STALE", "BLOCK", "UNSETTLED"]) {
      await resetTarget(); const value = makeInput((inputValue) => { inputValue.health.status = status; });
      await expect(run(["--input", value.path])).rejects.toThrow(new RegExp(`status ${status} is not HEALTHY`)); await expect(rebuildWrites()).resolves.toEqual({ tags: 0, provenance: 0 });
    }
    const stale = makeInput((value) => { value.health.lastFullScanAtMs = value.seal.sealedAtMs + 1; }); await expect(run(["--input", stale.path])).rejects.toThrow(/stale at seal time/);
    const findings = makeInput((value) => { value.health.openFindingCount = 1; }); await expect(run(["--input", findings.path])).rejects.toThrow(/open findings/);
  });

  it("refuses schema, logical-row, payload, and tag drift", async () => {
    await resetTarget(); const schema = await db`ALTER TABLE dcb_tags ALTER COLUMN "Tag" TYPE varchar`; await expect(run(["--input", fixture])).rejects.toThrow(/wrong type/); await db`ALTER TABLE dcb_tags ALTER COLUMN "Tag" TYPE text`;
    await db.unsafe(`UPDATE dcb_events SET "Payload" = '{"roomId":"drifted"}'::json WHERE "ServiceId" = '${input.serviceId}'`); await expect(run(["--input", fixture])).rejects.toThrow(/payload bytes/); await db.unsafe(`UPDATE dcb_events SET "Payload" = '${input.events[0].record.payload}'::json WHERE "ServiceId" = '${input.serviceId}'`);
    await db.unsafe(`INSERT INTO dcb_tags ("ServiceId","Tag","TagGroup","EventType","SortableUniqueId","EventId","CreatedAt") VALUES ('${input.serviceId}','orphan','orphan','RoomReserved','${input.events[0].record.sortableUniqueId}','00000000-0000-4000-8000-000000000000',transaction_timestamp())`); await expect(run(["--input", fixture])).rejects.toThrow(/orphan dcb_tags EventId/); await expect(rebuildWrites()).resolves.toEqual({ tags: 1, provenance: 0 }); void schema;
  });

  it("rolls back tag rows and provenance when the insert is rejected", async () => {
    await resetTarget(); await db`ALTER TABLE dcb_tags ADD CONSTRAINT sdt_g121_force_rollback CHECK (false)`; await expect(run(["--input", fixture, "--apply", "--input-sha256", inputSha, "--receipt", addReceiptPath()])).rejects.toThrow(/sdt_g121_force_rollback|check constraint/); await db`ALTER TABLE dcb_tags DROP CONSTRAINT sdt_g121_force_rollback`; await expect(rebuildWrites()).resolves.toEqual({ tags: 0, provenance: 0 });
  });

  it("refuses partial prior state and conflicting receipt paths without rebuild writes", async () => {
    await resetTarget(); const partialReceipt = addReceiptPath(); await db.unsafe(`INSERT INTO dcb_tags ("ServiceId","Tag","TagGroup","EventType","SortableUniqueId","EventId","CreatedAt") VALUES ('${input.serviceId}','room:room-1','room','RoomReserved','${input.events[0].record.sortableUniqueId}','${input.events[0].record.id}',transaction_timestamp())`); await expect(run(["--input", fixture, "--apply", "--input-sha256", inputSha, "--receipt", partialReceipt])).rejects.toThrow(/first apply requires zero target tag rows/); await resetTarget(); const orphanPath = addReceiptPath(); writeFileSync(orphanPath, Buffer.from("different\n")); await expect(run(["--input", fixture, "--apply", "--input-sha256", inputSha, "--receipt", orphanPath])).rejects.toThrow(/receipt path already exists before first apply/); await expect(rebuildWrites()).resolves.toEqual({ tags: 0, provenance: 0 });
  });

  it("observes a writer committed across the advisory-to-table-lock fence", async () => {
    await resetTarget(); await createProvenanceTable(); const writer = postgres(databaseUrl, { max: 1, fetch_types: false }); let applying: Promise<string>;
    await writer.begin(async (transaction: ReturnType<typeof postgres>) => {
      await transaction.unsafe("LOCK TABLE dcb_events IN ROW EXCLUSIVE MODE");
      applying = run(["--input", fixture, "--apply", "--input-sha256", inputSha, "--receipt", addReceiptPath()]);
      await waitForLock((rows) => rows.some((row) => row.locktype === "relation" && row.mode === "ShareRowExclusiveLock" && row.granted === false));
      const event = input.events[0].record; await transaction.unsafe(`INSERT INTO dcb_events ("ServiceId","Id","SortableUniqueId","EventType","Payload","Tags","Timestamp","CausationId","CorrelationId","ExecutedUser") VALUES ('${event.serviceId}','018f9c51-6b74-7f5e-8ca1-0123456789ac','063923011636102000000000000002','RoomReserved','${event.payload}'::json,'${JSON.stringify(event.tags)}'::jsonb,'${event.timestamp}',NULL,NULL,NULL)`);
    }); await expect(applying!).rejects.toThrow(/target event count 2 differs/); await writer.end({ timeout: 5 }); await expect(rebuildWrites()).resolves.toEqual({ tags: 0, provenance: 0 });
  });

  it("waits for an existing table lock without deadlock", async () => {
    await resetTarget(); await createProvenanceTable(); const writer = postgres(databaseUrl, { max: 1, fetch_types: false }); let applying: Promise<string>; await writer.begin(async (transaction: ReturnType<typeof postgres>) => { await transaction.unsafe("LOCK TABLE dcb_events IN ROW EXCLUSIVE MODE"); applying = run(["--input", fixture, "--apply", "--input-sha256", inputSha, "--receipt", addReceiptPath()]); await waitForLock((rows) => rows.some((row) => row.locktype === "relation" && row.mode === "ShareRowExclusiveLock" && row.granted === false)); }); await writer.end({ timeout: 5 }); await expect(applying!).resolves.toMatch(/mode=apply/); await expect(rebuildWrites()).resolves.toEqual({ tags: 1, provenance: 1 });
  });

  it("refuses the old declared-tag executable path", () => { expect(legacySource as string).toMatch(/postgres:tags:rebuild/); });
});
