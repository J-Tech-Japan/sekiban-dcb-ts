export interface G29Measurement {
  readonly commandStartToResponseMs: number;
  readonly responseToVisibleMs: number;
  readonly commandStartToVisibleMs: number;
  readonly status: number;
  readonly kind: string;
  readonly fallback: boolean;
}

export function summarizeMeasurements(values: readonly G29Measurement[]): {
  readonly sampleCount: number;
  readonly commandStartToResponseMs: { readonly p50: number | null; readonly p95: number | null; readonly max: number | null; readonly samples: number };
  readonly responseToVisibleMs: { readonly p50: number | null; readonly p95: number | null; readonly max: number | null; readonly samples: number };
  readonly commandStartToVisibleMs: { readonly p50: number | null; readonly p95: number | null; readonly max: number | null; readonly samples: number };
  readonly statusRaw: readonly { readonly status: number; readonly kind: string; readonly fallback: boolean }[];
  readonly errorCount: number;
  readonly fallbackCount: number;
};
