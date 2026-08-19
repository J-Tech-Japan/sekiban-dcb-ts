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
