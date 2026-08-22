import { describe, expect, it } from "vitest";
import mappingArtifact from "../docs/SDT-G29-mapping.json";
import { assertMappingContract, mutateMapping, validateMapping } from "../scripts/g29-mapping-contract.mjs";
import { observeMappingContract, observePortableMappingExecution } from "../samples/meeting-room/src/mapping-observation";
import { composeRuntime } from "../packages/dcb-runtime/src/composition";
import { meetingRoomDomain, meetingRoomRuntimeConfig } from "../samples/meeting-room/src/domain";

const mapping = validateMapping(mappingArtifact);

describe("SDT-G29 mapping authority", () => {
  it("loads the versioned table and validates observations from the real DO-ts session and runtime bridge", async () => {
    const observed = await observePortableMappingExecution();
    const runtime = composeRuntime(meetingRoomDomain, meetingRoomRuntimeConfig);
    const runtimeResult = await runtime.commands.execute("create-room", { roomId: "g29-mapping-runtime-bridge", name: "Observed" }, { now: "mapping-fixed-now" });
    expect(mapping.schemaVersion).toBe(1);
    expect(runtimeResult).toMatchObject({ kind: "committed", events: [{ eventType: "RoomCreated:1" }] });
    expect(observed.candidate.events[0]?.eventType).toBe("RoomCreated:1");
    expect(observed.decisionLogBytes).toContain("mapping-fixed-now");
    expect(assertMappingContract(observed.contract, mapping)).toEqual({ rows: 13, columns: 7 });
  });

  it.each([
    ["event-payload", "wire"],
    ["canonical-identity", "owner"],
    ["tags", "doTs"],
    ["view-descriptor", "unsupported"],
  ])("reports an exact row/column when %s:%s is dropped", (rowId, column) => {
    expect(() => assertMappingContract(mutateMapping(observeMappingContract(), rowId, column), mapping))
      .toThrow(`${rowId}:${column}`);
  });
});
