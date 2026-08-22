export interface G29WitnessSnapshot {
  readonly [key: string]: unknown;
  readonly identityVerified: boolean;
  readonly sourceCommit?: string | null;
  readonly data: { readonly digest: string; readonly [key: string]: unknown };
  readonly rawV1: { readonly status: number };
}

export interface G29WitnessExpected {
  readonly [key: string]: unknown;
}

export function assertWitnessStable(before: G29WitnessSnapshot, after: G29WitnessSnapshot, expected: G29WitnessExpected, beforeExpected?: G29WitnessExpected): { readonly stable: true; readonly fields: readonly string[]; readonly dataDigest: string };
export function assertSourceCommit(witness: G29WitnessSnapshot, sourceCommit: string): { readonly sourceCommit: string; readonly match: true };
