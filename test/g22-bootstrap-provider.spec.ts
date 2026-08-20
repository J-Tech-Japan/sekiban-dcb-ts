import { describe, expect, it } from "vitest";
import fixture from "./fixtures/g22-csharp-fixture.generated.json";
import provenance from "./fixtures/g22-csharp-fixture.provenance.json";
import { BootstrapIdentityConflictError, createBootstrapStoreAdapter } from "../packages/dcb-runtime/src/bootstrap/BootstrapStoreAdapter";
import { handleOperatorBootstrap } from "../packages/dcb-runtime/src/bootstrap/OperatorBootstrap";
import type { PipelineStore, StoredEvent } from "../packages/dcb-runtime/src/store/types";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";

const suid = (value: number) => `suid-${String(value).padStart(32, "0")}`;
function event(serviceId: string, eventId: string, n: number, payload = "AQ==", tags = ["orders"]): StoredEvent {
  return { serviceId, eventId, suid: suid(n), payload, eventTags: tags, firstArrivedAt: 0, lastArrivedAt: 0, maxDeliveryLagMs: 0, arrivals: [] };
}
function memory(events: StoredEvent[]): PipelineStore {
  const rows = [...events];
  return {
    initialize: async () => {},
    readAllEvents: async (serviceId: string) => rows.filter((row) => row.serviceId === serviceId).sort((left, right) => left.suid.localeCompare(right.suid)),
    recordDelivery: async (message: DownstreamOutboxMessage) => {
      const existing = rows.find((row) => row.serviceId === message.serviceId && row.eventId === message.eventId);
      if (existing === undefined) rows.push(event(message.serviceId, message.eventId, Number(message.suid.slice(-32)), message.payload, [...message.eventTags]));
      return { outcome: "stored", kind: "stored", event: rows.find((row) => row.serviceId === message.serviceId && row.eventId === message.eventId)! };
    },
  } as unknown as PipelineStore;
}

describe("SDT-G22 provider bootstrap adapters", () => {
  it("isolates management bearer guards on an existing route and never forwards client headers", async () => {
    const forwarded: Headers[] = [];
    const coordinator = { fetch: async (request: Request) => { forwarded.push(request.headers); return Response.json({ status: "EMPTY" }); } };
    const env = { REPAIR_OPERATOR_TOKEN: "operator-secret", BOOTSTRAP: { idFromName: (value: string) => value, get: () => coordinator } };
    const provider = { name: "test", create: () => memory([]) };
    const endpoint = "https://operator.test/operator/bootstrap/service/status";
    expect((await handleOperatorBootstrap(new Request(endpoint), env as never, provider)).status).toBe(404);
    expect((await handleOperatorBootstrap(new Request(endpoint, { headers: { authorization: "Bearer wrong" } }), env as never, provider)).status).toBe(403);
    const accepted = await handleOperatorBootstrap(new Request(endpoint, { headers: { authorization: "Bearer operator-secret", "x-sdt-test-only": "must-not-forward" } }), env as never, provider);
    expect(accepted.status).toBe(200);
    expect(forwarded).toHaveLength(1); expect(forwarded[0]!.get("authorization")).toBeNull(); expect(forwarded[0]!.get("x-sdt-test-only")).toBeNull();
  });
  it("uses the provenance-fixed C# reference fixture bytes rather than handwritten canonical JSON", async () => {
    const bytes = JSON.stringify(fixture);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
    expect([...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(provenance.sha256);
    expect(fixture as { events: unknown[] }).toMatchObject({ events: [{ eventId: "11111111-1111-1111-1111-111111111111", payload: "AQI=" }] });
  });
  for (const provider of ["postgres", "cosmos", "d1"]) {
    it(`${provider} fixes the export watermark across pages and crash-resume`, async () => {
      const store = memory([event("source", "a", 1), event("source", "b", 2)]);
      const adapter = createBootstrapStoreAdapter(provider, store);
      const first = await adapter.exportPage({ sourceServiceId: "source", targetServiceId: "target", allocatorLineageId: "lineage", pageSize: 1 });
      // This append is deliberately after the snapshot boundary and must not leak on resume.
      await store.recordDelivery({ version: 1, serviceId: "source", allocatorLineageId: "lineage", tag: "orders", attemptId: "late", eventId: "late", suid: suid(3), payload: "Aw==", eventTags: ["orders"], enqueuedAt: 0 }, 0);
      const resumed = await adapter.exportPage({ sourceServiceId: "source", targetServiceId: "target", allocatorLineageId: "lineage", pageSize: 1, cursor: first.cursor });
      expect(first.dump.manifest.contentDigest).toBe(resumed.dump.manifest.contentDigest);
      expect(resumed.dump.events.map((row) => row.eventId)).toEqual(["a", "b"]);
      expect(resumed.page.map((row) => row.eventId)).toEqual(["b"]);
    });

    it(`${provider} rejects one-axis EventId identity changes before writes and permits byte-identical replay`, async () => {
      const target = event("target", "same", 1, "AQ==", ["orders"]); const store = memory([target]);
      const adapter = createBootstrapStoreAdapter(provider, store);
      const base = await adapter.exportPage({ sourceServiceId: "target", targetServiceId: "target", allocatorLineageId: "lineage", pageSize: 8 });
      await expect(adapter.admitBootstrap({ importId: "same", leaseEpoch: 1, manifest: base.dump.manifest, events: base.dump.events })).resolves.toBeUndefined();
      const changed = { ...base.dump.events[0]!, payload: "Ag==" };
      await expect(adapter.admitBootstrap({ importId: "changed", leaseEpoch: 1, manifest: base.dump.manifest, events: [changed] })).rejects.toBeInstanceOf(BootstrapIdentityConflictError);
      expect((await store.readAllEvents("target", "")).map((row) => [row.eventId, row.suid, row.payload, row.eventTags])).toEqual([["same", suid(1), "AQ==", ["orders"]]]);
    });
  }
});
