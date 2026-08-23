export type ForwardPreservation = {
  readonly stable: true;
  readonly rule: string;
  readonly preSetDigest: string;
  readonly preserved: {
    readonly reservationListEntries: number;
    readonly knownRooms: number;
    readonly knownReservations: number;
  };
  readonly counts: unknown;
  readonly countDelta: unknown;
};

export function assertPreWitnessSetPreserved(before: unknown, after: unknown): ForwardPreservation;
export function captureDataWitness(baseUrl: string): Promise<unknown>;
export function capturePublicPreWitness(baseUrl: string): Promise<unknown>;
export function capturePostWitness(input: unknown): Promise<unknown>;
export function assertForwardWitness(pre: unknown, post: unknown, sourceCommit: string): ForwardPreservation;
