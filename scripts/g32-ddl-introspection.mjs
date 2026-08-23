import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();

function fail(message) {
  throw new Error(`g32-ddl-introspection: ${message}`);
}

export function loadEventStoreManifest(path = resolve(root, "contracts/event-store-ddl.json")) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(manifest?.logicalRecord?.fields) || !Array.isArray(manifest?.postgres?.columns) || !Array.isArray(manifest?.cosmos?.applicationFields)) {
    fail("event-store manifest is incomplete");
  }
  return manifest;
}

function expectedPostgresType(type) {
  const varchar = /^varchar\((\d+)\)$/i.exec(type);
  if (varchar !== null) return `character varying(${varchar[1]})`;
  if (type.toLowerCase() === "timestamptz") return "timestamp with time zone";
  return type.toLowerCase();
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Manifest-derived expected metadata for an information_schema/pg_catalog query. */
export function expectedPostgresSchema(manifest) {
  return Object.freeze({
    table: manifest.postgres.table,
    columns: Object.freeze(manifest.postgres.columns.map((column, index) => Object.freeze({
      name: column.name,
      ordinal: index + 1,
      nullable: column.nullable,
      renderedType: expectedPostgresType(column.type),
    }))),
    primaryKey: Object.freeze({ name: manifest.postgres.primaryKey.name, columns: [...manifest.postgres.primaryKey.columns] }),
    indexes: Object.freeze(manifest.postgres.indexes.map((index) => Object.freeze({ name: index.name, columns: [...index.columns] }))),
  });
}

/**
 * Compare already-introspected PostgreSQL metadata against the manifest. The
 * query and the expected table are separate: this checker never reads schema
 * source or a hand-written parallel DDL table.
 */
export function assertPostgresManifestIntrospection(manifest, actual) {
  const expected = expectedPostgresSchema(manifest);
  const columns = actual?.columns;
  if (!Array.isArray(columns) || columns.length !== expected.columns.length) fail("Postgres column count differs from manifest");
  for (const [index, column] of columns.entries()) {
    const expectedColumn = expected.columns[index];
    if (column?.name !== expectedColumn.name || Number(column?.ordinal) !== expectedColumn.ordinal || Boolean(column?.nullable) !== expectedColumn.nullable || String(column?.renderedType).toLowerCase() !== expectedColumn.renderedType) {
      fail(`Postgres column differs at ordinal ${index + 1}`);
    }
  }
  if (!same(actual?.primaryKey, expected.primaryKey)) fail("Postgres primary key differs from manifest");
  if (!same(actual?.indexes, expected.indexes)) fail("Postgres index name, order, or columns differ from manifest");
  if (!Array.isArray(actual?.forbidden) || actual.forbidden.length !== 0) fail(`Postgres forbidden logical DDL found: ${(actual?.forbidden ?? []).join(",")}`);
  return expected;
}

/** Runs information_schema plus pg_catalog against the live Postgres schema. */
export async function introspectPostgresEventStore(sql, manifest) {
  const table = manifest.postgres.table;
  const columns = await sql`
    SELECT c.column_name AS name,
           c.ordinal_position AS ordinal,
           (c.is_nullable = 'YES') AS nullable,
           pg_catalog.format_type(a.atttypid, a.atttypmod) AS "renderedType"
      FROM information_schema.columns c
      JOIN pg_catalog.pg_class cls ON cls.relname = c.table_name
      JOIN pg_catalog.pg_namespace ns ON ns.oid = cls.relnamespace AND ns.nspname = c.table_schema
      JOIN pg_catalog.pg_attribute a ON a.attrelid = cls.oid AND a.attname = c.column_name AND a.attnum > 0 AND NOT a.attisdropped
     WHERE c.table_schema = current_schema() AND c.table_name = ${table}
     ORDER BY c.ordinal_position`;
  const indexes = await sql`
    SELECT idx.relname AS name,
           array_agg(att.attname ORDER BY key.ordinality) AS columns,
           i.indisprimary AS primary
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class tbl ON tbl.oid = i.indrelid
      JOIN pg_catalog.pg_namespace ns ON ns.oid = tbl.relnamespace
      JOIN pg_catalog.pg_class idx ON idx.oid = i.indexrelid
      JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS key(attnum, ordinality) ON true
      JOIN pg_catalog.pg_attribute att ON att.attrelid = tbl.oid AND att.attnum = key.attnum
     WHERE ns.nspname = current_schema() AND tbl.relname = ${table}
     GROUP BY idx.relname, i.indisprimary
     ORDER BY idx.relname`;
  const defaults = await sql`
    SELECT column_name AS name
      FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = ${table} AND column_default IS NOT NULL
     ORDER BY ordinal_position`;
  const checks = await sql`
    SELECT con.conname AS name
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class tbl ON tbl.oid = con.conrelid
      JOIN pg_catalog.pg_namespace ns ON ns.oid = tbl.relnamespace
     WHERE ns.nspname = current_schema() AND tbl.relname = ${table} AND con.contype IN ('u', 'c')
     ORDER BY con.conname`;
  const primary = indexes.find((index) => index.primary === true);
  const nonPrimary = indexes.filter((index) => index.primary !== true).map((index) => ({ name: index.name, columns: [...index.columns] }));
  const actual = {
    columns: columns.map((column) => ({ name: column.name, ordinal: Number(column.ordinal), nullable: Boolean(column.nullable), renderedType: column.renderedType })),
    primaryKey: primary === undefined ? undefined : { name: primary.name, columns: [...primary.columns] },
    indexes: nonPrimary,
    forbidden: [...defaults.map((row) => `DEFAULT:${row.name}`), ...checks.map((row) => `CONSTRAINT:${row.name}`)],
  };
  return { actual, expected: assertPostgresManifestIntrospection(manifest, actual) };
}

function cosmosApplicationFields(manifest) {
  const fromLogicalRecord = manifest.logicalRecord.fields.map((field) => field.cosmos);
  if (!same(fromLogicalRecord, manifest.cosmos.applicationFields)) fail("Cosmos application fields drift from logical-record manifest");
  if (new Set(manifest.cosmos.applicationFields).size !== manifest.cosmos.applicationFields.length) fail("Cosmos application fields are not unique");
  if (manifest.cosmos.applicationFields.some((field) => manifest.cosmos.providerManagedReadonlyFields.includes(field))) {
    fail("Cosmos provider-managed field was promoted to logical application field");
  }
  return fromLogicalRecord;
}

/** Full-field Cosmos document classifier; provider metadata is never logical data. */
export function assertCosmosManifestDocument(manifest, document) {
  const applicationFields = cosmosApplicationFields(manifest);
  const expectedKeys = ["pk", ...applicationFields].sort();
  const actualKeys = Object.keys(document ?? {}).sort();
  const readonly = new Set(manifest.cosmos.providerManagedReadonlyFields);
  const applicationKeys = actualKeys.filter((key) => !readonly.has(key));
  if (!same(applicationKeys, expectedKeys)) fail(`Cosmos application fields differ from manifest: expected ${expectedKeys.join(",")}, received ${applicationKeys.join(",")}`);
  for (const field of manifest.cosmos.providerManagedReadonlyFields) {
    if (Object.hasOwn(document, field) && applicationFields.includes(field)) fail(`Cosmos provider field ${field} was treated as logical data`);
  }
  if (typeof document.pk !== "string" || document.pk !== `${document.serviceId}|${document.id}`) fail("Cosmos pk is not the manifest ServiceId|Id value");
  return Object.freeze({ applicationFields: Object.freeze(applicationFields), providerManagedReadonlyFields: Object.freeze([...readonly]) });
}

export function runSelfTest() {
  const manifest = loadEventStoreManifest();
  const expected = expectedPostgresSchema(manifest);
  assertPostgresManifestIntrospection(manifest, { ...expected, forbidden: [] });
  let snakeCaseRed = false;
  try {
    assertPostgresManifestIntrospection(manifest, { ...expected, columns: [{ ...expected.columns[0], name: "service_id" }, ...expected.columns.slice(1)], forbidden: [] });
  } catch (error) { snakeCaseRed = String(error).includes("column differs"); }
  if (!snakeCaseRed) fail("PascalCase-to-snake_case mutation unexpectedly passed");
  let jsonTypeRed = false;
  try {
    assertPostgresManifestIntrospection(manifest, {
      ...expected,
      columns: expected.columns.map((column) => column.name === "Payload" ? { ...column, renderedType: "jsonb" } : column),
      forbidden: [],
    });
  } catch (error) { jsonTypeRed = String(error).includes("column differs"); }
  if (!jsonTypeRed) fail("Postgres json-to-jsonb mutation unexpectedly passed");
  let nullableRed = false;
  try {
    assertPostgresManifestIntrospection(manifest, {
      ...expected,
      columns: expected.columns.map((column) => column.name === "CausationId" ? { ...column, nullable: false } : column),
      forbidden: [],
    });
  } catch (error) { nullableRed = String(error).includes("column differs"); }
  if (!nullableRed) fail("Postgres nullable mutation unexpectedly passed");
  let indexNameRed = false;
  try {
    assertPostgresManifestIntrospection(manifest, {
      ...expected,
      indexes: expected.indexes.map((index, position) => position === 0 ? { ...index, name: "wrong_index_name" } : index),
      forbidden: [],
    });
  } catch (error) { indexNameRed = String(error).includes("index name"); }
  if (!indexNameRed) fail("Postgres index-name mutation unexpectedly passed");
  let indexOrderRed = false;
  try {
    assertPostgresManifestIntrospection(manifest, {
      ...expected,
      indexes: expected.indexes.map((index) => index.columns.length > 1 ? { ...index, columns: [...index.columns].reverse() } : index),
      forbidden: [],
    });
  } catch (error) { indexOrderRed = String(error).includes("index name"); }
  if (!indexOrderRed) fail("Postgres index-column-order mutation unexpectedly passed");
  const document = Object.fromEntries([
    ["pk", "service|event"],
    ...manifest.cosmos.applicationFields.map((field) => [field, field === "serviceId" ? "service" : field === "id" ? "event" : field === "tags" ? [] : "value"]),
  ]);
  assertCosmosManifestDocument(manifest, document);
  let unknownRed = false;
  try { assertCosmosManifestDocument(manifest, { ...document, droppedApplicationField: "unexpected" }); } catch (error) { unknownRed = String(error).includes("application fields"); }
  if (!unknownRed) fail("unknown Cosmos application field mutation unexpectedly passed");
  let dropRed = false;
  try {
    const withoutId = Object.fromEntries(Object.entries(document).filter(([field]) => field !== "id"));
    assertCosmosManifestDocument(manifest, withoutId);
  } catch (error) { dropRed = String(error).includes("application fields"); }
  if (!dropRed) fail("dropped Cosmos application field mutation unexpectedly passed");
  let etagRed = false;
  try {
    assertCosmosManifestDocument({ ...manifest, cosmos: { ...manifest.cosmos, applicationFields: [...manifest.cosmos.applicationFields, "_etag"] } }, document);
  } catch (error) { etagRed = /drift|provider-managed/.test(String(error)); }
  if (!etagRed) fail("Cosmos _etag logical-promotion mutation unexpectedly passed");
  return {
    postgresColumns: expected.columns.length,
    cosmosApplicationFields: manifest.cosmos.applicationFields.length,
    mutations: [
      "snake-case",
      "json-to-jsonb",
      "nullable",
      "index-name",
      "index-column-order",
      "unknown-application-field",
      "dropped-application-field",
      "etag-logical-promotion",
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(runSelfTest()));
}
