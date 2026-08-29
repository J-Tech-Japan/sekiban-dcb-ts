// Vite keeps this raw import tied to the committed ordinary development
// migration. Test databases are intentionally recreated when their schema is
// incompatible; no compatibility bridge is hidden in this helper.
// @ts-expect-error Vite raw asset import.
import g44Migration from "../../migrations/d1/g32/0002_g44_global_completeness.sql?raw";

function statements(database: D1Database, sql: string): D1PreparedStatement[] {
  return sql.replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => database.prepare(statement));
}

/** Apply G44 only after the existing G32 new-database baseline is present. */
export async function applyG44D1Migration(database: D1Database): Promise<void> {
  const column = await database.prepare("PRAGMA table_info(dcb_events)").all<{ name: string }>();
  if (column.results.some((row) => row.name === "EventDigest")) return;
  await database.batch(statements(database, g44Migration as string));
}
