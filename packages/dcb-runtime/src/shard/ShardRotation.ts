import { assertSortableUniqueId, compareSortableUniqueId } from "../allocator/SortableUniqueId";

export type SealedShard = Readonly<{
  id: string;
  lastSuid: string;
}>;

export type LateArrival = Readonly<{
  shardId: string;
  suid: string;
  reason: "sealed-range";
}>;

export type ShardRotationState = Readonly<{
  sealed: readonly SealedShard[];
  active: string;
  ledger: readonly LateArrival[];
}>;

export type ShardRotationDiagnostic = Readonly<{
  code:
    | "ORDER_INVARIANT"
    | "SEALED_WRITE"
    | "IDENTITY_SWAP"
    | "ACTIVE_COUNT"
    | "SEAL_MAX_MISSING"
    | "UNKNOWN_SHARD"
    | "SILENT_MERGE"
    | "SAFEWINDOW_SEAL";
  path: string;
  reason: string;
}>;

export class ShardRotationError extends Error {
  readonly diagnostic: ShardRotationDiagnostic;
  constructor(diagnostic: ShardRotationDiagnostic) {
    super(diagnostic.code);
    this.name = "ShardRotationError";
    this.diagnostic = diagnostic;
  }
}

function fail(code: ShardRotationDiagnostic["code"], path: string, reason: string): never {
  throw new ShardRotationError({ code, path, reason });
}

export function createRotationState(active: string): ShardRotationState {
  if (typeof active !== "string" || active.length === 0) fail("ACTIVE_COUNT", "active", "active-missing");
  return { sealed: [], active, ledger: [] };
}

/** Fail closed unless last(D1-1) < first(D1-2). */
export function assertStrictlyBefore(lastD1_1: string, firstD1_2: string): void {
  assertSortableUniqueId(lastD1_1);
  assertSortableUniqueId(firstD1_2);
  if (compareSortableUniqueId(lastD1_1, firstD1_2) >= 0) {
    fail("ORDER_INVARIANT", "last(D1-1)<first(D1-2)", "order-invariant");
  }
}

export function maxSortableUniqueId(values: readonly string[]): string {
  if (values.length === 0) fail("SEAL_MAX_MISSING", "d1-1", "seal-max-missing");
  let max = assertSortableUniqueId(values[0]!).value;
  for (let i = 1; i < values.length; i += 1) {
    const next = assertSortableUniqueId(values[i]!).value;
    if (next > max) max = next;
  }
  return max;
}

/**
 * Normal rotation: derive last(D1-1) as the maximum SortableUniqueId present in
 * the shard being sealed, append that sealed entry in order, then point active
 * at exactly one new shard id that is not already sealed.
 */
export function rotateAppend(
  state: ShardRotationState,
  sealedId: string,
  shardSuids: readonly string[],
  nextActiveId: string,
): ShardRotationState {
  if (sealedId !== state.active) fail("UNKNOWN_SHARD", sealedId, "unknown-shard");
  if (typeof nextActiveId !== "string" || nextActiveId.length === 0 || nextActiveId === sealedId) {
    fail("ACTIVE_COUNT", "active", "active-count");
  }
  if (state.sealed.some((entry) => entry.id === nextActiveId)) {
    fail("ACTIVE_COUNT", nextActiveId, "active-already-sealed");
  }
  if (state.sealed.some((entry) => entry.id === sealedId)) fail("IDENTITY_SWAP", sealedId, "identity-swap");
  const lastSuid = maxSortableUniqueId(shardSuids);
  return {
    sealed: [...state.sealed, { id: sealedId, lastSuid }],
    active: nextActiveId,
    ledger: state.ledger,
  };
}

export function replaceSealedIdentity(state: ShardRotationState, index: number, nextId: string): never {
  if (index < 0 || index >= state.sealed.length) fail("UNKNOWN_SHARD", "sealed", "unknown-shard");
  fail("IDENTITY_SWAP", state.sealed[index]!.id, `identity-swap:${nextId}`);
}

export function refuseSealedWrite(state: ShardRotationState, shardId: string): void {
  if (state.sealed.some((entry) => entry.id === shardId)) fail("SEALED_WRITE", shardId, "sealed-write");
}

/**
 * First or later write into the active shard after a seal. Requires
 * last(D1-1) < candidate. Does not write when the gate fails.
 */
export function admitActiveWrite(state: ShardRotationState, shardId: string, firstOrNextSuid: string): void {
  assertSortableUniqueId(firstOrNextSuid);
  refuseSealedWrite(state, shardId);
  if (shardId !== state.active) fail("UNKNOWN_SHARD", shardId, "unknown-shard");
  if (state.sealed.length === 0) return;
  const previous = state.sealed[state.sealed.length - 1]!;
  assertStrictlyBefore(previous.lastSuid, firstOrNextSuid);
}

/**
 * Late arrival under a sealed range. Appended only to the side ledger.
 * Never writes back into the sealed shard.
 */
export function recordLateArrival(state: ShardRotationState, sealedShardId: string, suid: string): ShardRotationState {
  assertSortableUniqueId(suid);
  const sealed = state.sealed.find((entry) => entry.id === sealedShardId);
  if (sealed === undefined) fail("UNKNOWN_SHARD", sealedShardId, "unknown-shard");
  if (compareSortableUniqueId(suid, sealed.lastSuid) > 0) {
    fail("ORDER_INVARIANT", sealedShardId, "not-late-arrival");
  }
  return {
    ...state,
    ledger: [...state.ledger, { shardId: sealed.id, suid, reason: "sealed-range" }],
  };
}

const SILENT_MERGE_TOKENS = [
  ["merge", "Ledger", "Into", "Sealed"],
  ["merge", "OnRead", "Sealed"],
  ["silent", "Merge", "Ledger"],
  ["ledger", ".concat(", "sealed"],
  ["sealed", ".concat(", "ledger"],
] as const;

export function assertNoSilentLedgerMerge(source: string): void {
  const lowered = source.toLowerCase();
  for (const token of SILENT_MERGE_TOKENS) {
    const needle = token.join("").toLowerCase();
    if (lowered.includes(needle)) fail("SILENT_MERGE", "ledger", "silent-merge");
  }
}

export function refuseSilentLedgerMerge(_mergeOnRead: true): never {
  fail("SILENT_MERGE", "ledger", "silent-merge");
}

export function refuseSafeWindowSeal(_safeWindowAsSeal: true): never {
  fail("SAFEWINDOW_SEAL", "safe-window", "safewindow-seal");
}
