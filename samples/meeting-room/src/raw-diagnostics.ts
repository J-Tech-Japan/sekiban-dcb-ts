export interface RawProjectionDiagnostics {
  readonly rawSourceTimestamp: number | null;
  readonly observedTimestamp: number;
  readonly checkpoint: string | null;
  readonly head: string | null;
  readonly expectedVersion: number;
  readonly actualVersion: number;
}

export type ProjectionDiagnosticQuadrant =
  | "source-before-observed_checkpoint-behind-head"
  | "source-before-observed_checkpoint-at-head"
  | "source-after-observed_checkpoint-behind-head"
  | "source-after-observed_checkpoint-at-head";

const rawFields = Object.freeze([
  "rawSourceTimestamp",
  "observedTimestamp",
  "checkpoint",
  "head",
  "expectedVersion",
  "actualVersion",
] as const);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireField(value: unknown, field: string): unknown {
  if (!isRecord(value) || !(field in value)) throw new Error(`G29_DIAGNOSTIC_FIELD_MISSING:${field}`);
  return value[field];
}

export function parseRawProjectionDiagnostics(value: unknown): RawProjectionDiagnostics {
  const rawSourceTimestamp = requireField(value, "rawSourceTimestamp");
  const observedTimestamp = requireField(value, "observedTimestamp");
  const checkpoint = requireField(value, "checkpoint");
  const head = requireField(value, "head");
  const expectedVersion = requireField(value, "expectedVersion");
  const actualVersion = requireField(value, "actualVersion");
  if (rawSourceTimestamp !== null && (typeof rawSourceTimestamp !== "number" || !Number.isFinite(rawSourceTimestamp))) throw new Error("G29_DIAGNOSTIC_FIELD_INVALID:rawSourceTimestamp");
  if (typeof observedTimestamp !== "number" || !Number.isFinite(observedTimestamp)) throw new Error("G29_DIAGNOSTIC_FIELD_INVALID:observedTimestamp");
  if (checkpoint !== null && typeof checkpoint !== "string") throw new Error("G29_DIAGNOSTIC_FIELD_INVALID:checkpoint");
  if (head !== null && typeof head !== "string") throw new Error("G29_DIAGNOSTIC_FIELD_INVALID:head");
  if (typeof expectedVersion !== "number" || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error("G29_DIAGNOSTIC_FIELD_INVALID:expectedVersion");
  if (typeof actualVersion !== "number" || !Number.isSafeInteger(actualVersion) || actualVersion < 0) throw new Error("G29_DIAGNOSTIC_FIELD_INVALID:actualVersion");
  return Object.freeze({ rawSourceTimestamp, observedTimestamp, checkpoint, head, expectedVersion, actualVersion });
}

export function diagnosticQuadrant(value: RawProjectionDiagnostics): ProjectionDiagnosticQuadrant {
  const sourceBeforeObserved = value.rawSourceTimestamp === null || value.rawSourceTimestamp <= value.observedTimestamp;
  const checkpointAtHead = value.checkpoint === value.head;
  return `${sourceBeforeObserved ? "source-before-observed" : "source-after-observed"}_${checkpointAtHead ? "checkpoint-at-head" : "checkpoint-behind-head"}` as ProjectionDiagnosticQuadrant;
}

export function assertRawDiagnosticContract(value: unknown): RawProjectionDiagnostics {
  const parsed = parseRawProjectionDiagnostics(value);
  if (isRecord(value) && "quadrant" in value) throw new Error("G29_DIAGNOSTIC_DERIVED_FIELD_FORBIDDEN:quadrant");
  if (isRecord(value) && "axis" in value) throw new Error("G29_DIAGNOSTIC_DERIVED_FIELD_FORBIDDEN:axis");
  return parsed;
}

export function rawDiagnosticFields(): readonly string[] {
  return rawFields;
}
