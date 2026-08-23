export function assertG30Config(
  primaryOff: unknown,
  primaryOn: unknown,
  receiverOff: unknown,
): Readonly<{ primarySampling: readonly number[]; receiverSampling: number; placement: "off" }>;
export function assertPhaseRuntimeIsolation(
  workerSource: unknown,
  runbookSource: unknown,
): Readonly<{ phaseAuthority: "external-evidence-ledger"; runtimePhaseConfig: false }>;
export function selfTest(): Readonly<Record<string, unknown>>;
