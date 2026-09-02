import type { G50Sample, G50Telemetry } from "./g50-commit-latency.mjs";

export const TASK: "SDT-G52";
export const SAMPLE_COUNT: 50;
export const SNAPSHOT_PER_HOP_ROWS: readonly string[];

export interface G52Sample extends G50Sample {
  schema: "sdt-g52-commit-breakdown/v1";
  task: "SDT-G52";
  protocol: G50Sample["protocol"] & {
    retainedRootSource: "snapshot-log";
    retainedRootSourceRule: string;
  };
  telemetry: G50Telemetry & {
    snapshotRoots: {
      rootSource: "snapshot-log";
      retainedTraceCount: number;
      schemaCompleteTraceCount: number;
      observedTraceCount: number;
      descriptiveLossCount: number;
      untruncatedLogRootCount: number;
      ingestion: unknown;
    };
    doObservationMedians: readonly {
      actorClass: string;
      observationCount: number;
      constructorToHandlerMs: number | null;
      firstStorageReadMs: number | null;
      subrequestWallMs: number | null;
    }[];
    residualRanking: readonly {
      rowId: string;
      medianMs: number;
      observedSpanCount: number;
      waitsOn: string;
    }[];
  };
}

export function captureG52CommitBreakdown(input: Parameters<typeof import("./g50-commit-latency.mjs").captureG50AppCommitLatency>[0]): Promise<G52Sample>;
