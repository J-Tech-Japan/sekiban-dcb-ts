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
