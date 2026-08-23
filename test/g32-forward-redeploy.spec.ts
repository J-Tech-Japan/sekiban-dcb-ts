import { describe, expect, it } from "vitest";
import { assertPreWitnessSetPreserved } from "../scripts/deploy/g32-forward-witness.mjs";
// @ts-expect-error Vite raw source fixture
import forwardRedeploySource from "../scripts/deploy/g32-forward-redeploy.sh?raw";

function data() {
  return {
    roomQuery: { status: 200, body: { resultJson: JSON.stringify({ count: 1, rooms: [{ roomId: "room-1", name: "preserve" }] }) } },
    reservationList: {
      status: 200,
      totalCount: 1,
      body: { totalCount: 1, items: [{ reservationId: "reservation-1", roomId: "room-1", userId: "user-1", lastSortedUniqueId: "638915000000000000000000000001" }] },
    },
    knownRooms: [{ roomId: "room-1", status: 200, body: { roomId: "room-1", name: "preserve", lastSortedUniqueId: "638915000000000000000000000000" } }],
    knownReservations: [{ reservationId: "reservation-1", status: 200, body: { reservationId: "reservation-1", roomId: "room-1", userId: "user-1", lastSortedUniqueId: "638915000000000000000000000001" } }],
    eventHeads: { rooms: { "room-1": "638915000000000000000000000000" }, reservations: { "reservation-1": "638915000000000000000000000001" } },
  };
}

describe("SDT-G32 C3/C4/C5 forward-only witness", () => {
  it("requires the pre-captured data set and heads to survive post-candidate deployment", () => {
    const before = data();
    const after = structuredClone(before);
    after.reservationList.body.totalCount = 2; // observed only; a concurrent count is not the equality oracle.
    const result = assertPreWitnessSetPreserved(before, after);
    expect(result).toMatchObject({ stable: true, preserved: { reservationListEntries: 1, knownRooms: 1, knownReservations: 1 } });
    expect(result.preSetDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("turns a lost row, changed detail, or changed head into an independent red oracle", () => {
    const before = data();
    const lost = data();
    lost.reservationList.body.items = [];
    expect(() => assertPreWitnessSetPreserved(before, lost)).toThrow("missing reservation-1");

    const changed = data();
    changed.knownReservations[0]!.body.userId = "rewritten";
    expect(() => assertPreWitnessSetPreserved(before, changed)).toThrow("changed reservation-1");

    const head = data();
    head.eventHeads.rooms["room-1"] = "638915000000000000000000000099";
    expect(() => assertPreWitnessSetPreserved(before, head)).toThrow("event heads changed");
  });

  it("keeps C3/C4/C5 forward-only: no cutover, resource creation, migration apply, or reseed command", () => {
    const source = forwardRedeploySource;
    const executable = source.split(/\r?\n/).filter((line: string) => !line.trimStart().startsWith("#")).join("\n");
    expect(executable).toContain("G32_FORWARD_DEPLOY_LIVE");
    expect(executable).toContain("G32_FORWARD_CYCLE");
    expect(executable).toContain("C5) readonly CYCLE_LOWER=\"c5\"");
    expect(executable).toContain("g32-forward-witness.mjs --mode pre-deploy-public");
    expect(executable).toContain("g32-forward-record-evidence.mjs");
    expect(executable).toContain('d1 migrations list "${PIPELINE_DATABASE_BINDING}"');
    expect(executable).toContain('d1 migrations list "${MATERIALIZED_VIEW_DATABASE_BINDING}"');
    expect(executable).toContain('dirname "${BASH_SOURCE[0]}"');
    expect(executable).not.toContain("$${");
    expect(executable).not.toContain("d1 migrations apply");
    expect(executable).not.toContain("d1 create");
    expect(executable).not.toContain("queues create");
    expect(executable).not.toContain("g32-deploy-cutover.sh");
    expect(executable).not.toContain("seed-after");
  });
});
