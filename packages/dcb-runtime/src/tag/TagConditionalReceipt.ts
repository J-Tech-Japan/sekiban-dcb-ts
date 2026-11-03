/**
 * First-use conditional receipt inside the existing Tag SQLite database.
 * The table shape is the conditional extension's schema v1. Base schema
 * version 3 is not part of this module and must stay unchanged.
 */
import { assertSortableUniqueId, compareSortableUniqueId } from "../allocator/SortableUniqueId";
import { assertCanonicalEventType } from "../eventIdentity";
import { CANONICAL_UTC_TIMESTAMP_PATTERN, isUuidV7 } from "../eventRecord";
import { canonicalDeclaredTagSet, eventDigestHex } from "./EventDigest";

export const TAG_CONDITIONAL_RECEIPT_DDL = `CREATE TABLE tag_conditional_receipt (
  service_id TEXT NOT NULL,
  normalized_key TEXT NOT NULL,
  operation_fingerprint TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_digest TEXT NOT NULL,
  PRIMARY KEY (service_id, normalized_key),
  UNIQUE (service_id, event_id),
  FOREIGN KEY (service_id, event_id)
    REFERENCES tag_event(service_id, event_id) ON DELETE RESTRICT
)`;

export const CONDITIONAL_RECEIPT_INSERT_SQL = `INSERT INTO tag_conditional_receipt (
  service_id,
  normalized_key,
  operation_fingerprint,
  event_id,
  event_digest
) VALUES (?, ?, ?, ?, ?)`;

export const CONDITIONAL_APPEND_FAULTS = [
  "after-event",
  "after-membership",
  "after-outbox",
  "after-head",
  "after-conditional-receipt",
  "after-commit-receipt",
  "duplicate-receipt",
] as const;

export type ConditionalAppendFault = (typeof CONDITIONAL_APPEND_FAULTS)[number];

export class ConditionalReceiptUnsupported extends Error {
  constructor(message = "conditional receipt schema is unsupported") {
    super(message);
    this.name = "ConditionalReceiptUnsupported";
  }
}

export class ConditionalReceiptUniquenessFault extends Error {
  constructor() {
    super("conditional receipt uniqueness failed");
    this.name = "ConditionalReceiptUniquenessFault";
  }
}

export class ConditionalAppendCrash extends Error {
  readonly fault: ConditionalAppendFault;

  constructor(fault: ConditionalAppendFault) {
    super(`conditional append crash:${fault}`);
    this.name = "ConditionalAppendCrash";
    this.fault = fault;
  }
}

export interface ConditionalResolveBody {
  readonly serviceId: string;
  readonly tag: string;
  readonly normalizedKey: string;
  readonly operationFingerprint: string;
}

export interface ConditionalCandidateFacts {
  readonly attemptId: string;
  readonly epoch: number;
  readonly eventId: string;
  readonly suid: string;
  readonly payload: string;
  readonly eventTags: readonly [string];
  readonly allocatorLineageId: string;
  readonly eventType: string;
  readonly provenance: "g32";
  readonly timestamp: string;
}

export interface ConditionalAppendBody extends ConditionalResolveBody {
  readonly candidate: ConditionalCandidateFacts;
  readonly fault?: ConditionalAppendFault;
}

export interface ConditionalWinnerFacts {
  readonly serviceId: string;
  readonly tag: string;
  readonly normalizedKey: string;
  readonly operationFingerprint: string;
  readonly eventId: string;
  readonly suid: string;
  readonly payload: string;
  readonly eventType: string;
  readonly attemptId: string;
  readonly timestamp: string;
  readonly provenance: "g32";
  readonly allocatorLineageId: string;
  readonly eventDigest: string;
}

export type ConditionalTerminalRead =
  | { readonly kind: "absent" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "corrupt" }
  | { readonly kind: "winner"; readonly facts: ConditionalWinnerFacts };

interface SqlCursor {
  toArray(): SqlCellRow[];
  one(): SqlCellRow;
}

export interface ConditionalSqlExecutor {
  exec(query: string, ...bindings: unknown[]): SqlCursor;
}

export interface ConditionalSyncStorage {
  readonly sql?: ConditionalSqlExecutor;
  transactionSync?: (closure: () => void) => void;
}

type SqlCell = string | number | bigint | null | ArrayBuffer;
type SqlCellRow = Record<string, SqlCell>;

const FINGERPRINT = /^[0-9a-f]{64}$/;
const RESOLVE_KEYS = ["serviceId", "tag", "normalizedKey", "operationFingerprint"] as const;
const APPEND_KEYS = [...RESOLVE_KEYS, "candidate"] as const;
const CANDIDATE_KEYS = [
  "attemptId",
  "epoch",
  "eventId",
  "suid",
  "payload",
  "eventTags",
  "allocatorLineageId",
  "eventType",
  "provenance",
  "timestamp",
] as const;

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cellText(value: SqlCell | undefined, label: string): string {
  if (typeof value !== "string") throw new ConditionalReceiptUnsupported(label);
  return value;
}

function cellNumber(value: SqlCell | undefined, label: string): number {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ConditionalReceiptUnsupported(label);
    return Number(value);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ConditionalReceiptUnsupported(label);
  return value;
}

function rowsOf(sql: ConditionalSqlExecutor, query: string, ...bindings: unknown[]): SqlCellRow[] {
  return sql.exec(query, ...bindings).toArray();
}

function tableMaster(sql: ConditionalSqlExecutor): SqlCellRow | undefined {
  const rows = rowsOf(
    sql,
    "SELECT type, name, sql FROM sqlite_master WHERE name = ?",
    "tag_conditional_receipt",
  ).filter((row) => row.type === "table");
  if (rows.length > 1) throw new ConditionalReceiptUnsupported("duplicate conditional receipt table");
  return rows[0];
}

function assertIndexColumns(sql: ConditionalSqlExecutor, indexName: string, expected: readonly string[]): void {
  const columns = rowsOf(sql, `PRAGMA index_info(${JSON.stringify(indexName)})`);
  const ordered = [...columns].sort((left, right) => cellNumber(left.seqno, "seqno") - cellNumber(right.seqno, "seqno"));
  if (ordered.length !== expected.length) throw new ConditionalReceiptUnsupported("conditional receipt index columns");
  ordered.forEach((row, index) => {
    if (cellText(row.name, "index column") !== expected[index]) {
      throw new ConditionalReceiptUnsupported("conditional receipt index column order");
    }
  });
}

export function assertConditionalReceiptShape(sql: ConditionalSqlExecutor): void {
  const master = tableMaster(sql);
  if (master === undefined) throw new ConditionalReceiptUnsupported("conditional receipt table is absent");
  if (master.type !== "table" || master.name !== "tag_conditional_receipt") {
    throw new ConditionalReceiptUnsupported("conditional receipt master identity");
  }
  const storedSql = master.sql;
  if (typeof storedSql !== "string" || normalizeSql(storedSql) !== normalizeSql(TAG_CONDITIONAL_RECEIPT_DDL)) {
    throw new ConditionalReceiptUnsupported("conditional receipt sql");
  }

  const columns = rowsOf(sql, "PRAGMA table_info('tag_conditional_receipt')");
  const expectedColumns = [
    ["service_id", 1],
    ["normalized_key", 2],
    ["operation_fingerprint", 0],
    ["event_id", 0],
    ["event_digest", 0],
  ] as const;
  if (columns.length !== expectedColumns.length) throw new ConditionalReceiptUnsupported("conditional receipt columns");
  columns.forEach((row, index) => {
    const [name, pk] = expectedColumns[index]!;
    if (cellNumber(row.cid, "cid") !== index) throw new ConditionalReceiptUnsupported("conditional receipt column order");
    if (cellText(row.name, "name") !== name) throw new ConditionalReceiptUnsupported("conditional receipt column name");
    if (cellText(row.type, "type").toUpperCase() !== "TEXT") throw new ConditionalReceiptUnsupported("conditional receipt column type");
    if (cellNumber(row.notnull, "notnull") !== 1) throw new ConditionalReceiptUnsupported("conditional receipt nullability");
    if (row.dflt_value !== null) throw new ConditionalReceiptUnsupported("conditional receipt default");
    if (cellNumber(row.pk, "pk") !== pk) throw new ConditionalReceiptUnsupported("conditional receipt primary key");
  });

  const indexes = rowsOf(sql, "PRAGMA index_list('tag_conditional_receipt')");
  if (indexes.length !== 2) throw new ConditionalReceiptUnsupported("conditional receipt indexes");
  let sawPrimary = false;
  let sawUnique = false;
  for (const index of indexes) {
    if (cellNumber(index.unique, "unique") !== 1) throw new ConditionalReceiptUnsupported("conditional receipt index uniqueness");
    if (cellNumber(index.partial, "partial") !== 0) throw new ConditionalReceiptUnsupported("conditional receipt partial index");
    const origin = cellText(index.origin, "origin");
    const name = cellText(index.name, "index name");
    if (origin === "pk") {
      if (sawPrimary) throw new ConditionalReceiptUnsupported("conditional receipt primary index");
      sawPrimary = true;
      assertIndexColumns(sql, name, ["service_id", "normalized_key"]);
    } else if (origin === "u") {
      if (sawUnique) throw new ConditionalReceiptUnsupported("conditional receipt unique index");
      sawUnique = true;
      assertIndexColumns(sql, name, ["service_id", "event_id"]);
    } else {
      throw new ConditionalReceiptUnsupported("conditional receipt extra index");
    }
  }
  if (!sawPrimary || !sawUnique) throw new ConditionalReceiptUnsupported("conditional receipt index origins");

  const foreignKeys = rowsOf(sql, "PRAGMA foreign_key_list('tag_conditional_receipt')");
  if (foreignKeys.length !== 2) throw new ConditionalReceiptUnsupported("conditional receipt foreign key");
  const orderedKeys = [...foreignKeys].sort((left, right) => cellNumber(left.seq, "seq") - cellNumber(right.seq, "seq"));
  const expectedKeys = [
    ["service_id", "service_id"],
    ["event_id", "event_id"],
  ] as const;
  orderedKeys.forEach((row, index) => {
    if (cellNumber(row.id, "fk id") !== cellNumber(orderedKeys[0]?.id, "fk id")) {
      throw new ConditionalReceiptUnsupported("conditional receipt foreign key id");
    }
    if (cellNumber(row.seq, "fk seq") !== index) throw new ConditionalReceiptUnsupported("conditional receipt foreign key order");
    if (cellText(row.table, "fk table") !== "tag_event") throw new ConditionalReceiptUnsupported("conditional receipt foreign table");
    if (cellText(row.from, "fk from") !== expectedKeys[index]?.[0]) throw new ConditionalReceiptUnsupported("conditional receipt foreign key from");
    if (cellText(row.to, "fk to") !== expectedKeys[index]?.[1]) throw new ConditionalReceiptUnsupported("conditional receipt foreign key to");
    if (cellText(row.on_update, "fk update") !== "NO ACTION") throw new ConditionalReceiptUnsupported("conditional receipt update action");
    if (cellText(row.on_delete, "fk delete") !== "RESTRICT") throw new ConditionalReceiptUnsupported("conditional receipt delete action");
    const match = row.match;
    if (match !== null && match !== "NONE") throw new ConditionalReceiptUnsupported("conditional receipt match");
  });

  const triggers = rowsOf(
    sql,
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?",
    "tag_conditional_receipt",
  );
  if (triggers.length !== 0) throw new ConditionalReceiptUnsupported("conditional receipt trigger");
}

export function ensureConditionalReceiptSchema(storage: ConditionalSyncStorage): void {
  const sql = storage.sql;
  if (sql === undefined || typeof sql.exec !== "function" || typeof storage.transactionSync !== "function") {
    throw new ConditionalReceiptUnsupported("Tag SQL storage or transactionSync is unavailable");
  }
  if (tableMaster(sql) !== undefined) {
    assertConditionalReceiptShape(sql);
    return;
  }
  storage.transactionSync(() => {
    if (tableMaster(sql) === undefined) sql.exec(TAG_CONDITIONAL_RECEIPT_DDL);
    assertConditionalReceiptShape(sql);
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function closedKeys(value: Record<string, unknown>, allowed: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return false;
  const names = keys.filter((key): key is string => typeof key === "string");
  if (names.some((key) => !allowed.includes(key) && !optional.includes(key))) return false;
  if (allowed.some((key) => !names.includes(key))) return false;
  return names.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined
      && descriptor.enumerable === true
      && descriptor.get === undefined
      && descriptor.set === undefined
      && "value" in descriptor;
  });
}

function boundedText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (new TextEncoder().encode(value).byteLength > 512) return undefined;
  return value;
}

function parseResolveFields(value: Record<string, unknown>): ConditionalResolveBody | undefined {
  const serviceId = boundedText(value.serviceId);
  const tag = boundedText(value.tag);
  const normalizedKey = boundedText(value.normalizedKey);
  const operationFingerprint = value.operationFingerprint;
  if (
    serviceId === undefined
    || tag === undefined
    || normalizedKey === undefined
    || typeof operationFingerprint !== "string"
    || !FINGERPRINT.test(operationFingerprint)
  ) {
    return undefined;
  }
  return { serviceId, tag, normalizedKey, operationFingerprint };
}

export function parseConditionalResolveBody(value: unknown): ConditionalResolveBody | undefined {
  if (!isPlainRecord(value) || !closedKeys(value, RESOLVE_KEYS)) return undefined;
  return parseResolveFields(value);
}

export function parseConditionalAppendBody(value: unknown): ConditionalAppendBody | undefined {
  if (!isPlainRecord(value) || !closedKeys(value, APPEND_KEYS, ["fault"])) return undefined;
  const identity = parseResolveFields(value);
  if (identity === undefined || !isPlainRecord(value.candidate) || !closedKeys(value.candidate, CANDIDATE_KEYS)) {
    return undefined;
  }
  const candidate = value.candidate;
  const attemptId = boundedText(candidate.attemptId);
  const eventId = candidate.eventId;
  const suid = candidate.suid;
  const payload = candidate.payload;
  const allocatorLineageId = boundedText(candidate.allocatorLineageId);
  const eventType = candidate.eventType;
  const timestamp = candidate.timestamp;
  const epoch = candidate.epoch;
  if (
    attemptId === undefined
    || allocatorLineageId === undefined
    || typeof eventId !== "string"
    || !isUuidV7(eventId)
    || typeof suid !== "string"
    || typeof payload !== "string"
    || typeof eventType !== "string"
    || typeof timestamp !== "string"
    || !CANONICAL_UTC_TIMESTAMP_PATTERN.test(timestamp)
    || typeof epoch !== "number"
    || !Number.isSafeInteger(epoch)
    || epoch < 0
    || candidate.provenance !== "g32"
    || !Array.isArray(candidate.eventTags)
    || candidate.eventTags.length !== 1
    || candidate.eventTags[0] !== identity.tag
  ) {
    return undefined;
  }
  try {
    assertSortableUniqueId(suid);
    assertCanonicalEventType(eventType);
    JSON.parse(payload);
  } catch {
    return undefined;
  }
  let fault: ConditionalAppendFault | undefined;
  if (Object.prototype.hasOwnProperty.call(value, "fault")) {
    if (typeof value.fault !== "string" || !(CONDITIONAL_APPEND_FAULTS as readonly string[]).includes(value.fault)) {
      return undefined;
    }
    fault = value.fault as ConditionalAppendFault;
  }
  return {
    ...identity,
    candidate: {
      attemptId,
      epoch,
      eventId,
      suid,
      payload,
      eventTags: [identity.tag],
      allocatorLineageId,
      eventType,
      provenance: "g32",
      timestamp,
    },
    ...(fault === undefined ? {} : { fault }),
  };
}

function countRows(sql: ConditionalSqlExecutor, query: string, ...bindings: unknown[]): number {
  const row = rowsOf(sql, query, ...bindings)[0];
  if (row === undefined) throw new ConditionalReceiptUnsupported("conditional receipt count");
  return cellNumber(row.count, "count");
}

function jsonArray(value: string): unknown[] | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function readConditionalTerminal(
  sql: ConditionalSqlExecutor,
  input: Pick<ConditionalResolveBody, "serviceId" | "tag" | "normalizedKey">,
): Promise<ConditionalTerminalRead> {
  let marker = 0;
  try {
    marker = countRows(sql, "SELECT COUNT(*) AS count FROM tag_bootstrap_admission");
  } catch {
    return { kind: "unsupported" };
  }
  let receiptCount = 0;
  try {
    receiptCount = countRows(
      sql,
      "SELECT COUNT(*) AS count FROM tag_conditional_receipt WHERE service_id = ? AND normalized_key = ?",
      input.serviceId,
      input.normalizedKey,
    );
  } catch (error) {
    if (error instanceof ConditionalReceiptUnsupported) return { kind: "unsupported" };
    return { kind: "corrupt" };
  }
  if (receiptCount === 0) return marker === 0 ? { kind: "absent" } : { kind: "unsupported" };
  if (receiptCount !== 1 || marker !== 0) return { kind: "corrupt" };

  const joined = rowsOf(sql, `
    SELECT
      r.service_id AS service_id,
      r.normalized_key AS normalized_key,
      r.operation_fingerprint AS operation_fingerprint,
      r.event_id AS event_id,
      r.event_digest AS event_digest,
      e.attempt_id AS attempt_id,
      e.suid AS suid,
      e.payload AS payload,
      e.event_tags_json AS event_tags_json,
      e.allocator_lineage_id AS allocator_lineage_id,
      e.event_type AS event_type,
      e.provenance AS provenance,
      e.timestamp AS timestamp
    FROM tag_conditional_receipt AS r
    JOIN tag_event AS e
      ON e.service_id = r.service_id AND e.event_id = r.event_id
    WHERE r.service_id = ? AND r.normalized_key = ?
  `, input.serviceId, input.normalizedKey);
  if (joined.length !== 1) return { kind: "corrupt" };
  const row = joined[0]!;
  try {
    const serviceId = cellText(row.service_id, "service");
    const normalizedKey = cellText(row.normalized_key, "key");
    const operationFingerprint = cellText(row.operation_fingerprint, "fingerprint");
    const eventId = cellText(row.event_id, "event");
    const eventDigest = cellText(row.event_digest, "digest");
    const attemptId = cellText(row.attempt_id, "attempt");
    const suid = cellText(row.suid, "suid");
    const payload = cellText(row.payload, "payload");
    const eventTagsJson = cellText(row.event_tags_json, "tags");
    const allocatorLineageId = cellText(row.allocator_lineage_id, "lineage");
    const eventType = cellText(row.event_type, "type");
    const provenance = cellText(row.provenance, "provenance");
    const timestamp = cellText(row.timestamp, "timestamp");
    if (serviceId !== input.serviceId || normalizedKey !== input.normalizedKey) return { kind: "corrupt" };
    if (!FINGERPRINT.test(operationFingerprint) || !FINGERPRINT.test(eventDigest) || !isUuidV7(eventId)) {
      return { kind: "corrupt" };
    }
    assertSortableUniqueId(suid);
    assertCanonicalEventType(eventType);
    if (provenance !== "g32" || !CANONICAL_UTC_TIMESTAMP_PATTERN.test(timestamp)) return { kind: "corrupt" };
    const tags = jsonArray(eventTagsJson);
    if (tags === undefined || tags.length !== 1 || tags[0] !== input.tag || tags.some((tag) => typeof tag !== "string")) {
      return { kind: "corrupt" };
    }
    const membership = rowsOf(
      sql,
      "SELECT tag FROM tag_committed_membership WHERE service_id = ? AND event_id = ?",
      serviceId,
      eventId,
    );
    if (membership.length !== 1 || cellText(membership[0]?.tag, "membership") !== input.tag) return { kind: "corrupt" };
    const obligations = rowsOf(sql, `
      SELECT attempt_id, suid, payload, allocator_lineage_id, event_type, provenance, timestamp,
             event_digest, declared_tag_set_json, local_committed_membership_json
        FROM tag_outbox_obligation
       WHERE service_id = ? AND event_id = ?
    `, serviceId, eventId);
    if (obligations.length !== 1) return { kind: "corrupt" };
    const obligation = obligations[0]!;
    if (
      cellText(obligation.attempt_id, "outbox attempt") !== attemptId
      || cellText(obligation.suid, "outbox suid") !== suid
      || cellText(obligation.payload, "outbox payload") !== payload
      || cellText(obligation.allocator_lineage_id, "outbox lineage") !== allocatorLineageId
      || cellText(obligation.event_type, "outbox type") !== eventType
      || cellText(obligation.provenance, "outbox provenance") !== provenance
      || cellText(obligation.timestamp, "outbox timestamp") !== timestamp
      || cellText(obligation.event_digest, "outbox digest") !== eventDigest
    ) {
      return { kind: "corrupt" };
    }
    const declared = jsonArray(cellText(obligation.declared_tag_set_json, "declared"));
    const canonicalTags = canonicalDeclaredTagSet(tags as string[]);
    if (declared === undefined || declared.length !== canonicalTags.length || declared.some((tag, index) => tag !== canonicalTags[index])) {
      return { kind: "corrupt" };
    }
    const localMembership = jsonArray(cellText(obligation.local_committed_membership_json, "local membership"));
    const local = localMembership?.[0];
    if (
      localMembership?.length !== 1
      || !isPlainRecord(local)
      || local.serviceId !== serviceId
      || local.eventId !== eventId
      || local.tag !== input.tag
    ) {
      return { kind: "corrupt" };
    }
    const identity = rowsOf(sql, "SELECT tag FROM tag_identity WHERE singleton = 1");
    if (identity.length !== 1 || cellText(identity[0]?.tag, "identity") !== input.tag) return { kind: "corrupt" };
    const control = rowsOf(sql, "SELECT head_suid, schema_version FROM tag_control WHERE singleton = 1");
    const head = rowsOf(sql, "SELECT service_id, head_suid FROM tag_head WHERE singleton = 1");
    if (control.length !== 1 || head.length !== 1) return { kind: "corrupt" };
    if (cellNumber(control[0]?.schema_version, "schema") !== 3) return { kind: "corrupt" };
    const controlHead = cellText(control[0]?.head_suid, "control head");
    const headSuid = cellText(head[0]?.head_suid, "head");
    const headService = cellText(head[0]?.service_id, "head service");
    if (controlHead !== headSuid || headService !== serviceId || headSuid.length === 0) return { kind: "corrupt" };
    if (compareSortableUniqueId(headSuid, suid) < 0) return { kind: "corrupt" };
    const recomputed = await eventDigestHex({
      serviceId,
      eventId,
      sortableUniqueId: suid,
      eventType,
      timestamp,
      allocatorLineageId,
      attemptId,
      declaredTagSet: canonicalTags,
      payload: new TextEncoder().encode(payload),
    });
    if (recomputed !== eventDigest) return { kind: "corrupt" };
    return {
      kind: "winner",
      facts: {
        serviceId,
        tag: input.tag,
        normalizedKey,
        operationFingerprint,
        eventId,
        suid,
        payload,
        eventType,
        attemptId,
        timestamp,
        provenance: "g32",
        allocatorLineageId,
        eventDigest,
      },
    };
  } catch {
    return { kind: "corrupt" };
  }
}

export function insertConditionalReceipt(
  sql: ConditionalSqlExecutor,
  values: {
    readonly serviceId: string;
    readonly normalizedKey: string;
    readonly operationFingerprint: string;
    readonly eventId: string;
    readonly eventDigest: string;
  },
): void {
  try {
    sql.exec(
      CONDITIONAL_RECEIPT_INSERT_SQL,
      values.serviceId,
      values.normalizedKey,
      values.operationFingerprint,
      values.eventId,
      values.eventDigest,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("UNIQUE constraint failed") && message.includes("tag_conditional_receipt")) {
      throw new ConditionalReceiptUniquenessFault();
    }
    throw error;
  }
}

export function candidateEventExists(sql: ConditionalSqlExecutor, serviceId: string, eventId: string): boolean {
  return countRows(
    sql,
    "SELECT COUNT(*) AS count FROM tag_event WHERE service_id = ? AND event_id = ?",
    serviceId,
    eventId,
  ) !== 0;
}
