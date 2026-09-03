// Vite keeps this raw import tied to the committed ordinary development
// migration. Test databases are intentionally recreated when their schema is
// incompatible; no compatibility bridge is hidden in this helper.
// @ts-expect-error Vite raw asset import.
import g44Migration from "../../migrations/d1/g32/0002_g44_global_completeness.sql?raw";
// @ts-expect-error Vite raw asset import.
import g58Migration from "../../migrations/d1/g32/0003_g58_safe_lane_health.sql?raw";
// @ts-expect-error Vite raw asset import.
import g58HistoryMigration from "../../migrations/d1/g32/0005_g58_safe_lane_history.sql?raw";
// @ts-expect-error Vite raw asset import.
import g60HopMigration from "../../migrations/d1/g32/0006_g60_durable_hop_measurements.sql?raw";

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
  if (!column.results.some((row) => row.name === "EventDigest")) {
    await database.batch(statements(database, g44Migration as string));
  }
  const health = await database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'serialized_dcb_safe_lane_health'",
  ).first<{ name: string }>();
  if (health === null || health === undefined) {
    await database.batch(statements(database, g58Migration as string));
  }
  const history = await database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'serialized_dcb_safe_lane_history'",
  ).first<{ name: string }>();
  if (history === null || history === undefined) {
    await database.batch(statements(database, g58HistoryMigration as string));
  }
  const hopMeasurements = await database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'serialized_dcb_hop_measurements'",
  ).first<{ name: string }>();
  if (hopMeasurements === null || hopMeasurements === undefined) {
    await database.batch(statements(database, g60HopMigration as string));
  }
}
