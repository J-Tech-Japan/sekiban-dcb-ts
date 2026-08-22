export interface G29WitnessSnapshot {
  readonly [key: string]: unknown;
  readonly identityVerified: boolean;
  readonly data: { readonly digest: string };
  readonly rawV1: { readonly status: number };
}

export interface G29WitnessExpected {
  readonly [key: string]: unknown;
}

export function assertWitnessStable(before: G29WitnessSnapshot, after: G29WitnessSnapshot, expected: G29WitnessExpected): { readonly stable: true; readonly fields: readonly string[]; readonly dataDigest: string };
