import commitTraceManifestJson from "../../../../contracts/commit-trace-manifest.json";
import { calculateUnattributedRatio, type UnattributedRatio } from "./AttributionRatio";
import type { DurableObjectHandlerObservation } from "./ObservationStream";

/**
 * Trace-only commit attribution support.
 *
 * This module deliberately has no dependency on the commit protocol or on
 * Durable Object storage. It turns the host-owned manifest into the runtime
 * vocabulary and delegates real parentage to Cloudflare's active async
 * tracing context. The in-memory records are an observation adapter used by
 * unit tests and the B0 evidence tooling; they never cross a public wire.
 */

export type CommitTraceSchema =
  | "sdt.commit/v1"
  | "sdt.commit/v2"
  | "sdt.commit.reconcile/v1"
  | "sdt.commit.repair/v1";

export type CommitTraceFace =
  | "pre-admission"
  | "accepted"
  | "reconcile-root"
  | "repair-root";

export type CommitTraceActorClass =
  | "ROOT"
  | "BOOTSTRAP"
  | "JOURNAL"
  | "ALLOCATOR"
  | "TAG"
  | "REPAIR";

export type TraceAttributeValue = string | number | boolean;

export interface CommitTraceProviderAdapter {
  readonly scriptVersion?: string;
  readonly colo?: string;
  /** Observed only. G30 must never use this in a control branch. */
  readonly placement?: string;
  readonly cpuTimeMs?: number;
  readonly wallTimeMs?: number;
}

export interface NativeTraceSpan {
  readonly isTraced?: boolean;
  setAttribute(key: string, value: TraceAttributeValue | undefined): unknown;
}

export interface NativeTracing {
  enterSpan<T, A extends unknown[]>(
    name: string,
    callback: (span: NativeTraceSpan, ...args: A) => T,
    ...args: A
  ): T;
}

const NOOP_NATIVE_TRACE_SPAN: NativeTraceSpan = Object.freeze({
  isTraced: false,
  setAttribute: () => undefined,
});

/**
 * The portable runtime must remain importable from Node-side provider and
 * contract tooling.  Cloudflare-only entrypoints inject the real tracer;
 * this adapter preserves the trace-only, fail-open contract everywhere else.
 */
export const noOpNativeTracing: NativeTracing = Object.freeze({
  enterSpan<T, A extends unknown[]>(
    _name: string,
    callback: (span: NativeTraceSpan, ...args: A) => T,
    ...args: A
  ): T {
    return callback(NOOP_NATIVE_TRACE_SPAN, ...args);
  },
});

/**
 * A request handler can use the platform context without importing the
 * Cloudflare-only module into the portable Node/provider graph.
 */
export function nativeTracingFromContext(
  context?: Pick<ExecutionContext, "tracing">,
): NativeTracing {
  const native = context?.tracing as unknown as NativeTracing | undefined;
  return native ?? noOpNativeTracing;
}

export interface CommitTraceClock {
  now(): number;
}

export interface CommitTraceSpan {
  readonly rowId: string;
  readonly schema: CommitTraceSchema;
  readonly face: CommitTraceFace;
  readonly span: string;
  readonly emitter: string;
  readonly logicalParent: string | null;
  readonly rootId: string;
  readonly clockDomain: "caller" | "callee";
  readonly startMs: number;
  readonly endMs: number;
  readonly present: true;
  readonly attributes: Readonly<Record<string, TraceAttributeValue>>;
  readonly zeroDurationPlatformLimited: boolean;
}

export interface CommitTraceSnapshot {
  readonly schema: CommitTraceSchema;
  readonly rootId: string;
  readonly correlationId: string;
  readonly serviceId: string;
  readonly spans: readonly CommitTraceSpan[];
  readonly provider: CommitTraceProviderAdapter;
  readonly diagnostics: Readonly<Record<string, TraceAttributeValue>>;
  /** Private evidence/export field; never a public V1 response member. */
  readonly unattributed?: UnattributedRatio;
  readonly attributionGatePassed?: boolean;
  /**
   * In-process verifier result. This is an observation adapter for a trace
   * sink/exporter only; it is never copied onto a Response or a native span.
   * A verifier finding is deliberately fail-open so measurement cannot alter
   * the commit protocol it observes.
   */
  readonly runtimeVerification?: Readonly<{ readonly passed: boolean; readonly code?: string }>;
}

export interface CommitTraceSink {
  record(snapshot: CommitTraceSnapshot): void;
}

/** Structural verifier hook supplied by the owning runtime module. */
export interface CommitTraceRuntimeVerifier {
  verify(snapshot: CommitTraceSnapshot): void;
}

export interface CommitTraceOptions {
  readonly schema: CommitTraceSchema;
  readonly correlationId: string;
  readonly serviceId: string;
  readonly provider?: CommitTraceProviderAdapter;
  readonly nativeTracing?: NativeTracing;
  readonly sink?: CommitTraceSink;
  readonly clock?: CommitTraceClock;
  readonly diagnostics?: Readonly<Record<string, TraceAttributeValue>>;
  readonly runtimeVerifier?: CommitTraceRuntimeVerifier;
  /**
   * Optional observation-only work scheduled after the response object has
   * been assembled but before the root callback unwinds.  Production's
   * `waitUntil` integration is deliberately outside this trace model: the
   * returned promise is detached, so it can neither extend S00 nor alter the
   * commit result.  The seam lets the runtime oracle prove that boundary
   * without adding an ExecutionContext or a V1 wire field to CommitWorker.
   */
  readonly scheduleDetachedObservation?: () => Promise<void> | void;
  /**
   * Attribution observes an existing protocol.  Production callers keep this
   * enabled so a tracing/exporter defect can never reject, retry, or replay a
   * commit.  Focused unit or mutation tests may opt into strict behavior to
   * assert a local schema guard directly.
   */
  readonly failOpen?: boolean;
}

interface ManifestRow {
  readonly rowId: string;
  readonly span: string;
  readonly emitter: string;
  readonly logicalParent: string | null;
  readonly coverage: boolean;
  readonly kind: string;
}

interface ManifestAttribute {
  readonly type: string;
  readonly values?: readonly string[];
  readonly faces: Readonly<Record<CommitTraceFace, "required" | "optional" | "forbidden">>;
  /** Optional row-level scope layered on top of the schema face. */
  readonly rowScope?: readonly string[];
  /** A fact that is only available while its still-open root is active. */
  readonly factDerived?: boolean;
}

interface ManifestBoundary {
  readonly name: string;
  readonly requiredRows: readonly string[];
  readonly conditionalRows: readonly unknown[];
  readonly forbiddenRows: readonly string[];
}

interface TraceManifest {
  readonly schemas: Readonly<Record<CommitTraceSchema, {
    readonly rows: readonly ManifestRow[];
    readonly boundaries?: readonly ManifestBoundary[];
    readonly recoveryDag?: Readonly<Record<string, unknown>>;
    readonly terminalAtEntryBoundary?: Readonly<{ name?: string }>;
  }>>;
  readonly attributeMatrix: {
    readonly faces: readonly CommitTraceFace[];
    readonly states: readonly string[];
    readonly attributes: Readonly<Record<string, ManifestAttribute>>;
  };
}

const manifest = commitTraceManifestJson as unknown as TraceManifest;
const DEFAULT_CLOCK: CommitTraceClock = { now: () => Date.now() };
const RAW_TAG_KEY = /(^|[._])tag($|[._])/i;
const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function rowFor(schema: CommitTraceSchema, rowId: string): ManifestRow {
  const schemaRows = manifest.schemas[schema]?.rows;
  const row = schemaRows?.find((entry) => entry.rowId === rowId);
  if (row === undefined) {
    throw new Error(`Commit trace row ${rowId} is not defined by ${schema}`);
  }
  return row;
}

function faceState(attribute: string, face: CommitTraceFace): "required" | "optional" | "forbidden" {
  const matrix = manifest.attributeMatrix.attributes[attribute];
  if (matrix === undefined) {
    throw new Error(`Commit trace attribute ${attribute} is not declared by the authority matrix`);
  }
  const state = matrix.faces[face];
  if (state !== "required" && state !== "optional" && state !== "forbidden") {
    throw new Error(`Commit trace matrix omits face ${face} for ${attribute}`);
  }
  return state;
}

function rowScopedState(
  declaration: ManifestAttribute,
  face: CommitTraceFace,
  rowId: string,
): "required" | "optional" | "forbidden" {
  if (declaration.rowScope !== undefined && !declaration.rowScope.includes(rowId)) return "forbidden";
  return declaration.faces[face];
}

function asTraceValue(value: unknown, name: string): TraceAttributeValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  throw new Error(`Commit trace attribute ${name} must be scalar`);
}

/**
 * Keep the callback-boundary emission path subject to the same typed matrix
 * as the in-memory/export verifiers. A malformed observation remains
 * fail-open for the commit itself, but it must never be emitted as a
 * schema-conformant custom span.
 */
function assertAttributeValue(
  value: TraceAttributeValue,
  declaration: ManifestAttribute,
  key: string,
): void {
  const type = declaration.type;
  if (type === "hex64") {
    if (typeof value !== "string" || !HEX64.test(value)) throw new Error(`Commit trace attribute ${key} must be lower-case 64-hex`);
    return;
  }
  if (type === "uuid") {
    if (typeof value !== "string" || !UUID.test(value)) throw new Error(`Commit trace attribute ${key} must be a UUID`);
    return;
  }
  if (type === "boolean") {
    if (typeof value !== "boolean") throw new Error(`Commit trace attribute ${key} must be boolean`);
    return;
  }
  if (type === "integer" || type === "non-negative-integer") {
    if (typeof value !== "number" || !Number.isInteger(value) || (type === "non-negative-integer" && value < 0)) {
      throw new Error(`Commit trace attribute ${key} must be ${type}`);
    }
    return;
  }
  if (typeof value !== "string") throw new Error(`Commit trace attribute ${key} must be a string`);
  if (type === "enum-from-manifest-recovery") {
    const reconcile = manifest.schemas["sdt.commit.reconcile/v1"];
    const recoveryKinds = Object.keys(reconcile.recoveryDag ?? {});
    const terminalAtEntry = reconcile.terminalAtEntryBoundary?.name;
    if (!recoveryKinds.includes(value) && value !== terminalAtEntry) {
      throw new Error(`Commit trace attribute ${key} is not a manifest recovery kind`);
    }
    return;
  }
  if (declaration.values !== undefined && !declaration.values.includes(value)) {
    throw new Error(`Commit trace attribute ${key} is not manifest-declared`);
  }
}

function assertAttributeTypes(attributes: Readonly<Record<string, TraceAttributeValue>>): void {
  for (const [key, value] of Object.entries(attributes)) {
    const declaration = manifest.attributeMatrix.attributes[key];
    if (declaration === undefined) continue;
    assertAttributeValue(value, declaration, key);
  }
}

function assertNoRawTagAttributes(attributes: Readonly<Record<string, TraceAttributeValue>>): void {
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "tag.key_hash") continue;
    if (RAW_TAG_KEY.test(key)) {
      throw new Error(`Commit trace forbids raw tag attribute ${key}=${String(value)}`);
    }
  }
}

/**
 * Stable, non-authoritative, non-cryptographic observation key. Four
 * independent FNV-1a lanes yield the lower-case 64-hex spelling mandated by
 * the trace schema without making the key a protocol or storage authority.
 */
export function stableTraceHash(value: string): string {
  const masks = [
    0xcbf29ce484222325n,
    0x9e3779b185ebca87n,
    0x84222325cbf29ce4n,
    0x100000001b3n,
  ];
  const prime = 0x100000001b3n;
  const modulus = (1n << 64n) - 1n;
  return masks.map((seed, index) => {
    let hash = seed;
    for (let offset = 0; offset < value.length; offset += 1) {
      hash ^= BigInt(value.charCodeAt(offset) + index);
      hash = (hash * prime) & modulus;
    }
    return hash.toString(16).padStart(16, "0");
  }).join("");
}

/**
 * The DO request bodies already carry attemptId, while G30 cannot add a
 * correlation wire field. This deterministic, distinct observation key lets
 * independently exported caller/callee spans be joined without treating
 * attempt.id and correlation.id as the same attribute.
 */
export function correlationIdForAttempt(attemptId: string): string {
  return `corr-${stableTraceHash(`sdt.commit/v1:${attemptId}`)}`;
}

export function createTraceCorrelationId(): string {
  return crypto.randomUUID();
}

export function traceManifest(): TraceManifest {
  return manifest;
}

export interface CommitTraceSpanOptions {
  readonly face: CommitTraceFace;
  readonly actorClass: CommitTraceActorClass;
  readonly actorKey?: string;
  readonly attemptId?: string;
  readonly outcome?: string;
  readonly httpStatus?: number;
  readonly phaseOrdinal?: number;
  readonly retryIndex?: number;
  readonly memberIndex?: number;
  readonly tag?: string;
  readonly attributes?: Readonly<Record<string, TraceAttributeValue>>;
  readonly zeroDurationPlatformLimited?: boolean;
  readonly clockDomain?: "caller" | "callee";
}

interface ScopeState {
  readonly rootId: string;
  readonly currentRowId: string | null;
  readonly face: CommitTraceFace;
  readonly actorClass: CommitTraceActorClass;
  readonly actorKey?: string;
  readonly attemptId?: string;
  readonly clockDomain: "caller" | "callee";
  /** A failed observation subtree invokes application work without tracing. */
  readonly observationDisabled?: boolean;
}

/**
 * A scope is the test/evidence adapter's reflection of callback nesting. It
 * does not accept a native span context or a parent span ID; Cloudflare owns
 * real parentage through enterSpan's active async context.
 */
export class CommitTraceScope {
  constructor(
    private readonly trace: CommitTrace,
    private readonly state: ScopeState,
  ) {}

  accepted(attemptId: string): CommitTraceScope {
    return new CommitTraceScope(this.trace, {
      ...this.state,
      face: "accepted",
      attemptId,
    });
  }

  withActor(
    actorClass: CommitTraceActorClass,
    actorKey: string,
    clockDomain: "caller" | "callee" = this.state.clockDomain,
  ): CommitTraceScope {
    return new CommitTraceScope(this.trace, {
      ...this.state,
      actorClass,
      actorKey,
      clockDomain,
    });
  }

  fork(): CommitTraceScope {
    return new CommitTraceScope(this.trace, { ...this.state });
  }

  async span<T>(
    rowId: string,
    options: Omit<CommitTraceSpanOptions, "face" | "actorClass" | "actorKey" | "attemptId" | "clockDomain"> & {
      readonly face?: CommitTraceFace;
      readonly actorClass?: CommitTraceActorClass;
      readonly actorKey?: string;
      readonly attemptId?: string;
      readonly clockDomain?: "caller" | "callee";
    },
    callback: (scope: CommitTraceScope) => T | Promise<T>,
  ): Promise<T> {
    return this.trace.span(this.state, rowId, {
      face: options.face ?? this.state.face,
      actorClass: options.actorClass ?? this.state.actorClass,
      ...(options.actorKey === undefined && this.state.actorKey === undefined ? {} : { actorKey: options.actorKey ?? this.state.actorKey }),
      ...(options.attemptId === undefined && this.state.attemptId === undefined ? {} : { attemptId: options.attemptId ?? this.state.attemptId }),
      clockDomain: options.clockDomain ?? this.state.clockDomain,
      ...(options.outcome === undefined ? {} : { outcome: options.outcome }),
      ...(options.httpStatus === undefined ? {} : { httpStatus: options.httpStatus }),
      ...(options.phaseOrdinal === undefined ? {} : { phaseOrdinal: options.phaseOrdinal }),
      ...(options.retryIndex === undefined ? {} : { retryIndex: options.retryIndex }),
      ...(options.memberIndex === undefined ? {} : { memberIndex: options.memberIndex }),
      ...(options.tag === undefined ? {} : { tag: options.tag }),
      ...(options.attributes === undefined ? {} : { attributes: options.attributes }),
      ...(options.zeroDurationPlatformLimited === undefined ? {} : { zeroDurationPlatformLimited: options.zeroDurationPlatformLimited }),
    }, callback);
  }
}

export class CommitTrace {
  private readonly spans: CommitTraceSpan[] = [];
  private readonly provider: CommitTraceProviderAdapter;
  private readonly diagnostics: Readonly<Record<string, TraceAttributeValue>>;
  private correlationId: string;
  private activeRootId: string | undefined;
  private activeRootRecord: CommitTraceSpan | undefined;
  private activeRootNative: NativeTraceSpan | undefined;
  private nextRootIndex = 0;
  private runtimeVerification: CommitTraceSnapshot["runtimeVerification"] | undefined;
  private observationFailureCode: string | undefined;

  constructor(private readonly options: CommitTraceOptions) {
    this.provider = Object.freeze({ ...(options.provider ?? {}) });
    this.diagnostics = Object.freeze({ ...(options.diagnostics ?? {}) });
    this.correlationId = options.correlationId;
  }

  async root<T>(
    rowId: string,
    options: Omit<CommitTraceSpanOptions, "face" | "actorClass"> & {
      readonly face?: CommitTraceFace;
      readonly actorClass?: CommitTraceActorClass;
    },
    callback: (scope: CommitTraceScope) => T | Promise<T>,
  ): Promise<T> {
    if (this.activeRootId !== undefined) {
      throw new Error("Commit trace root is already active");
    }
    const rootId = `${this.options.correlationId}:${this.nextRootIndex++}`;
    const state: ScopeState = {
      rootId,
      currentRowId: null,
      face: options.face ?? "pre-admission",
      actorClass: options.actorClass ?? "ROOT",
      ...(options.actorKey === undefined ? {} : { actorKey: options.actorKey }),
      ...(options.attemptId === undefined ? {} : { attemptId: options.attemptId }),
      clockDomain: options.clockDomain ?? "caller",
    };
    this.activeRootId = rootId;
    try {
      return await this.span(state, rowId, {
        face: state.face,
        actorClass: state.actorClass,
        ...(state.actorKey === undefined ? {} : { actorKey: state.actorKey }),
        ...(state.attemptId === undefined ? {} : { attemptId: state.attemptId }),
        clockDomain: state.clockDomain,
        ...(options.outcome === undefined ? {} : { outcome: options.outcome }),
        ...(options.httpStatus === undefined ? {} : { httpStatus: options.httpStatus }),
        ...(options.phaseOrdinal === undefined ? {} : { phaseOrdinal: options.phaseOrdinal }),
        ...(options.retryIndex === undefined ? {} : { retryIndex: options.retryIndex }),
        ...(options.memberIndex === undefined ? {} : { memberIndex: options.memberIndex }),
        ...(options.tag === undefined ? {} : { tag: options.tag }),
        ...(options.attributes === undefined ? {} : { attributes: options.attributes }),
        ...(options.zeroDurationPlatformLimited === undefined ? {} : { zeroDurationPlatformLimited: options.zeroDurationPlatformLimited }),
      }, async (scope) => {
        const result = await callback(scope);
        // This has the same containment rule as a Worker waitUntil task: it
        // is spawned while the response is being finalized, but is never
        // awaited by S00.  The production entrypoint intentionally supplies
        // no callback here; exporters may use it without touching protocol.
        void this.scheduleDetachedObservation();
        return result;
      });
    } finally {
      this.activeRootId = undefined;
      this.activeRootRecord = undefined;
      this.activeRootNative = undefined;
      // A sink/exporter error is observation-only.  It must not replace the
      // response or durable outcome produced by the callback above.
      this.publishSnapshot();
    }
  }

  snapshot(): CommitTraceSnapshot {
    const rootId = this.spans.find((span) => span.logicalParent === null)?.rootId ?? `${this.correlationId}:none`;
    const spans = Object.freeze(this.spans.map((span) => Object.freeze({
      ...span,
      attributes: Object.freeze({ ...span.attributes }),
    })));
    const accepted = this.options.schema === "sdt.commit/v1" && spans.some((span) => typeof span.attributes["attempt.id"] === "string");
    const base = {
      schema: this.options.schema,
      rootId,
      correlationId: this.correlationId,
      serviceId: this.options.serviceId,
      spans,
      provider: this.provider,
      diagnostics: this.diagnostics,
      ...(this.runtimeVerification === undefined ? {} : { runtimeVerification: this.runtimeVerification }),
    } as const;
    if (!accepted) return Object.freeze(base);
    try {
      const unattributed = calculateUnattributedRatio(base);
      return Object.freeze({
        ...base,
        unattributed,
        attributionGatePassed: unattributed.unattributedRatio <= 0.05,
      });
    } catch (error) {
      // A malformed observation must be visible to evidence consumers, but
      // its calculation cannot become a new commit failure.
      this.noteObservationFailure(error);
      return Object.freeze({
        ...base,
        runtimeVerification: this.observationVerification(),
      });
    }
  }

  /**
   * A request becomes accepted after admission. Updating the still-active root
   * preserves the single root correlation while S01 remains an honest
   * pre-admission record with no attempt.id.
   */
  markAccepted(attemptId: string): void {
    if (this.activeRootRecord === undefined) return;
    const correlationId = correlationIdForAttempt(attemptId);
    // S00 begins before admission, but the accepted trace's root is the
    // accepted face: S01 is the separately retained pre-admission row.  Keep
    // the two phases distinct rather than leaking an attempt ID into a
    // pre-admission record (or leaving the accepted root without one).
    const attributes = {
      ...this.activeRootRecord.attributes,
      "correlation.id": correlationId,
      "attempt.id": attemptId,
      outcome: "accepted",
    };
    const record = Object.freeze({
      ...this.activeRootRecord,
      face: "accepted" as const,
      attributes: Object.freeze(attributes),
    });
    const index = this.spans.indexOf(this.activeRootRecord);
    if (index >= 0) this.spans[index] = record;
    this.activeRootRecord = record;
    this.correlationId = correlationId;
    this.setNativeAttributes(this.activeRootNative, {
      "correlation.id": correlationId,
      "attempt.id": attemptId,
      outcome: "accepted",
    });
  }

  async span<T>(
    state: ScopeState,
    rowId: string,
    options: CommitTraceSpanOptions,
    callback: (scope: CommitTraceScope) => T | Promise<T>,
  ): Promise<T> {
    const disabledChild = () => new CommitTraceScope(this, {
      rootId: state.rootId,
      currentRowId: rowId,
      face: options.face,
      actorClass: options.actorClass,
      ...(options.actorKey === undefined ? {} : { actorKey: options.actorKey }),
      ...(options.attemptId === undefined ? {} : { attemptId: options.attemptId }),
      clockDomain: options.clockDomain ?? state.clockDomain,
      observationDisabled: true,
    });
    if (state.observationDisabled === true) return callback(disabledChild());

    let row: ManifestRow;
    let attributes: Record<string, TraceAttributeValue>;
    try {
      row = rowFor(this.options.schema, rowId);
      if (row.logicalParent !== state.currentRowId) {
        throw new Error(`Commit trace row ${rowId} must run under ${row.logicalParent ?? "a root"}, observed ${state.currentRowId ?? "a root"}`);
      }
      if (row.logicalParent === null && this.activeRootId !== state.rootId) {
        throw new Error(`Commit trace root ${rowId} is not active`);
      }
      attributes = this.attributesFor(row, options);
    } catch (error) {
      if (!this.isFailOpen()) throw error;
      this.noteObservationFailure(error);
      return callback(disabledChild());
    }
    const execute = async (native: NativeTraceSpan | undefined): Promise<T> => {
      this.setNativeAttributes(native, attributes);
      const startMs = this.now();
      const record: CommitTraceSpan = {
        rowId,
        schema: this.options.schema,
        face: options.face,
        span: row.span,
        emitter: row.emitter,
        logicalParent: row.logicalParent,
        rootId: state.rootId,
        clockDomain: options.clockDomain ?? state.clockDomain,
        startMs,
        endMs: startMs,
        present: true,
        attributes: Object.freeze({ ...attributes }),
        zeroDurationPlatformLimited: options.zeroDurationPlatformLimited ?? false,
      };
      this.spans.push(record);
      if (row.logicalParent === null) {
        this.activeRootRecord = record;
        this.activeRootNative = native;
      }
      const child = new CommitTraceScope(this, {
        rootId: state.rootId,
        currentRowId: rowId,
        face: options.face,
        actorClass: options.actorClass,
        ...(options.actorKey === undefined ? {} : { actorKey: options.actorKey }),
        ...(options.attemptId === undefined ? {} : { attemptId: options.attemptId }),
        clockDomain: options.clockDomain ?? state.clockDomain,
      });
      try {
        const result = await callback(child);
        const final = this.finish(record, native, this.outcomeFromResult(result, options.outcome, options.httpStatus));
        if (row.logicalParent === null) this.activeRootRecord = final;
        return result;
      } catch (failure) {
        const final = this.finish(record, native, {
          outcome: options.outcome ?? "exception",
          ...(options.httpStatus === undefined ? {} : { httpStatus: options.httpStatus }),
        });
        if (row.logicalParent === null) this.activeRootRecord = final;
        throw failure;
      }
    };
    const native = this.options.nativeTracing;
    return native === undefined
      ? execute(undefined)
      : this.enterNativeSpan(native, row.span, execute);
  }

  private finish(
    existing: CommitTraceSpan,
    native: NativeTraceSpan | undefined,
    outcome: { readonly outcome?: string; readonly httpStatus?: number },
  ): CommitTraceSpan {
    // markAccepted replaces the still-open S00 record so it can move from
    // the pre-admission to accepted face. Finish the replacement rather than
    // silently leaving its terminal outcome behind in the in-memory evidence
    // adapter. Normal spans retain identity and follow the fast path.
    const current = this.activeRootRecord !== undefined && existing.logicalParent === null
      ? this.activeRootRecord
      : existing;
    const attributes = {
      ...current.attributes,
      ...(outcome?.outcome === undefined ? {} : { outcome: outcome.outcome }),
      ...(outcome?.httpStatus === undefined ? {} : { "http.status": outcome.httpStatus }),
    };
    const endMs = this.now();
    const next = Object.freeze({
      ...current,
      endMs,
      // Cloudflare may quantize custom spans to a zero-length interval. The
      // row remains present; duration is not used as a proxy for emission.
      zeroDurationPlatformLimited: current.zeroDurationPlatformLimited || endMs === current.startMs,
      attributes: Object.freeze(attributes),
    });
    const index = this.spans.indexOf(current);
    if (index >= 0) this.spans[index] = next;
    this.setNativeAttributes(native, {
      ...(outcome?.outcome === undefined ? {} : { outcome: outcome.outcome }),
      ...(outcome?.httpStatus === undefined ? {} : { "http.status": outcome.httpStatus }),
    });
    return next;
  }

  private attributesFor(row: ManifestRow, options: CommitTraceSpanOptions): Record<string, TraceAttributeValue> {
    const attributes: Record<string, TraceAttributeValue> = {
      "schema.version": this.options.schema,
      "correlation.id": this.correlationId,
      "service.id": this.options.serviceId,
      "actor.class": options.actorClass,
      operation: row.span,
      "span.kind": row.kind,
      outcome: options.outcome ?? "in-progress",
    };
    if (options.actorKey !== undefined) attributes["actor.key_hash"] = stableTraceHash(options.actorKey);
    if (options.attemptId !== undefined) attributes["attempt.id"] = options.attemptId;
    if (options.phaseOrdinal !== undefined) attributes["phase.ordinal"] = options.phaseOrdinal;
    if (options.retryIndex !== undefined) attributes["retry.index"] = options.retryIndex;
    if (options.memberIndex !== undefined) attributes["member.index"] = options.memberIndex;
    if (options.tag !== undefined) attributes["tag.key_hash"] = stableTraceHash(options.tag);
    if (options.httpStatus !== undefined) attributes["http.status"] = options.httpStatus;
    if (this.provider.scriptVersion !== undefined) attributes["script.version"] = this.provider.scriptVersion;
    if (this.provider.colo !== undefined) attributes.colo = this.provider.colo;
    if (this.provider.placement !== undefined) attributes.placement = this.provider.placement;
    for (const [key, value] of Object.entries(options.attributes ?? {})) {
      attributes[key] = asTraceValue(value, key);
    }
    assertNoRawTagAttributes(attributes);
    for (const [attribute, declaration] of Object.entries(manifest.attributeMatrix.attributes)) {
      const present = hasOwn(attributes, attribute);
      const state = rowScopedState(declaration, options.face, row.rowId);
      if (state === "required" && !present) {
        throw new Error(`Commit trace row ${row.rowId} is missing required ${attribute} on ${options.face}`);
      }
      if (state === "forbidden" && present) {
        throw new Error(`Commit trace row ${row.rowId} must not emit ${attribute} on ${options.face}`);
      }
    }
    // Every emitted schema attribute must have an authority-matrix row,
    // except diagnostics which intentionally live out-of-band in snapshots.
    for (const attribute of Object.keys(attributes)) {
      faceState(attribute, options.face);
    }
    assertAttributeTypes(attributes);
    return attributes;
  }

  private setNativeAttributes(native: NativeTraceSpan | undefined, attributes: Readonly<Record<string, TraceAttributeValue>>): void {
    if (native === undefined || native.isTraced === false) return;
    for (const [key, value] of Object.entries(attributes)) {
      try {
        native.setAttribute(key, value);
      } catch (error) {
        this.noteObservationFailure(error);
      }
    }
  }

  private outcomeFromResult(
    result: unknown,
    explicit: string | undefined,
    fallbackHttpStatus: number | undefined,
  ): { readonly outcome: string; readonly httpStatus?: number } {
    const response = result instanceof Response
      ? result
      : typeof result === "object" && result !== null && "response" in result && (result as { response?: unknown }).response instanceof Response
        ? (result as { response: Response }).response
        : undefined;
    return {
      outcome: explicit ?? (response === undefined ? "success" : response.ok ? "success" : `http-${response.status}`),
      ...(response === undefined ? fallbackHttpStatus === undefined ? {} : { httpStatus: fallbackHttpStatus } : { httpStatus: response.status }),
    };
  }

  private clock(): CommitTraceClock {
    return this.options.clock ?? DEFAULT_CLOCK;
  }

  private now(): number {
    try {
      return this.clock().now();
    } catch (error) {
      this.noteObservationFailure(error);
      // The timestamp is evidence-only.  Fall back to the process clock so
      // a broken injected/provider clock cannot change the observed commit.
      return Date.now();
    }
  }

  private publishSnapshot(): void {
    let beforeVerification: CommitTraceSnapshot;
    try {
      beforeVerification = this.snapshot();
    } catch (error) {
      this.noteObservationFailure(error);
      return;
    }
    if (this.options.runtimeVerifier !== undefined) {
      try {
        if (this.observationFailureCode !== undefined) {
          this.runtimeVerification = this.observationVerification();
        } else {
        this.options.runtimeVerifier.verify(beforeVerification);
        this.runtimeVerification = Object.freeze({ passed: true });
        }
      } catch (error) {
        // G30 observes the existing protocol. A trace defect must be retained
        // for the sink/evidence lane but can never turn a successful commit
        // into a new rejection or retry.
        const code = typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : "runtime-verifier-error";
        this.runtimeVerification = Object.freeze({ passed: false, code });
      }
    }
    try {
      this.options.sink?.record(this.snapshot());
    } catch (error) {
      // Export/sink loss is recorded in-process when a later observer asks
      // for a snapshot, but it can never replace the application result.
      this.noteObservationFailure(error);
    }
  }

  /**
   * A telemetry/export failure is retained as an observation failure, but a
   * detached task is never allowed to hold the root open or replace the
   * application's Response.  Keeping this as a method makes the exact
   * `void` call at root finalization mutation-testable.
   */
  private async scheduleDetachedObservation(): Promise<void> {
    try {
      await this.options.scheduleDetachedObservation?.();
    } catch (error) {
      this.noteObservationFailure(error);
    }
  }

  private isFailOpen(): boolean {
    return this.options.failOpen !== false;
  }

  private observationVerification(): Readonly<{ readonly passed: false; readonly code: string }> {
    return Object.freeze({ passed: false, code: this.observationFailureCode ?? "trace-observation-error" });
  }

  private noteObservationFailure(error: unknown): void {
    if (this.observationFailureCode !== undefined) return;
    this.observationFailureCode = typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "trace-observation-error";
    this.runtimeVerification = this.observationVerification();
  }

  /**
   * If a platform tracer declines a span before invoking its callback, run
   * the application callback once without a span.  Once the callback has
   * started, its own error remains authoritative and is never replayed.
   */
  private async enterNativeSpan<T>(
    native: NativeTracing,
    name: string,
    callback: (span: NativeTraceSpan | undefined) => Promise<T>,
  ): Promise<T> {
    let callbackStarted = false;
    const wrapped = (span: NativeTraceSpan): Promise<T> => {
      callbackStarted = true;
      return callback(span);
    };
    try {
      const result = native.enterSpan(name, wrapped);
      if (!callbackStarted) {
        this.noteObservationFailure(new Error("native tracer returned without invoking callback"));
        return callback(undefined);
      }
      return await result;
    } catch (error) {
      if (callbackStarted) throw error;
      this.noteObservationFailure(error);
      return callback(undefined);
    }
  }
}

export interface DurableObjectActivationObservation {
  readonly activationId: string;
  readonly first: boolean;
  /** Monotonic-in-practice wall-clock observation; never persisted. */
  readonly handlerStartedAtMs: number;
  readonly constructorToHandlerMs: number;
}

/**
 * Constructor-only activation observation. It never touches Durable Object
 * storage and callers must invoke beginHandler synchronously before awaiting.
 */
export class DurableObjectActivation {
  readonly activationId = crypto.randomUUID();
  private readonly constructedAtMs = Date.now();
  private first = true;

  beginHandler(): DurableObjectActivationObservation {
    const first = this.first;
    this.first = false;
    const handlerStartedAtMs = Date.now();
    return Object.freeze({
      activationId: this.activationId,
      first,
      handlerStartedAtMs,
      constructorToHandlerMs: Math.max(0, handlerStartedAtMs - this.constructedAtMs),
    });
  }
}

// Workerd forbids random generation while evaluating a module. Keep the
// isolate identity module-scoped once observed, but create it at the first
// request-handler boundary rather than during Worker startup.
let workerIsolateInstanceId: string | undefined;
let workerIsolateFirstInvocation = true;

export function beginWorkerInvocationObservation(): Readonly<{
  isolateInstanceId: string;
  firstInvocation: boolean;
}> {
  workerIsolateInstanceId ??= crypto.randomUUID();
  const firstInvocation = workerIsolateFirstInvocation;
  workerIsolateFirstInvocation = false;
  return Object.freeze({ isolateInstanceId: workerIsolateInstanceId, firstInvocation });
}

export interface IdleLedgerEntry {
  readonly actorKeyHash: string;
  readonly endMs: number;
  readonly complete: boolean;
}

/**
 * This deliberately accepts only an externally collected complete ledger.
 * The DO runtime never records timestamps or idle observations in storage.
 */
export function observedIdleGapLowerBoundMs(
  previous: IdleLedgerEntry | undefined,
  currentStartMs: number,
): number | null {
  if (previous === undefined || !previous.complete || !Number.isFinite(previous.endMs) || !Number.isFinite(currentStartMs)) return null;
  return Math.max(0, currentStartMs - previous.endMs);
}

export const IDLE_EXPERIMENT_SCHEDULE_MS = Object.freeze([2_000, 15_000, 180_000] as const);

/**
 * G30 intentionally does not infer a Durable Object reactivation cause from
 * elapsed time.  Idle eviction timings are only loose platform behaviour and
 * are not a durable fact.  The evidence runner may classify a constructor
 * observation only from a deployed-version change or explicit platform
 * evidence; otherwise it remains honestly unknown.
 */
export type ReactivationCause = "deployment-correlated" | "platform-evidenced" | "unknown";

export interface ReactivationEvidence {
  readonly deployedVersionChanged: boolean;
  readonly platformEvidence?: string;
  /**
   * Retained as a measured axis only.  It must never decide a reactivation
   * cause: Cloudflare may hibernate/evict at variable times.
   */
  readonly elapsedMs?: number;
}

export function classifyReactivationCause(evidence: ReactivationEvidence): ReactivationCause {
  if (evidence.deployedVersionChanged) return "deployment-correlated";
  if (typeof evidence.platformEvidence === "string" && evidence.platformEvidence.length > 0) return "platform-evidenced";
  return "unknown";
}

export interface NativeCommitSpanInput {
  readonly schema: CommitTraceSchema;
  /** The manifest face governs the complete emitted attribute set. */
  readonly face: CommitTraceFace;
  /** Exact host-manifest row emitted by this callback boundary. */
  readonly rowId: string;
  readonly correlationId: string;
  /** Repair roots may cover more than one attempt. */
  readonly attemptId?: string;
  readonly serviceId: string;
  readonly actorClass: CommitTraceActorClass;
  readonly actorKey: string;
  readonly activation: DurableObjectActivationObservation;
  readonly operation: string;
  readonly kind:
    | "root"
    | "nested"
    | "callee"
    | "direct"
    | "fanout-stage"
    | "fanout-member"
    | "sequential-stage"
    | "sequential-member";
  readonly attributes?: Readonly<Record<string, TraceAttributeValue>>;
}

export interface NativeActorHandleIdentity {
  readonly attemptId: string;
  readonly serviceId: string;
  /** Optional durable actor identity resolved with the attempt context. */
  readonly actorKey?: string;
}

export interface NativeActorHandleInput {
  readonly actorClass: CommitTraceActorClass;
  readonly actorKey: string;
  readonly activation: DurableObjectActivationObservation;
  /** Separate sdt.observe/v1 log stream; never a commit-span attribute. */
  readonly observation?: DurableObjectHandlerObservation;
}

/**
 * Alarm identity is intentionally supplied by the Journal's durable facts,
 * never guessed from a timestamp or a platform automatic attribute.  The
 * helper starts the custom span before those facts are read, then annotates
 * that already-active callback context once the Journal has decoded them.
 */
export interface NativeReconcileRootIdentity {
  readonly attemptId: string;
  readonly serviceId: string;
  readonly actorKey: string;
  readonly activation: DurableObjectActivationObservation;
  readonly alarmEventId: string;
  readonly invocationId: string;
  readonly retryCount: number;
  readonly isRetry: boolean;
  readonly prefixAtEntry: string;
}

/**
 * A reconciliation fact becomes available only after durable recovery reads.
 * R00 remains open for the handler's whole callback, so it is the sole span
 * to which the host contract permits this late attribute.
 */
export interface NativeReconcileRootFacts {
  setRecoveryKind(kind: string): void;
}

function assertNativeFaceAttributes(
  schema: CommitTraceSchema,
  face: CommitTraceFace,
  rowId: string,
  attributes: Readonly<Record<string, TraceAttributeValue>>,
  options: Readonly<{ allowDeferredFactDerived?: boolean }> = {},
): void {
  const row = rowFor(schema, rowId);
  if (attributes.operation !== row.span) {
    throw new Error(`Native commit trace row ${rowId} operation must equal ${row.span}`);
  }
  if (attributes["span.kind"] !== row.kind) {
    throw new Error(`Native commit trace row ${rowId} span.kind must equal ${row.kind}`);
  }
  assertNoRawTagAttributes(attributes);
  for (const [attribute, declaration] of Object.entries(manifest.attributeMatrix.attributes)) {
    const present = hasOwn(attributes, attribute);
    const state = rowScopedState(declaration, face, rowId);
    if (state === "required" && !present && !(options.allowDeferredFactDerived === true && declaration.factDerived === true)) {
      throw new Error(`Native commit trace row ${rowId} is missing required ${attribute} on ${face}`);
    }
    if (state === "forbidden" && present) {
      throw new Error(`Native commit trace row ${rowId} must not emit ${attribute} on ${face}`);
    }
  }
  for (const attribute of Object.keys(attributes)) {
    faceState(attribute, face);
  }
  assertAttributeTypes(attributes);
}

function nativeAttributesAreValid(
  schema: CommitTraceSchema,
  face: CommitTraceFace,
  rowId: string,
  attributes: Readonly<Record<string, TraceAttributeValue>>,
  options: Readonly<{ allowDeferredFactDerived?: boolean }> = {},
): boolean {
  try {
    assertNativeFaceAttributes(schema, face, rowId, attributes, options);
    return true;
  } catch {
    // The static manifest and mutation lanes make this observable.  At a
    // production callback boundary it must remain telemetry loss, never a
    // new application rejection or alarm retry.
    return false;
  }
}

function nativeTracingEnabled(span: NativeTraceSpan | undefined): span is NativeTraceSpan {
  return span !== undefined && span.isTraced !== false;
}

function setNativeAttribute(
  span: NativeTraceSpan | undefined,
  key: string,
  value: TraceAttributeValue,
): void {
  if (!nativeTracingEnabled(span)) return;
  try {
    span.setAttribute(key, value);
  } catch {
    // Span export is explicitly non-semantic.
  }
}

function setNativeAttributes(
  span: NativeTraceSpan | undefined,
  attributes: Readonly<Record<string, TraceAttributeValue>>,
): void {
  for (const [key, value] of Object.entries(attributes)) setNativeAttribute(span, key, value);
}

/**
 * A tracer that fails before callback invocation simply loses this span.  A
 * callback that did begin is never run a second time: its normal result or
 * error remains the protocol authority.
 */
async function enterNativeSpanFailOpen<T>(
  nativeTracing: NativeTracing,
  name: string,
  callback: (span: NativeTraceSpan | undefined) => T | Promise<T>,
): Promise<T> {
  let callbackStarted = false;
  const wrapped = (span: NativeTraceSpan): T | Promise<T> => {
    callbackStarted = true;
    return callback(span);
  };
  try {
    const result = nativeTracing.enterSpan(name, wrapped);
    if (!callbackStarted) return callback(undefined);
    return await result;
  } catch (error) {
    if (callbackStarted) throw error;
    return callback(undefined);
  }
}

/**
 * Emit a real Cloudflare custom span in the currently active async context.
 * There is intentionally no parent argument: Worker/DO parentage is the
 * platform's concern, and this function only supplies manifest attributes.
 */
export async function enterNativeCommitSpan<T>(
  nativeTracing: NativeTracing,
  name: string,
  input: NativeCommitSpanInput,
  callback: () => T | Promise<T>,
): Promise<T> {
  const attributes: Record<string, TraceAttributeValue> = {
      "schema.version": input.schema,
      "correlation.id": input.correlationId,
      "service.id": input.serviceId,
      "actor.class": input.actorClass,
      "actor.key_hash": stableTraceHash(input.actorKey),
      "activation.id": input.activation.activationId,
      "activation.first": input.activation.first,
      operation: input.operation,
      "span.kind": input.kind,
      outcome: "in-progress",
      ...(input.attributes ?? {}),
    };
    if (input.attemptId !== undefined) attributes["attempt.id"] = input.attemptId;
  if (!nativeAttributesAreValid(input.schema, input.face, input.rowId, attributes)) {
    return callback();
  }
  return enterNativeSpanFailOpen(nativeTracing, name, async (span) => {
    setNativeAttributes(span, attributes);
    try {
      const result = await callback();
      const response = result instanceof Response
        ? result
        : typeof result === "object" && result !== null && "response" in result && (result as { response?: unknown }).response instanceof Response
          ? (result as { response: Response }).response
          : undefined;
      if (nativeTracingEnabled(span)) {
        setNativeAttribute(span, "outcome", response === undefined ? "success" : response.ok ? "success" : `http-${response.status}`);
        // Alarm-root rows have no HTTP response surface, and the manifest
        // forbids http.status for that face even when a test harness happens
        // to represent an internal result as Response.
        if (response !== undefined && input.face !== "reconcile-root") setNativeAttribute(span, "http.status", response.status);
      }
      return result;
    } catch (error) {
      setNativeAttribute(span, "outcome", "exception");
      throw error;
    }
  });
}

/**
 * Emits S16 at the Durable Object handler boundary. Identity may only become
 * available after a clone of the internal request body is decoded, but the
 * custom span itself begins synchronously at handler entry. Failure to derive
 * an internal identity merely leaves that non-commit actor invocation outside
 * the sdt.commit universe; it never changes the request's control path.
 */
export async function enterNativeActorHandleSpan<T>(
  nativeTracing: NativeTracing,
  input: NativeActorHandleInput,
  resolveIdentity: () => Promise<NativeActorHandleIdentity | undefined>,
  callback: () => T | Promise<T>,
): Promise<T> {
  return enterNativeSpanFailOpen(nativeTracing, "actor.handle", async (span) => {
    let identity: NativeActorHandleIdentity | undefined;
    try {
      identity = await resolveIdentity();
    } catch {
      // Observation is deliberately fail-open. Parsing a cloned body must
      // never turn an internal actor request into a new rejection.
      identity = undefined;
    }
    if (identity !== undefined) {
      const attributes: Record<string, TraceAttributeValue> = {
        "schema.version": "sdt.commit/v1",
        "correlation.id": correlationIdForAttempt(identity.attemptId),
        "attempt.id": identity.attemptId,
        "service.id": identity.serviceId,
        "actor.class": input.actorClass,
        "actor.key_hash": stableTraceHash(identity.actorKey ?? input.actorKey),
        "activation.id": input.activation.activationId,
        "activation.first": input.activation.first,
        operation: "actor.handle",
        "span.kind": "callee",
        outcome: "in-progress",
      };
      if (nativeAttributesAreValid("sdt.commit/v1", "accepted", "S16", attributes)) {
        setNativeAttributes(span, attributes);
      }
    }
    try {
      const result = await callback();
      if (identity !== undefined && nativeTracingEnabled(span)) {
        const response = result instanceof Response
          ? result
          : typeof result === "object" && result !== null && "response" in result && (result as { response?: unknown }).response instanceof Response
            ? (result as { response: Response }).response
            : undefined;
        setNativeAttribute(span, "outcome", response === undefined ? "success" : response.ok ? "success" : `http-${response.status}`);
        if (response !== undefined) setNativeAttribute(span, "http.status", response.status);
      }
      return result;
    } catch (error) {
      if (identity !== undefined) setNativeAttribute(span, "outcome", "exception");
      throw error;
    } finally {
      // The structured log is emitted while the actor span is still active,
      // so Cloudflare supplies trace/request identity without a new header.
      input.observation?.finish();
    }
  });
}

/**
 * Emit R00 at actual alarm-handler entry.  The Journal must read the durable
 * record to discover the generation/attempt identity, so resolving it inside
 * the active callback is the only way to keep both the entry boundary and
 * Cloudflare-owned parentage without synthetic parent IDs.
 */
export async function enterNativeReconcileRootSpan<T>(
  nativeTracing: NativeTracing,
  resolveIdentity: () => Promise<NativeReconcileRootIdentity | undefined>,
  callback: (
    identity: NativeReconcileRootIdentity | undefined,
    facts: NativeReconcileRootFacts,
  ) => T | Promise<T>,
): Promise<T> {
  return enterNativeSpanFailOpen(nativeTracing, "sdt.commit.reconcile", async (span) => {
    let identity: NativeReconcileRootIdentity | undefined;
    let attributes: Record<string, TraceAttributeValue> | undefined;
    let recoveryKind: string | undefined;
    const facts: NativeReconcileRootFacts = {
      setRecoveryKind: (kind) => {
        recoveryKind = kind;
      },
    };
    try {
      identity = await resolveIdentity();
    } catch {
      // A missing/corrupt Journal record cannot be turned into a different
      // alarm outcome by attribution. The handler preserves its normal
      // fail-closed path while this non-commit invocation remains unlabelled.
      identity = undefined;
    }
    if (identity !== undefined) {
      attributes = {
        "schema.version": "sdt.commit.reconcile/v1",
        "correlation.id": correlationIdForAttempt(identity.attemptId),
        "attempt.id": identity.attemptId,
        "service.id": identity.serviceId,
        "actor.class": "JOURNAL",
        "actor.key_hash": stableTraceHash(identity.actorKey),
        "activation.id": identity.activation.activationId,
        "activation.first": identity.activation.first,
        operation: "sdt.commit.reconcile",
        "span.kind": "root",
        outcome: "in-progress",
        "alarm.event.id": identity.alarmEventId,
        "alarm.invocation.id": identity.invocationId,
        "alarm.retryCount": identity.retryCount,
        "alarm.isRetry": identity.isRetry,
        "durable.prefix.at_entry": identity.prefixAtEntry,
      };
      // recovery.kind is the one fact-derived R00 attribute. It is checked
      // after the recovery callback establishes the durable branch.
      if (nativeAttributesAreValid(
        "sdt.commit.reconcile/v1",
        "reconcile-root",
        "R00",
        attributes,
        { allowDeferredFactDerived: true },
      )) {
        setNativeAttributes(span, attributes);
      }
    }

    const finish = (outcome: "success" | "exception") => {
      if (identity === undefined || attributes === undefined || !nativeTracingEnabled(span)) return;
      if (recoveryKind === undefined) {
        // Trace-only behavior: an incomplete observation cannot alter the
        // alarm result. The export verifier retains the missing required fact.
        setNativeAttribute(span, "outcome", outcome);
        return;
      }
      const completed = { ...attributes, "recovery.kind": recoveryKind, outcome };
      if (!nativeAttributesAreValid("sdt.commit.reconcile/v1", "reconcile-root", "R00", completed)) return;
      setNativeAttribute(span, "recovery.kind", recoveryKind);
      setNativeAttribute(span, "outcome", outcome);
    };

    try {
      const result = await callback(identity, facts);
      finish("success");
      return result;
    } catch (error) {
      finish("exception");
      throw error;
    }
  });
}
