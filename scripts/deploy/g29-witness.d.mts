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

export interface G29DataPreservation {
  readonly stable: true;
  readonly rule: string;
  readonly preSetDigest: string;
  readonly preserved: {
    readonly reservationListEntries: number;
    readonly knownRooms: number;
    readonly knownReservations: number;
  };
  readonly counts: {
    readonly before: { readonly roomQuery: number | null; readonly reservations: number | null };
    readonly after: { readonly roomQuery: number | null; readonly reservations: number | null };
  };
  readonly countDelta: { readonly roomQuery: number | null; readonly reservations: number | null };
}

export function assertPreWitnessSetPreserved(before: G29WitnessSnapshot["data"], after: G29WitnessSnapshot["data"]): G29DataPreservation;
export function shouldRetryConformanceStatus(status: number): boolean;
export function assertWitnessStable(before: G29WitnessSnapshot, after: G29WitnessSnapshot, expected: G29WitnessExpected): { readonly stable: true; readonly fields: readonly string[]; readonly dataPreservation: G29DataPreservation };
export function assertFinalWitnessIdentity(sourceCommit: string, pre: G29WitnessSnapshot, post: G29WitnessSnapshot): { readonly preIdentitySource: unknown; readonly postSourceCommit: unknown; readonly match: true };
export function assertSourceCommit(witness: G29WitnessSnapshot, sourceCommit: string): { readonly sourceCommit: string; readonly match: true };
