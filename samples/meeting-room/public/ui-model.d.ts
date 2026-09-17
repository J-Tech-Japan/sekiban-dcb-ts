export declare const UI_SAFE_WINDOW_BOUND_MS: number;
export declare function compareV1Ordinal(left: string, right: string): number;
export declare function visibilityState(input: {
  readonly commitSortableUniqueId: string;
  readonly lastSortedUniqueId: string;
  readonly startedAt?: number;
  readonly now?: number;
}): "visible" | "pending" | "timeout";
export declare function commandOutcome(status: number, body: unknown):
  | "committed"
  | "conflict"
  | "partial"
  | "rejected"
  | "timeout"
  | "unavailable"
  | "transport"
  | "noop";
export interface ReservationListRow {
  readonly reservationId: string;
  readonly roomId: string;
  readonly status: string;
  readonly version: number;
}
export type ReservationListView =
  | { readonly kind: "error"; readonly status: number; readonly code: string; readonly error: string }
  | {
      readonly kind: "empty" | "ready";
      readonly rows: ReservationListRow[];
      readonly readHead?: string;
      readonly continuation?: unknown;
      readonly totalCount: number;
    };
export declare function reservationListView(status: number, body: unknown): ReservationListView;
export type RoomQueryView =
  | { readonly kind: "error"; readonly status: number; readonly code: string; readonly error: string }
  | { readonly kind: "ready"; readonly result: unknown; readonly readHead?: string };
export declare function roomQueryView(status: number, body: unknown): RoomQueryView;

export type PortableSnapshot = {
  readonly projectorId: string;
  readonly tag: string;
  readonly head: string | null;
  readonly exists: boolean;
  readonly state: Record<string, unknown>;
};

export declare function snapshotKey(projectorId: string, tag: string): string;
export declare function emptySnapshot(projectorId: string, tag: string): PortableSnapshot;
export declare function snapshotLooksOccupied(snapshot: unknown): boolean;
export declare function projectionReadLooksEmpty(body: unknown): boolean;
export declare function reconcileOccupiedAgainstRead(
  known: PortableSnapshot | undefined,
  readStatus: number,
  readBody: unknown,
):
  | { readonly action: "keep"; readonly snapshot: PortableSnapshot | undefined }
  | { readonly action: "forget"; readonly reason: string }
  | { readonly action: "refresh"; readonly snapshot: PortableSnapshot };
export declare function snapshotInputValue(input: unknown, key: string): string | undefined;
export declare function commandSnapshots(
  commandId: string,
  input: unknown,
  known: (projectorId: string, tag: string) => PortableSnapshot | undefined,
): { readonly snapshots: PortableSnapshot[]; readonly readMode: "snapshot-only" | "read-through" };
export declare function tagsToReconcileForCommand(
  commandId: string,
  input: unknown,
): ReadonlyArray<{
  readonly kind: "room" | "reservation";
  readonly id: string;
  readonly projectorId: string;
  readonly tag: string;
}>;
