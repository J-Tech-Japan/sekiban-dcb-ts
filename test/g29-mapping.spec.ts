import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import mappingArtifact from "../docs/SDT-G29-mapping.json";
import { assertMappingContract, mutateMapping, validateMapping } from "../scripts/g29-mapping-contract.mjs";
import { observePortableMappingExecution, type MappingAdmissionEvidence } from "../samples/meeting-room/src/mapping-observation";
import { composeRuntime } from "../packages/dcb-runtime/src/composition";
import { meetingRoomDomain, meetingRoomRuntimeConfig } from "../samples/meeting-room/src/domain";
import { CommitWorker, type CommitWorkerEnv, validateCommitEnvelope } from "../packages/dcb-runtime/src/commit/CommitWorker";

const mapping = validateMapping(mappingArtifact);

describe("SDT-G29 mapping authority", () => {
  let observed!: Awaited<ReturnType<typeof observePortableMappingExecution>>;

  beforeAll(async () => {
    const serviceId = `g29-mapping-${crypto.randomUUID()}`;
    const roomId = "g29-mapping-shared";
    const tag = `room:${roomId}`;
    const payloadBase64 = btoa(JSON.stringify({ roomId, name: "Observed" }));
    const worker = new CommitWorker(env as unknown as CommitWorkerEnv, serviceId);
    const response = await worker.handle(new Request("https://commit.test/api/sekiban/serialized/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, eventCandidates: [{ payload: payloadBase64, eventPayloadName: "RoomCreated", tags: [tag] }], consistencyTags: [] }),
    }));
    expect(response.status).toBe(200);
    const written = await response.json<{ writtenEvents: Array<{ id: string; eventPayloadName: string; sortableUniqueIdValue: string }> }>();
    expect(written.writtenEvents).toHaveLength(1);
    const eventId = written.writtenEvents[0]!.id;
    const tagNamespace = (env as unknown as { readonly TAG: DurableObjectNamespace }).TAG;
    const tagStub = tagNamespace.get(tagNamespace.idFromName(`${serviceId}|${tag}`));
    const stateResponse = await tagStub.fetch(new Request(`https://mapping.test/state?__tag=${encodeURIComponent(tag)}`));
    expect(stateResponse.status).toBe(200);
    const state = await stateResponse.json<{ events: Array<{ eventId: string; eventType?: string; suid?: string; eventTags?: string[] }> }>();
    const stored = state.events.find((event) => event.eventId === eventId);
    expect(stored).toMatchObject({ eventType: "RoomCreated", eventTags: [tag] });
    const callerSelectedVersion = validateCommitEnvelope({
      version: 1,
      eventCandidates: [{ payload: payloadBase64, eventPayloadName: "RoomCreated", eventPayloadVersion: 99, tags: [tag] }],
      consistencyTags: [],
    });
    const admission: MappingAdmissionEvidence = {
      eventPayloadName: written.writtenEvents[0]!.eventPayloadName,
      eventType: stored!.eventType!,
      payloadBase64,
      storedEventId: eventId,
      storedSuid: stored!.suid ?? written.writtenEvents[0]!.sortableUniqueIdValue,
      tags: stored!.eventTags ?? [tag],
      versionOptionRejected: "error" in callerSelectedVersion,
    };
    observed = await observePortableMappingExecution(admission);
  });

  it("loads the versioned table and validates observations from the real DO-ts session and runtime bridge", async () => {
    const execution = observed.execution;
    const runtime = composeRuntime(meetingRoomDomain, meetingRoomRuntimeConfig);
    const runtimeResult = await runtime.commands.execute("create-room", { roomId: "g29-mapping-runtime-bridge", name: "Observed" }, { now: "mapping-fixed-now" });
    expect(mapping.schemaVersion).toBe(1);
    expect(runtimeResult).toMatchObject({ kind: "committed", events: [{ eventType: "RoomCreated" }] });
    expect(observed.candidate.events[0]?.eventType).toBe("RoomCreated");
    expect(observed.decisionLogBytes).toContain("mapping-fixed-now");
    expect(execution.runtimeBridgeOutcome).toBe("committed");
    expect(execution.eventTypes).toEqual(meetingRoomDomain.events.map((event) => event.eventType));
    expect(execution.viewManifest).toEqual(meetingRoomRuntimeConfig.deliveryViews.map((view) => expect.objectContaining({ id: view.id })));
    expect(execution.restoredSnapshot).toEqual(execution.portableSnapshot);
    expect(execution.doTs.outcome).toBe(execution.portable.outcome);
    expect(execution.doTs.candidate.events).toEqual(execution.portable.candidate.events);
    expect(execution.doTs.claims).toEqual(execution.portable.claims);
    expect(execution.doTs.decisionLogBytes).toBe(execution.portable.decisionLogBytes);
    expect(execution.admission).toMatchObject({ eventPayloadName: "RoomCreated", eventType: "RoomCreated", versionOptionRejected: true });
    expect(assertMappingContract(observed.contract, mapping)).toEqual({ rows: 13, columns: 7 });
  });

  const mutationCases = mapping.rows.flatMap((row) => mapping.columns.map((column) => [row.rowId, column] as const));
  it.each(mutationCases)("reports an exact row/column when %s:%s is dropped", (rowId, column) => {
    expect(() => assertMappingContract(mutateMapping(observed.contract, rowId, column), mapping))
      .toThrow(`${rowId}:${column}`);
  });
});
