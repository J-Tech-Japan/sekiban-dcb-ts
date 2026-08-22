export interface G31WitnessSnapshot {
  readonly [key: string]: unknown;
  readonly identityVerified: boolean;
  readonly sourceCommit?: string | null;
  readonly data: { readonly digest: string; readonly [key: string]: unknown };
  readonly rawV1: { readonly status: number };
}

export interface G31WitnessExpected {
  readonly [key: string]: unknown;
}

export interface G31DataPreservation {
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

export function shouldRetryConformanceStatus(status: number): boolean;
export function assertPreWitnessSetPreserved(before: G31WitnessSnapshot["data"], after: G31WitnessSnapshot["data"]): G31DataPreservation;
export function assertWitnessStable(before: G31WitnessSnapshot, after: G31WitnessSnapshot, expected: G31WitnessExpected): { readonly stable: true; readonly fields: readonly string[]; readonly dataPreservation: G31DataPreservation };
export function assertFinalWitnessIdentity(sourceCommit: string, pre: G31WitnessSnapshot, post: G31WitnessSnapshot): { readonly preIdentitySource: unknown; readonly postSourceCommit: unknown; readonly match: true };
export function assertSourceCommit(witness: G31WitnessSnapshot, sourceCommit: string): { readonly sourceCommit: string; readonly match: true };
export function captureWitness(baseUrl: string, token: string, expected: G31WitnessExpected, retry?: { readonly attempts?: number; readonly delayMs?: number }): Promise<G31WitnessSnapshot>;
export function capturePublicPreWitness(baseUrl: string): Promise<G31WitnessSnapshot>;
