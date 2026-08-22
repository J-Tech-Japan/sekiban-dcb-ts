export interface G31Measurement {
  readonly index?: number;
  readonly roomId?: string;
  readonly reservationId?: string;
  readonly commitSuid?: string;
  readonly commandStartAt?: string;
  readonly responseAt?: string;
  readonly listRequestStartedAt?: string;
  readonly listRenderedAt?: string;
  readonly commandStartToResponseMs: number;
  readonly responseToListRedrawMs: number;
  readonly commandStartToListRedrawMs: number;
  readonly commandStatus: number;
  readonly commandKind: string;
  readonly listStatus: number;
  readonly listCode: string | null;
}

export function summarizeMeasurements(values: readonly G31Measurement[]): {
  readonly sampleCount: number;
  readonly commandStartToResponseMs: { readonly p50: number | null; readonly p95: number | null; readonly max: number | null; readonly samples: number };
  readonly responseToListRedrawMs: { readonly p50: number | null; readonly p95: number | null; readonly max: number | null; readonly samples: number };
  readonly commandStartToListRedrawMs: { readonly p50: number | null; readonly p95: number | null; readonly max: number | null; readonly samples: number };
  readonly statusRaw: readonly unknown[];
  readonly errorCount: number;
};

export function measure(baseUrl: string, samples: number, timeoutMs: number, token: string): Promise<unknown>;
