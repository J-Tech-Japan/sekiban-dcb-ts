import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  DEPLOYED_PROJECTOR_REGISTRY,
  ProjectorRegistry,
  TEST_TAG_STATE_PROJECTOR,
  type TagStateProjector,
} from "../packages/dcb-runtime/src/projection/ProjectorRegistry";
import { SerializedReadWorker } from "../packages/dcb-runtime/src/read/SerializedReadWorker";
import { TAG_READ_AFTER_THROUGH_SQL } from "../packages/dcb-runtime/src/tag/TagSqlSchema";
import type { G43SqlMeasurementSnapshot } from "../packages/dcb-runtime/src/tag/TagSqlMeasurement";
import type { G43TagStateIncrementalPage, G43TagStateIncrementalRequest, TagEvent } from "../packages/dcb-runtime/src/tag/types";
import {
  configureTagStateProjectorRegistry,
  type TagStateObjectIdentity,
} from "../packages/dcb-runtime/src/tagstate/TagStateDurableObject";
import { buildScopeName, scopeIdFor, tagStateScopeIdentity } from "../packages/dcb-runtime/src/scope/ScopeName";
import { TEST_SERVICE_ID_HEADER } from "../packages/dcb-runtime/src/service/ServiceIdentityProvider";
import { G32_FIXTURE_TIMESTAMP, g32EventId, g32Suid } from "./helpers/g32-fixtures";

const SOURCE_PAGE_LIMIT = 64;
const SOURCE_ROW_OVERHEAD = 3; // immutable identity + control + head rows
const SUID_BASE = 7_000_000;

interface Scope {
  readonly serviceId: string;
  readonly tag: string;
}

interface MeasuredTagInstance {
  beginG43SqlMeasurement(): void;
  completeG43SqlMeasurement(): G43SqlMeasurementSnapshot;
  g43TagStateIncrementalCatchUp(input: G43TagStateIncrementalRequest): Promise<G43TagStateIncrementalPage>;
}

interface TagStateTestInstance {
  setG46CheckpointFaultForTest(fault: "before-checkpoint" | "after-checkpoint" | undefined): void;
  setG46SourceNamespaceForTest(namespace: DurableObjectNamespace | undefined): void;
}

interface SourceCall {
  readonly path: string;
  readonly input: G43TagStateIncrementalRequest;
  readonly returnedEvents: number;
}

interface SourceHarness {
  readonly namespace: DurableObjectNamespace;
  readonly calls: SourceCall[];
  readonly events: TagEvent[];
}

function scope(prefix = "g46"): Scope {
  return {
    serviceId: `${prefix}-${crypto.randomUUID()}`,
    tag: `room:${prefix}-${crypto.randomUUID()}`,
  };
}

function identity(value: Scope, projectorId = TEST_TAG_STATE_PROJECTOR): TagStateObjectIdentity {
  return { serviceId: value.serviceId, tag: value.tag, projectorId };
}

function tagStub(value: Scope): DurableObjectStub {
  const namespace = (env as unknown as { readonly TAG: DurableObjectNamespace }).TAG;
  return namespace.get(scopeIdFor(namespace, { serviceId: value.serviceId, doClass: "tag", identity: value.tag }));
}

function tagStateStub(value: TagStateObjectIdentity): DurableObjectStub {
  const namespace = (env as unknown as { readonly TAG_STATE: DurableObjectNamespace }).TAG_STATE;
  return namespace.get(scopeIdFor(namespace, {
    serviceId: value.serviceId,
    doClass: "tag-state",
    identity: tagStateScopeIdentity(value.tag, value.projectorId),
  }));
}

function tagStateScopeName(value: TagStateObjectIdentity): string {
  return buildScopeName({
    serviceId: value.serviceId,
    doClass: "tag-state",
    identity: tagStateScopeIdentity(value.tag, value.projectorId),
  });
}

function eventFor(value: Scope, ordinal: number): TagEvent {
  return {
    attemptId: "g46-history-seed",
    eventId: g32EventId(`g46:${value.serviceId}:${ordinal}`),
    suid: g32Suid(SUID_BASE + ordinal),
    payload: JSON.stringify({ fixture: "g46", ordinal }),
    eventTags: [value.tag],
    allocatorLineageId: "g46-history-seed",
    eventType: "G46TagStateFixture",
    provenance: "g32",
    timestamp: G32_FIXTURE_TIMESTAMP,
  };
}

async function seedTagHistory(value: Scope, count: number): Promise<TagEvent[]> {
  const events = Array.from({ length: count }, (_unused, index) => eventFor(value, index + 1));
  await runInDurableObject(tagStub(value), (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec("INSERT INTO tag_identity (singleton, tag, created_at) VALUES (1, ?, ?)", value.tag, G32_FIXTURE_TIMESTAMP);
    sql.exec(`
      INSERT INTO tag_control (
        singleton, schema_version, head_suid, clock_offset_ms, clock_now_ms,
        version, repair_owner, repair_lease_until, highest_repair_epoch,
        repair_scope_version, created_at, updated_at
      ) VALUES (1, 3, ?, 0, NULL, ?, NULL, NULL, 0, 0, ?, ?)
    `, events.at(-1)?.suid ?? "", count, G32_FIXTURE_TIMESTAMP, G32_FIXTURE_TIMESTAMP);
    sql.exec("INSERT INTO tag_head (singleton, service_id, head_suid) VALUES (1, ?, ?)", value.serviceId, events.at(-1)?.suid ?? "");
    for (const event of events) {
      sql.exec(`
        INSERT INTO tag_event (
          service_id, event_id, attempt_id, suid, payload, event_tags_json,
          allocator_lineage_id, event_type, provenance, timestamp, event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, value.serviceId, event.eventId, event.attemptId, event.suid, event.payload,
      JSON.stringify(event.eventTags), event.allocatorLineageId, event.eventType,
      event.provenance, event.timestamp, JSON.stringify(event));
    }
  });
  return events;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function sourceHarness(
  events: readonly TagEvent[],
  failure?: Readonly<{ status: 409 | 503; body: Record<string, unknown> }>,
): SourceHarness {
  const calls: SourceCall[] = [];
  const mutableEvents = [...events];
  const namespace = {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: () => ({
      fetch: async (request: Request) => {
        const url = new URL(request.url);
        const input = await request.json<G43TagStateIncrementalRequest>();
        if (failure !== undefined) return response(failure.body, failure.status);
        const through = input.through ?? mutableEvents.at(-1)?.suid ?? "";
        const returned = mutableEvents
          .filter((event) => event.suid > input.cursor && (through === "" || event.suid <= through))
          .slice(0, input.limit);
        const lastSortableUniqueId = returned.at(-1)?.suid ?? input.cursor;
        const completeThrough = returned.length < input.limit || lastSortableUniqueId === through ? through : null;
        calls.push({ path: url.pathname, input, returnedEvents: returned.length });
        return response({ events: returned, lastSortableUniqueId, through, completeThrough });
      },
    }),
  } as unknown as DurableObjectNamespace;
  return { namespace, calls, events: mutableEvents };
}

async function installSource(value: TagStateObjectIdentity, source: SourceHarness): Promise<void> {
  await runInDurableObject(tagStateStub(value), (instance) => {
    (instance as unknown as TagStateTestInstance).setG46SourceNamespaceForTest(source.namespace);
  });
}

async function setCheckpointFault(value: TagStateObjectIdentity, fault: "before-checkpoint" | "after-checkpoint" | undefined): Promise<void> {
  await runInDurableObject(tagStateStub(value), (instance) => {
    (instance as unknown as TagStateTestInstance).setG46CheckpointFaultForTest(fault);
  });
}

async function readTagStateObject(value: TagStateObjectIdentity): Promise<Response> {
  return tagStateStub(value).fetch(new Request("https://tag-state.test/read", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  }));
}

function decodeJsonPayload(payload: string): unknown {
  const binary = atob(payload);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function decodePayload(payload: string): Array<{ readonly eventId: string; readonly suid: string }> {
  return decodeJsonPayload(payload) as Array<{ readonly eventId: string; readonly suid: string }>;
}

async function result(responseValue: Response): Promise<Record<string, unknown>> {
  expect(responseValue.headers.get("content-type")).toBe("application/json; charset=utf-8");
  return responseValue.json<Record<string, unknown>>();
}

function counterProjector(id: string, version = "1"): TagStateProjector {
  return {
    id,
    tagPayloadName: `G46${id}`,
    projectorVersion: version,
    initialState: () => ({ count: 0, entries: [] as string[] }),
    apply(state, event) {
      const current = state as { count: number; entries: string[] };
      return { count: current.count + 1, entries: [...current.entries, event.eventId] };
    },
    serializeState: (state) => JSON.stringify(state),
    deserializeState: (serialized) => JSON.parse(serialized) as { count: number; entries: string[] },
    payload: (state) => btoa(JSON.stringify(state)),
    version: (state) => (state as { count: number }).count,
  };
}

async function measuredSourcePage(value: Scope, input: G43TagStateIncrementalRequest): Promise<{
  readonly page: G43TagStateIncrementalPage;
  readonly snapshot: G43SqlMeasurementSnapshot;
}> {
  await runInDurableObject(tagStub(value), (instance) => {
    (instance as unknown as MeasuredTagInstance).beginG43SqlMeasurement();
  });
  const page = await runInDurableObject(tagStub(value), (instance) =>
    (instance as unknown as MeasuredTagInstance).g43TagStateIncrementalCatchUp(input));
  const snapshot = await runInDurableObject(tagStub(value), (instance) =>
    (instance as unknown as MeasuredTagInstance).completeG43SqlMeasurement());
  return { page, snapshot };
}

function assertSourceMeasurement(snapshot: G43SqlMeasurementSnapshot, returned: number): void {
  expect(snapshot.rowsRead).toBeLessThanOrEqual(returned + SOURCE_ROW_OVERHEAD);
  expect(snapshot.statements.some((statement) => statement.includes("FROM tag_event"))).toBe(true);
  expect(snapshot.statements.some((statement) => statement.includes("FROM tag_identity"))).toBe(true);
  expect(snapshot.statements.some((statement) => statement.includes("FROM tag_control"))).toBe(true);
  expect(snapshot.statements.some((statement) => statement.includes("FROM tag_head"))).toBe(true);
}

function assertSourceRowsAtAllHistories(rows: readonly { readonly historySize: number; readonly rowsRead: number; readonly returned: number }[]): void {
  expect(rows.map((row) => row.historySize)).toEqual([1, 10, 100, 1000, 5000]);
  for (const row of rows) {
    expect(row.rowsRead, `history ${row.historySize} must stay bounded by one page plus fixed scalar-head overhead`)
      .toBeLessThanOrEqual(row.returned + SOURCE_ROW_OVERHEAD);
  }
}

describe("SDT-G46 TagStateDO", () => {
  it("committing to TagDurableObject performs zero projector work", async () => {
    const value = scope("g46-commit-no-projection");
    let applyCalls = 0;
    const commitSentinel: TagStateProjector = {
      ...counterProjector("commit-sentinel"),
      apply(state, event) {
        applyCalls += 1;
        return counterProjector("commit-sentinel").apply(state, event);
      },
    };

    configureTagStateProjectorRegistry(new ProjectorRegistry([commitSentinel]));
    try {
      const committed = await SELF.fetch(
        `https://tag.test/tags/${encodeURIComponent(value.serviceId)}/${encodeURIComponent(value.tag)}/append`,
        {
          method: "POST",
          headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: value.serviceId },
          body: JSON.stringify({
            attemptId: "g46-commit-no-projection",
            epoch: 0,
            candidates: [eventFor(value, 1)],
          }),
        },
      );

      expect(committed.status).toBe(201);
      // Projection work is owned exclusively by TagStateDO's read/replay
      // path. A normal Tag commit must only persist its source event state.
      expect(applyCalls).toBe(0);
    } finally {
      configureTagStateProjectorRegistry(DEPLOYED_PROJECTOR_REGISTRY);
    }
  });

  it("does not expose the bounded G43 source adapter through the public tag router", async () => {
    const value = scope("g46-private-source");
    const rejected = await SELF.fetch(
      `https://tag.test/tags/${encodeURIComponent(value.serviceId)}/${encodeURIComponent(value.tag)}/__internal/g46/tag-state-incremental`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TEST_SERVICE_ID_HEADER]: value.serviceId,
          // This is deliberately the same header the direct DO transport
          // carries. A public request must not be able to replay it.
          "x-sdt-g46-source-read": "1",
        },
        body: JSON.stringify({ tag: value.tag, cursor: "", limit: SOURCE_PAGE_LIMIT }),
      },
    );
    expect(rejected.status).toBe(404);
  });

  it("uses the actual private Tag DO G43 source after the public router rejects that path", async () => {
    const value = scope("g46-real-source");
    const events = await seedTagHistory(value, 2);
    const loaded = await readTagStateObject(identity(value));
    expect(loaded.status).toBe(200);
    const body = await result(loaded);
    expect(body.lastSortedUniqueId).toBe(events.at(-1)!.suid);
    expect(decodePayload(body.payload as string).map((entry) => entry.eventId)).toEqual(events.map((event) => event.eventId));
  });

  it("fails typed when a TagState DO isolate lacks the runtime composition registry", async () => {
    const value = scope("g46-registry-required");
    configureTagStateProjectorRegistry(undefined);
    try {
      const unavailable = await readTagStateObject(identity(value));
      expect(unavailable.status).toBe(503);
      expect(await result(unavailable)).toMatchObject({ code: "tag_state_projector_registry_failure" });
    } finally {
      configureTagStateProjectorRegistry(DEPLOYED_PROJECTOR_REGISTRY);
    }
  });

  it("uses the single bounded G43 source adapter for normal deltas and never reads full Tag state", async () => {
    const value = scope("g46-normal");
    const source = sourceHarness([eventFor(value, 1), eventFor(value, 2)]);
    const state = identity(value);
    await installSource(state, source);

    const first = await readTagStateObject(state);
    expect(first.status).toBe(200);
    expect((await result(first)).version).toBe(2);

    source.events.push(eventFor(value, 3));
    const second = await readTagStateObject(state);
    expect(second.status).toBe(200);
    const secondBody = await result(second);
    expect(secondBody.version).toBe(3);
    expect(decodePayload(secondBody.payload as string)).toHaveLength(3);

    expect(source.calls.map((call) => call.path)).toEqual([
      "/__internal/g46/tag-state-incremental",
      "/__internal/g46/tag-state-incremental",
    ]);
    expect(source.calls.map((call) => call.input.cursor)).toEqual(["", eventFor(value, 2).suid]);
  });

  it("freezes the first source frontier and advances a normal delta only after that frontier completes", async () => {
    const value = scope("g46-frontier");
    const source = sourceHarness(Array.from({ length: 65 }, (_unused, index) => eventFor(value, index + 1)));
    const state = identity(value);
    await installSource(state, source);

    const first = await readTagStateObject(state);
    expect(first.status).toBe(503);
    expect((await result(first)).code).toBe("tag_state_rebuild_in_progress");
    expect(source.calls).toHaveLength(1);
    expect(source.calls[0]!.input.through).toBeUndefined();

    source.events.push(eventFor(value, 66));
    const second = await readTagStateObject(state);
    expect(second.status).toBe(200);
    const secondBody = await result(second);
    expect(secondBody.version).toBe(65);
    expect(secondBody.lastSortedUniqueId).toBe(eventFor(value, 65).suid);
    expect(source.calls[1]!.input.through).toBe(eventFor(value, 65).suid);

    const third = await readTagStateObject(state);
    expect(third.status).toBe(200);
    expect((await result(third)).version).toBe(66);
    expect(source.calls[2]!.input.through).toBeUndefined();
  });

  it("replays an author-version mismatch from origin in bounded G43 chunks", async () => {
    const value = scope("g46-version-mismatch");
    const registered = counterProjector("versioned", "1");
    const source = sourceHarness(Array.from({ length: 65 }, (_unused, index) => eventFor(value, index + 1)));
    const state = identity(value, registered.id);

    configureTagStateProjectorRegistry(new ProjectorRegistry([registered]));
    try {
      await installSource(state, source);
      expect((await readTagStateObject(state)).status).toBe(503);
      expect((await readTagStateObject(state)).status).toBe(200);
      const callsBeforeMismatch = source.calls.length;

      await runInDurableObject(tagStateStub(state), (_instance, durableState) => {
        durableState.storage.sql.exec("UPDATE tag_state_cache SET projector_version = '0' WHERE singleton = 1");
      });
      const rebuilding = await readTagStateObject(state);
      expect(rebuilding.status).toBe(503);
      expect((await result(rebuilding)).code).toBe("tag_state_rebuild_in_progress");
      const rebuilt = await readTagStateObject(state);
      expect(rebuilt.status).toBe(200);
      const rebuiltBody = await result(rebuilt);
      expect(rebuiltBody).toMatchObject({ version: 65, projectorVersion: "1" });
      expect(decodeJsonPayload(rebuiltBody.payload as string)).toEqual({
        count: 65,
        entries: source.events.map((event) => event.eventId),
      });

      const replayCalls = source.calls.slice(callsBeforeMismatch);
      expect(replayCalls.map((call) => call.returnedEvents)).toEqual([SOURCE_PAGE_LIMIT, 1]);
      expect(replayCalls[0]!.input).toMatchObject({ cursor: "" });
      expect(replayCalls[0]!.input.through).toBeUndefined();
      expect(replayCalls[1]!.input).toMatchObject({
        cursor: eventFor(value, SOURCE_PAGE_LIMIT).suid,
        through: eventFor(value, 65).suid,
      });
    } finally {
      configureTagStateProjectorRegistry(DEPLOYED_PROJECTOR_REGISTRY);
    }
  });

  it("resumes an after-checkpoint interruption without duplicate or skipped folds", async () => {
    const value = scope("g46-checkpoint");
    const source = sourceHarness(Array.from({ length: 65 }, (_unused, index) => eventFor(value, index + 1)));
    const state = identity(value);
    await installSource(state, source);
    await setCheckpointFault(state, "after-checkpoint");

    const interrupted = await readTagStateObject(state);
    expect(interrupted.status).toBe(503);
    expect((await result(interrupted)).code).toBe("tag_state_rebuild_interrupted");
    expect(source.calls[0]!.returnedEvents).toBe(SOURCE_PAGE_LIMIT);

    await setCheckpointFault(state, undefined);
    const resumed = await readTagStateObject(state);
    expect(resumed.status).toBe(200);
    const body = await result(resumed);
    expect(body.version).toBe(65);
    expect(source.calls[1]!.returnedEvents).toBe(1);
    expect(decodePayload(body.payload as string).map((entry) => entry.eventId)).toEqual(
      source.events.map((event) => event.eventId),
    );
  });

  it("never serves an incomplete replay accumulator as a ready tag state", async () => {
    const value = scope("g46-partial-never-ready");
    const source = sourceHarness(Array.from({ length: 65 }, (_unused, index) => eventFor(value, index + 1)));
    const state = identity(value);
    await installSource(state, source);

    const partial = await readTagStateObject(state);
    expect(partial.status).toBe(503);
    expect(await result(partial)).toMatchObject({ code: "tag_state_rebuild_in_progress" });

    const complete = await readTagStateObject(state);
    expect(complete.status).toBe(200);
    expect((await result(complete)).version).toBe(65);
  });

  it("restarts cleanly when a crash happens immediately before the checkpoint transaction", async () => {
    const beforeValue = scope("g46-before-checkpoint");
    const beforeSource = sourceHarness(Array.from({ length: 65 }, (_unused, index) => eventFor(beforeValue, index + 1)));
    const beforeState = identity(beforeValue);
    await installSource(beforeState, beforeSource);
    await setCheckpointFault(beforeState, "before-checkpoint");
    expect((await readTagStateObject(beforeState)).status).toBe(503);
    await setCheckpointFault(beforeState, undefined);
    expect((await readTagStateObject(beforeState)).status).toBe(503);
    const final = await readTagStateObject(beforeState);
    expect(final.status).toBe(200);
    const finalBody = await result(final);
    expect(finalBody.version).toBe(65);
    expect(beforeSource.calls.slice(0, 2).map((call) => call.returnedEvents)).toEqual([64, 64]);
    expect(decodePayload(finalBody.payload as string)).toHaveLength(65);
  });

  it("recovers from a lost response after a completed checkpoint without publishing a partial state", async () => {
    const lostResponseValue = scope("g46-lost-response");
    const lostResponseSource = sourceHarness([eventFor(lostResponseValue, 1)]);
    const lostResponseState = identity(lostResponseValue);
    await installSource(lostResponseState, lostResponseSource);
    await setCheckpointFault(lostResponseState, "after-checkpoint");
    expect((await readTagStateObject(lostResponseState)).status).toBe(503);
    await setCheckpointFault(lostResponseState, undefined);
    const recovered = await readTagStateObject(lostResponseState);
    expect(recovered.status).toBe(200);
    expect((await result(recovered)).version).toBe(1);
  });

  it("keeps the TagState identity immutable and rebuilds a deleted cache from an empty source", async () => {
    const value = scope("g46-failures");
    const state = identity(value);
    const source = sourceHarness([]);
    await installSource(state, source);
    const empty = await readTagStateObject(state);
    expect(empty.status).toBe(200);
    expect(await result(empty)).toMatchObject({ kind: "ready", version: 0, lastSortedUniqueId: "" });

    const collision = await tagStateStub(state).fetch(new Request("https://tag-state.test/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...state, tag: `${value.tag}-other` }),
    }));
    expect(collision.status).toBe(409);
    expect((await result(collision)).code).toBe("tag_state_identity_conflict");

    await runInDurableObject(tagStateStub(state), (_instance, durableState) => {
      durableState.storage.sql.exec("DELETE FROM tag_state_cache WHERE singleton = 1");
    });
    const rebuilt = await readTagStateObject(state);
    expect(rebuilt.status).toBe(200);
    expect((await result(rebuilt)).version).toBe(0);
  });

  it("reports detected cache corruption as a typed non-success rather than an empty projection", async () => {
    const value = scope("g46-cache-corruption");
    const state = identity(value);
    await installSource(state, sourceHarness([]));
    expect((await readTagStateObject(state)).status).toBe(200);
    await runInDurableObject(tagStateStub(state), (_instance, durableState) => {
      durableState.storage.sql.exec("UPDATE tag_state_cache SET state_json = 'not-json' WHERE singleton = 1");
    });
    const corrupt = await readTagStateObject(state);
    expect(corrupt.status).toBe(409);
    expect((await result(corrupt)).code).toBe("tag_state_cache_corrupt");
  });

  it("reports a source frontier failure as a distinct typed non-success", async () => {
    const sourceFailureValue = scope("g46-source-failure");
    const sourceFailureState = identity(sourceFailureValue);
    await installSource(sourceFailureState, sourceHarness([], { status: 503, body: { code: "source_down" } }));
    const sourceFailure = await readTagStateObject(sourceFailureState);
    expect(sourceFailure.status).toBe(503);
    expect((await result(sourceFailure)).code).toBe("tag_state_source_frontier_failure");
  });

  it("maps a G45 TagIdentityConflict to typed 409 source-frontier failure", async () => {
    const sourceConflictValue = scope("g46-source-conflict");
    const sourceConflictState = identity(sourceConflictValue);
    await installSource(sourceConflictState, sourceHarness([], { status: 409, body: { code: "tag_identity_conflict" } }));
    const sourceConflict = await readTagStateObject(sourceConflictState);
    const sourceConflictBody = await result(sourceConflict);
    expect({ status: sourceConflict.status, body: sourceConflictBody }).toEqual({
      status: 409,
      body: expect.objectContaining({ code: "tag_state_source_frontier_failure" }),
    });
  });

  it("reports a projector registry failure as a distinct typed non-success", async () => {
    const value = scope("g46-registry-failure");
    const reader = new SerializedReadWorker(
      (env as unknown as { TAG: DurableObjectNamespace; TAG_STATE: DurableObjectNamespace }),
      value.serviceId,
      { resolve: () => { throw new Error("registry down"); } } as unknown as ProjectorRegistry,
    );
    const registryFailure = await reader.handle(new Request("https://read.test/api/sekiban/serialized/tag-state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tagStateId: `room:unknown:${TEST_TAG_STATE_PROJECTOR}` }),
    }));
    expect(registryFailure.status).toBe(503);
    expect((await result(registryFailure)).code).toBe("tag_state_projector_registry_failure");
  });

  it("reports an unknown projector as a distinct typed non-success", async () => {
    const value = scope("g46-unknown-projector");
    const state = identity(value);
    const unknown = await readTagStateObject({ ...state, projectorId: "unknown-projector" });
    expect(unknown.status).toBe(404);
    expect((await result(unknown)).code).toBe("tag_state_unknown_projector");
  });

  it("uses the composition-selected projector authority for two independent projectors and accepts unchanged author versions as stale-cache risk", async () => {
    const value = scope("g46-custom-projectors");
    const firstProjector = counterProjector("custom-one");
    const secondProjector = counterProjector("custom-two");
    const registry = new ProjectorRegistry([firstProjector, secondProjector]);
    configureTagStateProjectorRegistry(registry);
    try {
      const source = sourceHarness([eventFor(value, 1)]);
      const firstState = identity(value, firstProjector.id);
      const secondState = identity(value, secondProjector.id);
      await installSource(firstState, source);
      await installSource(secondState, source);

      const reader = new SerializedReadWorker(
        (env as unknown as { TAG: DurableObjectNamespace; TAG_STATE: DurableObjectNamespace }),
        value.serviceId,
        registry,
      );
      const read = async (projectorId: string) => reader.handle(new Request("https://read.test/api/sekiban/serialized/tag-state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tagStateId: `room:${value.tag.slice("room:".length)}:${projectorId}` }),
      }));
      const first = await read(firstProjector.id);
      const second = await read(secondProjector.id);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect((await result(first)).tagPayloadName).toBe("G46custom-one");
      expect((await result(second)).tagPayloadName).toBe("G46custom-two");
      expect(tagStateScopeName(firstState)).not.toBe(tagStateScopeName(secondState));

      // Same author version means the source is not replayed merely because
      // reducer code changes. This is the explicit ADR 7.1 ruling-3 risk.
      let changedReducer = false;
      const staleProjector: TagStateProjector = {
        ...counterProjector("stale-author-version"),
        apply(state, event) {
          const current = state as { count: number; entries: string[] };
          return {
            count: current.count + (changedReducer ? 10 : 1),
            entries: [...current.entries, event.eventId],
          };
        },
      };
      const staleRegistry = new ProjectorRegistry([staleProjector]);
      configureTagStateProjectorRegistry(staleRegistry);
      const staleState = identity(value, staleProjector.id);
      await installSource(staleState, source);
      const initial = await readTagStateObject(staleState);
      expect(initial.status).toBe(200);
      changedReducer = true;
      const reused = await readTagStateObject(staleState);
      expect(reused.status).toBe(200);
      expect((await result(reused)).version).toBe(1);
    } finally {
      configureTagStateProjectorRegistry(DEPLOYED_PROJECTOR_REGISTRY);
    }
  });

  it("measures the real G45 head-facts bounded source seam at every history point and consumes every cursor", async () => {
    const firstPageRows: Array<{ historySize: number; rowsRead: number; returned: number }> = [];
    for (const historySize of [1, 10, 100, 1000, 5000]) {
      const value = scope(`g46-measure-${historySize}`);
      const events = await seedTagHistory(value, historySize);
      const seen: string[] = [];
      let cursor = "";
      let through: string | undefined;
      let complete = false;
      while (!complete) {
        const measured = await measuredSourcePage(value, {
          tag: value.tag,
          cursor,
          limit: SOURCE_PAGE_LIMIT,
          ...(through === undefined ? {} : { through }),
        });
        const { page, snapshot } = measured;
        expect(page.events.map((event) => event.eventId)).toEqual(
          events.filter((event) => event.suid > cursor && (page.through === "" || event.suid <= page.through))
            .slice(0, SOURCE_PAGE_LIMIT).map((event) => event.eventId),
        );
        assertSourceMeasurement(snapshot, page.events.length);
        if (seen.length === 0) firstPageRows.push({ historySize, rowsRead: snapshot.rowsRead, returned: page.events.length });
        seen.push(...page.events.map((event) => event.eventId));
        cursor = page.lastSortableUniqueId;
        through = page.through;
        complete = page.completeThrough !== null;
      }
      expect(seen).toEqual(events.map((event) => event.eventId));
      expect(cursor).toBe(events.at(-1)!.suid);

      const plan = await runInDurableObject(tagStub(value), (_instance, durableState) =>
        durableState.storage.sql.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${TAG_READ_AFTER_THROUGH_SQL}`, "", events.at(-1)!.suid, SOURCE_PAGE_LIMIT).toArray());
      expect(plan.some((row) => /SEARCH\s+tag_event\s+USING\s+(?:COVERING\s+)?INDEX\s+tag_event_suid_idx/i.test(row.detail))).toBe(true);
      expect(plan.some((row) => /SCAN\s+tag_event/i.test(row.detail))).toBe(false);
    }
    assertSourceRowsAtAllHistories(firstPageRows);
  }, 60_000);

  it("rejects an intermediate source-row spike even when the endpoint rows are bounded", () => {
    expect(() => assertSourceRowsAtAllHistories([
      { historySize: 1, rowsRead: 4, returned: 1 },
      { historySize: 10, rowsRead: 13, returned: 10 },
      { historySize: 100, rowsRead: 999, returned: 64 },
      { historySize: 1000, rowsRead: 67, returned: 64 },
      { historySize: 5000, rowsRead: 67, returned: 64 },
    ])).toThrow();
  });
});
