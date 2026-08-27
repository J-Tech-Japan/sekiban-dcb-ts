import commitTraceManifestJson from "../../../../contracts/commit-trace-manifest.json";
import type { CommitTraceSnapshot } from "./CommitTrace";

function failure(code: string, message: string): never {
  const error = new Error(`${code}:${message}`);
  error.name = "CommitTraceAttributionError";
  throw error;
}

function clip(interval: readonly [number, number], root: readonly [number, number]): readonly [number, number] | undefined {
  const start = Math.max(interval[0], root[0]);
  const end = Math.min(interval[1], root[1]);
  return end < start ? undefined : [start, end];
}

function unionDuration(intervals: readonly (readonly [number, number])[]): number {
  const sorted = [...intervals].sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let duration = 0;
  let current: [number, number] | undefined;
  for (const interval of sorted) {
    if (current === undefined) {
      current = [interval[0], interval[1]];
      continue;
    }
    if (interval[0] <= current[1]) {
      current[1] = Math.max(current[1], interval[1]);
      continue;
    }
    duration += current[1] - current[0];
    current = [interval[0], interval[1]];
  }
  return duration + (current === undefined ? 0 : current[1] - current[0]);
}

export interface UnattributedRatio {
  readonly rootDurationMs: number;
  readonly coveredDurationMs: number;
  readonly unattributedRatio: number;
}

/**
 * The attribution numerator is the union of caller-domain coverage only.
 * Callee, nested, fan-out-member, and provider-derived intervals are never
 * eligible, even if a provider happens to attach a duration to them.
 */
export function calculateUnattributedRatio(snapshot: CommitTraceSnapshot): UnattributedRatio {
  if (snapshot.schema !== "sdt.commit/v1") failure("ratio-schema", "unattributed ratio is defined for sdt.commit/v1 only");
  const root = snapshot.spans.find((span) => span.rowId === "S00");
  if (root === undefined) failure("ratio-root-missing", "sdt.commit/v1 needs S00");
  const manifest = commitTraceManifestJson as unknown as {
    schemas: { "sdt.commit/v1": { callerCoverageIntervals: readonly string[]; rows: readonly { rowId: string; emitter: string; kind: string }[] } };
  };
  const coverage = new Set(manifest.schemas["sdt.commit/v1"].callerCoverageIntervals);
  const rows = new Map(manifest.schemas["sdt.commit/v1"].rows.map((row) => [row.rowId, row]));
  const rootInterval: readonly [number, number] = [root.startMs, root.endMs];
  const intervals = snapshot.spans
    .filter((span) => coverage.has(span.rowId))
    .map((span) => {
      const row = rows.get(span.rowId);
      if (row === undefined) failure("coverage-row", `coverage row ${span.rowId} is not manifest-declared`);
      if (
        span.clockDomain !== "caller" ||
        row.emitter === "callee-do" ||
        row.kind === "nested" ||
        row.kind === "fanout-member" ||
        row.kind === "sequential-member"
      ) {
        failure("coverage-noncaller", `${span.rowId} is forbidden from caller coverage`);
      }
      return clip([span.startMs, span.endMs], rootInterval);
    })
    .filter((interval): interval is readonly [number, number] => interval !== undefined);
  const rootDurationMs = Math.max(0, root.endMs - root.startMs);
  const coveredDurationMs = Math.min(rootDurationMs, unionDuration(intervals));
  return {
    rootDurationMs,
    coveredDurationMs,
    unattributedRatio: rootDurationMs === 0 ? 0 : Math.max(0, rootDurationMs - coveredDurationMs) / rootDurationMs,
  };
}
