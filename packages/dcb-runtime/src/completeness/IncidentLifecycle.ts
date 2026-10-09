import type {
  IncidentCorrection,
  IncidentLifecycleProjection,
  IncidentLifecycleState,
  IncidentTransitionRecord,
  IncidentTransitionRequest,
} from "./types";

const MAX_IDENTITY_BYTES = 256;
const MAX_LONG_TEXT_BYTES = 2_048;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const LIFECYCLE_STATES: readonly IncidentLifecycleState[] = [
  "OPEN",
  "ACKNOWLEDGED",
  "CORRECTION_RECORDED",
  "CLOSED",
  "REOPENED",
];

type JsonObject = Record<string, unknown>;
type FindingRow = Readonly<{
  service_id: string;
  incident_identity: string;
  incident_type: string;
  partition_tag: string | null;
  obligation_sequence: number | null;
  event_id: string | null;
  event_digest: string | null;
  finding_state: "OPEN" | "UNRESOLVED";
  first_observed_at: number;
  last_observed_at: number;
}>;

type LifecycleRow = Readonly<{
  service_id: string;
  incident_identity: string;
  lifecycle_state: IncidentLifecycleState;
  owner_id: string | null;
  deadline_at: number | null;
  correction_kind: "event" | "receipt" | null;
  correction_reference: string | null;
  correction_digest: `sha256:${string}` | null;
  close_resolution: "CORRECTED" | "ACCEPTED_AS_IS" | null;
  close_reason: string | null;
  version: number;
  last_transition_key: string;
  updated_at: number;
}>;

type TransitionRow = Readonly<{
  transition_id: number;
  service_id: string;
  incident_identity: string;
  transition_key: string;
  request_digest: string;
  action: IncidentTransitionRequest["action"];
  from_state: IncidentLifecycleState;
  to_state: IncidentLifecycleState;
  from_version: number;
  to_version: number;
  actor_id: string;
  before_owner_id: string | null;
  before_deadline_at: number | null;
  before_correction_kind: "event" | "receipt" | null;
  before_correction_reference: string | null;
  before_correction_digest: `sha256:${string}` | null;
  before_close_resolution: "CORRECTED" | "ACCEPTED_AS_IS" | null;
  before_close_reason: string | null;
  after_owner_id: string | null;
  after_deadline_at: number | null;
  after_correction_kind: "event" | "receipt" | null;
  after_correction_reference: string | null;
  after_correction_digest: `sha256:${string}` | null;
  after_close_resolution: "CORRECTED" | "ACCEPTED_AS_IS" | null;
  after_close_reason: string | null;
  reason: string;
  occurred_at: number;
}>;

export interface IncidentListFilters {
  readonly state?: IncidentLifecycleState;
  readonly owner?: string;
  readonly unowned?: boolean;
  readonly overdue?: boolean;
  readonly observedAfterClose?: boolean;
}

export interface IncidentFinding {
  readonly serviceId: string;
  readonly incidentIdentity: string;
  readonly incidentType: string;
  readonly partitionTag: string | null;
  readonly obligationSequence: number | null;
  readonly eventId: string | null;
  readonly eventDigest: string | null;
  readonly state: "OPEN" | "UNRESOLVED";
  readonly firstObservedAt: number;
  readonly lastObservedAt: number;
}

export interface IncidentListItem {
  readonly finding: IncidentFinding;
  readonly lifecycle: IncidentLifecycleProjection;
  readonly overdue: boolean;
  readonly unowned: boolean;
  readonly observedAfterClose: boolean;
}

export interface IncidentListResult {
  readonly items: readonly IncidentListItem[];
  readonly summary: Readonly<{
    total: number;
    byState: Readonly<Record<IncidentLifecycleState, number>>;
    unowned: number;
    overdue: number;
    observedAfterClose: number;
  }>;
}

export interface IncidentDetailResult {
  readonly finding: IncidentFinding;
  readonly lifecycle: IncidentLifecycleProjection;
  readonly flags: Readonly<{ overdue: boolean; unowned: boolean; observedAfterClose: boolean }>;
  readonly transitions: readonly IncidentTransitionRecord[];
}

export interface IncidentTransitionResult {
  readonly projection: IncidentLifecycleProjection;
  readonly transition: IncidentTransitionRecord;
  readonly idempotent: boolean;
}

export class IncidentLifecycleError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "IncidentLifecycleError";
    this.code = code;
    this.status = status;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: JsonObject, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedString(value: unknown, name: string, maximum: number, required = true): string | null {
  if (typeof value !== "string") {
    throw new IncidentLifecycleError("incident_invalid_request", 400, `${name} must be a string`);
  }
  const normalized = value.trim();
  if (required && normalized.length === 0) {
    throw new IncidentLifecycleError("incident_invalid_request", 400, `${name} must be non-empty`);
  }
  if (bytes(normalized) > maximum) {
    throw new IncidentLifecycleError("incident_invalid_request", 400, `${name} is too long`);
  }
  return normalized.length === 0 ? null : normalized;
}

function safeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new IncidentLifecycleError("incident_invalid_request", 400, `${name} must be a safe integer`);
  }
  return value;
}

function normalizeCorrection(value: unknown): IncidentCorrection {
  if (!isObject(value) || !hasOnlyKeys(value, ["kind", "reference", "digest"])) {
    throw new IncidentLifecycleError("incident_invalid_request", 400, "correction has unknown or missing keys");
  }
  if (value.kind !== "event" && value.kind !== "receipt") {
    throw new IncidentLifecycleError("incident_invalid_request", 400, "correction.kind must be event or receipt");
  }
  const reference = boundedString(value.reference, "correction.reference", MAX_LONG_TEXT_BYTES);
  const digest = boundedString(value.digest, "correction.digest", MAX_IDENTITY_BYTES);
  if (reference === null || digest === null || !SHA256_DIGEST.test(digest)) {
    throw new IncidentLifecycleError("incident_invalid_request", 400, "correction.digest must be lowercase sha256");
  }
  return { kind: value.kind, reference, digest: digest as `sha256:${string}` };
}

function normalizeRequest(value: unknown): IncidentTransitionRequest {
  if (!isObject(value) || !hasOnlyKeys(value, ["action", "incidentIdentity", "transitionKey", "expectedVersion", "reason", "ownerId", "deadlineAt", "correction", "resolution"])) {
    throw new IncidentLifecycleError("incident_invalid_request", 400, "transition has unknown keys");
  }
  const action = value.action;
  if (typeof action !== "string" || !["ACKNOWLEDGE", "UPDATE_ASSIGNMENT", "RECORD_CORRECTION", "CLOSE", "REOPEN"].includes(action)) {
    throw new IncidentLifecycleError("incident_invalid_request", 400, "transition action is invalid");
  }
  const actionKeys = action === "RECORD_CORRECTION"
    ? ["action", "incidentIdentity", "transitionKey", "expectedVersion", "reason", "correction"]
    : action === "CLOSE"
      ? ["action", "incidentIdentity", "transitionKey", "expectedVersion", "reason", "resolution"]
      : ["action", "incidentIdentity", "transitionKey", "expectedVersion", "reason", "ownerId", "deadlineAt"];
  if (!hasOnlyKeys(value, actionKeys)) {
    throw new IncidentLifecycleError("incident_invalid_request", 400, "transition has keys not valid for its action");
  }
  const base = {
    incidentIdentity: boundedString(value.incidentIdentity, "incidentIdentity", MAX_IDENTITY_BYTES) as string,
    transitionKey: boundedString(value.transitionKey, "transitionKey", MAX_IDENTITY_BYTES) as string,
    expectedVersion: safeInteger(value.expectedVersion, "expectedVersion"),
    reason: boundedString(value.reason, "reason", MAX_LONG_TEXT_BYTES) as string,
  };
  if (base.expectedVersion < 0) {
    throw new IncidentLifecycleError("incident_invalid_request", 400, "expectedVersion must not be negative");
  }
  if (action === "ACKNOWLEDGE" || action === "UPDATE_ASSIGNMENT" || action === "REOPEN") {
    const ownerId = boundedString(value.ownerId, "ownerId", MAX_IDENTITY_BYTES);
    const deadlineAt = safeInteger(value.deadlineAt, "deadlineAt");
    if (ownerId === null) throw new IncidentLifecycleError("incident_invalid_request", 400, "ownerId must be non-empty");
    return { ...base, action, ownerId, deadlineAt } as IncidentTransitionRequest;
  }
  if (action === "RECORD_CORRECTION") {
    return { ...base, action, correction: normalizeCorrection(value.correction) } as IncidentTransitionRequest;
  }
  if (!isObject(value.resolution) || !hasOnlyKeys(value.resolution, ["kind", "explanation"])) {
    throw new IncidentLifecycleError("incident_invalid_request", 400, "resolution has unknown or missing keys");
  }
  if (value.resolution.kind === "CORRECTED") {
    if (value.resolution.explanation !== undefined) {
      throw new IncidentLifecycleError("incident_invalid_request", 400, "CORRECTED resolution has unknown keys");
    }
    return { ...base, action, resolution: { kind: "CORRECTED" } } as IncidentTransitionRequest;
  }
  if (value.resolution.kind === "ACCEPTED_AS_IS") {
    const explanation = boundedString(value.resolution.explanation, "resolution.explanation", MAX_LONG_TEXT_BYTES);
    if (explanation === null) throw new IncidentLifecycleError("incident_invalid_request", 400, "resolution.explanation is required");
    return { ...base, action, resolution: { kind: "ACCEPTED_AS_IS", explanation } } as IncidentTransitionRequest;
  }
  throw new IncidentLifecycleError("incident_invalid_request", 400, "resolution.kind is invalid");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

async function digestFor(request: IncidentTransitionRequest, actorId: string): Promise<string> {
  const envelope = canonicalize({ action: request, actor: actorId });
  const encoded = new TextEncoder().encode(JSON.stringify(envelope));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function projectionFromRow(row: LifecycleRow | null, finding: FindingRow): IncidentLifecycleProjection {
  if (row === null) {
    return {
      serviceId: finding.service_id,
      incidentIdentity: finding.incident_identity,
      lifecycleState: "OPEN",
      ownerId: null,
      deadlineAt: null,
      correction: null,
      closeResolution: null,
      closeReason: null,
      version: 0,
      lastTransitionKey: "",
      updatedAt: finding.last_observed_at,
    };
  }
  return {
    serviceId: row.service_id,
    incidentIdentity: row.incident_identity,
    lifecycleState: row.lifecycle_state,
    ownerId: row.owner_id,
    deadlineAt: row.deadline_at,
    correction: row.correction_kind === null ? null : {
      kind: row.correction_kind,
      reference: row.correction_reference as string,
      digest: row.correction_digest as `sha256:${string}`,
    },
    closeResolution: row.close_resolution,
    closeReason: row.close_reason,
    version: row.version,
    lastTransitionKey: row.last_transition_key,
    updatedAt: row.updated_at,
  };
}

function findingFromRow(row: FindingRow): IncidentFinding {
  return {
    serviceId: row.service_id,
    incidentIdentity: row.incident_identity,
    incidentType: row.incident_type,
    partitionTag: row.partition_tag,
    obligationSequence: row.obligation_sequence,
    eventId: row.event_id,
    eventDigest: row.event_digest,
    state: row.finding_state,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
  };
}

function transitionFromRow(row: TransitionRow): IncidentTransitionRecord {
  const before = projectionFromAudit(row, "before");
  const after = projectionFromAudit(row, "after");
  return {
    transitionId: row.transition_id,
    serviceId: row.service_id,
    incidentIdentity: row.incident_identity,
    transitionKey: row.transition_key,
    requestDigest: row.request_digest,
    action: row.action,
    fromState: row.from_state,
    toState: row.to_state,
    fromVersion: row.from_version,
    toVersion: row.to_version,
    actorId: row.actor_id,
    before,
    after,
    reason: row.reason,
    occurredAt: row.occurred_at,
  };
}

function projectionFromAudit(row: TransitionRow, prefix: "before" | "after"): IncidentLifecycleProjection {
  const state = prefix === "before" ? row.from_state : row.to_state;
  const version = prefix === "before" ? row.from_version : row.to_version;
  const ownerId = row[`${prefix}_owner_id`];
  const correctionKind = row[`${prefix}_correction_kind`];
  return {
    serviceId: row.service_id,
    incidentIdentity: row.incident_identity,
    lifecycleState: state,
    ownerId,
    deadlineAt: row[`${prefix}_deadline_at`],
    correction: correctionKind === null ? null : {
      kind: correctionKind,
      reference: row[`${prefix}_correction_reference`] as string,
      digest: row[`${prefix}_correction_digest`] as `sha256:${string}`,
    },
    closeResolution: row[`${prefix}_close_resolution`],
    closeReason: row[`${prefix}_close_reason`],
    version,
    lastTransitionKey: prefix === "after" ? row.transition_key : "",
    updatedAt: row.occurred_at,
  };
}

function active(state: IncidentLifecycleState): boolean {
  return state !== "CLOSED";
}

function compareItems(left: IncidentListItem, right: IncidentListItem): number {
  if (left.overdue !== right.overdue) return left.overdue ? -1 : 1;
  if (left.unowned !== right.unowned) return left.unowned ? -1 : 1;
  if (left.finding.lastObservedAt !== right.finding.lastObservedAt) return right.finding.lastObservedAt - left.finding.lastObservedAt;
  return left.finding.incidentIdentity < right.finding.incidentIdentity ? -1 : left.finding.incidentIdentity > right.finding.incidentIdentity ? 1 : 0;
}

export class IncidentLifecycle {
  constructor(
    private readonly database: D1Database,
    private readonly now: () => number = () => Date.now(),
  ) {}

  static parseTransition(value: unknown): IncidentTransitionRequest {
    return normalizeRequest(value);
  }

  private async finding(serviceId: string, incidentIdentity: string): Promise<FindingRow> {
    const row = await this.database.prepare(
      `SELECT service_id, incident_identity, incident_type, partition_tag,
              obligation_sequence, event_id, event_digest, state AS finding_state,
              first_observed_at, last_observed_at
         FROM serialized_dcb_completeness_findings
        WHERE service_id = ? AND incident_identity = ?`,
    ).bind(serviceId, incidentIdentity).first<FindingRow>();
    if (row === null || row === undefined) {
      throw new IncidentLifecycleError("incident_not_found", 404, "The completeness incident was not found");
    }
    return row;
  }

  private async lifecycle(serviceId: string, incidentIdentity: string): Promise<LifecycleRow | null> {
    const row = await this.database.prepare(
      `SELECT service_id, incident_identity, lifecycle_state, owner_id, deadline_at,
              correction_kind, correction_reference, correction_digest,
              close_resolution, close_reason, version, last_transition_key, updated_at
         FROM serialized_dcb_incident_lifecycles
        WHERE service_id = ? AND incident_identity = ?`,
    ).bind(serviceId, incidentIdentity).first<LifecycleRow>();
    return row === undefined ? null : row;
  }

  private async transitions(serviceId: string, incidentIdentity: string): Promise<IncidentTransitionRecord[]> {
    const result = await this.database.prepare(
      `SELECT * FROM serialized_dcb_incident_transitions
        WHERE service_id = ? AND incident_identity = ?
        ORDER BY transition_id ASC`,
    ).bind(serviceId, incidentIdentity).all<TransitionRow>();
    return result.results.map(transitionFromRow);
  }

  private async closeTime(serviceId: string, incidentIdentity: string): Promise<number | null> {
    const row = await this.database.prepare(
      `SELECT occurred_at FROM serialized_dcb_incident_transitions
        WHERE service_id = ? AND incident_identity = ? AND to_state = 'CLOSED'
        ORDER BY transition_id DESC LIMIT 1`,
    ).bind(serviceId, incidentIdentity).first<{ occurred_at: number }>();
    return row?.occurred_at ?? null;
  }

  private async item(finding: FindingRow, row: LifecycleRow | null, at: number): Promise<IncidentListItem> {
    const lifecycle = projectionFromRow(row, finding);
    const closeTime = lifecycle.lifecycleState === "OPEN" && row === null ? null : await this.closeTime(finding.service_id, finding.incident_identity);
    const observedAfterClose = closeTime !== null && finding.last_observed_at > closeTime;
    const overdue = active(lifecycle.lifecycleState) && lifecycle.deadlineAt !== null && lifecycle.deadlineAt < at;
    return {
      finding: findingFromRow(finding),
      lifecycle,
      overdue,
      unowned: lifecycle.ownerId === null,
      observedAfterClose,
    };
  }

  async list(serviceId: string, filters: IncidentListFilters = {}, at = this.now()): Promise<IncidentListResult> {
    const rows = await this.database.prepare(
      `SELECT service_id, incident_identity, incident_type, partition_tag,
              obligation_sequence, event_id, event_digest, state AS finding_state,
              first_observed_at, last_observed_at
         FROM serialized_dcb_completeness_findings
        WHERE service_id = ?`,
    ).bind(serviceId).all<FindingRow>();
    const items: IncidentListItem[] = [];
    for (const finding of rows.results) {
      const item = await this.item(finding, await this.lifecycle(serviceId, finding.incident_identity), at);
      if (filters.state !== undefined && item.lifecycle.lifecycleState !== filters.state) continue;
      if (filters.owner !== undefined && item.lifecycle.ownerId !== filters.owner) continue;
      if (filters.unowned === true && !item.unowned) continue;
      if (filters.overdue === true && !item.overdue) continue;
      if (filters.observedAfterClose === true && !item.observedAfterClose) continue;
      items.push(item);
    }
    items.sort(compareItems);
    const byState: Record<IncidentLifecycleState, number> = {
      OPEN: 0, ACKNOWLEDGED: 0, CORRECTION_RECORDED: 0, CLOSED: 0, REOPENED: 0,
    };
    for (const item of items) byState[item.lifecycle.lifecycleState] += 1;
    return {
      items,
      summary: {
        total: items.length,
        byState,
        unowned: items.filter((item) => item.unowned).length,
        overdue: items.filter((item) => item.overdue).length,
        observedAfterClose: items.filter((item) => item.observedAfterClose).length,
      },
    };
  }

  async detail(serviceId: string, incidentIdentity: string, at = this.now()): Promise<IncidentDetailResult> {
    const finding = await this.finding(serviceId, incidentIdentity);
    const lifecycle = await this.lifecycle(serviceId, incidentIdentity);
    const item = await this.item(finding, lifecycle, at);
    return {
      finding: item.finding,
      lifecycle: item.lifecycle,
      flags: { overdue: item.overdue, unowned: item.unowned, observedAfterClose: item.observedAfterClose },
      transitions: await this.transitions(serviceId, incidentIdentity),
    };
  }

  async transition(serviceId: string, value: unknown, actor: string): Promise<IncidentTransitionResult> {
    const request = normalizeRequest(value);
    const actorId = boundedString(actor, "x-sdt-maintainer", MAX_IDENTITY_BYTES);
    if (actorId === null) throw new IncidentLifecycleError("incident_invalid_actor", 400, "x-sdt-maintainer must be non-empty");
    const finding = await this.finding(serviceId, request.incidentIdentity);
    const digest = await digestFor(request, actorId);
    const existing = await this.database.prepare(
      `SELECT * FROM serialized_dcb_incident_transitions
        WHERE service_id = ? AND incident_identity = ? AND transition_key = ?`,
    ).bind(serviceId, request.incidentIdentity, request.transitionKey).first<TransitionRow>();
    if (existing !== null && existing !== undefined) {
      if (existing.request_digest !== digest) {
        throw new IncidentLifecycleError("incident_idempotency_conflict", 409, "The transition key was already used with different content");
      }
      return { projection: transitionFromRow(existing).after, transition: transitionFromRow(existing), idempotent: true };
    }

    const priorRow = await this.lifecycle(serviceId, request.incidentIdentity);
    const before = projectionFromRow(priorRow, finding);
    if (before.version !== request.expectedVersion) {
      throw new IncidentLifecycleError("incident_version_conflict", 409, "The incident version is stale");
    }
    const at = this.now();
    const after = this.nextProjection(before, request, at);
    const newVersion = before.version + 1;
    const occurredAt = at;
    const seed = this.database.prepare(
      `INSERT INTO serialized_dcb_incident_lifecycles
         (service_id, incident_identity, lifecycle_state, version, last_transition_key, updated_at)
       VALUES (?, ?, 'OPEN', 0, '', ?)
       ON CONFLICT (service_id, incident_identity) DO NOTHING`,
    ).bind(serviceId, request.incidentIdentity, occurredAt);
    const update = this.database.prepare(
      `UPDATE serialized_dcb_incident_lifecycles
          SET lifecycle_state = ?, owner_id = ?, deadline_at = ?,
              correction_kind = ?, correction_reference = ?, correction_digest = ?,
              close_resolution = ?, close_reason = ?, version = ?,
              last_transition_key = ?, updated_at = ?
        WHERE service_id = ? AND incident_identity = ? AND version = ?
          AND last_transition_key <> ?`,
    ).bind(
      after.lifecycleState, after.ownerId, after.deadlineAt,
      after.correction?.kind ?? null, after.correction?.reference ?? null, after.correction?.digest ?? null,
      after.closeResolution, after.closeReason, newVersion, request.transitionKey, occurredAt,
      serviceId, request.incidentIdentity, before.version, request.transitionKey,
    );
    const audit = this.database.prepare(
      `INSERT INTO serialized_dcb_incident_transitions
         (service_id, incident_identity, transition_key, request_digest, action,
          from_state, to_state, from_version, to_version, actor_id,
          before_owner_id, before_deadline_at, before_correction_kind,
          before_correction_reference, before_correction_digest, before_close_resolution,
          before_close_reason, after_owner_id, after_deadline_at, after_correction_kind,
          after_correction_reference, after_correction_digest, after_close_resolution,
          after_close_reason, reason, occurred_at)
       SELECT ?, ?, ?, ?, ?, ?, lifecycle_state, ?, version, ?,
              ?, ?, ?, ?, ?, ?, ?, owner_id, deadline_at, correction_kind,
              correction_reference, correction_digest, close_resolution, close_reason, ?, ?
         FROM serialized_dcb_incident_lifecycles
        WHERE service_id = ? AND incident_identity = ? AND version = ? AND last_transition_key = ?`,
    ).bind(
      serviceId, request.incidentIdentity, request.transitionKey, digest, request.action, before.lifecycleState,
      before.version, actorId,
      before.ownerId, before.deadlineAt, before.correction?.kind ?? null, before.correction?.reference ?? null,
      before.correction?.digest ?? null, before.closeResolution, before.closeReason,
      request.reason, occurredAt,
      serviceId, request.incidentIdentity, newVersion, request.transitionKey,
    );
    await this.database.batch([seed, update, audit]);
    const inserted = await this.database.prepare(
      `SELECT * FROM serialized_dcb_incident_transitions
        WHERE service_id = ? AND incident_identity = ? AND transition_key = ?`,
    ).bind(serviceId, request.incidentIdentity, request.transitionKey).first<TransitionRow>();
    if (inserted === null || inserted === undefined) {
      const competing = await this.database.prepare(
        `SELECT * FROM serialized_dcb_incident_transitions
          WHERE service_id = ? AND incident_identity = ? AND transition_key = ?`,
      ).bind(serviceId, request.incidentIdentity, request.transitionKey).first<TransitionRow>();
      if (competing !== null && competing !== undefined && competing.request_digest !== digest) {
        throw new IncidentLifecycleError("incident_idempotency_conflict", 409, "The transition key was already used with different content");
      }
      if (competing !== null && competing !== undefined) {
        const transition = transitionFromRow(competing);
        return { projection: transition.after, transition, idempotent: true };
      }
      throw new IncidentLifecycleError("incident_version_conflict", 409, "The incident version is stale");
    }
    const transition = transitionFromRow(inserted);
    return { projection: transition.after, transition, idempotent: false };
  }

  private nextProjection(
    before: IncidentLifecycleProjection,
    request: IncidentTransitionRequest,
    at: number,
  ): IncidentLifecycleProjection {
    const laterDeadline = (deadlineAt: number): number => {
      if (deadlineAt <= at) throw new IncidentLifecycleError("incident_invalid_deadline", 400, "deadlineAt must be in the future");
      return deadlineAt;
    };
    let lifecycleState: IncidentLifecycleState;
    let ownerId = before.ownerId;
    let deadlineAt = before.deadlineAt;
    let correction = before.correction;
    let closeResolution = before.closeResolution;
    let closeReason = before.closeReason;
    if (request.action === "ACKNOWLEDGE") {
      if (before.lifecycleState !== "OPEN" && before.lifecycleState !== "REOPENED") {
        throw new IncidentLifecycleError("incident_invalid_transition", 409, "The incident cannot be acknowledged from its current state");
      }
      lifecycleState = "ACKNOWLEDGED";
      ownerId = request.ownerId;
      deadlineAt = laterDeadline(request.deadlineAt);
      correction = null;
      closeResolution = null;
      closeReason = null;
    } else if (request.action === "UPDATE_ASSIGNMENT") {
      if (before.lifecycleState !== "ACKNOWLEDGED" && before.lifecycleState !== "CORRECTION_RECORDED") {
        throw new IncidentLifecycleError("incident_invalid_transition", 409, "The incident cannot be reassigned from its current state");
      }
      lifecycleState = before.lifecycleState;
      ownerId = request.ownerId;
      deadlineAt = laterDeadline(request.deadlineAt);
    } else if (request.action === "RECORD_CORRECTION") {
      if (before.lifecycleState !== "ACKNOWLEDGED") {
        throw new IncidentLifecycleError("incident_invalid_transition", 409, "The incident must be acknowledged before correction evidence");
      }
      lifecycleState = "CORRECTION_RECORDED";
      correction = request.correction;
    } else if (request.action === "CLOSE") {
      if (before.ownerId === null || before.deadlineAt === null) {
        throw new IncidentLifecycleError("incident_invalid_transition", 409, "The incident must have an owner and deadline before closure");
      }
      if (request.resolution.kind === "CORRECTED") {
        if (before.lifecycleState !== "CORRECTION_RECORDED") {
          throw new IncidentLifecycleError("incident_invalid_transition", 409, "A corrected closure requires recorded correction evidence");
        }
        lifecycleState = "CLOSED";
        closeResolution = "CORRECTED";
        closeReason = request.reason;
      } else {
        if (before.lifecycleState !== "ACKNOWLEDGED") {
          throw new IncidentLifecycleError("incident_invalid_transition", 409, "Accepted-as-is closure requires an acknowledged incident");
        }
        lifecycleState = "CLOSED";
        closeResolution = "ACCEPTED_AS_IS";
        closeReason = request.resolution.explanation;
        correction = null;
      }
    } else {
      if (before.lifecycleState !== "CLOSED") {
        throw new IncidentLifecycleError("incident_invalid_transition", 409, "Only a closed incident can be reopened");
      }
      lifecycleState = "REOPENED";
      ownerId = request.ownerId;
      deadlineAt = laterDeadline(request.deadlineAt);
      correction = null;
      closeResolution = null;
      closeReason = null;
    }
    return {
      ...before,
      lifecycleState,
      ownerId,
      deadlineAt,
      correction,
      closeResolution,
      closeReason,
      version: before.version + 1,
      lastTransitionKey: request.transitionKey,
      updatedAt: at,
    };
  }
}

export { LIFECYCLE_STATES };
