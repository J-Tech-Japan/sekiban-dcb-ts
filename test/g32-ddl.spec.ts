import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
// @ts-expect-error Raw migration is the new-database D1 authority.
import g32Migration from "../migrations/d1/g32/0001_dcb_events.sql?raw";
// @ts-expect-error Contract manifest is deliberately data, not a hand-written test table.
import manifestSource from "../contracts/event-store-ddl.json?raw";

type SqliteMasterRow = { readonly type: string; readonly name: string; readonly sql: string | null };
type Column = { readonly name: string; readonly type: string; readonly notnull: number; readonly pk: number };

const manifest = JSON.parse(manifestSource as string) as {
  readonly d1: {
    readonly columns: readonly { readonly name: string; readonly type: string; readonly nullable: boolean }[];
    readonly indexes: readonly { readonly name: string; readonly columns: readonly string[] }[];
  };
  readonly sidecar: { readonly table: string; readonly primaryKey: readonly string[]; readonly columns: readonly string[] };
};

let migration: Promise<D1Database> | undefined;

async function migratedD1(): Promise<D1Database> {
  if (migration !== undefined) return migration;
  migration = (async () => {
  const database = (env as unknown as { readonly D1?: D1Database }).D1;
  if (database === undefined) throw new Error("G32 DDL oracle needs the Miniflare D1 binding");
  const statements = (g32Migration as string)
    .replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  await database.batch(statements.map((statement) => database.prepare(statement)));
  return database;
  })();
  return migration;
}

describe("SDT-G32 D1 logical-record DDL", () => {
  it("introspects the new baseline against the immutable C# logical record contract", async () => {
    const database = await migratedD1();
    const columns = (await database.prepare("PRAGMA table_info(dcb_events)").all<Column>()).results;
    expect(columns.map((column) => ({ name: column.name, type: column.type, nullable: column.notnull === 0 }))).toEqual(
      manifest.d1.columns.map((column) => ({
        name: column.name,
        // SQLite exposes affinity rather than the COLLATE clause in PRAGMA.
        type: column.type.replace(" COLLATE BINARY", ""),
        nullable: column.nullable,
      })),
    );
    expect(columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name)).toEqual(["ServiceId", "Id"]);

    const objects = (await database.prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE tbl_name IN ('dcb_events', 'dcb_event_ops') ORDER BY type, name",
    ).all<SqliteMasterRow>()).results;
    const tableSql = objects.find((object) => object.type === "table" && object.name === "dcb_events")?.sql ?? "";
    expect(tableSql).toContain('CONSTRAINT "PK_dcb_events" PRIMARY KEY ("ServiceId", "Id")');
    expect(tableSql).toContain('"SortableUniqueId" TEXT NOT NULL COLLATE BINARY');
    expect(tableSql).not.toMatch(/UNIQUE\s*\([^)]*SortableUniqueId/i);
    for (const index of manifest.d1.indexes) {
      const sql = objects.find((object) => object.type === "index" && object.name === index.name)?.sql ?? "";
      expect(sql).toContain(`CREATE INDEX "${index.name}" ON dcb_events`);
      for (const column of index.columns) expect(sql).toContain(`"${column}"`);
    }
    const sidecarSql = objects.find((object) => object.type === "table" && object.name === manifest.sidecar.table)?.sql ?? "";
    for (const column of manifest.sidecar.columns) expect(sidecarSql).toContain(`"${column}"`);
    expect(sidecarSql).toContain('PRIMARY KEY ("ServiceId", "Id")');
  });

  it("allows a same-SUID second logical row so collisions remain a typed store concern", async () => {
    const database = await migratedD1();
    const values = [
      "g32-ddl",
      "018f9c51-6b74-7f5e-8ca1-0123456789ab",
      "063923011636102000000000000001",
      "RoomCreated",
      "{\"roomId\":\"room-1\"}",
      "[\"room:room-1\"]",
      "2026-08-22T17:00:00.123Z",
      null,
      null,
      null,
    ];
    await database.prepare(
      'INSERT INTO dcb_events ("ServiceId", "Id", "SortableUniqueId", "EventType", "Payload", "Tags", "Timestamp", "CausationId", "CorrelationId", "ExecutedUser") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(...values).run();
    await expect(database.prepare(
      'INSERT INTO dcb_events ("ServiceId", "Id", "SortableUniqueId", "EventType", "Payload", "Tags", "Timestamp", "CausationId", "CorrelationId", "ExecutedUser") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(...values.slice(0, 1), "018f9c51-6b74-7f5e-8ca1-0123456789ac", ...values.slice(2)).run()).resolves.toBeDefined();
  });
});
