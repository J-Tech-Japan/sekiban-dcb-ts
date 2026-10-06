export function assertG30Config(config?: unknown): Readonly<{
  sampling: 1;
  observationLogPersistence: true;
  placement: "off";
}>;
export function selfTest(): Readonly<Record<string, unknown>>;
