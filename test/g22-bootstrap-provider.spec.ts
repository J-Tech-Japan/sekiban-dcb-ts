import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/g22-csharp-fixture.generated.json";
// @ts-expect-error Vite raw asset import preserves the committed generator bytes.
import fixtureBytes from "./fixtures/g22-csharp-fixture.generated.json?raw";
import provenance from "./fixtures/g22-csharp-fixture.provenance.json";
import { bootstrapDigest } from "../packages/dcb-runtime/src/bootstrap/manifest";
import { handleOperatorBootstrap } from "../packages/dcb-runtime/src/bootstrap/OperatorBootstrap";
import { createRuntimeWorker } from "../packages/dcb-runtime/src/index";
import { createCloudflareOnlyRuntimeWorker } from "../packages/dcb-runtime/src/cloudflare";
import {
  injectableServiceIdentity,
  TEST_SERVICE_ID_HEADER,
  type ServiceIdentityProvider,
  type ServiceIdentityRequestOptions,
} from "../packages/dcb-runtime/src/service/ServiceIdentityProvider";
import type { PipelineStore, StoredEvent } from "../packages/dcb-runtime/src/store/types";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { PostgresEventStore } from "../packages/dcb-runtime/src/store/PostgresEventStore";
import { createPostgresBootstrapAdapter } from "../packages/dcb-runtime/src/store/provider";
import { runG22BootstrapProviderContract } from "./helpers/g22-bootstrap-provider-contract";
import { G32_FIXTURE_TIMESTAMP, g32EventId, g32Suid } from "./helpers/g32-fixtures";
import { serializedEventMetadata } from "../packages/dcb-runtime/src/eventRecord";

const suid = (value: number) => g32Suid(`g22-provider-${value}`);
function event(serviceId: string, eventId: string, n: number, payload = JSON.stringify({ fixture: n }), tags = ["orders"]): StoredEvent {
  const id = g32EventId(eventId);
  const metadata = serializedEventMetadata(id);
  return {
    serviceId,
    id,
    eventId: id,
    sortableUniqueId: suid(n),
    suid: suid(n),
    payload,
    tags: [...tags],
    eventTags: [...tags],
    eventType: "BootstrapFixture",
    timestamp: G32_FIXTURE_TIMESTAMP,
    causationId: metadata.causationId,
    correlationId: metadata.correlationId,
    executedUser: metadata.executedUser,
    provenance: "g32",
    firstArrivedAt: 0,
    lastArrivedAt: 0,
    maxDeliveryLagMs: 0,
    arrivals: [],
  };
}
function memory(events: StoredEvent[]): PipelineStore {
  const rows = [...events];
  return {
    initialize: async () => {},
    readAllEvents: async (serviceId: string) => rows.filter((row) => row.serviceId === serviceId).sort((left, right) => left.suid.localeCompare(right.suid)),
    recordDelivery: async (message: DownstreamOutboxMessage) => {
      const existing = rows.find((row) => row.serviceId === message.serviceId && row.eventId === message.eventId);
      if (existing === undefined) {
        const stored = event(message.serviceId, message.eventId, rows.length + 1, message.payload, [...message.eventTags]);
        rows.push({
          ...stored,
          id: message.eventId,
          eventId: message.eventId,
          sortableUniqueId: message.suid,
          suid: message.suid,
          eventType: message.eventType,
          timestamp: message.timestamp,
          causationId: message.causationId,
          correlationId: message.correlationId,
          executedUser: message.executedUser,
        });
      }
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
    expect(allocatorNames).toEqual(["target/allocator/allocator", "source/allocator/allocator"]);
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
    await runG22BootstrapProviderContract("postgres", new PostgresEventStore(url), createPostgresBootstrapAdapter);
  });
  it("does not publish READY when deployment read-model rebuild fails after verification", async () => {
    const calls: string[] = [];
    const eventId = g32EventId("rebuild-event");
    const metadata = serializedEventMetadata(eventId);
    const record = {
      eventId,
      suid: suid(1),
      payload: JSON.stringify({ fixture: "rebuild" }),
      eventTags: ["orders"],
      eventType: "RebuildEvent",
      provenance: { origin: "g32" as const },
      timestamp: G32_FIXTURE_TIMESTAMP,
      causationId: metadata.causationId,
      correlationId: metadata.correlationId,
      executedUser: metadata.executedUser,
    };
    const draft = {
      format: "sekiban-dcb-bootstrap" as const, version: 1 as const,
      source: { serviceId: "source", lineageId: "source-lineage" },
      target: { serviceId: "target", allocatorLineageId: "lineage" },
      highWatermark: suid(1), eventCount: 1, tagCounts: { orders: 1 }, canonicalization: "utf8-json-sorted-keys-v1" as const,
    };
    const dump = { manifest: { ...draft, contentDigest: bootstrapDigest({ manifest: { ...draft, contentDigest: "" }, events: [record] }) }, events: [record] };
    const coordinator = {
      fetch: async (request: Request) => {
        calls.push(new URL(request.url).pathname);
        return Response.json({ status: new URL(request.url).pathname === "/verify" ? "VERIFYING" : "IMPORTING" });
      },
    };
    const env = { REPAIR_OPERATOR_TOKEN: "operator-secret", BOOTSTRAP: { idFromName: (value: string) => value, get: () => coordinator } };
    const response = await handleOperatorBootstrap(new Request("https://operator.test/operator/bootstrap/target/import", {
      method: "POST", headers: { authorization: "Bearer operator-secret", "content-type": "application/json" }, body: JSON.stringify({ importId: "rebuild", leaseEpoch: 1, dump }),
    }), env as never, { name: "test", create: () => memory([]) }, {
      afterVerifyBeforeReady: async () => { throw new Error("materialized view rebuild unavailable"); },
    });
    expect(response.status).toBe(503);
    expect((await response.json<{ code: string }>()).code).toBe("bootstrap_read_model_rebuild_failed");
    expect(calls).toEqual(["/import", "/verify"]);
  });
});

const DOWNSTREAM = ["BOOTSTRAP", "ALLOCATOR", "JOURNAL", "TAG", "TAG_STATE", "D1", "D1_MV", "REPAIR_EXCLUSION_LOOKUP", "DOWNSTREAM_QUEUE"] as const;

function countedIdentity(configured: string | undefined) {
  const calls = { forRequest: 0, deployment: 0 };
  const seen: Array<{ readonly options: ServiceIdentityRequestOptions | undefined; readonly header: string | null }> = [];
  const inner = injectableServiceIdentity(configured);
  const provider: ServiceIdentityProvider = {
    deployment() {
      calls.deployment += 1;
      return inner.deployment();
    },
    forRequest(request, options) {
      calls.forRequest += 1;
      seen.push({ options, header: request.headers.get(TEST_SERVICE_ID_HEADER) });
      return inner.forRequest(request, options);
    },
  };
  return { calls, seen, provider };
}

function countJson(request: Request, reads: { json: number }): Request {
  return new Proxy(request, {
    get(target, property) {
      if (property === "json") {
        return async () => {
          reads.json += 1;
          return target.json();
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function accessEnv(base: Record<string, unknown>, access: Record<string, number>) {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (typeof property === "string") access[property] = (access[property] ?? 0) + 1;
      if (typeof property === "string" && DOWNSTREAM.includes(property as typeof DOWNSTREAM[number]) && !Object.hasOwn(target, property)) {
        throw new Error(`unexpected downstream access: ${property}`);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function countTracing(reads: { tracing: number }): ExecutionContext {
  return new Proxy({} as ExecutionContext, {
    get(_target, property) {
      if (property === "tracing") {
        reads.tracing += 1;
        return undefined;
      }
      if (property === "waitUntil" || property === "passThroughOnException") return () => undefined;
      return undefined;
    },
  });
}

function expectNoDownstream(access: Record<string, number>, reads: { json: number; tracing: number; creates: number }, identity: { forRequest: number; deployment: number }, label: string) {
  for (const name of DOWNSTREAM) expect(access[name] ?? 0, `${label} ${name}`).toBe(0);
  expect(reads.json, `${label} json`).toBe(0);
  expect(reads.tracing, `${label} tracing`).toBe(0);
  expect(reads.creates, `${label} provider create`).toBe(0);
  expect(identity.forRequest, `${label} forRequest`).toBe(0);
  expect(identity.deployment, `${label} deployment`).toBe(0);
}

describe("bootstrap bearer denials", () => {
  const factories = [
    { name: "createRuntimeWorker", create: createRuntimeWorker },
    { name: "createCloudflareOnlyRuntimeWorker", create: createCloudflareOnlyRuntimeWorker },
  ] as const;
  const denials = [
    { label: "absent binding", token: undefined, header: "Bearer operator-secret", status: 404, code: "not_found" },
    { label: "empty binding", token: "", header: "Bearer ", status: 404, code: "not_found" },
    { label: "whitespace binding", token: " \t\n ", header: "Bearer  \t\n ", status: 404, code: "not_found" },
    { label: "missing header", token: "operator-secret", header: undefined, status: 404, code: "not_found" },
    { label: "wrong credential", token: "operator-secret", header: "Bearer wrong", status: 403, code: "operator_auth_required" },
  ] as const;

  it("rejects direct handler denials before parsing, provider creation, or Durable Object access", async () => {
    for (const row of denials) {
      const reads = { bootstrap: 0, allocator: 0, creates: 0, json: 0 };
      const runtimeEnv = {
        REPAIR_OPERATOR_TOKEN: row.token,
        BOOTSTRAP: { idFromName: () => "id", get: () => { reads.bootstrap += 1; throw new Error("bootstrap get"); } },
        ALLOCATOR: { idFromName: () => "id", get: () => { reads.allocator += 1; throw new Error("allocator get"); } },
      };
      const provider = { name: "test", create: () => { reads.creates += 1; throw new Error("provider create"); } };
      const request = countJson(new Request("https://operator.test/operator/bootstrap/service/plan", {
        method: "POST",
        headers: row.header === undefined ? undefined : { authorization: row.header },
        body: "{}",
      }), reads);
      const response = await handleOperatorBootstrap(request, runtimeEnv as never, provider as never);
      expect(response.status, row.label).toBe(row.status);
      const body = await response.text();
      expect(JSON.parse(body), row.label).toMatchObject({ code: row.code });
      expect(body, row.label).not.toContain("operator-secret");
      expect(reads, row.label).toEqual({ bootstrap: 0, allocator: 0, creates: 0, json: 0 });
    }
  });

  it.each(factories)("rejects $name bootstrap denials before identity and downstream access", async (factory) => {
    for (const row of denials) {
      const access: Record<string, number> = {};
      const reads = { json: 0, tracing: 0, creates: 0 };
      const identity = countedIdentity("deployed-service");
      const storeProvider = { name: "test", create: () => { reads.creates += 1; throw new Error("provider create"); } };
      const worker = factory.create({ serviceIdentityProvider: identity.provider, storeProvider } as never);
      const fetch = worker.fetch as (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>;
      const request = countJson(new Request("https://operator.test/operator/bootstrap/service/plan", {
        method: "POST",
        headers: row.header === undefined ? undefined : { authorization: row.header },
        body: "{}",
      }), reads);
      const response = await fetch(request, accessEnv({ REPAIR_OPERATOR_TOKEN: row.token }, access), countTracing(reads));
      expect(response.status, `${factory.name} ${row.label}`).toBe(row.status);
      const body = await response.text();
      expect(JSON.parse(body), `${factory.name} ${row.label}`).toMatchObject({ code: row.code });
      expect(body, `${factory.name} ${row.label}`).not.toContain("operator-secret");
      if (row.header !== undefined) expect(body, `${factory.name} ${row.label}`).not.toContain(row.header);
      expectNoDownstream(access, reads, identity.calls, `${factory.name} ${row.label}`);
    }
  });

  it.each(factories)("keeps $name authorized bootstrap on the identity-missing 503", async (factory) => {
    const access: Record<string, number> = {};
    const reads = { json: 0, tracing: 0, creates: 0 };
    const identity = countedIdentity(undefined);
    const worker = factory.create({ serviceIdentityProvider: identity.provider } as never);
    const fetch = worker.fetch as (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>;
    const response = await fetch(
      new Request("https://operator.test/operator/bootstrap/service/status", { headers: { authorization: "Bearer operator-secret" } }),
      accessEnv({ REPAIR_OPERATOR_TOKEN: "operator-secret" }, access),
      countTracing(reads),
    );
    expect(response.status, factory.name).toBe(503);
    expect(await response.json(), factory.name).toEqual({
      code: "scope.identity_missing",
      error: "A deployment service identity is required for this scope",
    });
    expect(identity.calls.forRequest, factory.name).toBe(1);
    expect(identity.calls.deployment, factory.name).toBe(0);
    expectNoDownstream(access, reads, { forRequest: 0, deployment: 0 }, `${factory.name} identity-missing downstream`);
  });

  it.each(factories)("passes $name request-identity options through to authorized bootstrap handling", async (factory) => {
    for (const allow of [true, false]) {
      const access: Record<string, number> = {};
      const reads = { json: 0, tracing: 0, creates: 0, coordinator: 0 };
      const identity = countedIdentity("deployed-service");
      const namespace = {
        idFromName: (value: string) => value,
        get: () => ({ fetch: async () => { reads.coordinator += 1; return Response.json({ status: "EMPTY" }); } }),
      };
      const worker = factory.create({ serviceIdentityProvider: identity.provider } as never);
      const fetch = worker.fetch as (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>;
      const response = await fetch(new Request("https://operator.test/operator/bootstrap/service/status", {
        headers: { authorization: "Bearer operator-secret", [TEST_SERVICE_ID_HEADER]: "override-service" },
      }), accessEnv({
        REPAIR_OPERATOR_TOKEN: "operator-secret",
        D1: undefined,
        ...(allow ? { G11_VERIFICATION_ENABLED: "true" } : {}),
        BOOTSTRAP: namespace,
      }, access), countTracing(reads));
      expect(response.status, `${factory.name} allow=${allow}`).toBe(200);
      expect(identity.calls.forRequest, `${factory.name} allow=${allow}`).toBe(1);
      expect(identity.seen[0]?.options, `${factory.name} allow=${allow}`).toEqual({ allowG11Verification: allow });
      expect(identity.seen[0]?.header, `${factory.name} allow=${allow}`).toBe("override-service");
      expect(reads.coordinator, `${factory.name} allow=${allow}`).toBe(1);
      expect(access.D1 ?? 0, `${factory.name} allow=${allow} D1`).toBe(factory.name === "createCloudflareOnlyRuntimeWorker" ? 1 : 0);
    }
  });
});
