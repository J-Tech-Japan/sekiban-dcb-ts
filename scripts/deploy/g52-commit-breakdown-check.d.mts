export function validateG52Sample(sample: unknown): Readonly<{
  sampleCount: number;
  client: { count: number; p50: number | null; p95: number | null };
  callerColoDistribution: Readonly<Record<string, number>>;
  rootSource: "snapshot-log";
  activePerHopRows: number;
  doActorClasses: number;
}>;
