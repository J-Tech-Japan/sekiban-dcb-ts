export function assertG30Config(
  primaryOff: unknown,
  primaryOn: unknown,
  receiverOff: unknown,
): Readonly<{ primarySampling: readonly number[]; receiverSampling: number; placement: "off"; receiverPublicSurface: Readonly<{ workersDev: false; previewUrls: false }> }>;
export function assertReceiverPublicSurface(receiverOff: unknown): Readonly<{ workersDev: false; previewUrls: false }>;
export function assertPhaseRuntimeIsolation(
  workerSource: unknown,
  runbookSource: unknown,
): Readonly<{ phaseAuthority: "external-evidence-ledger"; runtimePhaseConfig: false }>;
export function assertRemoteMigrationPreflight(
  primaryOff: unknown,
  runbookSource: unknown,
): Readonly<{ migrationBindings: readonly string[]; identityAuthority: "sealed-config-database-id/name/migrations-dir" }>;
export function assertWitnessCaptureShellSafety(runbookSource: unknown): Readonly<{ witnessCaptureLocals: "ordered" }>;
export function assertWitnessReplaySnapshotSafety(runbookSource: unknown): Readonly<{ witnessReplaySnapshot: "pre-deploy" }>;
export function selfTest(): Readonly<Record<string, unknown>>;
