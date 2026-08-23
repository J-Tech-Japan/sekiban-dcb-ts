export function positiveEnvelopeBlock(source: string): string;
export function assertNoLegacyPositiveFixtureText(text: string, label?: string, eventPayloadName?: string): void;
export function auditG32LegacyIngress(): {
  readonly task: "SDT-G32";
  readonly positiveIngresses: readonly string[];
  readonly legacyNegative: readonly string[];
  readonly eventPayloadVersionReferences: readonly string[];
  readonly conclusion: string;
};
export function runSelfTest(options?: { readonly includeAudit?: boolean }): {
  readonly mutations: readonly string[];
  readonly task?: "SDT-G32";
};
