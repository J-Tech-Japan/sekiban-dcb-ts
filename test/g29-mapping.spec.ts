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
    const execution = observed.execution;
    const runtime = composeRuntime(meetingRoomDomain, meetingRoomRuntimeConfig);
    const runtimeResult = await runtime.commands.execute("create-room", { roomId: "g29-mapping-runtime-bridge", name: "Observed" }, { now: "mapping-fixed-now" });
    expect(mapping.schemaVersion).toBe(1);
    expect(runtimeResult).toMatchObject({ kind: "committed", events: [{ eventType: "RoomCreated:1" }] });
    expect(observed.candidate.events[0]?.eventType).toBe("RoomCreated:1");
    expect(observed.decisionLogBytes).toContain("mapping-fixed-now");
    expect(execution.runtimeBridgeOutcome).toBe("committed");
    expect(execution.eventTypes).toEqual(meetingRoomDomain.events.map((event) => event.eventType));
    expect(execution.viewManifest).toEqual(meetingRoomRuntimeConfig.deliveryViews.map((view) => expect.objectContaining({ id: view.id })));
    expect(execution.restoredSnapshot).toEqual(execution.portableSnapshot);
    expect(execution.doTs.outcome).toBe(execution.portable.outcome);
    expect(execution.doTs.candidate.events).toEqual(execution.portable.candidate.events);
    expect(execution.doTs.claims).toEqual(execution.portable.claims);
    expect(execution.doTs.decisionLogBytes).toBe(execution.portable.decisionLogBytes);
    expect(assertMappingContract(observed.contract, mapping)).toEqual({ rows: 13, columns: 7 });
  });

  const mutationCases = mapping.rows.flatMap((row) => mapping.columns.map((column) => [row.rowId, column] as const));
  it.each(mutationCases)("reports an exact row/column when %s:%s is dropped", (rowId, column) => {
    expect(() => assertMappingContract(mutateMapping(observeMappingContract(), rowId, column), mapping))
      .toThrow(`${rowId}:${column}`);
  });
});
