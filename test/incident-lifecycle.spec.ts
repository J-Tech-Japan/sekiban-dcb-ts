import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
// @ts-expect-error Vite raw asset import.
import g32Migration from "../migrations/d1/g32/0001_dcb_events.sql?raw";
// @ts-expect-error Vite raw asset import.
import lifecycleMigration from "../migrations/d1/g32/0021_incident_lifecycle.sql?raw";
// @ts-expect-error Vite raw asset import.
import starterLifecycleMigration from "../packages/create-dcb/template/migrations/d1/g32/0021_incident_lifecycle.sql?raw";
// @ts-expect-error Vite raw asset import.
import incidentMaintenanceSource from "../packages/dcb-runtime/src/http/IncidentMaintenance.ts?raw";
// @ts-expect-error Vite raw asset import.
import incidentLifecycleSource from "../packages/dcb-runtime/src/completeness/IncidentLifecycle.ts?raw";
import { IncidentLifecycle } from "../packages/dcb-runtime/src/completeness/IncidentLifecycle";
import { GlobalCompletenessReconciler } from "../packages/dcb-runtime/src/completeness/GlobalCompletenessReconciler";
import { createRuntimeWorker } from "../packages/dcb-runtime/src/index";
import { createCloudflareOnlyRuntimeWorker } from "../packages/dcb-runtime/src/cloudflare";
import { injectableServiceIdentity, TEST_SERVICE_ID_HEADER } from "../packages/dcb-runtime/src/service/ServiceIdentityProvider";
import { PARTIAL_WRITE_FENCE_REASON } from "../packages/dcb-runtime/src/tag/types";
import { scopeIdFor } from "../packages/dcb-runtime/src/scope/ScopeName";
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
  return statementsFor(database(), sql);
}

function statementsFor(target: D1Database, sql: string): D1PreparedStatement[] {
  return sql.replace(/^\s*--.*$/gm, "").split(/;\s*(?=(?:CREATE|ALTER|INSERT|UPDATE|DELETE|DROP|PRAGMA|$))/i).map((value) => value.trim())
    .filter(Boolean).map((value) => target.prepare(value));
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

function transitionBase(identity: string, transitionKey: string, expectedVersion: number): Record<string, unknown> {
  return { incidentIdentity: identity, transitionKey, expectedVersion, reason: "take ownership" };
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
    await expect(database().prepare("UPDATE serialized_dcb_incident_transitions SET reason = ? WHERE transition_id = ?").bind("changed", audit?.transition_id).run()).rejects.toThrow(/immutable/);
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

type MatrixState = "OPEN" | "ACKNOWLEDGED" | "CORRECTION_RECORDED" | "CLOSED" | "REOPENED";

function correction(reference = "event-1") {
  return { kind: "event" as const, reference, digest: `sha256:${"a".repeat(64)}` };
}

async function arrangeState(
  lifecycle: IncidentLifecycle,
  serviceId: string,
  identity: string,
  state: MatrixState,
): Promise<number> {
  if (state === "OPEN") return 0;
  await lifecycle.transition(serviceId, action(identity, "ack-1", 0, { deadlineAt: 100 }), "alice");
  if (state === "ACKNOWLEDGED") return 1;
  if (state === "CORRECTION_RECORDED") {
    await lifecycle.transition(serviceId, {
      action: "RECORD_CORRECTION", incidentIdentity: identity, transitionKey: "correction-1",
      expectedVersion: 1, reason: "evidence recorded", correction: correction(),
    }, "alice");
    return 2;
  }
  if (state === "CLOSED") {
    await lifecycle.transition(serviceId, {
      action: "CLOSE", incidentIdentity: identity, transitionKey: "close-1", expectedVersion: 1,
      reason: "accepted", resolution: { kind: "ACCEPTED_AS_IS", explanation: "accepted" },
    }, "alice");
    return 2;
  }
  await lifecycle.transition(serviceId, {
    action: "CLOSE", incidentIdentity: identity, transitionKey: "close-1", expectedVersion: 1,
    reason: "accepted", resolution: { kind: "ACCEPTED_AS_IS", explanation: "accepted" },
  }, "alice");
  if (state === "REOPENED") {
    await lifecycle.transition(serviceId, {
      action: "REOPEN", incidentIdentity: identity, transitionKey: "reopen-1", expectedVersion: 2,
      reason: "new observation", ownerId: "bob", deadlineAt: 100,
    }, "alice");
    return 3;
  }
  throw new Error(`unsupported matrix state ${state}`);
}

async function expectUnchangedRejection(
  lifecycle: IncidentLifecycle,
  serviceId: string,
  identity: string,
  value: unknown,
  actor: string,
  code: string,
): Promise<void> {
  const before = await lifecycle.detail(serviceId, identity, 0);
  await expect(lifecycle.transition(serviceId, value, actor)).rejects.toMatchObject({ code });
  const after = await lifecycle.detail(serviceId, identity, 0);
  expect(after.lifecycle, "projection changed on rejected transition").toEqual(before.lifecycle);
  expect(after.transitions, "audit changed on rejected transition").toEqual(before.transitions);
}

describe("SDT-G124 review matrices", () => {
  it("pins the exact graph without an OPEN-to-CLOSED shortcut", () => {
    expect(incidentLifecycleSource).not.toContain(
      'before.lifecycleState !== "ACKNOWLEDGED" && before.lifecycleState !== "OPEN"',
    );
    expect(incidentLifecycleSource).toContain('lifecycleState = "REOPENED"');
  });

  it("applies both migration copies to separate bindings and checks every durable state shape", async () => {
    const secondary = (env as unknown as { D1_MV?: D1Database }).D1_MV;
    if (secondary === undefined) throw new Error("incident migration parity requires D1_MV");
    const secondaryFinding = await secondary.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'serialized_dcb_completeness_findings'",
    ).first<{ name: string }>();
    if (secondaryFinding === null || secondaryFinding === undefined) {
      await secondary.prepare(`CREATE TABLE serialized_dcb_completeness_findings (
        service_id TEXT NOT NULL, incident_identity TEXT NOT NULL COLLATE BINARY,
        incident_type TEXT NOT NULL, state TEXT NOT NULL, first_observed_at INTEGER NOT NULL,
        last_observed_at INTEGER NOT NULL, PRIMARY KEY (service_id, incident_identity)
      )`).run();
    }
    const secondaryLifecycle = await secondary.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'serialized_dcb_incident_lifecycles'",
    ).first<{ name: string }>();
    if (secondaryLifecycle === null || secondaryLifecycle === undefined) {
      await secondary.batch(statementsFor(secondary, starterLifecycleMigration as string));
    }
    expect(await secondary.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'serialized_dcb_incident_transitions'",
    ).first<{ name: string }>()).toBeTruthy();

    const lifecycle = new IncidentLifecycle(database(), () => 0);
    const states: MatrixState[] = ["OPEN", "ACKNOWLEDGED", "CORRECTION_RECORDED", "CLOSED", "REOPENED"];
    for (const state of states) {
      const serviceId = `g124-shape-${state}-${crypto.randomUUID()}`;
      const identity = `shape-${state}-${crypto.randomUUID()}`;
      await seedFinding(serviceId, identity);
      const version = await arrangeState(lifecycle, serviceId, identity, state);
      expect((await lifecycle.detail(serviceId, identity)).lifecycle).toMatchObject({ lifecycleState: state, version });
    }
    const malformed = [
      { label: "before owner", column: "before_owner_id", value: "", from: "ACKNOWLEDGED", to: "ACKNOWLEDGED" },
      { label: "before resolution", column: "before_close_resolution", value: "NOT_A_RESOLUTION", from: "CLOSED", to: "CLOSED" },
      { label: "before reason", column: "before_close_reason", value: "x".repeat(2_049), from: "CLOSED", to: "CLOSED" },
      { label: "after owner", column: "after_owner_id", value: "", from: "OPEN", to: "ACKNOWLEDGED" },
      { label: "after resolution", column: "after_close_resolution", value: "NOT_A_RESOLUTION", from: "OPEN", to: "ACKNOWLEDGED" },
      { label: "after reason", column: "after_close_reason", value: "x".repeat(2_049), from: "OPEN", to: "CLOSED" },
    ] as const;
    for (const entry of malformed) {
      const serviceId = `g124-audit-shape-${crypto.randomUUID()}`;
      const identity = `audit-${crypto.randomUUID()}`;
      await seedFinding(serviceId, identity);
      const lifecycle = new IncidentLifecycle(database(), () => 0);
      const before = await lifecycle.detail(serviceId, identity);
      const beforeAudit = await database().prepare(
        "SELECT COUNT(*) AS count FROM serialized_dcb_incident_transitions WHERE service_id = ? AND incident_identity = ?",
      ).bind(serviceId, identity).first<{ count: number }>();
      const columns = [
        "service_id", "incident_identity", "transition_key", "request_digest", "action",
        "from_state", "to_state", "from_version", "to_version", "actor_id", "before_owner_id",
        "before_deadline_at", "before_correction_kind", "before_correction_reference", "before_correction_digest",
        "before_close_resolution", "before_close_reason", "after_owner_id", "after_deadline_at",
        "after_correction_kind", "after_correction_reference", "after_correction_digest", "after_close_resolution",
        "after_close_reason", "reason", "occurred_at",
      ];
      const beforeAssigned = entry.from !== "OPEN";
      const afterAssigned = entry.to === "ACKNOWLEDGED" || entry.to === "CLOSED";
      const beforeClosed = entry.from === "CLOSED";
      const afterClosed = entry.to === "CLOSED";
      const row: unknown[] = [serviceId, identity, `bad-${entry.label}`, "sha256:test", "ACKNOWLEDGE",
        entry.from, entry.to, 0, 1, "alice", beforeAssigned ? "alice" : null, beforeAssigned ? 100 : null,
        null, null, null, beforeClosed ? "ACCEPTED_AS_IS" : null, beforeClosed ? "valid" : null,
        afterAssigned ? "alice" : null, afterAssigned ? 100 : null, null, null, null,
        afterClosed ? "ACCEPTED_AS_IS" : null, afterClosed ? "valid" : null, "reason", 1];
      row[columns.indexOf(entry.column)] = entry.value;
      const placeholders = columns.map(() => "?").join(", ");
      await expect(database().prepare(
        `INSERT INTO serialized_dcb_incident_transitions (${columns.join(", ")}) VALUES (${placeholders})`,
      ).bind(...row).run()).rejects.toThrow(/CHECK constraint/);
      const after = await lifecycle.detail(serviceId, identity);
      const afterAudit = await database().prepare(
        "SELECT COUNT(*) AS count FROM serialized_dcb_incident_transitions WHERE service_id = ? AND incident_identity = ?",
      ).bind(serviceId, identity).first<{ count: number }>();
      expect(after.lifecycle, `${entry.label} changed lifecycle`).toEqual(before.lifecycle);
      expect(after.transitions, `${entry.label} changed audit`).toEqual(before.transitions);
      expect(afterAudit?.count, `${entry.label} changed audit count`).toBe(beforeAudit?.count);
    }
  });

  it("covers every illegal edge with an independent projection and audit assertion", async () => {
    const cases: Array<{ from: MatrixState; action: Record<string, unknown>; code?: string }> = [
      ...(["ACKNOWLEDGED", "CORRECTION_RECORDED", "CLOSED"] as MatrixState[]).map((from) => ({
        from, action: { action: "ACKNOWLEDGE", ownerId: "bob", deadlineAt: 100 },
      })),
      ...(["OPEN", "CLOSED", "REOPENED"] as MatrixState[]).map((from) => ({
        from, action: { action: "UPDATE_ASSIGNMENT", ownerId: "bob", deadlineAt: 100 },
      })),
      ...(["OPEN", "CORRECTION_RECORDED", "CLOSED", "REOPENED"] as MatrixState[]).map((from) => ({
        from, action: { action: "RECORD_CORRECTION", correction: correction() },
      })),
      ...(["OPEN", "ACKNOWLEDGED", "CLOSED", "REOPENED"] as MatrixState[]).map((from) => ({
        from, action: { action: "CLOSE", resolution: { kind: "CORRECTED" } },
      })),
      ...(["OPEN", "CORRECTION_RECORDED", "CLOSED", "REOPENED"] as MatrixState[]).map((from) => ({
        from, action: { action: "CLOSE", resolution: { kind: "ACCEPTED_AS_IS", explanation: "no" } },
      })),
      ...(["OPEN", "ACKNOWLEDGED", "CORRECTION_RECORDED", "REOPENED"] as MatrixState[]).map((from) => ({
        from, action: { action: "REOPEN", ownerId: "bob", deadlineAt: 100 },
      })),
    ];
    for (const [index, entry] of cases.entries()) {
      const serviceId = `g124-edge-${index}-${crypto.randomUUID()}`;
      const identity = `edge-${index}-${crypto.randomUUID()}`;
      await seedFinding(serviceId, identity);
      const lifecycle = new IncidentLifecycle(database(), () => 0);
      const version = await arrangeState(lifecycle, serviceId, identity, entry.from);
      await expectUnchangedRejection(lifecycle, serviceId, identity, {
        ...entry.action, incidentIdentity: identity, transitionKey: `bad-${index}`,
        expectedVersion: version, reason: "invalid edge",
      }, "alice", "incident_invalid_transition");
    }
    const serviceId = `g124-legal-assignment-${crypto.randomUUID()}`;
    const identity = `legal-assignment-${crypto.randomUUID()}`;
    await seedFinding(serviceId, identity);
    const lifecycle = new IncidentLifecycle(database(), () => 0);
    await arrangeState(lifecycle, serviceId, identity, "CORRECTION_RECORDED");
    const updated = await lifecycle.transition(serviceId, {
      action: "UPDATE_ASSIGNMENT", incidentIdentity: identity, transitionKey: "update-correction",
      expectedVersion: 2, reason: "new owner", ownerId: "bob", deadlineAt: 200,
    }, "alice");
    expect(updated.projection).toMatchObject({ lifecycleState: "CORRECTION_RECORDED", ownerId: "bob", version: 3 });
  });

  it("rejects every listed request-shape case without changing either durable side", async () => {
    const base = action("shape-identity", "shape-key", 0);
    const missingOwner = { ...base };
    delete missingOwner.ownerId;
    const missingDeadline = { ...base };
    delete missingDeadline.deadlineAt;
    const missingReason = { ...base };
    delete missingReason.reason;
    const cases: Array<{ label: string; value: unknown; actor?: string; code: string }> = [
      { label: "missing owner", value: missingOwner, code: "incident_invalid_request" },
      { label: "empty owner", value: { ...base, ownerId: " " }, code: "incident_invalid_request" },
      { label: "oversized owner", value: { ...base, ownerId: "x".repeat(257) }, code: "incident_invalid_request" },
      { label: "missing deadline", value: missingDeadline, code: "incident_invalid_request" },
      { label: "unsafe deadline", value: { ...base, deadlineAt: Number.MAX_SAFE_INTEGER + 1 }, code: "incident_invalid_request" },
      { label: "missing reason", value: missingReason, code: "incident_invalid_request" },
      { label: "empty reason", value: { ...base, reason: " " }, code: "incident_invalid_request" },
      { label: "oversized reason", value: { ...base, reason: "x".repeat(2_049) }, code: "incident_invalid_request" },
      { label: "oversized identity", value: { ...base, incidentIdentity: "x".repeat(257) }, code: "incident_invalid_request" },
      { label: "empty identity", value: { ...base, incidentIdentity: " " }, code: "incident_invalid_request" },
      { label: "empty transition key", value: { ...base, transitionKey: " " }, code: "incident_invalid_request" },
      { label: "oversized transition key", value: { ...base, transitionKey: "x".repeat(257) }, code: "incident_invalid_request" },
      { label: "negative version", value: { ...base, expectedVersion: -1 }, code: "incident_invalid_request" },
      { label: "unsafe version", value: { ...base, expectedVersion: Number.MAX_SAFE_INTEGER + 1 }, code: "incident_invalid_request" },
      { label: "unknown action key", value: { ...base, extra: true }, code: "incident_invalid_request" },
      { label: "past deadline", value: { ...base, deadlineAt: 0 }, code: "incident_invalid_deadline" },
      { label: "invalid actor", value: base, actor: " ", code: "incident_invalid_actor" },
      { label: "event evidence key", value: { ...transitionBase("shape-identity", "shape-key", 0), action: "RECORD_CORRECTION",
        correction: { ...correction(), evidence: "event" } }, code: "incident_invalid_request" },
      { label: "bad correction object", value: { ...transitionBase("shape-identity", "shape-key", 0), action: "RECORD_CORRECTION",
        correction: null }, code: "incident_invalid_request" },
      { label: "bad correction kind", value: { ...transitionBase("shape-identity", "shape-key", 0), action: "RECORD_CORRECTION",
        correction: { ...correction(), kind: "other" } }, code: "incident_invalid_request" },
      { label: "bad correction reference", value: { ...transitionBase("shape-identity", "shape-key", 0), action: "RECORD_CORRECTION",
        correction: { ...correction(), reference: " " } }, code: "incident_invalid_request" },
      { label: "bad correction digest", value: { ...transitionBase("shape-identity", "shape-key", 0), action: "RECORD_CORRECTION",
        correction: { ...correction(), digest: `sha256:${"A".repeat(64)}` } }, code: "incident_invalid_request" },
      { label: "bad corrected resolution", value: { ...transitionBase("shape-identity", "shape-key", 0), action: "CLOSE",
        resolution: { kind: "CORRECTED", explanation: "not allowed" } }, code: "incident_invalid_request" },
      { label: "bad accepted resolution", value: { ...transitionBase("shape-identity", "shape-key", 0), action: "CLOSE",
        resolution: { kind: "ACCEPTED_AS_IS", explanation: " " } }, code: "incident_invalid_request" },
    ];
    for (const entry of cases) {
      const serviceId = `g124-shape-case-${crypto.randomUUID()}`;
      await seedFinding(serviceId, "shape-identity");
      const lifecycle = new IncidentLifecycle(database(), () => 0);
      await expectUnchangedRejection(lifecycle, serviceId, "shape-identity", entry.value, entry.actor ?? "alice", entry.code);
    }
  });
});

describe("SDT-G124 authentication, reads, concurrency, and routing", () => {
  it("pins the shared authenticator to digest/XOR comparison rather than string equality", () => {
    expect(incidentMaintenanceSource).toContain("crypto.subtle.digest");
    expect(incidentMaintenanceSource).toContain("fixedLengthEqual");
    expect(incidentMaintenanceSource).toContain("for (let index = 0; index < length; index += 1)");
    expect(incidentMaintenanceSource).not.toContain("credential === `Bearer ${token}`");
  });

  it("runs the complete authentication matrix before identity, D1, parsing, and lifecycle work", async () => {
    const identityCalls = { default: 0, cloudflare: 0 };
    const defaultWorker = createRuntimeWorker({
      serviceIdentityProvider: injectableServiceIdentity(() => {
        identityCalls.default += 1;
        throw new Error("identity must not run");
      }),
    });
    const cloudflareWorker = createCloudflareOnlyRuntimeWorker({
      serviceIdentityProvider: injectableServiceIdentity(() => {
        identityCalls.cloudflare += 1;
        throw new Error("identity must not run");
      }),
    });
    const starter = (await import("../packages/create-dcb/template/src/worker")) as { default: ExportedHandler };
    const defaultFetch = defaultWorker.fetch as unknown as (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>;
    const cloudflareFetch = cloudflareWorker.fetch as unknown as (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>;
    const starterFetch = starter.default.fetch as unknown as (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>;
    const handlers: Array<{ name: string; fetch: (request: Request, env: unknown) => Promise<Response>; path: string }> = [
      {
        name: "default",
        fetch: (request, runtimeEnv) => defaultFetch(request, runtimeEnv, {} as ExecutionContext),
        path: "/maintenance/incidents",
      },
      {
        name: "cloudflare-only",
        fetch: (request, runtimeEnv) => cloudflareFetch(request, runtimeEnv, {} as ExecutionContext),
        path: "/maintenance/incidents",
      },
      {
        name: "generated-starter",
        fetch: (request, runtimeEnv) => starterFetch(request, runtimeEnv, {} as ExecutionContext),
        path: "/internal/sekiban/maintenance/incidents",
      },
    ];
    for (const handler of handlers) {
      for (const missingBinding of [undefined, " "]) {
        const response = await handler.fetch(new Request(`https://auth.test${handler.path}`, {
          method: "POST", body: "not-json", headers: { authorization: "Bearer wrong" },
        }), { INCIDENT_MAINTAINER_TOKEN: missingBinding });
        expect(response.status, `${handler.name} binding`).toBe(503);
        expect(await response.json()).toEqual({ error: "Incident maintenance is not configured", code: "incident_maintenance_unavailable" });
      }
      for (const authorization of [undefined, "", "Bearer wrong", "Bearer undefined"]) {
        const headers = authorization === undefined ? undefined : new Headers({ authorization });
        const response = await handler.fetch(new Request(`https://auth.test${handler.path}`, {
          method: "POST", body: "not-json", headers,
        }), { INCIDENT_MAINTAINER_TOKEN: TOKEN });
        expect(response.status, `${handler.name} credential ${authorization}`).toBe(401);
        const responseText = await response.text();
        expect(JSON.parse(responseText)).toEqual({ error: "A valid incident maintenance bearer token is required", code: "incident_auth_required" });
        expect(responseText).not.toContain(TOKEN);
      }
    }
    expect(identityCalls).toEqual({ default: 0, cloudflare: 0 });
  });

  it("keeps bearer credentials out of the digest while preserving idempotency across valid tokens", async () => {
    const serviceId = `g124-bearer-${crypto.randomUUID()}`;
    const identity = `bearer-${crypto.randomUUID()}`;
    await seedFinding(serviceId, identity);
    const worker = createRuntimeWorker({ serviceIdentityProvider: injectableServiceIdentity(serviceId) });
    const workerFetch = worker.fetch as unknown as (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>;
    const bearerBody = action(identity, "bearer-key", 0, { deadlineAt: Date.now() + 10_000 });
    const call = async (token: string) => workerFetch(new Request("https://bearer.test/maintenance/incidents/transitions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`, [TEST_SERVICE_ID_HEADER]: serviceId,
        "x-sdt-maintainer": "same-actor", "content-type": "application/json",
      },
      body: JSON.stringify(bearerBody),
    }), { D1: database(), INCIDENT_MAINTAINER_TOKEN: token } as never, {} as ExecutionContext);
    const first = await call("token-one");
    const second = await call("token-two");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = await first.json<{ transition: { requestDigest: string }; idempotent: boolean }>();
    const secondBody = await second.json<{ transition: { requestDigest: string }; idempotent: boolean }>();
    expect(firstBody.idempotent).toBe(false);
    expect(secondBody.idempotent).toBe(true);
    expect(secondBody.transition.requestDigest).toBe(firstBody.transition.requestDigest);
    expect((await (new IncidentLifecycle(database(), () => 0)).detail(serviceId, identity)).transitions).toHaveLength(1);
  });

  it("asserts owner and unowned filters, counts, ordering, closed overdue exclusion, and encoded history", async () => {
    const serviceId = `g124-reads-${crypto.randomUUID()}`;
    const ownerIdentity = "identity-owner";
    const unownedIdentity = "identity-unowned";
    const closedIdentity = "identity-closed";
    await seedFinding(serviceId, ownerIdentity, 10);
    await seedFinding(serviceId, unownedIdentity, 10);
    await seedFinding(serviceId, closedIdentity, 10);
    const lifecycle = new IncidentLifecycle(database(), () => 0);
    await lifecycle.transition(serviceId, action(ownerIdentity, "ack", 0, { deadlineAt: 1 }), "alice");
    await lifecycle.transition(serviceId, action(closedIdentity, "ack", 0, { deadlineAt: 1 }), "alice");
    await lifecycle.transition(serviceId, {
      action: "CLOSE", incidentIdentity: closedIdentity, transitionKey: "close", expectedVersion: 1,
      reason: "accepted", resolution: { kind: "ACCEPTED_AS_IS", explanation: "closed" },
    }, "alice");
    const all = await lifecycle.list(serviceId, {}, 2);
    expect(all.items.map((item) => item.finding.incidentIdentity)).toEqual([
      ownerIdentity, unownedIdentity, closedIdentity,
    ]);
    expect(all.summary).toMatchObject({ total: 3, unowned: 1, overdue: 1, byState: {
      OPEN: 1, ACKNOWLEDGED: 1, CLOSED: 1,
    }});
    expect((await lifecycle.list(serviceId, { owner: "alice" }, 2)).summary.total).toBe(2);
    expect((await lifecycle.list(serviceId, { unowned: true }, 2)).summary).toMatchObject({ total: 1, unowned: 1 });
    expect((await lifecycle.list(serviceId, { overdue: true }, 2)).items.map((item) => item.lifecycle.lifecycleState)).not.toContain("CLOSED");
    expect((await lifecycle.list(serviceId, { owner: "unknown" }, 2)).summary.total).toBe(0);
    const worker = createRuntimeWorker({ serviceIdentityProvider: injectableServiceIdentity(serviceId) });
    for (const filter of ["?unknown=true", "?state=not-a-state"]) {
      const response = await (worker.fetch as unknown as (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>)(new Request(`https://read.test/maintenance/incidents${filter}`, {
        headers: { authorization: `Bearer ${TOKEN}`, [TEST_SERVICE_ID_HEADER]: serviceId },
      }), { D1: database(), INCIDENT_MAINTAINER_TOKEN: TOKEN } as never, {} as ExecutionContext);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "incident_invalid_filter" });
    }
  });

  it("keeps exact filters, encoded detail, and generated-starter lookalikes on their intended routes", async () => {
    const starter = (await import("../packages/create-dcb/template/src/worker")) as { default: ExportedHandler };
    const starterFetch = starter.default.fetch as unknown as (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>;
    const starterEnv = { ...(env as unknown as Record<string, unknown>), D1: database(), D1_MV: database(), INCIDENT_MAINTAINER_TOKEN: TOKEN };
    for (const path of [
      "/internal/sekiban/api/sekiban/serialized/query-other",
      "/internal/sekiban/operator/repair-other",
      "/internal/sekiban/maintenance-prefix",
    ]) {
      const response = await starterFetch(new Request(`https://route.test${path}`), starterEnv, {} as ExecutionContext);
      expect(response.status, path).toBe(404);
      await expect(response.text(), path).resolves.toBe("runtime route is not forwarded");
    }

    const serviceId = `g124-detail-${crypto.randomUUID()}`;
    const identity = "detail/with encoded content";
    await seedFinding(serviceId, identity);
    const lifecycle = new IncidentLifecycle(database(), () => 0);
    await lifecycle.transition(serviceId, action(identity, "detail-ack", 0), "alice");
    const worker = createCloudflareOnlyRuntimeWorker({ serviceIdentityProvider: injectableServiceIdentity(serviceId) });
    const response = await (worker.fetch as unknown as (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>)(new Request(`https://detail.test/maintenance/incidents/${encodeURIComponent(identity)}`, {
      headers: { authorization: `Bearer ${TOKEN}`, [TEST_SERVICE_ID_HEADER]: serviceId },
    }), { D1: database(), INCIDENT_MAINTAINER_TOKEN: TOKEN } as never, {} as ExecutionContext);
    expect(response.status).toBe(200);
    const body = await response.json<{ finding: { incidentIdentity: string }; transitions: Array<{ reason: string }> }>();
    expect(body.finding.incidentIdentity).toBe(identity);
    expect(body.transitions).toEqual([expect.objectContaining({ reason: "take ownership" })]);
  });

  it("rejects whitespace-only and oversized encoded detail identities before detail or D1 access", async () => {
    const serviceId = `g124-detail-validation-${crypto.randomUUID()}`;
    let prepareCalls = 0;
    const realDatabase = database();
    const spiedDatabase = new Proxy(realDatabase, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return (...args: Parameters<D1Database["prepare"]>) => {
            prepareCalls += 1;
            return target.prepare(...args);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as D1Database;
    const detailSpy = vi.spyOn(IncidentLifecycle.prototype, "detail");
    const worker = createCloudflareOnlyRuntimeWorker({ serviceIdentityProvider: injectableServiceIdentity(serviceId) });
    const workerFetch = worker.fetch as unknown as (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>;
    try {
      for (const identity of ["   ", "x".repeat(257)]) {
        const response = await workerFetch(new Request(`https://detail.test/maintenance/incidents/${encodeURIComponent(identity)}`, {
          headers: { authorization: `Bearer ${TOKEN}`, [TEST_SERVICE_ID_HEADER]: serviceId },
        }), { D1: spiedDatabase, INCIDENT_MAINTAINER_TOKEN: TOKEN } as never, {} as ExecutionContext);
        expect(response.status, identity.length.toString()).toBe(400);
        expect(await response.json()).toMatchObject({ code: "incident_invalid_request" });
      }
      expect(detailSpy).not.toHaveBeenCalled();
      expect(prepareCalls).toBe(0);
    } finally {
      detailSpy.mockRestore();
    }
  });

  it("proves exact retry equality, payload/actor conflicts, competing writes, stale versions, and atomic batch rollback", async () => {
    const serviceId = `g124-concurrency-${crypto.randomUUID()}`;
    const identity = `concurrency-${crypto.randomUUID()}`;
    await seedFinding(serviceId, identity);
    const lifecycle = new IncidentLifecycle(database(), () => 0);
    const first = await lifecycle.transition(serviceId, action(identity, "same", 0), "alice");
    const retry = await lifecycle.transition(serviceId, action(identity, "same", 0), "alice");
    expect(retry.idempotent).toBe(true);
    expect(retry.projection).toEqual(first.projection);
    expect(retry.transition).toEqual(first.transition);
    await expectUnchangedRejection(lifecycle, serviceId, identity, { ...action(identity, "same", 0), reason: "changed" }, "alice", "incident_idempotency_conflict");
    await expectUnchangedRejection(lifecycle, serviceId, identity, action(identity, "same", 0), "bob", "incident_idempotency_conflict");
    await expectUnchangedRejection(lifecycle, serviceId, identity, action(identity, "stale", 0), "alice", "incident_version_conflict");

    const competingIdentity = `competing-${crypto.randomUUID()}`;
    await seedFinding(serviceId, competingIdentity);
    const competing = new IncidentLifecycle(database(), () => 0);
    const writes = await Promise.allSettled([
      competing.transition(serviceId, action(competingIdentity, "writer-a", 0), "alice"),
      competing.transition(serviceId, action(competingIdentity, "writer-b", 0), "alice"),
    ]);
    expect(writes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(writes.filter((result) => result.status === "rejected").map((result) => (result as PromiseRejectedResult).reason.code)).toContain("incident_version_conflict");
    expect((await competing.detail(serviceId, competingIdentity)).transitions).toHaveLength(1);

    const rollbackIdentity = `rollback-${crypto.randomUUID()}`;
    await seedFinding(serviceId, rollbackIdentity);
    const failingDatabase = new Proxy(database(), {
      get(target, property, receiver) {
        if (property === "batch") return async () => { throw new Error("injected batch statement failure"); };
        return Reflect.get(target, property, receiver);
      },
    }) as D1Database;
    const failingLifecycle = new IncidentLifecycle(failingDatabase, () => 0);
    await expect(failingLifecycle.transition(serviceId, action(rollbackIdentity, "rollback", 0), "alice")).rejects.toThrow("injected batch");
    const rollback = await lifecycle.detail(serviceId, rollbackIdentity);
    expect(rollback.lifecycle).toMatchObject({ lifecycleState: "OPEN", version: 0 });
    expect(rollback.transitions).toEqual([]);
  });
});

describe("SDT-G124 safety regressions", () => {
  it("runs the real rediscovery scanner after close and leaves lifecycle and audit unchanged", async () => {
    const serviceId = `g124-scanner-${crypto.randomUUID()}`;
    const tag = `room:g124:${crypto.randomUUID()}`;
    const eventId = `event-${crypto.randomUUID()}`;
    const digest = "b".repeat(64);
    const identity = `SOURCE_RECEIPT_ABSENT|${serviceId}|${tag}|1|${eventId}|${digest}`;
    await seedFinding(serviceId, identity, 10);
    await database().prepare(
      `INSERT INTO serialized_dcb_source_partitions (service_id, partition_tag, last_obligation_sequence, registered_at)
       VALUES (?, ?, 1, 1)`,
    ).bind(serviceId, tag).run();
    const lifecycle = new IncidentLifecycle(database(), () => 0);
    await lifecycle.transition(serviceId, action(identity, "ack", 0, { deadlineAt: 100 }), "alice");
    await lifecycle.transition(serviceId, {
      action: "CLOSE", incidentIdentity: identity, transitionKey: "close", expectedVersion: 1,
      reason: "accepted", resolution: { kind: "ACCEPTED_AS_IS", explanation: "accepted" },
    }, "alice");
    const before = await lifecycle.detail(serviceId, identity);
    const namespace = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => new Response(JSON.stringify({
          serviceId, tag, upperBoundSequence: 1, observedMaxSequence: 1, afterSequence: 0, hasMore: false,
          rows: [{ obligationSequence: 1, eventId, eventDigest: digest, canonicalBytesBase64: "e30=",
            declaredTagSet: [tag], localCommittedMembership: [{ serviceId, eventId, tag }], status: "pending" }],
        })),
      }),
    } as unknown as DurableObjectNamespace;
    const scanner = new GlobalCompletenessReconciler(database(), namespace, undefined, {
      globalReceiptMatcher: async () => false,
    });
    await expect(scanner.reconcile(serviceId, 100)).resolves.toMatchObject({ kind: "BLOCK", findingCount: 1 });
    const after = await lifecycle.detail(serviceId, identity);
    expect(after.lifecycle, "scanner changed the lifecycle projection").toEqual(before.lifecycle);
    expect(after.transitions, "scanner changed lifecycle audit").toEqual(before.transitions);
    expect(after.finding.lastObservedAt).toBe(100);
  });

  it("preserves a real partial command outcome, fence, health, and non-COMPLETE status across lifecycle actions", async () => {
    const serviceId = `g124-partial-${crypto.randomUUID()}`;
    const tag = `room:g124:partial:${crypto.randomUUID()}`;
    const tagNamespace = (env as unknown as { TAG?: DurableObjectNamespace }).TAG;
    if (tagNamespace === undefined) throw new Error("incident partial-write proof requires the TAG binding");
    const failedTagStub = tagNamespace.get(scopeIdFor(tagNamespace, { serviceId, doClass: "tag", identity: `${tag}-failed` }));
    const readDurableFence = () => runInDurableObject(failedTagStub, (_instance, state) => state.storage.sql.exec<{
      reason: string;
      attempt_id: string;
      epoch: number;
    }>("SELECT reason, attempt_id, epoch FROM tag_fence ORDER BY reason, attempt_id").toArray());
    const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { "content-type": "application/json" },
    });
    const namespace = (name: string): DurableObjectNamespace => ({
      idFromName: (value: string) => value,
      get: (id: DurableObjectId) => {
        void id;
        return {
          fetch: async (request: Request) => {
            const path = new URL(request.url).pathname;
            if (name === "bootstrap") return jsonResponse({ leaseEpoch: 1 });
            if (name === "allocator") {
              const body = await request.json<{ candidates: Array<{ eventId: string }> }>();
              return jsonResponse({ attemptId: "partial-attempt", allocatorLineageId: "partial-lineage",
                candidates: body.candidates.map((candidate) => ({ ...candidate, suid: "0".repeat(29) + "1" })) });
            }
            return jsonResponse({ code: `unexpected_${path}` }, 500);
          },
        } as unknown as DurableObjectStub;
      },
    }) as unknown as DurableObjectNamespace;
    const worker = new (await import("../packages/dcb-runtime/src/commit/CommitWorker")).CommitWorker({
      ALLOCATOR: namespace("allocator"), BOOTSTRAP: namespace("bootstrap"), TAG: tagNamespace,
    }, serviceId);
    const request = new Request("https://commit.test/api/sekiban/serialized/commit", {
      method: "POST", headers: { "content-type": "application/json", "x-sdt-g4-test-fault": "tag-append-last",
        "x-sdt-g4-test-attempt-id": "partial-attempt" },
      body: JSON.stringify({ version: 1, eventCandidates: [{ payload: btoa(JSON.stringify({ fixture: "g76-regression-matrix" })),
        eventPayloadName: "G76RegressionMatrixEvent", tags: [tag, `${tag}-failed`] }], consistencyTags: [] }),
    });
    const partial = await worker.handle(request);
    const partialBody = await partial.json();
    expect(partial.status, JSON.stringify(partialBody)).toBe(500);
    expect(partialBody).toMatchObject({ code: "partial_write", partial: { retryable: false } });
    const reconciler = new GlobalCompletenessReconciler(database(), tagNamespace);
    const fenceBefore = await readDurableFence();
    const healthBefore = await reconciler.readHealth(serviceId, NOW);
    const coverageBefore = await reconciler.coverage(serviceId, NOW);
    expect(fenceBefore).toEqual([expect.objectContaining({ reason: PARTIAL_WRITE_FENCE_REASON, attempt_id: "partial-attempt" })]);
    expect(coverageBefore.kind).not.toBe("SETTLED");
    const lifecycle = new IncidentLifecycle(database(), () => 0);
    const identity = `partial-${crypto.randomUUID()}`;
    await seedFinding(serviceId, identity);
    await lifecycle.transition(serviceId, action(identity, "ack", 0, { deadlineAt: 100 }), "alice");
    await lifecycle.transition(serviceId, { action: "CLOSE", incidentIdentity: identity, transitionKey: "close",
      expectedVersion: 1, reason: "accepted", resolution: { kind: "ACCEPTED_AS_IS", explanation: "partial remains" } }, "alice");
    await lifecycle.transition(serviceId, { action: "REOPEN", incidentIdentity: identity, transitionKey: "reopen",
      expectedVersion: 2, reason: "review again", ownerId: "bob", deadlineAt: 100 }, "alice");
    const fenceAfter = await readDurableFence();
    const healthAfter = await reconciler.readHealth(serviceId, NOW);
    const coverageAfter = await reconciler.coverage(serviceId, NOW);
    expect(fenceAfter).toEqual(fenceBefore);
    expect(healthAfter).toEqual(healthBefore);
    expect(coverageAfter).toEqual(coverageBefore);
  });
});
