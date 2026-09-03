import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  assertG32StoredIdentity,
  cutoverAdmission,
  cutoverLaneIds,
  cutoverOutcome,
} from "../samples/meeting-room/src/compatibility";
import { CommitWorker, type CommitWorkerEnv, validateCommitEnvelope } from "../packages/dcb-runtime/src/commit/CommitWorker";
import { processDownstreamDelivery } from "../packages/dcb-runtime/src/downstream/DownstreamAdapter";
import type { PipelineStore } from "../packages/dcb-runtime/src/store/types";
import { g32EventId, g32Message, g32Suid } from "./helpers/g32-fixtures";
import { scopeIdFor } from "../packages/dcb-runtime/src/scope/ScopeName";

describe("SDT-G29 cutover compatibility boundary", () => {
  it("exposes only the bridge-freeze and fresh-G32 lanes", () => {
    expect(cutoverLaneIds()).toEqual(["bridge-freeze", "fresh-g32"]);
    expect(cutoverLaneIds().map(cutoverOutcome)).toEqual(["frozen", "accepted"]);
  });

  it("accepts only the bridge freeze token before the fresh service opens writers", () => {
    expect(cutoverAdmission("bridge-freeze", { freezeToken: true })).toBe("frozen");
    expect(cutoverAdmission("bridge-freeze", { freezeToken: false })).toBe("typed-rejected");
    expect(cutoverAdmission("bridge-freeze", {
      eventId: g32EventId("bridge-must-not-write"),
      suid: g32Suid("bridge-must-not-write"),
      eventType: "RoomCreated",
      provenance: "g32",
    })).toBe("typed-rejected");
  });

  it("admits only a fully formed fresh G32 record and rejects all pre-cutover shapes", () => {
    const accepted = {
      eventId: g32EventId("fresh-g32"),
      suid: g32Suid("fresh-g32"),
      eventType: "RoomCreated",
      provenance: "g32" as const,
    };
    expect(cutoverAdmission("fresh-g32", accepted)).toBe("accepted");
    expect(() => assertG32StoredIdentity({ ...accepted, eventType: "RoomCreated:1" })).toThrow("G32_STORED_RECORD_INVALID");
    expect(() => assertG32StoredIdentity({ ...accepted, suid: accepted.suid.slice(1) })).toThrow("G32_STORED_RECORD_INVALID");
    expect(() => assertG32StoredIdentity({ ...accepted, provenance: "g27" })).toThrow("G32_STORED_RECORD_INVALID");
  });

  it("uses the real CommitWorker/Tag boundary with name-only EventType and no version option", async () => {
    const serviceId = `g29-g32-${crypto.randomUUID()}`;
    const tag = `room:g29-g32-${crypto.randomUUID()}`;
    const response = await new CommitWorker(env as unknown as CommitWorkerEnv, serviceId).handle(new Request("https://commit.test/api/sekiban/serialized/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        eventCandidates: [{
          payload: btoa(JSON.stringify({ roomId: "g29-g32" })),
          eventPayloadName: "G29Observed",
          tags: [tag],
        }],
        consistencyTags: [],
      }),
    }));
    expect(response.status).toBe(200);
    const written = await response.json<{ writtenEvents: Array<{ id: string; eventPayloadName: string; sortableUniqueIdValue: string }> }>();
    expect(written.writtenEvents[0]).toMatchObject({ eventPayloadName: "G29Observed" });

    const tagNamespace = (env as unknown as { readonly TAG: DurableObjectNamespace }).TAG;
    const tagStub = tagNamespace.get(scopeIdFor(tagNamespace, { serviceId, doClass: "tag", identity: tag }));
    const stateResponse = await tagStub.fetch(new Request(`https://compat.test/state?__tag=${encodeURIComponent(tag)}`));
    expect(stateResponse.status).toBe(200);
    const state = await stateResponse.json<{ events: Array<{ eventId: string; eventType?: string; provenance?: string }> }>();
    expect(state.events).toContainEqual(expect.objectContaining({
      eventId: written.writtenEvents[0]?.id,
      eventType: "G29Observed",
      provenance: "g32",
    }));
    expect(validateCommitEnvelope({
      version: 1,
      eventCandidates: [{ payload: "e30=", eventPayloadName: "G29Observed", eventPayloadVersion: 2, tags: [tag] }],
      consistencyTags: [],
    })).toHaveProperty("error");
  });

  it("fails legacy Queue input before a downstream store can be called", async () => {
    let downstreamCalls = 0;
    const store = { recordDelivery: async () => { downstreamCalls += 1; throw new Error("must not dispatch"); } } as unknown as PipelineStore;
    const legacy = g32Message({
      serviceId: "g29-cutover-boundary",
      allocatorLineageId: "g29-cutover-lineage",
      tag: "room:g29-cutover",
      eventId: "g29-cutover-event",
      suid: "g29-cutover-suid",
      payload: JSON.stringify({ roomId: "g29-cutover" }),
      eventTags: ["room:g29-cutover"],
      eventType: "RoomCreated",
    });
    await expect(processDownstreamDelivery({ ...legacy, provenance: "g27" } as never, {}, { store })).rejects.toThrow("invalid outbox message");
    expect(downstreamCalls).toBe(0);
  });
});
