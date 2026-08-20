import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/g22-csharp-fixture.generated.json";
// @ts-expect-error Vite raw asset import preserves the committed generator bytes.
import fixtureBytes from "./fixtures/g22-csharp-fixture.generated.json?raw";
import provenance from "./fixtures/g22-csharp-fixture.provenance.json";
import { handleOperatorBootstrap } from "../packages/dcb-runtime/src/bootstrap/OperatorBootstrap";
import type { PipelineStore, StoredEvent } from "../packages/dcb-runtime/src/store/types";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { PostgresEventStore } from "../packages/dcb-runtime/src/store/PostgresEventStore";
import { runG22BootstrapProviderContract } from "./helpers/g22-bootstrap-provider-contract";

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
  it("isolates management bearer guards and never forwards client headers on GET or POST coordinator calls", async () => {
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
    const plan = await handleOperatorBootstrap(new Request("https://operator.test/operator/bootstrap/service/plan", {
      method: "POST",
      headers: { authorization: "Bearer operator-secret", "content-type": "application/json", "x-sdt-test-only": "must-not-forward", "x-unrelated-client-header": "must-not-forward" },
      body: JSON.stringify({ importId: "operator-plan", dump: {}, targetEvidence: {} }),
    }), env as never, provider);
    expect(plan.status).toBe(200);
    expect(forwarded).toHaveLength(2);
    expect(forwarded[1]!.get("authorization")).toBeNull();
    expect(forwarded[1]!.get("x-sdt-test-only")).toBeNull();
    expect(forwarded[1]!.get("x-unrelated-client-header")).toBeNull();
    expect(forwarded[1]!.get("content-type")).toBe("application/json");
  });
  it("binds bootstrap to the target serving allocator lineage, never a caller-supplied synthetic value", async () => {
    const allocatorNames: string[] = [];
    const env = {
      REPAIR_OPERATOR_TOKEN: "operator-secret",
      BOOTSTRAP: { idFromName: (value: string) => value, get: () => ({ fetch: async () => Response.json({ status: "EMPTY" }) }) },
      ALLOCATOR: {
        idFromName: (value: string) => { allocatorNames.push(value); return value; },
        get: () => ({ fetch: async () => Response.json({ allocatorLineageId: "serving-allocator-lineage", allocatedWatermark: null, bootstrapSeed: null }) }),
      },
    };
    const provider = { name: "test", create: () => memory([event("source", "event", 1)]) };
    const endpoint = "https://operator.test/operator/bootstrap/source/export";
    const exported = await handleOperatorBootstrap(new Request(endpoint, { method: "POST", headers: { authorization: "Bearer operator-secret", "content-type": "application/json" }, body: JSON.stringify({ targetServiceId: "target" }) }), env as never, provider);
    expect(exported.status).toBe(200);
    const body = await exported.json<{ dump: { manifest: { target: { allocatorLineageId: string } } } }>();
    expect(body.dump.manifest.target.allocatorLineageId).toBe("serving-allocator-lineage");
    expect(allocatorNames).toEqual(["service-allocator:target"]);
    const synthetic = await handleOperatorBootstrap(new Request(endpoint, { method: "POST", headers: { authorization: "Bearer operator-secret", "content-type": "application/json" }, body: JSON.stringify({ targetServiceId: "target", allocatorLineageId: "synthetic" }) }), env as never, provider);
    expect(synthetic.status).toBe(400);
  });
  it("uses the provenance-fixed C# reference fixture bytes rather than handwritten canonical JSON", async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fixtureBytes));
    expect([...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(provenance.sha256);
    expect(fixture as { events: unknown[] }).toMatchObject({ events: [{ eventId: "11111111-1111-1111-1111-111111111111", payload: "AQI=" }] });
  });
  it("runs export snapshot and admission identity invariants against PostgresEventStore", async () => {
    const url = (env as unknown as { POSTGRES_URL?: string }).POSTGRES_URL;
    if (url === undefined) throw new Error("POSTGRES_URL binding is required for the real Postgres bootstrap contract");
    await runG22BootstrapProviderContract("postgres", new PostgresEventStore(url));
  });
});
