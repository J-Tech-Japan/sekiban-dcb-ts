import { createExecutionContext, env } from "cloudflare:test";
import postgres from "postgres";
import { beforeAll, describe, expect, it } from "vitest";

// @ts-expect-error Vite raw migration imports.
import mv0001 from "../migrations/mv/0001_materialized_views.sql?raw";
// @ts-expect-error Vite raw migration imports.
import mv0002 from "../migrations/mv/0002_unsafe_window_materialized_views.sql?raw";
// @ts-expect-error Vite raw migration imports.
import mv0003 from "../migrations/mv/0003_checkpoint_ahead_hardening.sql?raw";
// @ts-expect-error Vite raw migration imports.
import mv0004 from "../migrations/mv/0004_unsafe_window_failure_findings.sql?raw";
// @ts-expect-error Vite raw migration imports.
import mv0005 from "../migrations/mv/0005_g31_wait_receipts.sql?raw";
// @ts-expect-error Vite raw migration imports.
import mv0006 from "../migrations/mv/0006_g31_wait_target_poison.sql?raw";
// @ts-expect-error Vite raw migration imports.
import mv0007 from "../migrations/mv/0007_g69_ordering_quarantine.sql?raw";
// @ts-expect-error Vite raw migration imports.
import mv0008 from "../migrations/mv/0008_g69_rebuild_verification.sql?raw";
// @ts-expect-error Vite raw migration imports.
import mv0009 from "../migrations/mv/0009_g69_rebuild_proof.sql?raw";
// @ts-expect-error Vite raw migration imports.
import d1StatusMigration from "../migrations/d1/g32/0022_g150_projection_statuses.sql?raw";
// @ts-expect-error Vite raw migration imports.
import postgresStatusMigration from "../migrations/postgres/0001_g150_projection_statuses.sql?raw";
// @ts-expect-error Vite raw migration imports.
import templateStatusMigration from "../packages/create-dcb/template/migrations/d1/g32/0022_g150_projection_statuses.sql?raw";

import { defineRowMaterializer, type MaterializedViewRowMaterializer } from "@sekiban/dcb-core";
import { createRuntimeWorker } from "../packages/dcb-runtime/src/index";
import { handleSerializedQuery } from "../packages/dcb-runtime/src/http/SerializedQueryWorker";
import { MaterializedViewCatchUpRuntime } from "../packages/dcb-runtime/src/mv/MaterializedViewCatchUp";
import {
  D1MaterializedViewStore,
  MaterializedViewStoreError,
  type MaterializedViewInstance,
  type MaterializedViewStatusFacts,
} from "../packages/dcb-runtime/src/mv/MaterializedViewStore";
import {
  handleSerializedProjectionStatus,
  mapMaterializedViewStatusPhase,
  mvProjectionStatusIdentity,
  serializeProjectionStatusEnvelopeV1,
  serializeProjectionStatusRequestV1,
  type MaterializedViewStatusObservation,
  type ProjectionStatusSnapshotV1,
} from "../packages/dcb-runtime/src/mv/ProjectionStatus";
import { pollLiveProjections } from "../packages/dcb-runtime/src/projection/LiveProjectionWorker";
import { projectionIdFor } from "../packages/dcb-runtime/src/projection/ProjectionRuntime";
import { ProjectorRegistry } from "../packages/dcb-runtime/src/projection/ProjectorRegistry";
import { TEST_SERVICE_ID_HEADER } from "../packages/dcb-runtime/src/service/ServiceIdentityProvider";
import { D1EventStore } from "../packages/dcb-runtime/src/store/D1EventStore";
import { PostgresEventStore } from "../packages/dcb-runtime/src/store/PostgresEventStore";
import type {
  ProjectionStatusHeartbeat,
  ProjectionStatusWriteResult,
  ProjectionStore,
  StoredEvent,
} from "../packages/dcb-runtime/src/store/types";
import { G32_FIXTURE_TIMESTAMP, g32Suid } from "./helpers/g32-fixtures";

const GOLDEN_REQUEST = "{\"version\":1,\"serviceId\":\"server-service\",\"projectorName\":\"students\",\"projectorVersion\":\"v1\"}";
const GOLDEN_RESPONSE = "{\"version\":1,\"serviceId\":\"server-service\",\"snapshots\":[{\"projectorName\":\"students\",\"projectorVersion\":\"v1\",\"clusterId\":\"cluster-a\",\"activationId\":\"activation-a\",\"sequence\":7,\"appliedEventCount\":3,\"lastAppliedSortableUniqueId\":\"0001\",\"lastTraversedSortableUniqueId\":\"0002\",\"totalEventCount\":4,\"remainingEventCount\":0,\"sampledAtUtc\":\"2026-01-01T00:00:00+00:00\",\"consistency\":\"bestEffort\",\"isCaughtUp\":true,\"hasConflict\":false,\"conflictingActivationIds\":[],\"phase\":\"active\",\"leaseExpiresAtUtc\":\"2026-01-01T00:01:00+00:00\",\"isFaulted\":false,\"faultMessage\":null,\"isFresh\":true}]}";
const NOW_MS = 60_000;

interface StatusStore {
  initialize(): Promise<void>;
  close?(): Promise<void>;
  readProjectionStatusHeartbeat(
    serviceId: string,
    projectorName: string,
    projectorVersion: string,
    clusterId: string,
  ): Promise<ProjectionStatusHeartbeat | undefined>;
  upsertProjectionStatusHeartbeat(
    heartbeat: ProjectionStatusHeartbeat,
    expectedSequence: number,
  ): Promise<ProjectionStatusWriteResult>;
  listProjectionStatusHeartbeats(
    serviceId: string,
    projectorName?: string | null,
    projectorVersion?: string | null,
  ): Promise<readonly ProjectionStatusHeartbeat[]>;
}

function serviceId(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

function d1(): D1Database {
  const binding = (env as unknown as { D1?: D1Database }).D1;
  if (binding === undefined) throw new Error("D1 binding is required");
  return binding;
}

function materializedViewDatabase(): D1Database {
  const binding = (env as unknown as { D1_MV?: D1Database }).D1_MV;
  if (binding === undefined) throw new Error("D1_MV binding is required");
  return binding;
}

function postgresUrl(): string {
  const url = (env as unknown as { POSTGRES_URL?: string }).POSTGRES_URL;
  if (url === undefined || url.length === 0) throw new Error("POSTGRES_URL is required");
  return url;
}

function sqlStatements(source: string): string[] {
  return source.replace(/^\s*--.*$/gm, "").split(";").map((statement) => statement.trim()).filter((statement) => statement.length > 0);
}

function heartbeat(service: string, sequence: number, overrides: Partial<ProjectionStatusHeartbeat> = {}): ProjectionStatusHeartbeat {
  return {
    serviceId: service,
    projectorName: "mv:students",
    projectorVersion: "v:1",
    clusterId: "cloudflare",
    activationId: "scheduled",
    sequence,
    appliedEventCount: 1,
    lastAppliedSortableUniqueId: g32Suid(1),
    lastTraversedSortableUniqueId: g32Suid(1),
    recordedAt: 1_700_000_000_000,
    phase: "active",
    leaseExpiresAt: 1_700_000_060_000,
    isFaulted: false,
    faultMessage: null,
    switchKind: null,
    switchReason: null,
    switchedAt: null,
    ...overrides,
  };
}

async function expectMatrix(store: StatusStore, ids: string[]): Promise<void> {
  const rejected = serviceId("g150z");
  ids.push(rejected);
  await expect(store.upsertProjectionStatusHeartbeat(heartbeat(rejected, 0), 0)).rejects.toThrow("projection status heartbeat is invalid");
  expect(await store.readProjectionStatusHeartbeat(rejected, "mv:students", "v:1", "cloudflare")).toBeUndefined();

  const created = serviceId("g150c");
  ids.push(created);
  const createdRow = heartbeat(created, 1);
  const first = await store.upsertProjectionStatusHeartbeat(createdRow, 0);
  expect(first).toEqual({ committed: true, current: createdRow });
  const replaced = heartbeat(created, 2, { activationId: "replacement" });
  const second = await store.upsertProjectionStatusHeartbeat(replaced, 1);
  expect(second).toEqual({ committed: true, current: replaced });
  const stale = await store.upsertProjectionStatusHeartbeat(heartbeat(created, 3, { activationId: "stale" }), 1);
  expect(stale.committed).toBe(false);
  expect(stale.current).toEqual(replaced);
  const competing = await store.upsertProjectionStatusHeartbeat(heartbeat(created, 1, { activationId: "loser" }), 0);
  expect(competing.committed).toBe(false);
  expect(competing.current).toEqual(replaced);

  const absent = serviceId("g150a");
  ids.push(absent);
  const missing = await store.upsertProjectionStatusHeartbeat(heartbeat(absent, 2), 1);
  expect(missing).toEqual({ committed: false, current: undefined });
  expect(await store.readProjectionStatusHeartbeat(absent, "mv:students", "v:1", "cloudflare")).toBeUndefined();

  const listed = serviceId("g150l");
  ids.push(listed);
  const rows = [
    heartbeat(listed, 1, { projectorName: "mv:b", projectorVersion: "v:2", clusterId: "b", activationId: "b" }),
    heartbeat(listed, 1, { projectorName: "mv:a", projectorVersion: "v:2", clusterId: "a", activationId: "z" }),
    heartbeat(listed, 1, { projectorName: "mv:a", projectorVersion: "v:1", clusterId: "m", activationId: "m" }),
  ];
  for (const row of rows) expect((await store.upsertProjectionStatusHeartbeat(row, 0)).committed).toBe(true);
  expect((await store.listProjectionStatusHeartbeats(listed)).map((row) => row.projectorName + row.projectorVersion + row.clusterId)).toEqual([
    "mv:av:1m",
    "mv:av:2a",
    "mv:bv:2b",
  ]);
  expect(await store.listProjectionStatusHeartbeats(listed, "mv:a")).toHaveLength(2);
  expect(await store.listProjectionStatusHeartbeats(listed, "mv:a", "v:1")).toHaveLength(1);
  expect(await store.listProjectionStatusHeartbeats(listed, null, "v:2")).toHaveLength(2);

  const detailed = serviceId("g150d");
  ids.push(detailed);
  const roundTrip = heartbeat(detailed, 1, {
    phase: "faulted",
    isFaulted: true,
    faultMessage: "materialized view catch-up faulted",
    leaseExpiresAt: 1_700_000_120_000,
    switchKind: "ordinary",
    switchReason: "planned",
    switchedAt: 1_700_000_000_000,
    lastAppliedSortableUniqueId: null,
    lastTraversedSortableUniqueId: null,
  });
  expect((await store.upsertProjectionStatusHeartbeat(roundTrip, 0)).committed).toBe(true);
  expect(await store.readProjectionStatusHeartbeat(detailed, roundTrip.projectorName, roundTrip.projectorVersion, roundTrip.clusterId)).toEqual(roundTrip);
}

function storedEvent(service: string, seed: number, eventId: string): StoredEvent {
  const suid = g32Suid(seed);
  return {
    serviceId: service,
    id: eventId,
    eventId,
    sortableUniqueId: suid,
    suid,
    payload: JSON.stringify({ eventId }),
    tags: ["g150:events"],
    eventTags: ["g150:events"],
    eventType: "G150FixtureEvent",
    timestamp: G32_FIXTURE_TIMESTAMP,
    causationId: null,
    correlationId: null,
    executedUser: null,
    provenance: "g32",
    firstArrivedAt: 1_000,
    lastArrivedAt: 1_000,
    maxDeliveryLagMs: 0,
    arrivals: [],
  };
}

class MemoryStatus {
  readonly rows = new Map<string, ProjectionStatusHeartbeat>();
  upserts = 0;
  loseNext = false;
  throwNext = false;
  hangRead = false;
  hangUpsert = false;

  private key(row: Pick<ProjectionStatusHeartbeat, "serviceId" | "projectorName" | "projectorVersion" | "clusterId">): string {
    return `${row.serviceId}\u0000${row.projectorName}\u0000${row.projectorVersion}\u0000${row.clusterId}`;
  }

  async readProjectionStatusHeartbeat(
    service: string,
    projectorName: string,
    projectorVersion: string,
    clusterId: string,
  ): Promise<ProjectionStatusHeartbeat | undefined> {
    if (this.hangRead) return new Promise(() => undefined);
    return this.rows.get(this.key({ serviceId: service, projectorName, projectorVersion, clusterId }));
  }

  async upsertProjectionStatusHeartbeat(
    row: ProjectionStatusHeartbeat,
    expectedSequence: number,
  ): Promise<ProjectionStatusWriteResult> {
    if (this.hangUpsert) return new Promise<ProjectionStatusWriteResult>(() => undefined);
    this.upserts += 1;
    if (this.throwNext) {
      this.throwNext = false;
      throw new Error("status write failed");
    }
    const current = this.rows.get(this.key(row));
    if (this.loseNext) {
      this.loseNext = false;
      return { committed: false, current };
    }
    if (expectedSequence === 0) {
      if (current !== undefined) return { committed: false, current };
    } else if (current === undefined || current.sequence !== expectedSequence || row.sequence <= current.sequence) {
      return { committed: false, current };
    }
    this.rows.set(this.key(row), row);
    return { committed: true, current: row };
  }

  async listProjectionStatusHeartbeats(
    service: string,
    projectorName?: string | null,
    projectorVersion?: string | null,
  ): Promise<readonly ProjectionStatusHeartbeat[]> {
    return [...this.rows.values()].filter((row) => row.serviceId === service
      && (projectorName === undefined || projectorName === null || row.projectorName === projectorName)
      && (projectorVersion === undefined || projectorVersion === null || row.projectorVersion === projectorVersion));
  }
}

function sourceFor(events: readonly StoredEvent[], status: MemoryStatus): ProjectionStore {
  return {
    readAllEvents: async (_serviceId, since) => events.filter((event) => since.length === 0 || event.suid > since),
    currentLagBound: async () => 0,
    listProjectionTags: async () => [],
    readProjectionCheckpoint: async () => undefined,
    advanceProjectionCheckpoint: async () => false,
    projectionLag: async () => ({ serviceId: "g150", projectionId: "g150", tag: "g150:events", checkpointSuid: "", headSuid: "", behindEvents: 0 }),
    appendDeliveryIncident: async () => undefined,
    readProjectionStatusHeartbeat: status.readProjectionStatusHeartbeat.bind(status),
    upsertProjectionStatusHeartbeat: status.upsertProjectionStatusHeartbeat.bind(status),
    listProjectionStatusHeartbeats: status.listProjectionStatusHeartbeats.bind(status),
  };
}

function materializer(id: string, version: number): MaterializedViewRowMaterializer<StoredEvent> {
  return defineRowMaterializer({
    id,
    version,
    indexDescriptors: [{ id: "event-id", valueType: "text", value: (_row, event) => event.eventId }],
    materialize: (event) => ({
      rowUpserts: [{ rowKey: event.eventId, value: { eventId: event.eventId }, sourceSuid: event.suid }],
    }),
  });
}

function facts(overrides: Partial<MaterializedViewStatusFacts> = {}): MaterializedViewStatusFacts {
  return {
    serviceId: "g150-facts",
    viewId: "view",
    generation: 0,
    definitionVersion: 1,
    status: "active",
    lastSuid: g32Suid(1),
    activePointer: true,
    rebuildRequired: false,
    checkpointAhead: false,
    targetPoison: false,
    openOrderingQuarantine: false,
    rebuildVerifiedAt: 1,
    rebuildSourceEventCount: 1,
    ...overrides,
  };
}

function observation(overrides: Partial<MaterializedViewStatusObservation> = {}): MaterializedViewStatusObservation {
  return {
    facts: facts(),
    indeterminate: false,
    stopReason: null,
    typedFault: false,
    rebuildRecovery: false,
    knownSourceCount: true,
    sourceEventCount: 1,
    appliedEventCount: 1,
    ...overrides,
  };
}

async function serializedStatus(row: ProjectionStatusHeartbeat, sampledAt: number): Promise<{ text: string; snapshot: Record<string, unknown> }> {
  const status = new MemoryStatus();
  status.rows.set(`${row.serviceId}\u0000${row.projectorName}\u0000${row.projectorVersion}\u0000${row.clusterId}`, row);
  const response = await handleSerializedProjectionStatus(new Request("https://status.test/api/sekiban/serialized/projection-status", {
    method: "POST",
    body: "{\"version\":1,\"serviceId\":null,\"projectorName\":null,\"projectorVersion\":null}",
  }), {
    serverServiceId: row.serviceId,
    nowMs: () => sampledAt,
    createStore: () => ({
      initialize: async () => undefined,
      readAllEvents: async () => [],
      readProjectionStatusHeartbeat: status.readProjectionStatusHeartbeat.bind(status),
      upsertProjectionStatusHeartbeat: status.upsertProjectionStatusHeartbeat.bind(status),
      listProjectionStatusHeartbeats: status.listProjectionStatusHeartbeats.bind(status),
    }) as never,
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  const body = JSON.parse(text) as { snapshots: Array<Record<string, unknown>> };
  const snapshot = body.snapshots[0];
  if (snapshot === undefined) throw new Error("missing projection status snapshot");
  return { text, snapshot };
}

async function snapshotGeneration(mv: D1MaterializedViewStore, service: string, viewId: string, generation: number): Promise<MaterializedViewInstance | undefined> {
  return mv.readInstance(service, viewId, generation);
}

describe("passive materialized-view projection status", () => {
  beforeAll(async () => {
    const existing = await d1().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dcb_projection_statuses'").first<{ name: string }>();
    if (existing === null || existing === undefined) {
      const statements = sqlStatements(d1StatusMigration as string);
      await d1().batch(statements.map((statement) => d1().prepare(statement)));
    }
    const viewTables = await materializedViewDatabase().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mv_instances'").first<{ name: string }>();
    if (viewTables === null || viewTables === undefined) {
      const statements = [mv0001, mv0002, mv0003, mv0004, mv0005, mv0006, mv0007, mv0008, mv0009]
        .flatMap((source) => sqlStatements(source as string));
      await materializedViewDatabase().batch(statements.map((statement) => materializedViewDatabase().prepare(statement)));
    }
    const sql = postgres(postgresUrl(), { max: 1, fetch_types: false });
    for (const statement of sqlStatements(postgresStatusMigration as string)) await sql.unsafe(statement);
  });

  it("keeps the starter migration byte-identical to the root migration", () => {
    expect(templateStatusMigration).toBe(d1StatusMigration);
    expect(d1StatusMigration).toContain("CHECK (sequence > 0)");
    expect(d1StatusMigration).not.toContain("sequence >= 0");
    expect(postgresStatusMigration).toContain("CHECK (sequence > 0)");
    expect(postgresStatusMigration).not.toContain("sequence >= 0");
  });

  it("compares and sets heartbeats on D1 and PostgreSQL", async () => {
    const d1Store = new D1EventStore(d1());
    await d1Store.initialize();
    const d1Ids: string[] = [];
    try {
      await expectMatrix(d1Store, d1Ids);
    } finally {
      for (const id of d1Ids) {
        await d1().prepare("DELETE FROM dcb_projection_statuses WHERE service_id = ?").bind(id).run();
      }
    }

    const pgStore = new PostgresEventStore(postgresUrl());
    const sql = postgres(postgresUrl(), { max: 1, fetch_types: false });
    const pgIds: string[] = [];
    try {
      await pgStore.initialize();
      await expectMatrix(pgStore, pgIds);
    } finally {
      for (const id of pgIds) {
        await sql.unsafe("DELETE FROM dcb_projection_statuses WHERE service_id = $1", [id]);
      }
    }
  });

  it("serializes the frozen version-1 request and response", () => {
    expect(serializeProjectionStatusRequestV1({
      serviceId: "server-service",
      projectorName: "students",
      projectorVersion: "v1",
    })).toBe(GOLDEN_REQUEST);
    const snapshot: ProjectionStatusSnapshotV1 = {
      projectorName: "students",
      projectorVersion: "v1",
      clusterId: "cluster-a",
      activationId: "activation-a",
      sequence: 7,
      appliedEventCount: 3,
      lastAppliedSortableUniqueId: "0001",
      lastTraversedSortableUniqueId: "0002",
      totalEventCount: 4,
      remainingEventCount: 0,
      sampledAtUtc: "2026-01-01T00:00:00+00:00",
      consistency: "bestEffort",
      isCaughtUp: true,
      hasConflict: false,
      conflictingActivationIds: [],
      phase: "active",
      leaseExpiresAtUtc: "2026-01-01T00:01:00+00:00",
      isFaulted: false,
      faultMessage: null,
      isFresh: true,
      switchKind: null,
      switchReason: null,
      switchedAtUtc: null,
    };
    expect(serializeProjectionStatusEnvelopeV1("server-service", [snapshot])).toBe(GOLDEN_RESPONSE);
  });

  it("refuses malformed and unsupported requests before opening a store", async () => {
    const bodies = [
      "",
      "null",
      "[]",
      "{\"version\":1}{}",
      "{\"version\":1,\"extra\":1}",
      "{\"version\":1,\"serviceId\":1}",
      "{\"version\":\"1\"}",
      "{\"serviceId\":\"server-service\"}",
    ];
    for (const body of bodies) {
      let created = 0;
      const response = await handleSerializedProjectionStatus(new Request("https://status.test/api/sekiban/serialized/projection-status", {
        method: "POST",
        body,
      }), {
        serverServiceId: "server-service",
        createStore: () => {
          created += 1;
          throw new Error("store");
        },
      });
      expect(created).toBe(0);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Projection status request is invalid.", code: "projection_status_invalid_request" });
    }
    for (const body of ["{\"version\":2}", "{\"version\":99,\"unknown\":{\"malformed\":true}}"]) {
      let created = 0;
      const response = await handleSerializedProjectionStatus(new Request("https://status.test/api/sekiban/serialized/projection-status", {
        method: "POST",
        body,
      }), {
        serverServiceId: "server-service",
        createStore: () => {
          created += 1;
          throw new Error("store");
        },
      });
      expect(created).toBe(0);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Projection status version is not supported.", code: "projection_status_unsupported_version" });
    }
    let mismatched = 0;
    const mismatch = await handleSerializedProjectionStatus(new Request("https://status.test/api/sekiban/serialized/projection-status", {
      method: "POST",
      body: GOLDEN_REQUEST,
    }), {
      serverServiceId: "other-service",
      createStore: () => {
        mismatched += 1;
        throw new Error("store");
      },
    });
    expect(mismatched).toBe(0);
    expect(mismatch.status).toBe(400);
    const missingMethod = await handleSerializedProjectionStatus(new Request("https://status.test/api/sekiban/serialized/projection-status"), {
      serverServiceId: "server-service",
      createStore: () => { throw new Error("store"); },
    });
    expect(missingMethod.status).toBe(404);
    expect(await missingMethod.json()).toEqual({ error: "Projection status route was not found.", code: "projection_status_route_not_found" });
  });

  it("samples counts, freshness, conflict, and optional switch fields without opening the target", async () => {
    const sampledAt = Date.parse("2026-01-01T00:02:00.100Z");
    const earlier = g32Suid(1);
    const events = [storedEvent("server-service", 1, "event-1"), storedEvent("server-service", 2, "event-2")];
    const rows = [
      heartbeat("server-service", 4, {
        projectorName: "students",
        projectorVersion: "v1",
        clusterId: "cluster-b",
        activationId: "zeta",
        recordedAt: sampledAt,
        leaseExpiresAt: sampledAt,
        lastTraversedSortableUniqueId: earlier,
        lastAppliedSortableUniqueId: null,
        switchKind: "ordinary",
        switchReason: null,
        switchedAt: sampledAt,
      }),
      heartbeat("server-service", 5, {
        projectorName: "students",
        projectorVersion: "v1",
        clusterId: "cluster-a",
        activationId: "alpha",
        recordedAt: sampledAt - 120_001,
        leaseExpiresAt: null,
        lastTraversedSortableUniqueId: null,
        lastAppliedSortableUniqueId: null,
      }),
    ];
    const status = new MemoryStatus();
    for (const row of rows) status.rows.set(`${row.serviceId}\u0000${row.projectorName}\u0000${row.projectorVersion}\u0000${row.clusterId}`, row);
    let reads = 0;
    const response = await handleSerializedProjectionStatus(new Request("https://status.test/api/sekiban/serialized/projection-status", {
      method: "POST",
      body: JSON.stringify({ version: 1, serviceId: "", projectorName: "students", projectorVersion: "v1" }),
    }), {
      serverServiceId: "server-service",
      nowMs: () => sampledAt,
      createStore: () => ({
        initialize: async () => undefined,
        readAllEvents: async () => {
          reads += 1;
          return events;
        },
        readProjectionStatusHeartbeat: status.readProjectionStatusHeartbeat.bind(status),
        upsertProjectionStatusHeartbeat: status.upsertProjectionStatusHeartbeat.bind(status),
        listProjectionStatusHeartbeats: status.listProjectionStatusHeartbeats.bind(status),
      }) as never,
    });
    expect(response.status).toBe(200);
    expect(status.upserts).toBe(0);
    expect(reads).toBe(1);
    const body = await response.json<{ snapshots: Array<Record<string, unknown>> }>();
    expect(body.snapshots.map((row) => row.clusterId)).toEqual(["cluster-a", "cluster-b"]);
    expect(body.snapshots[0]).toMatchObject({
      totalEventCount: 2,
      remainingEventCount: 2,
      isFresh: false,
      isCaughtUp: false,
      hasConflict: false,
      conflictingActivationIds: [],
      leaseExpiresAtUtc: null,
      lastTraversedSortableUniqueId: null,
    });
    expect(body.snapshots[0]).not.toHaveProperty("switchKind");
    expect(body.snapshots[1]).toMatchObject({
      totalEventCount: 2,
      remainingEventCount: 1,
      isFresh: true,
      hasConflict: false,
      isCaughtUp: false,
      switchKind: "ordinary",
      switchedAtUtc: "2026-01-01T00:02:00.1+00:00",
    });
    expect(body.snapshots[1]).not.toHaveProperty("switchReason");

    const conflictStatus = new MemoryStatus();
    for (const row of [
      heartbeat("server-service", 1, { clusterId: "b", activationId: "zeta", recordedAt: sampledAt, leaseExpiresAt: sampledAt }),
      heartbeat("server-service", 1, { clusterId: "a", activationId: "alpha", recordedAt: sampledAt, leaseExpiresAt: sampledAt }),
    ]) conflictStatus.rows.set(`${row.serviceId}\u0000${row.projectorName}\u0000${row.projectorVersion}\u0000${row.clusterId}`, row);
    const conflict = await handleSerializedProjectionStatus(new Request("https://status.test/api/sekiban/serialized/projection-status", {
      method: "POST",
      body: "{\"version\":1,\"serviceId\":null,\"projectorName\":null,\"projectorVersion\":null}",
    }), {
      serverServiceId: "server-service",
      nowMs: () => sampledAt,
      createStore: () => ({
        initialize: async () => undefined,
        readAllEvents: async () => events,
        readProjectionStatusHeartbeat: conflictStatus.readProjectionStatusHeartbeat.bind(conflictStatus),
        upsertProjectionStatusHeartbeat: conflictStatus.upsertProjectionStatusHeartbeat.bind(conflictStatus),
        listProjectionStatusHeartbeats: conflictStatus.listProjectionStatusHeartbeats.bind(conflictStatus),
      }) as never,
    });
    const conflictBody = await conflict.json<{ snapshots: Array<{ hasConflict: boolean; conflictingActivationIds: string[]; isCaughtUp: boolean }> }>();
    expect(conflictBody.snapshots.every((row) => row.hasConflict && !row.isCaughtUp)).toBe(true);
    expect(conflictBody.snapshots[0]?.conflictingActivationIds).toEqual(["alpha", "zeta"]);

    const unavailable = await handleSerializedProjectionStatus(new Request("https://status.test/api/sekiban/serialized/projection-status", {
      method: "POST",
      body: "{\"version\":1,\"serviceId\":null,\"projectorName\":null,\"projectorVersion\":null}",
    }), {
      serverServiceId: "server-service",
      createStore: () => ({
        initialize: async () => undefined,
        readAllEvents: async () => { throw new Error("secret-source-failure"); },
        readProjectionStatusHeartbeat: async () => undefined,
        upsertProjectionStatusHeartbeat: async () => ({ committed: false, current: undefined }),
        listProjectionStatusHeartbeats: async () => [],
      }) as never,
    });
    expect(unavailable.status).toBe(503);
    const unavailableText = await unavailable.text();
    expect(unavailableText).not.toContain("secret-source-failure");
    expect(unavailableText).not.toContain("\"isCaughtUp\":true");
    expect(JSON.parse(unavailableText)).toEqual({ error: "Projection status is unavailable.", code: "projection_status_unavailable" });

    const unsupported = await handleSerializedProjectionStatus(new Request("https://status.test/api/sekiban/serialized/projection-status", {
      method: "POST",
      body: "{\"version\":1,\"serviceId\":null,\"projectorName\":null,\"projectorVersion\":null}",
    }), {
      serverServiceId: "server-service",
      createStore: () => ({ initialize: async () => undefined, readAllEvents: async () => [] }) as never,
    });
    expect(unsupported.status).toBe(501);
    expect(await unsupported.json()).toEqual({ error: "Projection status is not supported by this provider.", code: "projection_status_unsupported" });
  });

  it("does not open the materialized-view database or a durable object while reading status", async () => {
    let durableGets = 0;
    let targetTouches = 0;
    const namespace = {
      get(): never {
        durableGets += 1;
        throw new Error("durable object");
      },
      idFromName: () => "id",
      newUniqueId: () => "id",
    };
    const target = new Proxy({}, {
      get(): never {
        targetTouches += 1;
        throw new Error("D1_MV");
      },
    });
    const sampledAt = Date.now();
    const row = heartbeat("server-service", 1, { recordedAt: sampledAt, leaseExpiresAt: sampledAt + 60_000, lastAppliedSortableUniqueId: null, lastTraversedSortableUniqueId: null });
    const worker = createRuntimeWorker({
      serviceIdentityProvider: {
        deployment: () => ({ serviceId: "server-service", behavior: "deployment" as const }),
        forRequest: () => ({ serviceId: "server-service", behavior: "deployment" as const }),
      },
      storeProvider: {
        name: "memory",
        create: () => ({
          initialize: async () => undefined,
          readAllEvents: async () => [],
          readProjectionStatusHeartbeat: async () => row,
          upsertProjectionStatusHeartbeat: async () => { throw new Error("status write"); },
          listProjectionStatusHeartbeats: async () => [row],
        }) as never,
      },
    });
    const response = await worker.fetch!(new Request("https://status.test/api/sekiban/serialized/projection-status", {
      method: "POST",
      body: "{\"version\":1,\"serviceId\":null,\"projectorName\":null,\"projectorVersion\":null}",
    }) as never, {
      SDT_SERVICE_ID: "server-service",
      D1_MV: target,
      ALLOCATOR: namespace,
      TAG: namespace,
      TAG_STATE: namespace,
      JOURNAL: namespace,
      BOOTSTRAP: namespace,
    } as never, createExecutionContext());
    expect(response.status).toBe(200);
    expect(targetTouches).toBe(0);
    expect(durableGets).toBe(0);
  });

  it("maps completion facts in fail-closed phase order", () => {
    expect(mapMaterializedViewStatusPhase(observation({ facts: undefined }))).toBe("unknown");
    expect(mapMaterializedViewStatusPhase(observation({ facts: facts({ checkpointAhead: true }) }))).toBe("faulted");
    expect(mapMaterializedViewStatusPhase(observation({ facts: facts({ targetPoison: true }) }))).toBe("faulted");
    expect(mapMaterializedViewStatusPhase(observation({ facts: facts({ openOrderingQuarantine: true }) }))).toBe("faulted");
    expect(mapMaterializedViewStatusPhase(observation({ typedFault: true }))).toBe("faulted");
    expect(mapMaterializedViewStatusPhase(observation({ facts: facts({ status: "retired", checkpointAhead: true }) }))).toBe("faulted");
    expect(mapMaterializedViewStatusPhase(observation({ facts: facts({ status: "retired", rebuildRequired: true }) }))).toBe("stopped");
    expect(mapMaterializedViewStatusPhase(observation({ facts: facts({ rebuildRequired: true }) }))).toBe("catchingUp");
    expect(mapMaterializedViewStatusPhase(observation({ indeterminate: true }))).toBe("unknown");
    expect(mapMaterializedViewStatusPhase(observation({
      facts: facts({ lastSuid: "" }),
      knownSourceCount: false,
      sourceEventCount: null,
      appliedEventCount: null,
    }))).toBe("starting");
    expect(mapMaterializedViewStatusPhase(observation({
      facts: facts({ status: "candidate" }),
      stopReason: "frontier_fence",
    }))).toBe("catchingUp");
    expect(mapMaterializedViewStatusPhase(observation({
      facts: facts({ status: "candidate" }),
      knownSourceCount: false,
    }))).toBe("catchingUp");
    expect(mapMaterializedViewStatusPhase(observation({
      facts: facts({ status: "candidate", rebuildVerifiedAt: null }),
      rebuildRecovery: true,
    }))).toBe("catchingUp");
    expect(mapMaterializedViewStatusPhase(observation({
      facts: facts({ status: "candidate", rebuildVerifiedAt: 5 }),
      rebuildRecovery: true,
    }))).toBe("caughtUp");
    expect(mapMaterializedViewStatusPhase(observation({ facts: facts({ status: "candidate", rebuildVerifiedAt: null }) }))).toBe("caughtUp");
    expect(mapMaterializedViewStatusPhase(observation({ stopReason: "safe_window_fence" }))).toBe("catchingUp");
    expect(mapMaterializedViewStatusPhase(observation({
      facts: facts({ lastSuid: "" }),
      sourceEventCount: 0,
      appliedEventCount: 0,
    }))).toBe("active");
    expect(mapMaterializedViewStatusPhase(observation())).toBe("active");
    expect(mapMaterializedViewStatusPhase(observation({
      facts: facts({ status: "paused" as "active" }),
    }))).toBe("unknown");
  });

  it("publishes after catch-up and leaves the catch-up result untouched when publication fails", async () => {
    const service = serviceId("g150p");
    const viewId = `g150-view-${service}`;
    const first = materializer(viewId, 1);
    const second = materializer(viewId, 2);
    const events = [storedEvent(service, 1, `${service}-1`)];
    const status = new MemoryStatus();
    const mv = new D1MaterializedViewStore(materializedViewDatabase());
    await mv.initialize();
    const runtime = new MaterializedViewCatchUpRuntime(sourceFor(events, status), mv);
    const built = await runtime.build(service, first, NOW_MS);
    const identity = mvProjectionStatusIdentity(viewId, 1);
    const published = await status.readProjectionStatusHeartbeat(service, identity.projectorName, identity.projectorVersion, "cloudflare");
    expect(published).toMatchObject({
      projectorName: identity.projectorName,
      projectorVersion: "v:1",
      clusterId: "cloudflare",
      activationId: "scheduled",
      sequence: 1,
      appliedEventCount: 1,
      phase: "active",
    });
    expect(mvProjectionStatusIdentity("生徒", 3).projectorName.startsWith("mv:")).toBe(true);
    expect(mvProjectionStatusIdentity("生徒", 3).projectorName).not.toContain("生徒");

    events.push(storedEvent(service, 2, `${service}-2`));
    const followed = await runtime.follow(service, first, NOW_MS);
    expect(followed.instance.lastSuid).toBe(events[1]!.suid);
    expect((await status.readProjectionStatusHeartbeat(service, identity.projectorName, identity.projectorVersion, "cloudflare"))?.appliedEventCount).toBe(2);

    const emptyService = serviceId("g150e");
    const emptyView = `g150-empty-${emptyService}`;
    const emptyRuntime = new MaterializedViewCatchUpRuntime(sourceFor([], status), mv);
    await emptyRuntime.build(emptyService, materializer(emptyView, 1), NOW_MS);
    const emptyIdentity = mvProjectionStatusIdentity(emptyView, 1);
    expect(await status.readProjectionStatusHeartbeat(emptyService, emptyIdentity.projectorName, emptyIdentity.projectorVersion, "cloudflare")).toMatchObject({
      phase: "active",
      appliedEventCount: 0,
      lastAppliedSortableUniqueId: null,
    });

    const rebuilt = await runtime.rebuild(service, second, NOW_MS);
    expect(rebuilt.candidateGeneration).toBe(1);
    const candidateIdentity = mvProjectionStatusIdentity(viewId, 2);
    expect(await status.readProjectionStatusHeartbeat(service, candidateIdentity.projectorName, candidateIdentity.projectorVersion, "cloudflare")).toMatchObject({ phase: "caughtUp" });
    const promoted = await runtime.promote(service, second as never, rebuilt.candidateGeneration, NOW_MS);
    expect(promoted.generation).toBe(1);
    expect(await status.readProjectionStatusHeartbeat(service, identity.projectorName, identity.projectorVersion, "cloudflare")).toMatchObject({ phase: "stopped", switchKind: null });
    expect(await status.readProjectionStatusHeartbeat(service, candidateIdentity.projectorName, candidateIdentity.projectorVersion, "cloudflare")).toMatchObject({
      phase: "active",
      switchKind: "ordinary",
    });

    const same = serviceId("g150s");
    const sameView = `g150-same-${same}`;
    const sameEvents = [storedEvent(same, 1, `${same}-1`)];
    const sameRuntime = new MaterializedViewCatchUpRuntime(sourceFor(sameEvents, status), mv);
    await sameRuntime.build(same, materializer(sameView, 1), NOW_MS);
    const sameRebuild = await sameRuntime.rebuild(same, materializer(sameView, 1), NOW_MS);
    await sameRuntime.promote(same, materializer(sameView, 1) as never, sameRebuild.candidateGeneration, NOW_MS);
    const sameIdentity = mvProjectionStatusIdentity(sameView, 1);
    const sameRows = await status.listProjectionStatusHeartbeats(same, sameIdentity.projectorName, sameIdentity.projectorVersion);
    expect(sameRows).toHaveLength(1);
    expect(sameRows[0]?.phase).toBe("active");

    const before = await snapshotGeneration(mv, service, viewId, 1);
    status.throwNext = true;
    const afterThrow = await runtime.follow(service, second, NOW_MS);
    expect(afterThrow.appliedEvents).toBe(0);
    expect(await snapshotGeneration(mv, service, viewId, 1)).toEqual(before);

    const beforeLoss = await snapshotGeneration(mv, service, viewId, 0);
    status.loseNext = true;
    const afterLoss = await runtime.follow(service, second, NOW_MS);
    expect(afterLoss.instance.lastSuid).toBe(events.at(-1)?.suid);
    expect(await snapshotGeneration(mv, service, viewId, 0)).toEqual(beforeLoss);

    const sentinel = new MaterializedViewStoreError("apply", "MV_STORE_OPERATION_FAILED", "sentinel");
    let publicationAttempts = 0;
    const failing = new Proxy(mv, {
      get(target, prop, receiver) {
        if (prop === "readInstance") return async () => { throw sentinel; };
        if (prop === "readStatusFacts") return async () => {
          publicationAttempts += 1;
          throw new Error("facts blew up");
        };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const failingRuntime = new MaterializedViewCatchUpRuntime(sourceFor(events, status), failing);
    const caught = await failingRuntime.follow(service, second, NOW_MS).then(() => undefined, (error: unknown) => error);
    expect(publicationAttempts).toBeGreaterThan(0);
    expect(caught).toBe(sentinel);
    expect(await snapshotGeneration(mv, service, viewId, 1)).toEqual(before);
    expect(built.instance.generation).toBe(0);
  });

  it("returns catch-up results when status publication never settles", async () => {
    const service = serviceId("g150h");
    const viewId = `g150-hang-${service}`;
    const view = materializer(viewId, 1);
    const events = [storedEvent(service, 1, `${service}-1`)];
    const status = new MemoryStatus();
    const mv = new D1MaterializedViewStore(materializedViewDatabase());
    await mv.initialize();
    const runtime = new MaterializedViewCatchUpRuntime(sourceFor(events, status), mv);
    const built = await runtime.build(service, view, NOW_MS);
    const identity = mvProjectionStatusIdentity(viewId, 1);
    expect(built.stopReason).toBe(null);
    expect(await status.readProjectionStatusHeartbeat(service, identity.projectorName, identity.projectorVersion, "cloudflare")).toMatchObject({ sequence: 1 });

    status.hangRead = true;
    const afterRead = await runtime.follow(service, view, NOW_MS);
    status.hangRead = false;
    expect(afterRead.instance.lastSuid).toBe(events[0]!.suid);
    expect((await status.readProjectionStatusHeartbeat(service, identity.projectorName, identity.projectorVersion, "cloudflare"))?.sequence).toBe(1);

    status.hangUpsert = true;
    const afterUpsert = await runtime.follow(service, view, NOW_MS);
    expect(afterUpsert.appliedEvents).toBe(0);
    expect((await status.readProjectionStatusHeartbeat(service, identity.projectorName, identity.projectorVersion, "cloudflare"))?.sequence).toBe(1);
    status.hangUpsert = false;

    let captures = 0;
    const hangingFacts = new Proxy(mv, {
      get(target, prop, receiver) {
        if (prop === "readStatusFacts") return () => {
          captures += 1;
          return new Promise(() => undefined);
        };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const captured = await new MaterializedViewCatchUpRuntime(sourceFor(events, status), hangingFacts).follow(service, view, NOW_MS);
    expect(captures).toBeGreaterThan(0);
    expect(captured.instance.generation).toBe(built.instance.generation);
    expect((await status.readProjectionStatusHeartbeat(service, identity.projectorName, identity.projectorVersion, "cloudflare"))?.sequence).toBe(1);

    const sentinel = new MaterializedViewStoreError("apply", "MV_ORDERING_QUARANTINED", "sentinel");
    let faultPublications = 0;
    const faulting = new Proxy(mv, {
      get(target, prop, receiver) {
        if (prop === "readInstance") return async () => { throw sentinel; };
        if (prop === "readStatusFacts") return () => {
          faultPublications += 1;
          return new Promise(() => undefined);
        };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const caught = await new MaterializedViewCatchUpRuntime(sourceFor(events, status), faulting).follow(service, view, NOW_MS).then(() => undefined, (error: unknown) => error);
    expect(faultPublications).toBeGreaterThan(0);
    expect(caught).toBe(sentinel);
  }, 20_000);

  it("serializes fail-closed caught-up flags for lease, fault, rebuild, and hard findings", async () => {
    const sampledAt = 1_700_000_000_000;
    const fresh = {
      recordedAt: sampledAt,
      leaseExpiresAt: sampledAt + 60_000,
      lastAppliedSortableUniqueId: g32Suid(1),
      lastTraversedSortableUniqueId: g32Suid(1),
      appliedEventCount: 0,
      isFaulted: false,
      faultMessage: null,
    };
    const caughtUp = await serializedStatus(heartbeat("g150-reader", 1, { ...fresh, phase: "active" }), sampledAt);
    expect(caughtUp.text).toContain('"isCaughtUp":true');
    expect(caughtUp.snapshot).toMatchObject({ isCaughtUp: true, remainingEventCount: 0, isFresh: true, phase: "active" });

    const expired = await serializedStatus(heartbeat("g150-reader", 1, {
      ...fresh,
      phase: "active",
      leaseExpiresAt: sampledAt - 1,
    }), sampledAt);
    expect(expired.text).toContain('"isCaughtUp":false');
    expect(expired.snapshot).toMatchObject({ isCaughtUp: false, remainingEventCount: 0, isFresh: false, phase: "active" });

    const fault = await serializedStatus(heartbeat("g150-reader", 1, {
      ...fresh,
      phase: "faulted",
      isFaulted: true,
      faultMessage: "materialized view catch-up faulted",
    }), sampledAt);
    expect(fault.text).toContain('"isCaughtUp":false');
    expect(fault.snapshot).toMatchObject({ isCaughtUp: false, remainingEventCount: 0, isFresh: true, phase: "faulted", isFaulted: true });

    const rebuildPhase = mapMaterializedViewStatusPhase(observation({ facts: facts({ rebuildRequired: true }) }));
    expect(rebuildPhase).toBe("catchingUp");
    const rebuild = await serializedStatus(heartbeat("g150-reader", 1, { ...fresh, phase: rebuildPhase }), sampledAt);
    expect(rebuild.text).toContain('"isCaughtUp":false');
    expect(rebuild.snapshot).toMatchObject({ isCaughtUp: false, remainingEventCount: 0, isFresh: true, phase: "catchingUp", isFaulted: false });

    for (const finding of ["checkpointAhead", "targetPoison", "openOrderingQuarantine"] as const) {
      const phase = mapMaterializedViewStatusPhase(observation({ facts: facts({ [finding]: true }) }));
      expect(phase).toBe("faulted");
      const serialized = await serializedStatus(heartbeat("g150-reader", 1, {
        ...fresh,
        phase,
        isFaulted: true,
        faultMessage: "materialized view catch-up faulted",
      }), sampledAt);
      expect(serialized.text).toContain('"isCaughtUp":false');
      expect(serialized.snapshot).toMatchObject({ isCaughtUp: false, remainingEventCount: 0, isFresh: true, phase: "faulted" });
    }
  });

  it("opens PostgreSQL for status reads without schema DDL", async () => {
    const store = new PostgresEventStore(postgresUrl());
    let ddlStatements = 0;
    const guarded = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "initialize") {
          return async () => {
            ddlStatements += 1;
            throw new Error("CREATE TABLE");
          };
        }
        if (property === "close") return async () => undefined;
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const response = await handleSerializedProjectionStatus(new Request("https://status.test/api/sekiban/serialized/projection-status", {
      method: "POST",
      body: "{\"version\":1,\"serviceId\":null,\"projectorName\":null,\"projectorVersion\":null}",
    }), {
      serverServiceId: "server-service",
      createStore: () => guarded as never,
    });
    expect(ddlStatements).toBe(0);
    expect(response.status).toBe(200);
  });

  it("does not publish from query, wait, unsafe, or live polling", async () => {
    const service = serviceId("g150q");
    const status = new MemoryStatus();
    const suid = g32Suid(1);
    const tag = "test:g150-query";
    const event = storedEvent(service, 1, "event-1");
    event.tags = [tag];
    event.eventTags = [tag];
    const projectionId = projectionIdFor({ tag, tagGroup: "test", tagContent: "g150-query", tagProjector: "test-projector" });
    const store = {
      ...sourceFor([event], status),
      initialize: async () => undefined,
      listProjectionTags: async () => [tag],
      readProjectionCheckpoint: async () => ({
        serviceId: service,
        projectionId,
        lastSuid: suid,
        stateJson: JSON.stringify([{ eventId: "event-1", suid, payload: "{}" }]),
        version: 1,
        updatedAt: 1,
      }),
    };
    const request = (body: unknown) => new Request("https://query.test/api/sekiban/serialized/list-query", {
      method: "POST",
      headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: service },
      body: JSON.stringify(body),
    });
    const listed = await handleSerializedQuery(request({
      queryType: "GetTestListQuery",
      queryParamsJson: JSON.stringify({ PageNumber: 1, PageSize: 20 }),
    }), {}, { store });
    expect(listed.status).toBe(200);
    const waited = await handleSerializedQuery(request({
      queryType: "GetTestListQuery",
      queryParamsJson: JSON.stringify({ PageNumber: 1, PageSize: 20 }),
      waitForSortableUniqueId: suid,
    }), {}, { store, sleep: async () => undefined });
    expect(waited.status).toBe(200);
    const unsafe = await handleSerializedQuery(request({
      queryType: "GetTestListQuery",
      queryParamsJson: JSON.stringify({ PageNumber: 1, PageSize: 20, consistency: "unsafe" }),
    }), {}, {
      store,
      queryBacking: "d1-mv",
      materializedViewQueryPort: {
        initialize: async () => undefined,
        queryRows: async () => [],
        readOrderingQuarantine: async () => undefined,
        hasCheckpointAheadFinding: async () => false,
        readActiveGeneration: async () => 0,
        readListPage: async () => ({ rows: [], totalCount: 0, readHead: "" }),
      },
    });
    expect(unsafe.status).toBe(200);
    await pollLiveProjections({}, { store: store as never, registry: new ProjectorRegistry([]), serviceId: service });
    expect(status.upserts).toBe(0);
  });
});
