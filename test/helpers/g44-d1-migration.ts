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
// @ts-expect-error Vite raw asset import.
import g60PostAdmissionMigration from "../../migrations/d1/g32/0007_g60_post_admission_decomposition.sql?raw";
// @ts-expect-error Vite raw asset import.
import g60UnsafeWriterMigration from "../../migrations/d1/g32/0008_g60_unsafe_writer_boundaries.sql?raw";
// @ts-expect-error Vite raw asset import.
import g65AdmissionMigration from "../../migrations/d1/g32/0009_g65_admission_attempts.sql?raw";
// @ts-expect-error Vite raw asset import.
import g65DirectRingMigration from "../../migrations/d1/g32/0010_g65_direct_rings.sql?raw";
// @ts-expect-error Vite raw asset import.
import g67SafeLanePassMigration from "../../migrations/d1/g32/0011_g67_safe_lane_passes.sql?raw";
// @ts-expect-error Vite raw asset import.
import g67SafeLanePassOwnershipMigration from "../../migrations/d1/g32/0012_g67_safe_lane_pass_ownership.sql?raw";
// @ts-expect-error Vite raw migration import.
import g67SafeLaneCatchUpObservationsMigration from "../../migrations/d1/g32/0013_g67_safe_lane_catch_up_observations.sql?raw";
// @ts-expect-error Vite raw migration import.
import g67SafeLaneFenceExpiryMigration from "../../migrations/d1/g32/0014_g67_safe_lane_fence_expiry.sql?raw";

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
  const hopSubmeasurements = await database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'serialized_dcb_hop_submeasurements'",
  ).first<{ name: string }>();
  if (hopSubmeasurements === null || hopSubmeasurements === undefined) {
    await database.batch(statements(database, g60PostAdmissionMigration as string));
  }
  const unsafeWriterBoundaries = await database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'serialized_dcb_unsafe_writer_boundaries'",
  ).first<{ name: string }>();
  if (unsafeWriterBoundaries === null || unsafeWriterBoundaries === undefined) {
    await database.batch(statements(database, g60UnsafeWriterMigration as string));
  }
  const admissionAttempts = await database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'serialized_dcb_g65_admission_attempts'",
  ).first<{ name: string }>();
  if (admissionAttempts === null || admissionAttempts === undefined) {
    await database.batch(statements(database, g65AdmissionMigration as string));
  }
  const directRings = await database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'serialized_dcb_g65_direct_rings'",
  ).first<{ name: string }>();
  if (directRings === null || directRings === undefined) {
    await database.batch(statements(database, g65DirectRingMigration as string));
  }
  const safeLanePasses = await database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'serialized_dcb_safe_lane_passes'",
  ).first<{ name: string }>();
  if (safeLanePasses === null || safeLanePasses === undefined) {
    await database.batch(statements(database, g67SafeLanePassMigration as string));
  }
  const safeLanePassColumns = await database.prepare(
    "PRAGMA table_info(serialized_dcb_safe_lane_passes)",
  ).all<{ name: string }>();
  if (!safeLanePassColumns.results.some((row) => row.name === "delivery_event_id")) {
    await database.batch(statements(database, g67SafeLanePassOwnershipMigration as string));
  }
  const safeLanePassObservationColumns = await database.prepare(
    "PRAGMA table_info(serialized_dcb_safe_lane_passes)",
  ).all<{ name: string }>();
  if (!safeLanePassObservationColumns.results.some((row) => row.name === "delivery_suid")) {
    await database.batch(statements(database, g67SafeLaneCatchUpObservationsMigration as string));
  }
  const safeLanePassFenceExpiryColumns = await database.prepare(
    "PRAGMA table_info(serialized_dcb_safe_lane_passes)",
  ).all<{ name: string }>();
  if (!safeLanePassFenceExpiryColumns.results.some((row) => row.name === "stop_deadline_at")) {
    await database.batch(statements(database, g67SafeLaneFenceExpiryMigration as string));
  }
}
