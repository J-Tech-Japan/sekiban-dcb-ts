import {
  type CommitTraceFace,
  type CommitTraceSnapshot,
  type CommitTraceSpan,
  type TraceAttributeValue,
  traceManifest,
} from "./CommitTrace";
import { calculateUnattributedRatio, type UnattributedRatio } from "./AttributionRatio";

export { calculateUnattributedRatio } from "./AttributionRatio";
export type { UnattributedRatio } from "./AttributionRatio";

export class CommitTraceVerificationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CommitTraceVerificationError";
  }
}

export interface CommitTraceVerificationOptions {
  /** A literal v1 boundary name from the authority manifest. */
  readonly boundary?: string;
  /** Result of every manifest conditional predicate for this trace. */
  readonly conditionals?: Readonly<Record<string, boolean>>;
  /** Exact runtime cardinalities for indexed/fan-out rows. */
  readonly cardinalities?: Readonly<Record<string, number>>;
  /** Enforce the per-request <=5% unattributed gate. */
  readonly accepted?: boolean;
}

interface ManifestRow {
  readonly rowId: string;
  readonly span: string;
  readonly emitter: string;
  readonly logicalParent: string | null;
  readonly coverage: boolean;
  readonly kind: string;
  readonly successCardinality: string;
}

const TRANSITION_PHASE: Readonly<Record<string, number>> = Object.freeze({
  S05a: 0,
  S05b: 1,
  S05c: 2,
  S05d: 3,
  S05e: 4,
});

interface BoundaryConditional {
  readonly rowId: string;
  readonly instanceCount: number | string;
  readonly whenTrue: "required" | "forbidden";
  readonly whenFalse: "required" | "forbidden";
}

interface Boundary {
  readonly name: string;
  readonly requiredRows: readonly string[];
  readonly conditionalRows: readonly BoundaryConditional[];
  readonly forbiddenRows: readonly string[];
}

const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function failure(code: string, message: string): never {
  throw new CommitTraceVerificationError(code, message);
}

function schemaRows(snapshot: CommitTraceSnapshot): readonly ManifestRow[] {
  const schema = traceManifest().schemas[snapshot.schema];
  if (schema === undefined || !Array.isArray(schema.rows)) failure("schema-missing", `manifest lacks ${snapshot.schema}`);
  return schema.rows as readonly ManifestRow[];
}

function rowMap(snapshot: CommitTraceSnapshot): ReadonlyMap<string, ManifestRow> {
  return new Map(schemaRows(snapshot).map((row) => [row.rowId, row]));
}

function typeCheck(value: TraceAttributeValue, type: string, values: readonly string[] | undefined, key: string): void {
  if (type === "enum-from-manifest-recovery") {
    if (typeof value !== "string") failure("attribute-type", `${key} must be a string`);
    const reconcile = traceManifest().schemas["sdt.commit.reconcile/v1"] as unknown as {
      readonly recoveryDag?: Readonly<Record<string, unknown>>;
      readonly terminalAtEntryBoundary?: Readonly<{ readonly name?: string }>;
    };
    const recoveryKinds = [
      ...Object.keys(reconcile.recoveryDag ?? {}),
      reconcile.terminalAtEntryBoundary?.name,
    ].filter((candidate): candidate is string => typeof candidate === "string");
    if (!recoveryKinds.includes(value)) {
      failure("attribute-enum", `${key} value ${value} is not manifest-declared`);
    }
    return;
  }
  if (type === "string" || type === "string-literal" || type === "enum" || type.startsWith("enum-") || type === "provider-adapter") {
    if (typeof value !== "string") failure("attribute-type", `${key} must be a string`);
    if (values !== undefined && !values.includes(value)) failure("attribute-enum", `${key} value ${value} is not manifest-declared`);
    return;
  }
  if (type === "hex64") {
    if (typeof value !== "string" || !HEX64.test(value)) failure("attribute-hex64", `${key} must be lower-case 64-hex`);
    return;
  }
  if (type === "uuid") {
    if (typeof value !== "string" || !UUID.test(value)) failure("attribute-uuid", `${key} must be a UUID`);
    return;
  }
  if (type === "boolean") {
    if (typeof value !== "boolean") failure("attribute-boolean", `${key} must be boolean`);
    return;
  }
  if (type === "integer" || type === "non-negative-integer") {
    if (typeof value !== "number" || !Number.isInteger(value) || (type === "non-negative-integer" && value < 0)) {
      failure("attribute-integer", `${key} must be ${type}`);
    }
    return;
  }
  failure("attribute-type-unknown", `manifest declares unsupported type ${type} for ${key}`);
}

function verifyAttributes(span: CommitTraceSpan, row: ManifestRow): void {
  const matrix = traceManifest().attributeMatrix;
  for (const [key, declaration] of Object.entries(matrix.attributes)) {
    const state = declaration.rowScope !== undefined && !declaration.rowScope.includes(span.rowId)
      ? "forbidden"
      : declaration.faces[span.face];
    const present = Object.prototype.hasOwnProperty.call(span.attributes, key);
    if (state === "required" && !present) failure("attribute-missing", `${span.rowId} lacks required ${key} on ${span.face}`);
    if (state === "forbidden" && present) failure("attribute-forbidden", `${span.rowId} emits forbidden ${key} on ${span.face}`);
    if (present) typeCheck(span.attributes[key]!, declaration.type, declaration.values, key);
  }
  for (const key of Object.keys(span.attributes)) {
    if (!Object.prototype.hasOwnProperty.call(matrix.attributes, key)) {
      failure("attribute-unknown", `${span.rowId} emits unknown attribute ${key}`);
    }
    if (key !== "tag.key_hash" && /(^|[._])tag($|[._])/i.test(key)) {
      failure("raw-tag", `${span.rowId} emits raw tag-like attribute ${key}`);
    }
  }
  if (span.attributes.operation !== row.span) {
    failure("operation-row", `${span.rowId} operation must equal the manifest span name`);
  }
  if (span.attributes["span.kind"] !== row.kind) {
    failure("kind-row", `${span.rowId} span.kind must equal the manifest row kind`);
  }
  const expectedPhase = TRANSITION_PHASE[span.rowId];
  if (expectedPhase !== undefined && span.attributes["phase.ordinal"] !== expectedPhase) {
    failure("transition-phase", `${span.rowId} must carry phase.ordinal=${expectedPhase}`);
  }
  // The host-owned rowScope is the authority for member attributes.  Do not
  // duplicate a hand-maintained list here: S14 was omitted from such a list
  // once even though it is a real v1 fan-out member.  The bundle validator
  // proves rowScope is exactly the complete set of member rows; the runtime
  // verifier therefore uses that same declared scope for the emitted trace.
  const memberIndexScope = matrix.attributes["member.index"]?.rowScope ?? [];
  if (memberIndexScope.includes(span.rowId) && span.attributes["member.index"] === undefined) {
    failure("fanout-member-index", `${span.rowId} must carry member.index`);
  }
  const tagKeyHashScope = matrix.attributes["tag.key_hash"]?.rowScope ?? [];
  if (tagKeyHashScope.includes(span.rowId) && span.attributes["tag.key_hash"] === undefined) {
    failure("fanout-tag-hash", `${span.rowId} must carry tag.key_hash rather than a raw tag`);
  }
}

function instancesByRow(spans: readonly CommitTraceSpan[]): ReadonlyMap<string, readonly CommitTraceSpan[]> {
  const entries = new Map<string, CommitTraceSpan[]>();
  for (const span of spans) {
    const list = entries.get(span.rowId) ?? [];
    list.push(span);
    entries.set(span.rowId, list);
  }
  return entries;
}

function findBoundary(snapshot: CommitTraceSnapshot, name: string): Boundary {
  const boundaries = (traceManifest().schemas[snapshot.schema] as unknown as { boundaries?: readonly Boundary[] }).boundaries;
  const boundary = boundaries?.find((entry) => entry.name === name);
  if (boundary === undefined) failure("boundary-missing", `manifest lacks ${snapshot.schema} boundary ${name}`);
  return boundary;
}

function expectedConditionalCount(conditional: BoundaryConditional, enabled: boolean): number {
  const state = enabled ? conditional.whenTrue : conditional.whenFalse;
  if (state === "forbidden") return 0;
  return typeof conditional.instanceCount === "number" ? conditional.instanceCount : 1;
}

function verifyBoundary(snapshot: CommitTraceSnapshot, options: CommitTraceVerificationOptions): void {
  if (options.boundary === undefined) return;
  const boundary = findBoundary(snapshot, options.boundary);
  const instances = instancesByRow(snapshot.spans);
  for (const rowId of boundary.requiredRows) {
    if ((instances.get(rowId)?.length ?? 0) === 0) failure("boundary-required", `${boundary.name} requires ${rowId}`);
  }
  for (const rowId of boundary.forbiddenRows) {
    if ((instances.get(rowId)?.length ?? 0) !== 0) failure("boundary-forbidden", `${boundary.name} forbids ${rowId}`);
  }
  for (const conditional of boundary.conditionalRows) {
    const enabled = options.conditionals?.[conditional.rowId];
    if (enabled === undefined) failure("boundary-conditional-missing", `${boundary.name} needs predicate result for ${conditional.rowId}`);
    const actual = instances.get(conditional.rowId)?.length ?? 0;
    const expected = expectedConditionalCount(conditional, enabled);
    if (actual !== expected) {
      failure("boundary-conditional", `${boundary.name} expects ${conditional.rowId}=${expected}, observed ${actual}`);
    }
  }
  for (const [rowId, expected] of Object.entries(options.cardinalities ?? {})) {
    const actual = instances.get(rowId)?.length ?? 0;
    if (actual !== expected) failure("cardinality", `${rowId} expected ${expected}, observed ${actual}`);
    const members = instances.get(rowId) ?? [];
    if (members.length > 0 && members.every((span) => span.attributes["member.index"] !== undefined)) {
      const indexes = members.map((span) => span.attributes["member.index"]).sort((left, right) => Number(left) - Number(right));
      if (indexes.some((value, index) => value !== index)) failure("member-index", `${rowId} member.index is not 0..N-1`);
    }
  }
}

function verifyDeclaredCardinality(snapshot: CommitTraceSnapshot): void {
  const rows = rowMap(snapshot);
  const instances = instancesByRow(snapshot.spans);
  for (const [rowId, row] of rows) {
    if (!row.successCardinality.startsWith("1")) continue;
    const count = instances.get(rowId)?.length ?? 0;
    if (row.successCardinality.includes("per attempt")) {
      const attempts = instances.get(rowId) ?? [];
      const seen = new Set<string>();
      for (const span of attempts) {
        const attempt = span.attributes["attempt.id"];
        if (typeof attempt !== "string") failure("attempt-cardinality", `${rowId} needs attempt.id for its per-attempt cardinality`);
        if (seen.has(attempt)) failure("cardinality-duplicate", `${rowId} repeats attempt ${attempt}`);
        seen.add(attempt);
      }
      continue;
    }
    // A conditional/terminal row may legitimately be absent. Repeated
    // caller work is not a duplicate, however, when it is the manifest's
    // explicit retry sequence. In particular S11/S12 can have a second
    // append attempt after a failed member; collapsing it would make the
    // partial-handoff trace lie about the actual remote work.
    if (count > 1) {
      const retryIndexes = instances.get(rowId)!
        .map((span) => span.attributes["retry.index"])
        .filter((value): value is number => typeof value === "number");
      const distinct = [...new Set(retryIndexes)].sort((left, right) => left - right);
      const sequential = distinct.length > 0 && distinct.every((value, index) => value === index);
      if (retryIndexes.length !== count || !sequential) {
        failure("cardinality-duplicate", `${rowId} has cardinality ${count} without a 0..n retry.index sequence`);
      }
    }
  }
}

function verifyStructure(snapshot: CommitTraceSnapshot): void {
  const rows = rowMap(snapshot);
  const byRoot = new Map<string, CommitTraceSpan[]>();
  for (const span of snapshot.spans) {
    const row = rows.get(span.rowId);
    if (row === undefined) failure("row-unknown", `unknown row ${span.rowId}`);
    if (
      span.schema !== snapshot.schema ||
      span.span !== row.span ||
      span.emitter !== row.emitter ||
      span.logicalParent !== row.logicalParent
    ) {
      failure("row-shape", `row ${span.rowId} differs from the manifest authority`);
    }
    if (span.endMs < span.startMs) failure("time-negative", `${span.rowId} ends before it starts`);
    if (span.endMs === span.startMs && (span.zeroDurationPlatformLimited !== true || span.present !== true)) {
      failure("zero-duration-missing", `${span.rowId} needs present=true and zeroDurationPlatformLimited=true for zero duration`);
    }
    verifyAttributes(span, row);
    const list = byRoot.get(span.rootId) ?? [];
    list.push(span);
    byRoot.set(span.rootId, list);
  }

  for (const [rootId, spans] of byRoot) {
    // S16 is a provider-linked remote-invocation universe. It is correlated
    // through Cloudflare's active async context, not a synthetic local root.
    if (spans.every((span) => span.logicalParent === "provider-subrequest")) continue;
    for (const child of spans) {
      if (child.logicalParent === null || child.logicalParent === "provider-subrequest") continue;
      const parents = spans.filter((candidate) => candidate.rowId === child.logicalParent);
      if (parents.length === 0) {
        const otherRoot = snapshot.spans.find((candidate) => candidate.rootId !== rootId && candidate.rowId === child.logicalParent);
        if (otherRoot !== undefined) failure("cross-root-parent", `${child.rowId} points to parent ${child.logicalParent} in another root`);
        failure("parent-missing", `${child.rowId} lacks parent ${child.logicalParent}`);
      }
      const parent = parents.find((candidate) =>
        child.startMs >= candidate.startMs && child.endMs <= candidate.endMs,
      );
      if (parent === undefined) {
        const temporal = parents[0]!;
        if (child.startMs < temporal.startMs || child.endMs > temporal.endMs) {
          failure("parent-containment", `${child.rowId} is not temporally contained by ${child.logicalParent}`);
        }
        failure("parent-missing", `${child.rowId} cannot resolve parent ${child.logicalParent}`);
      }
      if (parent.clockDomain !== child.clockDomain) {
        failure("clock-domain-mix", `${child.rowId} mixes ${child.clockDomain} with parent ${parent.clockDomain}`);
      }
    }
    const roots = spans.filter((span) => span.logicalParent === null);
    if (roots.length !== 1) failure("root-cardinality", `trace root ${rootId} has ${roots.length} roots`);
  }

  const repairLeases = snapshot.spans.filter((span) => span.rowId === "X02");
  for (const item of snapshot.spans.filter((span) => span.rowId === "X03e")) {
    const leaseId = item.attributes["repair.lease.id"];
    const tagHash = item.attributes["tag.key_hash"];
    if (typeof leaseId !== "string" || typeof tagHash !== "string") {
      failure("repair-link-attributes", "X03e needs repair.lease.id and tag.key_hash");
    }
    if (!repairLeases.some((lease) => lease.attributes["repair.lease.id"] === leaseId && lease.attributes["tag.key_hash"] === tagHash)) {
      failure("repair-link", "X03e must link to an X02 lease by repair.lease.id and tag.key_hash");
    }
  }
}

export function verifyCommitTrace(
  snapshot: CommitTraceSnapshot,
  options: CommitTraceVerificationOptions = {},
): Readonly<{ unattributed?: UnattributedRatio; rows: number }> {
  verifyStructure(snapshot);
  verifyDeclaredCardinality(snapshot);
  verifyBoundary(snapshot, options);
  if (options.accepted === true) {
    const unattributed = calculateUnattributedRatio(snapshot);
    if (unattributed.unattributedRatio > 0.05) {
      failure("unattributed-over-budget", `unattributed ratio ${unattributed.unattributedRatio} exceeds 0.05`);
    }
    return Object.freeze({ rows: snapshot.spans.length, unattributed });
  }
  return Object.freeze({ rows: snapshot.spans.length });
}
