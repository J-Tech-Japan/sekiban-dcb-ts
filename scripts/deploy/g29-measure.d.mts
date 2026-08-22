export interface G29Measurement {
  readonly index?: number;
  readonly roomId?: string;
  readonly reservationId?: string;
  readonly commandStartAt?: string;
  readonly commandStartedAt?: string;
  readonly responseAt?: string;
  readonly visibleAt?: string;
  readonly commandStartToResponseMs: number;
  readonly responseToVisibleMs: number;
  readonly commandStartToVisibleMs: number;
  readonly status: number;
  readonly kind: string;
  readonly fallback: boolean;
  readonly statusRaw?: { readonly httpStatus: number; readonly kind: string | null; readonly code: string | null; readonly fallback: boolean };
}

export function summarizeMeasurements(values: readonly G29Measurement[]): {
  readonly sampleCount: number;
  readonly commandStartToResponseMs: { readonly p50: number | null; readonly p95: number | null; readonly max: number | null; readonly samples: number };
  readonly responseToVisibleMs: { readonly p50: number | null; readonly p95: number | null; readonly max: number | null; readonly samples: number };
  readonly commandStartToVisibleMs: { readonly p50: number | null; readonly p95: number | null; readonly max: number | null; readonly samples: number };
  readonly statusRaw: readonly { readonly index?: number; readonly roomId?: string; readonly reservationId?: string; readonly commandStartAt?: string; readonly responseAt?: string; readonly visibleAt?: string; readonly status?: number; readonly httpStatus?: number; readonly kind?: string | null; readonly code?: string | null; readonly fallback: boolean }[];
  readonly errorCount: number;
  readonly fallbackCount: number;
};
