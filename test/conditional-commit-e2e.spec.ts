import { createExecutionContext, createMessageBatch, env, getQueueResult, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { defineEvent, defineRowMaterializer } from "../packages/dcb-core/src/index";
import { createInProcessTransport, createSekibanExecutor, type SekibanExecutor } from "../packages/dcb-client/src/index";
import { ClientError } from "../packages/dcb-client/src/errors";
import { createCloudflareOnlyRuntimeWorker } from "../packages/dcb-runtime/src/cloudflare";
import type { CommitWorkerEnv } from "../packages/dcb-runtime/src/commit/CommitWorker";
import { handleDownstreamQueue, processDownstreamDoorbell } from "../packages/dcb-runtime/src/downstream/DownstreamAdapter";
import { drainTagOutbox } from "../packages/dcb-runtime/src/downstream/OutboxDrain";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { isUuidV7 } from "../packages/dcb-runtime/src/eventRecord";
import { createRuntimeWorker } from "../packages/dcb-runtime/src/index";
import { D1MaterializedViewStore } from "../packages/dcb-runtime/src/mv/MaterializedViewStore";
import { MaterializedViewCatchUpRuntime } from "../packages/dcb-runtime/src/mv/MaterializedViewCatchUp";
import { catchUpDurableTagState, projectionIdFor, ProjectionRuntime } from "../packages/dcb-runtime/src/projection/ProjectionRuntime";
import { ProjectorRegistry, type ProjectionEvent, type TagStateProjector } from "../packages/dcb-runtime/src/projection/ProjectorRegistry";
import { scopeIdFor } from "../packages/dcb-runtime/src/scope/ScopeName";
import { D1EventStore } from "../packages/dcb-runtime/src/store/D1EventStore";
import { POSTGRES_STORE_PROVIDER } from "../packages/dcb-runtime/src/store/provider";
import type { StoredEvent } from "../packages/dcb-runtime/src/store/types";
import type { TagEvent } from "../packages/dcb-runtime/src/tag/types";
import { applyG44D1Migration } from "./helpers/g44-d1-migration";
// @ts-expect-error Vite raw asset import
import d1Migration from "../migrations/d1/g32/0001_dcb_events.sql?raw";
// @ts-expect-error Vite raw asset import
import mv0001 from "../migrations/mv/0001_materialized_views.sql?raw";
// @ts-expect-error Vite raw asset import
import mv0002 from "../migrations/mv/0002_unsafe_window_materialized_views.sql?raw";
// @ts-expect-error Vite raw asset import
import mv0003 from "../migrations/mv/0003_checkpoint_ahead_hardening.sql?raw";
// @ts-expect-error Vite raw asset import
import mv0004 from "../migrations/mv/0004_unsafe_window_failure_findings.sql?raw";
// @ts-expect-error Vite raw asset import
import mv0005 from "../migrations/mv/0005_g31_wait_receipts.sql?raw";
// @ts-expect-error Vite raw asset import
import mv0006 from "../migrations/mv/0006_g31_wait_target_poison.sql?raw";
// @ts-expect-error Vite raw asset import
import mv0007 from "../migrations/mv/0007_g69_ordering_quarantine.sql?raw";
// @ts-expect-error Vite raw asset import
import mv0008 from "../migrations/mv/0008_g69_rebuild_verification.sql?raw";
// @ts-expect-error Vite raw asset import
import mv0009 from "../migrations/mv/0009_g69_rebuild_proof.sql?raw";

export const conditionalFixtureEvent = defineEvent<{ readonly sku: string }>("FixtureEvent");
const domain = { events: [conditionalFixtureEvent] };

export interface ConditionalFacade {
  readonly executor: SekibanExecutor;
  readonly serviceId: string;
  readonly tagGets: { get: number };
}

interface WitnessState {
  readonly ids: readonly string[];
  readonly suid: string;
}

function bindings(): CommitWorkerEnv {
  return env as unknown as CommitWorkerEnv;
}

function serviceId(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

function countingNamespace(namespace: DurableObjectNamespace, counts: { get: number }): DurableObjectNamespace {
  return {
    get(id: DurableObjectId) {
      counts.get += 1;
      return namespace.get(id);
    },
    idFromName: (name: string) => namespace.idFromName(name),
    idFromString: (id: string) => namespace.idFromString(id),
    newUniqueId: (options?: DurableObjectNamespaceNewUniqueIdOptions) => namespace.newUniqueId(options),
    jurisdiction: (jurisdiction: DurableObjectJurisdiction) => namespace.jurisdiction(jurisdiction),
  } as unknown as DurableObjectNamespace;
}

function workerFetch(worker: { fetch?: unknown }): (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response> {
  return worker.fetch as (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>;
}

export function openConditionalFacade(input: {
  readonly kind: "d1" | "postgres" | "unsupported";
  readonly dropFirst?: boolean;
}): ConditionalFacade {
  const id = serviceId(input.kind === "d1" ? "d1" : "pg");
  const tagGets = { get: 0 };
  const worker = input.kind === "d1"
    ? createCloudflareOnlyRuntimeWorker({ domain })
    : createRuntimeWorker({
      domain,
      ...(input.kind === "unsupported" ? { storeProvider: POSTGRES_STORE_PROVIDER } : {}),
    });
  let dropped = false;
  const fetchImpl = async (requestInput: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await workerFetch(worker)(new Request(requestInput, init), {
      ...bindings(),
      SDT_SERVICE_ID: id,
      TAG: countingNamespace(bindings().TAG, tagGets),
    }, createExecutionContext());
    if (input.dropFirst === true && !dropped) {
      dropped = true;
      throw new TypeError("conditional response dropped");
    }
    return response;
  };
  const transport = createInProcessTransport({ fetch: fetchImpl }, { serviceId: id });
  return {
    executor: createSekibanExecutor(transport, { serviceId: id }),
    serviceId: id,
    tagGets,
  };
}

function prepare(executor: SekibanExecutor, key: string, tag: string, sku: string) {
  return executor.prepareConditionalCommit({
    idempotencyKey: key,
    event: conditionalFixtureEvent,
    payload: { sku },
    tag,
  });
}

export function registerPublicConditionalConformanceSuite(
  label: string,
  open: (dropFirst?: boolean) => ConditionalFacade,
): void {
  describe(`${label} public conditional conformance`, () => {
    it("first append", async () => {
      const opened = open();
      const result = await opened.executor.commitPreparedConditionally(prepare(opened.executor, "first-key", "order:first", "a"));
      expect(result.outcome).toBe("Appended");
      if (result.outcome !== "Appended") return;
      expect(result.writtenEvents).toHaveLength(1);
      expect(result.writtenEvents[0]?.id).toBe(result.receipt.winnerEventId);
      expect(isUuidV7(result.receipt.winnerEventId)).toBe(true);
    });

    it("same-operation resend", async () => {
      const opened = open();
      const prepared = prepare(opened.executor, "same-key", "order:same", "a");
      const first = await opened.executor.commitPreparedConditionally(prepared);
      const second = await opened.executor.commitPreparedConditionally(prepared);
      expect(first.outcome).toBe("Appended");
      expect(second.outcome).toBe("AlreadyCommittedSameOperation");
      if (first.outcome !== "Appended" || second.outcome !== "AlreadyCommittedSameOperation") return;
      expect(second.writtenEvents).toHaveLength(0);
      expect(second.receipt.winnerEventId).toBe(first.receipt.winnerEventId);
    });

    it("different-payload conflict", async () => {
      const opened = open();
      const tag = "order:conflict";
      const first = await opened.executor.commitPreparedConditionally(prepare(opened.executor, "conflict-key", tag, "a"));
      const second = await opened.executor.commitPreparedConditionally(prepare(opened.executor, "conflict-key", tag, "b"));
      expect(first.outcome).toBe("Appended");
      expect(second.outcome).toBe("KeyReuseConflict");
    });

    it("concurrent identical calls", async () => {
      const opened = open();
      const prepared = prepare(opened.executor, "race-key", "order:race", "a");
      const results = await Promise.all(Array.from({ length: 6 }, () => opened.executor.commitPreparedConditionally(prepared)));
      expect(results.filter((result) => result.outcome === "Appended")).toHaveLength(1);
      expect(results.filter((result) => result.outcome === "AlreadyCommittedSameOperation")).toHaveLength(5);
    });

    it("same key on different tags", async () => {
      const opened = open();
      const left = await opened.executor.commitPreparedConditionally(prepare(opened.executor, "shared-key", "order:left", "a"));
      const right = await opened.executor.commitPreparedConditionally(prepare(opened.executor, "shared-key", "order:right", "a"));
      expect(left.outcome).toBe("Appended");
      expect(right.outcome).toBe("Appended");
      if (left.outcome !== "Appended" || right.outcome !== "Appended") return;
      expect(left.receipt.winnerEventId).not.toBe(right.receipt.winnerEventId);
    });

    it("unknown-outcome resend of the same held prepared value", async () => {
      const opened = open(true);
      const prepared = prepare(opened.executor, "unknown-key", "order:unknown", "a");
      await expect(opened.executor.commitPreparedConditionally(prepared)).rejects.toBeInstanceOf(ClientError);
      const resent = await opened.executor.commitPreparedConditionally(prepared);
      expect(resent.outcome).toBe("AlreadyCommittedSameOperation");
    });

    it("Unsupported", async () => {
      const opened = openConditionalFacade({ kind: "unsupported" });
      const result = await opened.executor.commitPreparedConditionally(prepare(opened.executor, "unsupported-key", "order:unsupported", "a"));
      expect(result.outcome).toBe("Unsupported");
      expect(opened.tagGets.get).toBe(0);
    });
  });
}

function database(name: "D1" | "D1_MV"): D1Database {
  const binding = (env as unknown as { D1?: D1Database; D1_MV?: D1Database })[name];
  if (binding === undefined) throw new Error(`${name} binding is required`);
  return binding;
}

function sqlStatements(sql: string): string[] {
  return sql.replace(/^\s*--.*$/gm, "").split(";").map((statement) => statement.trim()).filter((statement) => statement.length > 0);
}

async function applySql(target: D1Database, sql: string): Promise<void> {
  const statements = sqlStatements(sql);
  if (statements.length > 0) await target.batch(statements.map((statement) => target.prepare(statement)));
}

function projector(id: string): TagStateProjector {
  return {
    id,
    tagPayloadName: "FixtureEvent",
    projectorVersion: "1",
    initialState: (): WitnessState => ({ ids: [], suid: "" }),
    apply(state: unknown, event: ProjectionEvent): WitnessState {
      const current = state as WitnessState;
      return { ids: [...current.ids, event.eventId], suid: event.suid };
    },
    serializeState: (state: unknown) => JSON.stringify(state),
    deserializeState: (serialized: string) => JSON.parse(serialized) as WitnessState,
    payload: (state: unknown) => JSON.stringify(state),
    version: (state: unknown) => (state as WitnessState).ids.length,
  };
}

const witnessProjectors = [projector("conditional-a"), projector("conditional-b")];

function tagIdentity(tag: string, tagProjector: string) {
  const [tagGroup, tagContent] = tag.split(":");
  return { tag, tagGroup: tagGroup ?? tag, tagContent: tagContent ?? tag, tagProjector };
}

async function queuedMessages(service: string, tag: string): Promise<DownstreamOutboxMessage[]> {
  const queued: DownstreamOutboxMessage[] = [];
  const drained = await drainTagOutbox({ serviceId: service, tag }, {
    TAG: bindings().TAG,
    DOWNSTREAM_QUEUE: {
      async metrics() { return { backlogCount: queued.length, backlogBytes: 0 }; },
      async send(body: DownstreamOutboxMessage) {
        queued.push(body);
        return { metadata: { metrics: { backlogCount: queued.length, backlogBytes: 0 } } };
      },
      async sendBatch(batch: Iterable<{ body: DownstreamOutboxMessage }>) {
        for (const entry of batch) queued.push(entry.body);
        return { metadata: { metrics: { backlogCount: queued.length, backlogBytes: 0 } } };
      },
    },
  }, { now: () => Date.now() }, { acknowledgement: "global-receipt" });
  expect(drained.delivered).toBe(1);
  expect(queued).toHaveLength(1);
  return queued;
}

async function deliverDirect(message: DownstreamOutboxMessage, store: D1EventStore): Promise<void> {
  await processDownstreamDoorbell(message, {}, { store });
}

async function deliverQueue(message: DownstreamOutboxMessage, store: D1EventStore): Promise<void> {
  const batch = createMessageBatch("serialized-dcb-v1-outbox", [{
    id: `${message.eventId}-queue`,
    timestamp: new Date(),
    attempts: 1,
    body: message,
  }]);
  await handleDownstreamQueue(batch, {}, { store });
  expect((await getQueueResult(batch, createExecutionContext())).retryMessages).toEqual([]);
}

const skipE2eEntry = (globalThis as { __SDT_SKIP_CONDITIONAL_E2E_ENTRY?: boolean }).__SDT_SKIP_CONDITIONAL_E2E_ENTRY === true;

if (!skipE2eEntry) {
  registerPublicConditionalConformanceSuite("fixed D1", (dropFirst = false) => openConditionalFacade({ kind: "d1", dropFirst }));

  describe("fixed D1 conditional downstream", () => {
    beforeAll(async () => {
      await applySql(database("D1"), d1Migration as string);
      await applyG44D1Migration(database("D1"));
      for (const migration of [mv0001, mv0002, mv0003, mv0004, mv0005, mv0006, mv0007, mv0008, mv0009]) {
        await applySql(database("D1_MV"), migration as string);
      }
    });

    it.each(["direct-first", "queue-first"] as const)("keeps one winner when delivery order is %s", async (order) => {
      const opened = openConditionalFacade({ kind: "d1" });
      const tag = `order:${order}`;
      const prepared = prepare(opened.executor, `${order}-key`, tag, "winner");
      const committed = await opened.executor.commitPreparedConditionally(prepared);
      expect(committed.outcome).toBe("Appended");
      if (committed.outcome !== "Appended") return;
      const winnerId = committed.receipt.winnerEventId;
      const winnerSuid = committed.receipt.winnerSortableUniqueId;
      expect(isUuidV7(winnerId)).toBe(true);
      const [message] = await queuedMessages(opened.serviceId, tag);
      if (message === undefined) throw new Error("outbox message missing");
      const store = new D1EventStore(database("D1"));
      await store.initialize();
      if (order === "direct-first") {
        await deliverDirect(message, store);
        await deliverQueue(message, store);
      } else {
        await deliverQueue(message, store);
        await deliverDirect(message, store);
      }
      const globalEvents = await store.readAllEvents(opened.serviceId, "");
      expect(globalEvents, "one global event").toHaveLength(1);
      const stored = globalEvents[0];
      expect(stored?.eventId).toBe(winnerId);
      expect(stored?.suid).toBe(winnerSuid);
      const runtime = new ProjectionRuntime(store, new ProjectorRegistry(witnessProjectors));
      const nowMs = Date.now() + 60_000;
      const views = new D1MaterializedViewStore(database("D1_MV"));
      await views.initialize();
      for (const item of witnessProjectors) {
        const identity = tagIdentity(tag, item.id);
        const applied = await runtime.catchUp(opened.serviceId, identity, nowMs);
        expect(applied.appliedEvents).toBe(1);
        const duplicate = await runtime.catchUp(opened.serviceId, identity, nowMs);
        expect(duplicate.appliedEvents).toBe(0);
        const checkpoint = await store.readProjectionCheckpoint(opened.serviceId, projectionIdFor(identity));
        if (checkpoint === undefined) throw new Error("safe checkpoint missing");
        const safeState = item.deserializeState(checkpoint.stateJson) as WitnessState;
        expect(safeState.ids).toEqual([winnerId]);
        expect(safeState.suid).toBe(winnerSuid);
        expect(checkpoint.lastSuid).toBe(winnerSuid);
        const materializer = defineRowMaterializer<StoredEvent>({
          id: `${item.id}-${opened.serviceId}`,
          version: 1,
          materialize: (event) => ({
            rowUpserts: [{ rowKey: event.eventId, value: { eventId: event.eventId, suid: event.suid }, sourceSuid: event.suid }],
          }),
        });
        await views.createActive({
          serviceId: opened.serviceId,
          viewId: materializer.id,
          generation: 0,
          definitionVersion: materializer.version,
          updatedAt: nowMs,
        });
        const plan = materializer.plan(stored!);
        const unsafe = views.unsafeWindow();
        const unsafeInput = {
          serviceId: opened.serviceId,
          viewId: materializer.id,
          generation: 0,
          eventId: winnerId,
          suid: winnerSuid,
          safeHead: "",
          updatedAt: nowMs,
          mutations: plan,
        };
        expect((await unsafe.apply(unsafeInput)).outcome).toBe("applied");
        expect((await unsafe.apply(unsafeInput)).duplicate).toBe(true);
        const unsafePage = await unsafe.queryComposedPage(opened.serviceId, materializer.id, 0, 10, 0);
        expect(unsafePage.rows).toHaveLength(1);
        expect(unsafePage.rows[0]?.rowKey).toBe(winnerId);
        expect(unsafePage.rows[0]?.sourceSuid).toBe(winnerSuid);
        expect(unsafePage.rows[0]?.value).toEqual({ eventId: winnerId, suid: winnerSuid });
        const catchUp = new MaterializedViewCatchUpRuntime(store, views);
        const built = await catchUp.follow(opened.serviceId, materializer, nowMs);
        expect(built.appliedEvents).toBe(1);
        const followed = await catchUp.follow(opened.serviceId, materializer, nowMs);
        expect(followed.appliedEvents).toBe(0);
        const rows = await views.readRows(opened.serviceId, materializer.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.rowKey).toBe(winnerId);
        expect(rows[0]?.sourceSuid).toBe(winnerSuid);
        expect(rows[0]?.value).toEqual({ eventId: winnerId, suid: winnerSuid });
      }
      const stub = bindings().TAG.get(scopeIdFor(bindings().TAG, {
        serviceId: opened.serviceId,
        doClass: "tag",
        identity: tag,
      }));
      const rebuiltEvents = await runInDurableObject(stub, (instance) => (
        instance as unknown as { g43TagStateRebuild(): Promise<readonly TagEvent[]> }
      ).g43TagStateRebuild());
      for (const item of witnessProjectors) {
        const rebuilt = catchUpDurableTagState(item, rebuiltEvents);
        expect(rebuilt.version).toBe(1);
        expect(rebuilt.stateJson).toContain(winnerId);
        expect(rebuilt.stateJson).toContain(winnerSuid);
      }
    });
  });
}
