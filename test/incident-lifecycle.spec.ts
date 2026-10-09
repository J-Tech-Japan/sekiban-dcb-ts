import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error Vite raw asset import.
import g32Migration from "../migrations/d1/g32/0001_dcb_events.sql?raw";
// @ts-expect-error Vite raw asset import.
import lifecycleMigration from "../migrations/d1/g32/0021_incident_lifecycle.sql?raw";
// @ts-expect-error Vite raw asset import.
import starterLifecycleMigration from "../packages/create-dcb/template/migrations/d1/g32/0021_incident_lifecycle.sql?raw";
import { IncidentLifecycle } from "../packages/dcb-runtime/src/completeness/IncidentLifecycle";
import { createRuntimeWorker } from "../packages/dcb-runtime/src/index";
import { createCloudflareOnlyRuntimeWorker } from "../packages/dcb-runtime/src/cloudflare";
import { injectableServiceIdentity, TEST_SERVICE_ID_HEADER } from "../packages/dcb-runtime/src/service/ServiceIdentityProvider";
import { composeFetch } from "../packages/dcb-cloudflare/src/compose";
import { applyG44D1Migration } from "./helpers/g44-d1-migration";

const TOKEN = "incident-test-bearer";
const NOW = 5_000;

function database(): D1Database {
  const value = (env as unknown as { D1?: D1Database }).D1;
  if (value === undefined) throw new Error("incident lifecycle requires D1");
  return value;
}

function statements(sql: string): D1PreparedStatement[] {
  return sql.replace(/^\s*--.*$/gm, "").split(/;\s*(?=(?:CREATE|ALTER|INSERT|UPDATE|DELETE|DROP|PRAGMA|$))/i).map((value) => value.trim())
    .filter(Boolean).map((value) => database().prepare(value));
}

async function hasTable(name: string): Promise<boolean> {
  const row = await database().prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).bind(name).first<{ name: string }>();
  return row !== null && row !== undefined;
}

async function seedFinding(serviceId: string, incidentIdentity: string, observedAt = NOW): Promise<void> {
  await database().prepare(
    `INSERT INTO serialized_dcb_completeness_findings
       (service_id, incident_identity, incident_type, state, first_observed_at, last_observed_at)
     VALUES (?, ?, 'MISSING_RECEIPT', 'OPEN', ?, ?)`,
  ).bind(serviceId, incidentIdentity, observedAt, observedAt).run();
}

function action(identity: string, key: string, expectedVersion: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "ACKNOWLEDGE",
    incidentIdentity: identity,
    transitionKey: key,
    expectedVersion,
    reason: "take ownership",
    ownerId: "alice",
    deadlineAt: NOW + 10_000,
    ...extra,
  };
}

async function installMigration(): Promise<void> {
  if (!(await hasTable("dcb_events"))) await database().batch(statements(g32Migration as string));
  await applyG44D1Migration(database());
  if (!(await hasTable("serialized_dcb_incident_lifecycles"))) {
    await database().batch(statements(lifecycleMigration as string));
  }
}

beforeAll(installMigration);

describe("SDT-G124 incident lifecycle", () => {
  it("keeps root and starter migrations byte-identical and installs the lifecycle schema", async () => {
    expect(starterLifecycleMigration).toBe(lifecycleMigration);
    expect(await hasTable("serialized_dcb_incident_lifecycles")).toBe(true);
    expect(await hasTable("serialized_dcb_incident_transitions")).toBe(true);
    const triggers = await database().prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'serialized_dcb_incident_transitions_no_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(triggers.results.map((row) => row.name)).toEqual([
      "serialized_dcb_incident_transitions_no_delete",
      "serialized_dcb_incident_transitions_no_update",
    ]);
  });

  it("synthesizes legacy OPEN, follows every legal edge, and retains audit history", async () => {
    const serviceId = `g124-graph-${crypto.randomUUID()}`;
    const identity = `finding-${crypto.randomUUID()}`;
    await seedFinding(serviceId, identity);
    const lifecycle = new IncidentLifecycle(database(), () => 0);
    expect((await lifecycle.detail(serviceId, identity)).lifecycle.lifecycleState).toBe("OPEN");

    const acknowledged = await lifecycle.transition(serviceId, action(identity, "a", 0), "alice");
    expect(acknowledged.projection.lifecycleState).toBe("ACKNOWLEDGED");
    const corrected = await lifecycle.transition(serviceId, {
      action: "RECORD_CORRECTION", incidentIdentity: identity, transitionKey: "c", expectedVersion: 1,
      reason: "receipt recorded", correction: { kind: "receipt", reference: "receipt-1", digest: `sha256:${"a".repeat(64)}` },
    }, "alice");
    expect(corrected.projection.lifecycleState).toBe("CORRECTION_RECORDED");
    const closed = await lifecycle.transition(serviceId, {
      action: "CLOSE", incidentIdentity: identity, transitionKey: "close", expectedVersion: 2,
      reason: "corrected", resolution: { kind: "CORRECTED" },
    }, "alice");
    expect(closed.projection.lifecycleState).toBe("CLOSED");
    const reopened = await lifecycle.transition(serviceId, {
      action: "REOPEN", incidentIdentity: identity, transitionKey: "reopen", expectedVersion: 3,
      reason: "new observation", ownerId: "bob", deadlineAt: NOW + 20_000,
    }, "alice");
    expect(reopened.projection).toMatchObject({ lifecycleState: "REOPENED", correction: null, closeResolution: null });
    const reacknowledged = await lifecycle.transition(serviceId, action(identity, "reack", 4), "alice");
    expect(reacknowledged.projection.lifecycleState).toBe("ACKNOWLEDGED");
    const reassigned = await lifecycle.transition(serviceId, {
      action: "UPDATE_ASSIGNMENT", incidentIdentity: identity, transitionKey: "reassign", expectedVersion: 5,
      reason: "new owner", ownerId: "carol", deadlineAt: NOW + 30_000,
    }, "alice");
    expect(reassigned.projection).toMatchObject({ lifecycleState: "ACKNOWLEDGED", ownerId: "carol" });
    const detail = await lifecycle.detail(serviceId, identity);
    expect(detail.transitions).toHaveLength(6);
    expect(detail.transitions.map((row) => `${row.fromState}->${row.toState}`)).toEqual([
      "OPEN->ACKNOWLEDGED", "ACKNOWLEDGED->CORRECTION_RECORDED",
      "CORRECTION_RECORDED->CLOSED", "CLOSED->REOPENED", "REOPENED->ACKNOWLEDGED",
      "ACKNOWLEDGED->ACKNOWLEDGED",
    ]);
  });

  it("rejects illegal edges and invalid shapes without changing projection or audit", async () => {
    const serviceId = `g124-invalid-${crypto.randomUUID()}`;
    const identity = `finding-${crypto.randomUUID()}`;
    await seedFinding(serviceId, identity);
    const lifecycle = new IncidentLifecycle(database(), () => 0);
    await expect(lifecycle.transition(serviceId, {
      action: "CLOSE", incidentIdentity: identity, transitionKey: "bad-close", expectedVersion: 0,
      reason: "too early", resolution: { kind: "ACCEPTED_AS_IS", explanation: "no" },
    }, "alice")).rejects.toMatchObject({ code: "incident_invalid_transition" });
    await expect(lifecycle.transition(serviceId, action(identity, "bad-deadline", 0, { deadlineAt: 0 }), "alice"))
      .rejects.toMatchObject({ code: "incident_invalid_deadline" });
    const detail = await lifecycle.detail(serviceId, identity);
    expect(detail.lifecycle).toMatchObject({ lifecycleState: "OPEN", version: 0 });
    expect(detail.transitions).toHaveLength(0);
  });

  it("enforces durable lifecycle state shapes and the restrictive finding foreign key", async () => {
    const serviceId = `g124-ddl-${crypto.randomUUID()}`;
    const identity = `finding-${crypto.randomUUID()}`;
    await seedFinding(serviceId, identity);
    await expect(database().prepare(
      `INSERT INTO serialized_dcb_incident_lifecycles
        (service_id, incident_identity, lifecycle_state, version, last_transition_key, updated_at)
       VALUES (?, ?, 'ACKNOWLEDGED', 0, '', 1)`,
    ).bind(serviceId, identity).run()).rejects.toThrow(/CHECK constraint/);
    await new IncidentLifecycle(database(), () => 0).transition(serviceId, action(identity, "seed-ack", 0), "alice");
    await expect(database().prepare(
      `INSERT INTO serialized_dcb_incident_lifecycles
        (service_id, incident_identity, lifecycle_state, owner_id, deadline_at,
         correction_kind, correction_reference, correction_digest, close_resolution,
         close_reason, version, last_transition_key, updated_at)
       VALUES (?, ?, 'CLOSED', 'alice', 10, 'event', 'e', 'sha256:${"A".repeat(64)}',
               'CORRECTED', 'done', 0, '', 1)`,
    ).bind(serviceId, identity).run()).rejects.toThrow(/CHECK constraint/);
    await expect(database().prepare(
      "DELETE FROM serialized_dcb_completeness_findings WHERE service_id = ? AND incident_identity = ?",
    ).bind(serviceId, identity).run()).rejects.toThrow(/FOREIGN KEY/);
  });

  it("implements actor-bound idempotency, stale versions, and accepted-as-is closure", async () => {
    const serviceId = `g124-idempotency-${crypto.randomUUID()}`;
    const identity = `finding-${crypto.randomUUID()}`;
    await seedFinding(serviceId, identity);
    const lifecycle = new IncidentLifecycle(database(), () => 0);
    const first = await lifecycle.transition(serviceId, action(identity, "same", 0), "alice");
    const retry = await lifecycle.transition(serviceId, action(identity, "same", 0), "alice");
    expect(retry.idempotent).toBe(true);
    await expect(lifecycle.transition(serviceId, action(identity, "same", 0), "bob"))
      .rejects.toMatchObject({ code: "incident_idempotency_conflict" });
    await expect(lifecycle.transition(serviceId, action(identity, "new", 0), "alice"))
      .rejects.toMatchObject({ code: "incident_version_conflict" });
    const closed = await lifecycle.transition(serviceId, {
      action: "CLOSE", incidentIdentity: identity, transitionKey: "accepted", expectedVersion: 1,
      reason: "reviewed", resolution: { kind: "ACCEPTED_AS_IS", explanation: "source was intentionally unavailable" },
    }, "alice");
    expect(closed.projection.closeResolution).toBe("ACCEPTED_AS_IS");
    expect(first.transition.requestDigest).not.toContain(TOKEN);
  });

  it("applies post-filter summaries, active-only overdue, and same-millisecond observation semantics", async () => {
    const serviceId = `g124-read-${crypto.randomUUID()}`;
    const overdueIdentity = `a-${crypto.randomUUID()}`;
    const closedIdentity = `b-${crypto.randomUUID()}`;
    const otherService = `g124-read-other-${crypto.randomUUID()}`;
    await seedFinding(serviceId, overdueIdentity, NOW - 2);
    await seedFinding(serviceId, closedIdentity, NOW - 1);
    await seedFinding(otherService, overdueIdentity, NOW - 2);
    const lifecycle = new IncidentLifecycle(database(), () => 0);
    await lifecycle.transition(serviceId, action(overdueIdentity, "ack", 0, { deadlineAt: 1 }), "alice");
    await lifecycle.transition(serviceId, action(closedIdentity, "ack", 0), "alice");
    await lifecycle.transition(serviceId, {
      action: "CLOSE", incidentIdentity: closedIdentity, transitionKey: "close", expectedVersion: 1,
      reason: "accepted", resolution: { kind: "ACCEPTED_AS_IS", explanation: "accepted" },
    }, "alice");
    await database().prepare(
      "UPDATE serialized_dcb_completeness_findings SET last_observed_at = ? WHERE service_id = ? AND incident_identity = ?",
    ).bind(0, serviceId, closedIdentity).run();
    const closed = await lifecycle.list(serviceId, { state: "CLOSED" }, NOW);
    expect(closed.summary).toMatchObject({ total: 1, overdue: 0, observedAfterClose: 0 });
    expect((await lifecycle.list(serviceId)).items.map((item) => item.finding.serviceId)).toEqual([
      serviceId,
      serviceId,
    ]);
    await database().prepare(
      "UPDATE serialized_dcb_completeness_findings SET last_observed_at = ? WHERE service_id = ? AND incident_identity = ?",
    ).bind(1, serviceId, closedIdentity).run();
    expect((await lifecycle.list(serviceId, { observedAfterClose: true }, NOW)).summary.observedAfterClose).toBe(1);
    expect((await lifecycle.list(serviceId, { overdue: true }, NOW)).items.every((item) => item.lifecycle.lifecycleState !== "CLOSED")).toBe(true);
  });

  it("authenticates before identity, D1, and request parsing on the default and Cloudflare-only surfaces", async () => {
    const serviceId = `g124-http-${crypto.randomUUID()}`;
    const provider = injectableServiceIdentity(() => { throw new Error("identity should not run"); });
    const runtime = createRuntimeWorker({ serviceIdentityProvider: provider });
    const runtimeHandler = runtime.fetch as unknown as (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>;
    const missing = await runtimeHandler(new Request("https://incident.test/maintenance/incidents"), { INCIDENT_MAINTAINER_TOKEN: undefined }, {} as ExecutionContext);
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({ code: "incident_maintenance_unavailable" });
    const wrong = await runtimeHandler(new Request("https://incident.test/maintenance/incidents", { headers: { authorization: "Bearer undefined" } }), { INCIDENT_MAINTAINER_TOKEN: TOKEN }, {} as ExecutionContext);
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).not.toContain(TOKEN);

    const cloudflare = createCloudflareOnlyRuntimeWorker({ serviceIdentityProvider: injectableServiceIdentity(serviceId) });
    const cloudflareHandler = cloudflare.fetch as unknown as (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>;
    const cloudflareMissing = await cloudflareHandler(new Request("https://incident.test/maintenance/incidents", { headers: { authorization: `Bearer ${TOKEN}` } }), { INCIDENT_MAINTAINER_TOKEN: TOKEN }, {} as ExecutionContext);
    expect(cloudflareMissing.status).toBe(503);
  });

  it("keeps exact mounted routes exact while allowing only a segment-safe maintenance prefix", async () => {
    const calls: string[] = [];
    const composed = composeFetch<unknown, ExecutionContext, Request>({
      application: (request) => { calls.push(`app:${new URL(request.url).pathname}`); return new Response("app"); },
      sekiban: {
        prefix: "/internal/sekiban",
        extraPaths: ["/operator/repair"],
        extraPrefixes: ["/maintenance"],
        authorize: () => true,
        fetch: (request) => { calls.push(`runtime:${new URL(request.url).pathname}`); return new Response("runtime"); },
      },
    });
    expect((await composed(new Request("https://incident.test/internal/sekiban/maintenance/incidents"), {}, {} as ExecutionContext)).status).toBe(200);
    expect((await composed(new Request("https://incident.test/internal/sekiban/api/sekiban/serialized/query"), {}, {} as ExecutionContext)).status).toBe(200);
    expect(calls).toContain("runtime:/api/sekiban/serialized/query");
    expect((await composed(new Request("https://incident.test/internal/sekiban/api/sekiban/serialized/query/child"), {}, {} as ExecutionContext)).status).toBe(404);
    expect((await composed(new Request("https://incident.test/internal/sekiban/maintenance-other"), {}, {} as ExecutionContext)).status).toBe(404);
    expect((await composed(new Request("https://incident.test/internal/sekiban/operator/repair"), {}, {} as ExecutionContext)).status).toBe(200);
    expect((await composed(new Request("https://incident.test/internal/sekiban/operator/repair/child"), {}, {} as ExecutionContext)).status).toBe(404);
    const fallback = await composed(new Request("https://incident.test/application/assets"), {}, {} as ExecutionContext);
    await expect(fallback.text()).resolves.toBe("app");
    expect((await composed(new Request("https://incident.test/internal/sekiban/unknown"), {}, {} as ExecutionContext)).status).toBe(404);
    expect(calls).toContain("runtime:/maintenance/incidents");
  });

  it("rejects direct audit mutation and preserves scanner observations", async () => {
    const serviceId = `g124-safety-${crypto.randomUUID()}`;
    const identity = `finding-${crypto.randomUUID()}`;
    await seedFinding(serviceId, identity, 10);
    const lifecycle = new IncidentLifecycle(database(), () => NOW);
    await lifecycle.transition(serviceId, action(identity, "ack", 0), "alice");
    const audit = await database().prepare("SELECT transition_id FROM serialized_dcb_incident_transitions WHERE service_id = ? AND incident_identity = ?").bind(serviceId, identity).first<{ transition_id: number }>();
    await expect(database().prepare("DELETE FROM serialized_dcb_incident_transitions WHERE transition_id = ?").bind(audit?.transition_id).run()).rejects.toThrow(/immutable/);
    await database().prepare("UPDATE serialized_dcb_completeness_findings SET last_observed_at = ? WHERE service_id = ? AND incident_identity = ?").bind(20, serviceId, identity).run();
    const detail = await lifecycle.detail(serviceId, identity);
    expect(detail.finding.lastObservedAt).toBe(20);
    expect(detail.lifecycle.lifecycleState).toBe("ACKNOWLEDGED");
  });

  it("exposes a successful generated-starter list path through the mounted prefix", async () => {
    const serviceId = `g124-starter-${crypto.randomUUID()}`;
    const identity = `finding-${crypto.randomUUID()}`;
    await seedFinding(serviceId, identity);
    const starter = (await import("../packages/create-dcb/template/src/worker")) as { default: ExportedHandler };
    const starterFetch = starter.default.fetch as unknown as (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>;
    const response = await starterFetch(new Request("https://starter.test/internal/sekiban/maintenance/incidents", {
      headers: { authorization: `Bearer ${TOKEN}`, [TEST_SERVICE_ID_HEADER]: serviceId },
    }), { ...(env as unknown as Record<string, unknown>), D1: database(), D1_MV: database(), INCIDENT_MAINTAINER_TOKEN: TOKEN, SDT_SERVICE_ID: serviceId } as never, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect((await response.json<{ items: unknown[] }>()).items).toEqual(expect.arrayContaining([expect.objectContaining({ finding: expect.objectContaining({ incidentIdentity: identity }) })]));
    const detail = await starterFetch(new Request(`https://starter.test/internal/sekiban/maintenance/incidents/${encodeURIComponent(identity)}`, {
      headers: { authorization: `Bearer ${TOKEN}`, [TEST_SERVICE_ID_HEADER]: serviceId },
    }), { ...(env as unknown as Record<string, unknown>), D1: database(), D1_MV: database(), INCIDENT_MAINTAINER_TOKEN: TOKEN, SDT_SERVICE_ID: serviceId } as never, {} as ExecutionContext);
    expect(detail.status).toBe(200);
    const write = await starterFetch(new Request("https://starter.test/internal/sekiban/maintenance/incidents/transitions", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, [TEST_SERVICE_ID_HEADER]: serviceId, "x-sdt-maintainer": "starter-maintainer", "content-type": "application/json" },
      body: JSON.stringify(action(identity, "starter-ack", 0, { deadlineAt: Date.now() + 10_000 })),
    }), { ...(env as unknown as Record<string, unknown>), D1: database(), D1_MV: database(), INCIDENT_MAINTAINER_TOKEN: TOKEN, SDT_SERVICE_ID: serviceId } as never, {} as ExecutionContext);
    expect(write.status).toBe(200);
  });
});
