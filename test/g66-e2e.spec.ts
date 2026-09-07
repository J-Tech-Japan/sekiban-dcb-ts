import { describe, expect, it } from "vitest";
import { createG66GuardFixture, inspectG66Receipt } from "../scripts/g66-e2e-guard.mjs";

function fixture() {
  return createG66GuardFixture() as {
    commands: Array<{
      target: { kind: string; id: string; expectedStatus: string };
      safePredicate: { mode: string; kind: string; id: string; expectedStatus: string; terminalMutationOrdinal: number | null };
      commit: { startedAtMs: number; completedAtMs: number; responseMs: number; suid: string };
      unsafe: { firstVisibleAtMs?: number; responseRelativeMs?: number; observations: Array<{ completedAtMs?: number; visible?: boolean }> };
      safe: { firstVisibleAtMs?: number; observedAtMs?: number; responseRelativeMs?: number; publicQuery: { completedAtMs?: number; readHead?: string } };
    }>;
    contract: { minimumInterSampleMs: number };
    finalQuery: { reservations: { rows: Array<unknown> } };
    finalConsistency: { exactReservationSet: boolean };
  };
}

function passes(receipt: unknown): boolean {
  try { return inspectG66Receipt(receipt).passed; } catch { return false; }
}

describe("SDT-G66 public e2e guard", () => {
  it("accepts a complete cold-first receipt with continuous paced writes", () => {
    expect(inspectG66Receipt(fixture()).passed).toBe(true);
  });

  it("fails closed for censored safe visibility and a fully chronological pause", () => {
    const censored = fixture();
    (censored.commands[0]!.safe as unknown) = { disposition: "censored" };
    expect(passes(censored)).toBe(false);

    const paused = fixture();
    const previous = paused.commands[0]!;
    const current = paused.commands[1]!;
    current.commit.startedAtMs = previous.safe.firstVisibleAtMs! + paused.contract.minimumInterSampleMs;
    current.commit.completedAtMs = current.commit.startedAtMs + current.commit.responseMs;
    current.unsafe.firstVisibleAtMs = current.commit.completedAtMs + 10;
    current.unsafe.responseRelativeMs = 10;
    current.unsafe.observations[0]!.completedAtMs = current.unsafe.firstVisibleAtMs;
    current.safe.firstVisibleAtMs = current.commit.completedAtMs + 19_990;
    current.safe.observedAtMs = current.safe.firstVisibleAtMs;
    current.safe.responseRelativeMs = 19_990;
    current.safe.publicQuery.completedAtMs = current.safe.firstVisibleAtMs;
    expect(passes(paused)).toBe(false);
  });

  it("rejects absolute-clock, safe-head/readHead, fixed-bound and unsafe-observation escapes", () => {
    const absoluteClock = fixture();
    absoluteClock.commands.forEach((sample) => { sample.unsafe.firstVisibleAtMs = sample.commit.completedAtMs + 999_999; });
    expect(passes(absoluteClock)).toBe(false);

    const safeHead = fixture();
    (safeHead.commands[0]!.safe as unknown as { safeHead: string }).safeHead = "000000000000000000000000000000";
    safeHead.commands[0]!.safe.publicQuery.readHead = "000000000000000000000000000000";
    expect(passes(safeHead)).toBe(false);

    const inflatedBound = fixture() as ReturnType<typeof fixture> & { commands: Array<{ unsafe: { boundMs?: number }; safe: { boundMs?: number } }> };
    (inflatedBound.commands[0]!.unsafe as { boundMs?: number }).boundMs = 999_999;
    (inflatedBound.commands[0]!.safe as { boundMs?: number }).boundMs = 999_999;
    expect(passes(inflatedBound)).toBe(false);

    const unsafeObservation = fixture();
    unsafeObservation.commands[0]!.unsafe.observations = [{ visible: false, completedAtMs: unsafeObservation.commands[0]!.unsafe.firstVisibleAtMs }];
    expect(passes(unsafeObservation)).toBe(false);
  });

  it("rejects missing, stale, duplicate and unrelated final reservation sets", () => {
    const duplicate = fixture();
    duplicate.finalQuery.reservations.rows.push({ reservationId: "reservation-1", roomId: "room-1", status: "cancelled" });
    duplicate.finalConsistency.exactReservationSet = false;
    expect(passes(duplicate)).toBe(false);

    const missing = fixture();
    missing.finalQuery.reservations.rows = [];
    missing.finalConsistency.exactReservationSet = false;
    expect(passes(missing)).toBe(false);

    const stale = fixture();
    stale.commands[1]!.safe.publicQuery.readHead = stale.commands[0]!.commit.suid;
    expect(passes(stale)).toBe(false);
  });

  it("rejects a safe predicate whose reservation is mutated by a later sample", () => {
    const laterMutation = fixture();
    laterMutation.commands[8]!.safePredicate.expectedStatus = "reserved";
    laterMutation.commands[8]!.safePredicate.terminalMutationOrdinal = null;
    expect(passes(laterMutation)).toBe(false);
  });

  it("retains hard failures for rejected writes and missing coverage", () => {
    const failedWrite = fixture() as ReturnType<typeof fixture> & { commands: Array<{ commit: { status?: number } }> };
    failedWrite.commands[0]!.commit.status = 504;
    expect(passes(failedWrite)).toBe(false);

    const coverage = fixture() as ReturnType<typeof fixture> & { commands: Array<{ healthSnapshots: Array<{ coverageHistory: unknown[] | null }> }> };
    coverage.commands[0]!.healthSnapshots[0]!.coverageHistory = null;
    expect(passes(coverage)).toBe(false);
  });
});
