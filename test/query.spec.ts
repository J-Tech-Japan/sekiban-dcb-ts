import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { handleSerializedQuery } from "../packages/dcb-runtime/src/http/SerializedQueryWorker";
import { serviceIdForRequest, TEST_SERVICE_ID_HEADER } from "../packages/dcb-runtime/src/http/testServiceId";
import { createRuntimeWorker, type Env as WorkerEnv, type MaterializedViewRow } from "../packages/dcb-runtime/src/index";
import type { MaterializedViewQueryOptions } from "../packages/dcb-runtime/src/mv/MaterializedViewStore";
import { processDownstreamDelivery } from "../packages/dcb-runtime/src/downstream/DownstreamAdapter";
import { drainTagOutbox } from "../packages/dcb-runtime/src/downstream/OutboxDrain";
import type { DownstreamOutboxMessage, PipelineClock } from "../packages/dcb-runtime/src/downstream/types";
import { pollLiveProjections } from "../packages/dcb-runtime/src/projection/LiveProjectionWorker";
import { TEST_TAG_STATE_PROJECTOR as TEST_PROJECTOR, ProjectorRegistry } from "../packages/dcb-runtime/src/projection/ProjectorRegistry";
import { projectionIdFor } from "../packages/dcb-runtime/src/projection/ProjectionRuntime";
import type { QueryProjectionStore } from "../packages/dcb-runtime/src/query/ProjectionQueryStore";
import { QueryRegistry } from "../packages/dcb-runtime/src/query/QueryRegistry";
import { PostgresEventStore } from "../packages/dcb-runtime/src/store/PostgresEventStore";
import type { StoreProvider } from "../packages/dcb-runtime/src/store/provider";
import type { PipelineStore, ProjectionCheckpoint, StoredEvent } from "../packages/dcb-runtime/src/store/types";
import { G32_FIXTURE_TIMESTAMP, g32EventId, g32Suid } from "./helpers/g32-fixtures";

const SERVICE_ID = "local-test-runtime";
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

function unique(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function base64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function queryRequest(path: "query" | "list-query", body: unknown): Request {
  return new Request(`https://query.test/api/sekiban/serialized/${path}`, {
    method: "POST",
    headers: testServiceHeaders(SERVICE_ID),
    body: JSON.stringify(body),
  });
}

function testServiceHeaders(serviceId: string): HeadersInit {
  return {
    "content-type": "application/json",
    [TEST_SERVICE_ID_HEADER]: serviceId,
  };
}

function testIdentity(tag: string) {
  const parts = tag.split(":");
  return {
    tag,
    tagGroup: parts[0]!,
    tagContent: parts[1]!,
    tagProjector: TEST_PROJECTOR,
  };
}

function checkpoint(tag: string, entries: unknown[], lastSuid: string): ProjectionCheckpoint {
  return {
    serviceId: SERVICE_ID,
    projectionId: projectionIdFor(testIdentity(tag)),
    lastSuid,
    stateJson: JSON.stringify(entries),
    version: entries.length,
    updatedAt: 1,
  };
}

function storedEvent(suid: string, eventId: string, tag: string): StoredEvent {
  return {
    serviceId: SERVICE_ID,
    id: g32EventId(eventId),
    eventId: g32EventId(eventId),
    sortableUniqueId: g32Suid(suid),
    suid: g32Suid(suid),
    payload: JSON.stringify({ forecastId: eventId }),
    tags: [tag],
    eventTags: [tag],
    eventType: "QueryFixtureEvent",
    timestamp: G32_FIXTURE_TIMESTAMP,
    causationId: g32EventId(eventId),
    correlationId: "SerializedCommit",
    executedUser: "SerializedSekibanExecutor",
    provenance: "g32",
    firstArrivedAt: 0,
    lastArrivedAt: 0,
    maxDeliveryLagMs: 0,
    arrivals: [],
  };
}

class FakeQueryStore implements QueryProjectionStore {
  readonly checkpoints = new Map<string, ProjectionCheckpoint>();
  readonly readTimes: number[] = [];
  readonly serviceIds: string[] = [];
  events: StoredEvent[] = [];
  tags: string[] = [];
  lagBoundMs = 0;
  onReadAllEvents: (() => void) | undefined;

  async readAllEvents(serviceId: string): Promise<StoredEvent[]> {
    this.serviceIds.push(serviceId);
    this.onReadAllEvents?.();
    return this.events;
  }

  async currentLagBound(serviceId: string): Promise<number> {
    this.serviceIds.push(serviceId);
    return this.lagBoundMs;
  }

  async listProjectionTags(serviceId: string): Promise<string[]> {
    this.serviceIds.push(serviceId);
    return this.tags;
  }

  async readProjectionCheckpoint(...input: [serviceId: string, projectionId: string]): Promise<ProjectionCheckpoint | undefined> {
    this.serviceIds.push(input[0]);
    return this.checkpoints.get(input[1]);
  }
}

class CountingStoreProvider implements StoreProvider {
  readonly name = "counting-test";
  creates = 0;
  initializes = 0;

  create(): PipelineStore {
    this.creates += 1;
    return {
      initialize: async () => {
        this.initializes += 1;
      },
    } as PipelineStore;
  }
}

class ListPageSpy {
  readonly pages: unknown[] = [];
  readonly rowReads: unknown[] = [];
  initialized = 0;

  async initialize(): Promise<void> {
    this.initialized += 1;
  }

  async queryRows(serviceId: string, viewId: string, options: unknown = {}): Promise<MaterializedViewRow[]> {
    this.rowReads.push({ serviceId, viewId, options });
    return [];
  }

  async readListPage(_serviceId: string, _viewId: string, options: unknown): Promise<{
    rows: readonly MaterializedViewRow[];
    totalCount: number;
    readHead: string;
  }> {
    this.pages.push(options);
    return { rows: [], totalCount: 0, readHead: "" };
  }
}

class FakeMaterializedViewQueryPort {
  readonly calls: Array<{ serviceId: string; viewId: string; options: unknown }> = [];
  initialized = 0;

  constructor(private readonly rows: readonly MaterializedViewRow[]) {}

  async initialize(): Promise<void> {
    this.initialized += 1;
  }

  async queryRows(serviceId: string, viewId: string, options: MaterializedViewQueryOptions = {}): Promise<MaterializedViewRow[]> {
    this.calls.push({ serviceId, viewId, options });
    return [...this.rows];
  }
}

async function expectSection6(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toBe(JSON_CONTENT_TYPE);
  const body = await response.json<Record<string, unknown>>();
  expect(body).toMatchObject({ error: expect.any(String), code });
  expect((body.error as string).length).toBeGreaterThan(0);
  expect(body).not.toHaveProperty("resultJson");
  expect(body).not.toHaveProperty("itemsJson");
  expect(body).not.toHaveProperty("partial");
  expect(body).not.toHaveProperty("writtenEvents");
}

function postgresStore(): PostgresEventStore {
  const url = (env as unknown as WorkerEnv).POSTGRES_URL;
  if (url === undefined) {
    throw new Error("POSTGRES_URL binding is required; run docker compose up --wait postgres");
  }
  return new PostgresEventStore(url);
}

function collectingQueue(messages: DownstreamOutboxMessage[]): Queue<DownstreamOutboxMessage> {
  return {
    async metrics() {
      return { backlogCount: messages.length, backlogBytes: 0 };
    },
    async send(body) {
      messages.push(body);
      return { metadata: { metrics: { backlogCount: messages.length, backlogBytes: 0 } } };
    },
    async sendBatch(batch) {
      for (const entry of batch) {
        messages.push(entry.body);
      }
      return { metadata: { metrics: { backlogCount: messages.length, backlogBytes: 0 } } };
    },
  };
}

describe("SDT-G9 serialized V1 query and list-query", () => {
  it("requires a configured production service identity while allowing only Miniflare test isolation", () => {
    const testServiceId = unique("g9-test-service");
    expect(serviceIdForRequest(new Request("https://query.test/", {
      headers: { [TEST_SERVICE_ID_HEADER]: testServiceId },
    }))).toBe(testServiceId);
    expect(() => serviceIdForRequest(new Request("https://api.example.com/", {
      headers: { [TEST_SERVICE_ID_HEADER]: testServiceId },
    }))).toThrow("SDT_SERVICE_ID is required");
    expect(() => serviceIdForRequest(new Request("https://api.example.com/", {
      headers: { "x-sdt-g11-service-id": "g11-attacker-namespace" },
    }))).toThrow("SDT_SERVICE_ID is required");
    expect(serviceIdForRequest(new Request("https://runtime.internal/", {
      headers: { "x-sdt-g11-service-id": "g11-verification-namespace" },
    }), { allowG11Verification: true })).toBe("g11-verification-namespace");
    expect(serviceIdForRequest(new Request("https://runtime.internal/", {
      headers: { "x-sdt-g11-service-id": "g22-bootstrap-target" },
    }), { allowG11Verification: true })).toBe("g22-bootstrap-target");
  });

  it("uses the server-side SDT_SERVICE_ID for production reads without allowing client headers to override it", async () => {
    const configuredServiceId = unique("g16-deployed-service");
    const store = new FakeQueryStore();
    const response = await handleSerializedQuery(new Request("https://api.example.com/api/sekiban/serialized/query", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sdt-g11-service-id": "g11-client-namespace",
        [TEST_SERVICE_ID_HEADER]: "g9-client-namespace",
      },
      body: JSON.stringify({ queryType: "GetTestCountQuery", queryParamsJson: "{}" }),
    }), { SDT_SERVICE_ID: configuredServiceId }, { store });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ resultJson: JSON.stringify({ count: 0 }) });
    expect(store.serviceIds.length).toBeGreaterThan(0);
    expect(new Set(store.serviceIds)).toEqual(new Set([configuredServiceId]));
    expect(serviceIdForRequest(new Request("https://api.example.com/", {
      headers: { "x-sdt-g11-service-id": "g11-client-namespace" },
    }), { configuredServiceId })).toBe(configuredServiceId);
    expect(() => serviceIdForRequest(new Request("https://api.example.com/"), {
      configuredServiceId: "not valid with spaces",
    })).toThrow("SDT_SERVICE_ID is required");
  });

  it("routes list-query through the selected D1-MV backing and preserves the memory V1 response", async () => {
    const serviceId = unique("g19-backing-service");
    const tag = "test:mv-route";
    const entries = [
      { eventId: g32EventId("z-event"), suid: g32Suid("mv-route-1"), payload: JSON.stringify({ eventId: "z-event", forecastId: "first" }) },
      { eventId: g32EventId("a-event"), suid: g32Suid("mv-route-2"), payload: JSON.stringify({ eventId: "a-event", forecastId: "second" }) },
    ];
    const memory = new FakeQueryStore();
    memory.tags = [tag];
    memory.checkpoints.set(
      checkpoint(tag, entries, entries[1]!.suid).projectionId,
      checkpoint(tag, entries, entries[1]!.suid),
    );
    const rows: MaterializedViewRow[] = entries.map((entry) => ({
      serviceId,
      viewId: TEST_PROJECTOR,
      generation: 0,
      rowKey: entry.eventId,
      value: JSON.parse(entry.payload) as MaterializedViewRow["value"],
      rowVersion: 1,
      sourceSuid: entry.suid,
    }));
    const materializedView = new FakeMaterializedViewQueryPort(rows);
    const body = {
      queryType: "GetTestListQuery",
      queryParamsJson: JSON.stringify({ PageNumber: 1, PageSize: 20 }),
    };
    const memoryResponse = await handleSerializedQuery(new Request("https://query.test/api/sekiban/serialized/list-query", {
      method: "POST",
      headers: testServiceHeaders(serviceId),
      body: JSON.stringify(body),
    }), {}, { store: memory });
    const runtime = createRuntimeWorker({ queryBacking: "d1-mv", materializedViewQueryPort: materializedView });
    if (runtime.fetch === undefined) throw new Error("Runtime worker fetch handler was not composed");
    const fetchHandler = runtime.fetch as unknown as (request: Request, env: WorkerEnv, context: ExecutionContext) => Promise<Response>;
    const mvResponse = await fetchHandler(new Request("https://query.test/api/sekiban/serialized/list-query", {
      method: "POST",
      headers: testServiceHeaders(serviceId),
      body: JSON.stringify(body),
    }), { SDT_SERVICE_ID: "g24-runtime-fixture" } as WorkerEnv, {} as ExecutionContext);

    expect(memoryResponse.status).toBe(200);
    expect(mvResponse.status).toBe(200);
    const memoryListBody = await memoryResponse.json<Record<string, unknown>>();
    const mvListBody = await mvResponse.json<Record<string, unknown>>();
    // This fixture intentionally exercises the legacy queryRows-only D1 port,
    // which has no active-checkpoint head API. The production readListPage
    // port supplies the safe head; the fallback must preserve the shared V1
    // rows/count shape without fabricating one.
    expect(mvListBody).toMatchObject({
      itemsJson: memoryListBody.itemsJson,
      totalCount: memoryListBody.totalCount,
      totalPages: memoryListBody.totalPages,
      currentPage: memoryListBody.currentPage,
      pageSize: memoryListBody.pageSize,
    });
    expect(mvListBody).not.toHaveProperty("readHead");
    const scalarBody = { queryType: "GetTestCountQuery", queryParamsJson: "{}" };
    const memoryScalar = await handleSerializedQuery(new Request("https://query.test/api/sekiban/serialized/query", {
      method: "POST",
      headers: testServiceHeaders(serviceId),
      body: JSON.stringify(scalarBody),
    }), {}, { store: memory });
    const mvScalar = await fetchHandler(new Request("https://query.test/api/sekiban/serialized/query", {
      method: "POST",
      headers: testServiceHeaders(serviceId),
      body: JSON.stringify(scalarBody),
    }), { SDT_SERVICE_ID: "g24-runtime-fixture" } as WorkerEnv, {} as ExecutionContext);
    expect(await mvScalar.json()).toEqual(await memoryScalar.json());
    expect(materializedView.initialized).toBeGreaterThan(0);
    expect(materializedView.calls).toEqual([{
      serviceId,
      viewId: TEST_PROJECTOR,
      options: { limit: null },
    }, {
      serviceId,
      viewId: TEST_PROJECTOR,
      options: { limit: null },
    }]);
  });

  it("pins the exact 5.4/5.5 empty-success shapes and distinguishes unavailable projections", async () => {
    const store = new FakeQueryStore();
    const scalar = await handleSerializedQuery(queryRequest("query", {
      queryType: "GetTestCountQuery",
      queryParamsJson: "{}",
    }), {}, { store });
    expect(scalar.status).toBe(200);
    expect(scalar.headers.get("content-type")).toBe(JSON_CONTENT_TYPE);
    expect(await scalar.json()).toEqual({ resultJson: JSON.stringify({ count: 0 }) });

    const list = await handleSerializedQuery(queryRequest("list-query", {
      queryType: "GetTestListQuery",
      queryParamsJson: "{}",
    }), {}, { store });
    expect(list.status).toBe(200);
    expect(list.headers.get("content-type")).toBe(JSON_CONTENT_TYPE);
    expect(await list.json()).toEqual({
      itemsJson: "[]",
      totalCount: 0,
      totalPages: 0,
      currentPage: 1,
      pageSize: 20,
      readHead: "",
    });

    const disabledRegistry = new QueryRegistry([{
      queryType: "GetTestCountQuery",
      endpoint: "query",
      tagGroup: "test",
      tagProjector: TEST_PROJECTOR,
      enabled: false,
    }]);
    await expectSection6(await handleSerializedQuery(queryRequest("query", {
      queryType: "GetTestCountQuery",
      queryParamsJson: "{}",
    }), {}, { store, registry: disabledRegistry }), 503, "projection_unavailable");

    await expectSection6(await handleSerializedQuery(queryRequest("list-query", {
      queryType: "GetTestListQuery",
      queryParamsJson: "{}",
    }), {}, { store, projectors: new ProjectorRegistry([]) }), 503, "projection_unavailable");
  });

  it("times out exactly at the SafeWindow boundary instead of fabricating an empty success", async () => {
    const store = new FakeQueryStore();
    const tag = "test:wait-boundary";
    const requestedSuid = g32Suid("wait-boundary");
    store.events = [storedEvent(requestedSuid, "wait-event", tag)];
    store.tags = [tag];
    let now = 50_000;
    store.onReadAllEvents = () => { store.readTimes.push(now); };
    const sleeps: number[] = [];

    const response = await handleSerializedQuery(queryRequest("query", {
      queryType: "GetTestCountQuery",
      queryParamsJson: "{}",
      waitForSortableUniqueId: requestedSuid,
    }), {}, {
      store,
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
      pollIntervalMs: 19_999,
    });

    expect(store.readTimes).toEqual([50_000, 69_999]);
    expect(sleeps).toEqual([19_999, 1]);
    expect(now).toBe(70_000);
    await expectSection6(response, 504, "timeout");
  });

  it("returns timeout JSON immediately when the dynamic estimate exceeds the published ceiling", async () => {
    const store = new FakeQueryStore();
    store.lagBoundMs = 120_001;
    const response = await handleSerializedQuery(queryRequest("query", {
      queryType: "GetTestCountQuery",
      queryParamsJson: "{}",
      waitForSortableUniqueId: g32Suid("ceiling"),
    }), {}, { store, now: () => 1_000 });
    const body = await response.clone().json<{ error: string }>();
    await expectSection6(response, 504, "timeout");
    expect(body.error).toContain("Projection did not reach the requested sortableUniqueId");
    expect(body.error).toContain("refresh this read");
    expect(body.error).not.toContain("duplicate events");
  });

  it("keeps list pages SUID-ordered and stable while an unsafe concurrent append arrives", async () => {
    const store = new FakeQueryStore();
    const stableTag = "test:stable-page";
    const unsafeTag = "test:concurrent-page";
    store.tags = [stableTag];
    const stableEntries = [
      { eventId: g32EventId("z-event"), suid: g32Suid("stable-page-1"), payload: JSON.stringify({ forecastId: "one" }) },
      { eventId: g32EventId("m-event"), suid: g32Suid("stable-page-2"), payload: JSON.stringify({ forecastId: "two" }) },
      { eventId: g32EventId("a-event"), suid: g32Suid("stable-page-3"), payload: JSON.stringify({ forecastId: "three" }) },
    ];
    store.checkpoints.set(checkpoint(stableTag, stableEntries, stableEntries[2]!.suid).projectionId,
      checkpoint(stableTag, stableEntries, stableEntries[2]!.suid));

    const first = await handleSerializedQuery(queryRequest("list-query", {
      queryType: "GetTestListQuery",
      queryParamsJson: JSON.stringify({ PageNumber: 1, PageSize: 2 }),
    }), {}, { store });
    expect(first.status).toBe(200);
    const firstBody = await first.json<{ itemsJson: string; totalCount: number; totalPages: number }>();
    expect(firstBody).toMatchObject({ totalCount: 3, totalPages: 2 });

    // The source sees a concurrent append, but SafeWindow has no durable
    // checkpoint for it yet. The second page must stay in the first snapshot.
    store.events.push(storedEvent("concurrent-page-4", "0-event", unsafeTag));
    store.tags.push(unsafeTag);
    const second = await handleSerializedQuery(queryRequest("list-query", {
      queryType: "GetTestListQuery",
      queryParamsJson: JSON.stringify({ PageNumber: 2, PageSize: 2 }),
    }), {}, { store });
    expect(second.status).toBe(200);
    const secondBody = await second.json<{ itemsJson: string; totalCount: number; totalPages: number }>();
    expect(secondBody).toMatchObject({ totalCount: 3, totalPages: 2 });

    const pageOne = JSON.parse(firstBody.itemsJson) as Array<{ forecastId: string }>;
    const pageTwo = JSON.parse(secondBody.itemsJson) as Array<{ forecastId: string }>;
    expect([...pageOne, ...pageTwo].map((item) => item.forecastId)).toEqual(["one", "two", "three"]);
    expect([...pageOne, ...pageTwo].map((item) => item.forecastId)).not.toContain("four");
  });

  it("runs commit through durable projection and every V1 endpoint on Miniflare plus Docker PostgreSQL", async () => {
    const serviceId = unique("g9-query-e2e-service");
    const forecastId = unique("g9-test");
    const tag = `test:${forecastId}`;
    const [tagGroup, tagContent] = tag.split(":");
    const commitResponse = await SELF.fetch("https://query.test/api/sekiban/serialized/commit", {
      method: "POST",
      headers: testServiceHeaders(serviceId),
      body: JSON.stringify({
        version: 1,
        eventCandidates: [{
          payload: base64Json({ forecastId, location: "Tokyo", temperatureC: 21, summary: "SDT-G9" }),
          eventPayloadName: "TestEventCreated",
          tags: [tag],
        }],
        consistencyTags: [],
      }),
    });
    expect(commitResponse.status, await commitResponse.clone().text()).toBe(200);
    expect(commitResponse.headers.get("content-type")).toBe(JSON_CONTENT_TYPE);
    const commitBody = await commitResponse.json<{ writtenEvents: Array<{ id: string; sortableUniqueIdValue: string }> }>();
    const written = commitBody.writtenEvents[0]!;
    expect(written.sortableUniqueIdValue).toEqual(expect.any(String));

    const latest = await SELF.fetch("https://query.test/api/sekiban/serialized/tag-latest-sortable", {
      method: "POST",
      headers: testServiceHeaders(serviceId),
      body: JSON.stringify({ tag }),
    });
    expect(latest.status).toBe(200);
    expect(latest.headers.get("content-type")).toBe(JSON_CONTENT_TYPE);
    expect(await latest.json()).toEqual({ exists: true, lastSortableUniqueId: written.sortableUniqueIdValue });

    const tagState = await SELF.fetch("https://query.test/api/sekiban/serialized/tag-state", {
      method: "POST",
      headers: testServiceHeaders(serviceId),
      body: JSON.stringify({ tagStateId: `${tag}:${TEST_PROJECTOR}` }),
    });
    expect(tagState.status).toBe(200);
    expect(tagState.headers.get("content-type")).toBe(JSON_CONTENT_TYPE);
    expect(await tagState.json()).toMatchObject({
      lastSortedUniqueId: written.sortableUniqueIdValue,
      tagGroup,
      tagContent,
      tagProjector: TEST_PROJECTOR,
    });

    // G32 SafeWindow compares the .NET-tick prefix with the injected clock;
    // retain the real allocation epoch rather than the old synthetic ordinal.
    const clockNow = Date.now();
    const clock: PipelineClock = { now: () => clockNow };
    const queued: DownstreamOutboxMessage[] = [];
    const workerEnv = env as unknown as WorkerEnv;
    expect((await drainTagOutbox({ serviceId, tag }, {
      TAG: workerEnv.TAG,
      DOWNSTREAM_QUEUE: collectingQueue(queued),
    }, clock)).delivered).toBe(1);
    expect(queued).toHaveLength(1);

    const store = postgresStore();
    await store.initialize();
    await processDownstreamDelivery(queued[0]!, { POSTGRES_URL: workerEnv.POSTGRES_URL }, { store, clock });
    await pollLiveProjections(
      { POSTGRES_URL: workerEnv.POSTGRES_URL },
      { store, clock: { now: () => clockNow + 20_000 }, serviceId },
    );

    const scalar = await SELF.fetch("https://query.test/api/sekiban/serialized/query", {
      method: "POST",
      headers: testServiceHeaders(serviceId),
      body: JSON.stringify({
        queryType: "GetTestCountQuery",
        queryParamsJson: "{}",
        waitForSortableUniqueId: written.sortableUniqueIdValue,
      }),
    });
    expect(scalar.status, await scalar.clone().text()).toBe(200);
    expect(scalar.headers.get("content-type")).toBe(JSON_CONTENT_TYPE);
    const scalarBody = await scalar.json<{ resultJson: string }>();
    expect(Object.keys(scalarBody)).toEqual(["resultJson"]);
    expect(JSON.parse(scalarBody.resultJson)).toMatchObject({ count: expect.any(Number) });

    const list = await SELF.fetch("https://query.test/api/sekiban/serialized/list-query", {
      method: "POST",
      headers: testServiceHeaders(serviceId),
      body: JSON.stringify({
        queryType: "GetTestListQuery",
        queryParamsJson: JSON.stringify({ PageNumber: 1, PageSize: 20 }),
        waitForSortableUniqueId: written.sortableUniqueIdValue,
      }),
    });
    expect(list.status, await list.clone().text()).toBe(200);
    expect(list.headers.get("content-type")).toBe(JSON_CONTENT_TYPE);
    const listBody = await list.json<{
      itemsJson: string;
      totalCount: number;
      totalPages: number;
      currentPage: number;
      pageSize: number;
    }>();
    expect(Object.keys(listBody).sort()).toEqual(["currentPage", "itemsJson", "pageSize", "readHead", "totalCount", "totalPages"]);
    expect(JSON.parse(listBody.itemsJson)).toContainEqual(expect.objectContaining({ forecastId }));
    expect(listBody).toMatchObject({ currentPage: 1, pageSize: 20 });

    // If the test accidentally falls back to the production fixed service ID,
    // this exact tag is visible without the Miniflare-only header. That makes
    // the isolation regression observable before the second local run.
    const defaultLatest = await SELF.fetch("https://query.test/api/sekiban/serialized/tag-latest-sortable", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag }),
    });
    expect(defaultLatest.status).toBe(200);
    expect(await defaultLatest.json()).toEqual({ exists: false, lastSortableUniqueId: "" });
  });

  const unsupportedMessage = "The selected query does not support these parameters.";

  function unsupportedSeams() {
    return {
      memory: new FakeQueryStore(),
      provider: new CountingStoreProvider(),
      materializedView: new FakeMaterializedViewQueryPort([]),
    };
  }

  async function refuseAcrossBackings(path: "query" | "list-query", body: unknown) {
    const seams = unsupportedSeams();
    const memoryResponse = await handleSerializedQuery(queryRequest(path, body), {}, { store: seams.memory });
    const providerResponse = await handleSerializedQuery(queryRequest(path, body), {}, { storeProvider: seams.provider });
    const materializedViewResponse = await handleSerializedQuery(queryRequest(path, body), {}, {
      queryBacking: "d1-mv",
      materializedViewQueryPort: seams.materializedView,
    });
    return { seams, memoryResponse, providerResponse, materializedViewResponse };
  }

  async function expectUnsupportedRefusal(path: "query" | "list-query", queryParamsJson: string, leaked: readonly string[]) {
    const queryType = path === "query" ? "GetTestCountQuery" : "GetTestListQuery";
    const observed = await refuseAcrossBackings(path, { queryType, queryParamsJson });
    const responses = [observed.memoryResponse, observed.providerResponse, observed.materializedViewResponse];
    for (const response of responses) {
      expect(response.status).toBe(400);
      const body = await response.json<Record<string, unknown>>();
      expect(body).toEqual({ error: unsupportedMessage, code: "query_params_unsupported" });
      expect(Object.keys(body).sort()).toEqual(["code", "error"]);
      const encoded = JSON.stringify(body);
      for (const fragment of leaked) {
        expect(encoded).not.toContain(fragment);
      }
    }
    expect(observed.seams.memory.serviceIds).toEqual([]);
    expect(observed.seams.provider.creates).toBe(0);
    expect(observed.seams.provider.initializes).toBe(0);
    expect(observed.seams.materializedView.initialized).toBe(0);
    expect(observed.seams.materializedView.calls).toEqual([]);
    return observed;
  }

  function pagedStore() {
    const store = new FakeQueryStore();
    const tag = "test:param-page";
    const entries = [
      { eventId: g32EventId("p-1"), suid: g32Suid("param-page-1"), payload: JSON.stringify({ forecastId: "one" }) },
      { eventId: g32EventId("p-2"), suid: g32Suid("param-page-2"), payload: JSON.stringify({ forecastId: "two" }) },
      { eventId: g32EventId("p-3"), suid: g32Suid("param-page-3"), payload: JSON.stringify({ forecastId: "three" }) },
    ];
    store.tags = [tag];
    const point = checkpoint(tag, entries, g32Suid("param-page-9"));
    store.checkpoints.set(point.projectionId, point);
    return store;
  }

  it("keeps the legacy count for a caller-supplied empty object and whitespace-equivalent JSON", async () => {
    const compactStore = new FakeQueryStore();
    const compact = await handleSerializedQuery(queryRequest("query", {
      queryType: "GetTestCountQuery",
      queryParamsJson: "{}",
    }), {}, { store: compactStore });
    expect(compact.status).toBe(200);
    expect(await compact.json()).toEqual({ resultJson: JSON.stringify({ count: 0 }) });
    expect(compactStore.serviceIds.length).toBeGreaterThan(0);

    const spacedStore = new FakeQueryStore();
    const spaced = await handleSerializedQuery(queryRequest("query", {
      queryType: "GetTestCountQuery",
      queryParamsJson: " \n{ }\t",
    }), {}, { store: spacedStore });
    expect(spaced.status).toBe(200);
    expect(await spaced.json()).toEqual({ resultJson: JSON.stringify({ count: 0 }) });
    expect(spacedStore.serviceIds.length).toBeGreaterThan(0);
  });

  it("refuses a scalar roomId object before projector checks and backing access", async () => {
    await expectUnsupportedRefusal("query", JSON.stringify({ roomId: "room-1" }), ["roomId", "room-1"]);
    const disabledRegistry = new QueryRegistry([{
      queryType: "GetTestCountQuery",
      endpoint: "query",
      tagGroup: "test",
      tagProjector: TEST_PROJECTOR,
      enabled: false,
    }]);
    const store = new FakeQueryStore();
    const disabled = await handleSerializedQuery(queryRequest("query", {
      queryType: "GetTestCountQuery",
      queryParamsJson: JSON.stringify({ roomId: "room-1" }),
    }), {}, { store, registry: disabledRegistry });
    expect(disabled.status).toBe(400);
    expect(await disabled.json()).toEqual({ error: unsupportedMessage, code: "query_params_unsupported" });
    expect(store.serviceIds).toEqual([]);
  });

  it("refuses a scalar array before any backing access", async () => {
    await expectUnsupportedRefusal("query", JSON.stringify(["room-1"]), ["room-1"]);
  });

  it("refuses a scalar string before any backing access", async () => {
    await expectUnsupportedRefusal("query", JSON.stringify("room-1"), ["room-1"]);
  });

  it("refuses a scalar number before any backing access", async () => {
    await expectUnsupportedRefusal("query", "7", ["7"]);
  });

  it("refuses a scalar boolean before any backing access", async () => {
    await expectUnsupportedRefusal("query", "true", []);
  });

  it("refuses scalar null before any backing access", async () => {
    await expectUnsupportedRefusal("query", "null", []);
  });

  it("keeps malformed queryParamsJson on validation_error ahead of parameter policy", async () => {
    const store = new FakeQueryStore();
    const disabledRegistry = new QueryRegistry([{
      queryType: "GetTestCountQuery",
      endpoint: "query",
      tagGroup: "test",
      tagProjector: TEST_PROJECTOR,
      enabled: false,
    }]);
    const response = await handleSerializedQuery(queryRequest("query", {
      queryType: "GetTestCountQuery",
      queryParamsJson: "{",
    }), {}, { store, registry: disabledRegistry });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "queryParamsJson must contain a JSON document",
      code: "validation_error",
    });
    expect(store.serviceIds).toEqual([]);
  });

  it("keeps an endpoint mismatch ahead of unsupported scalar parameters", async () => {
    const store = new FakeQueryStore();
    const response = await handleSerializedQuery(queryRequest("query", {
      queryType: "GetTestListQuery",
      queryParamsJson: JSON.stringify({ roomId: "room-1" }),
    }), {}, { store });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "queryType is not mapped for this endpoint",
      code: "validation_error",
    });
    expect(store.serviceIds).toEqual([]);
  });

  it("accepts each list control and preserves current paging, order, and consistency", async () => {
    const pageNumber = await handleSerializedQuery(queryRequest("list-query", {
      queryType: "GetTestListQuery",
      queryParamsJson: JSON.stringify({ PageNumber: 2, PageSize: 2 }),
    }), {}, { store: pagedStore() });
    expect(pageNumber.status).toBe(200);
    const pageNumberBody = await pageNumber.json<{ itemsJson: string; currentPage: number; pageSize: number; totalCount: number; totalPages: number }>();
    expect(pageNumberBody).toMatchObject({ currentPage: 2, pageSize: 2, totalCount: 3, totalPages: 2 });
    expect(JSON.parse(pageNumberBody.itemsJson)).toEqual([{ forecastId: "three" }]);

    const pageSize = await handleSerializedQuery(queryRequest("list-query", {
      queryType: "GetTestListQuery",
      queryParamsJson: JSON.stringify({ PageSize: 1 }),
    }), {}, { store: pagedStore() });
    expect(pageSize.status).toBe(200);
    const pageSizeBody = await pageSize.json<{ itemsJson: string; currentPage: number; pageSize: number }>();
    expect(pageSizeBody).toMatchObject({ currentPage: 1, pageSize: 1 });
    expect(JSON.parse(pageSizeBody.itemsJson)).toEqual([{ forecastId: "one" }]);

    const newest = await handleSerializedQuery(queryRequest("list-query", {
      queryType: "GetTestListQuery",
      queryParamsJson: JSON.stringify({ NewestFirst: true, PageSize: 2 }),
    }), {}, { store: pagedStore() });
    expect(newest.status).toBe(200);
    const newestBody = await newest.json<{ itemsJson: string }>();
    expect(JSON.parse(newestBody.itemsJson)).toEqual([{ forecastId: "one" }, { forecastId: "two" }]);

    const defaults = await handleSerializedQuery(queryRequest("list-query", {
      queryType: "GetTestListQuery",
      queryParamsJson: "{}",
    }), {}, { store: pagedStore() });
    expect(defaults.status).toBe(200);
    const defaultBody = await defaults.json<{ currentPage: number; pageSize: number; readHead: string; itemsJson: string }>();
    expect(defaultBody).toMatchObject({ currentPage: 1, pageSize: 20, readHead: g32Suid("param-page-9") });
    expect(JSON.parse(defaultBody.itemsJson)).toEqual([
      { forecastId: "one" },
      { forecastId: "two" },
      { forecastId: "three" },
    ]);

    const unsafe = await handleSerializedQuery(queryRequest("list-query", {
      queryType: "GetTestListQuery",
      queryParamsJson: JSON.stringify({ consistency: "unsafe" }),
    }), {}, { store: pagedStore() });
    expect(unsafe.status).toBe(200);
    expect(await unsafe.json()).toMatchObject({
      currentPage: 1,
      pageSize: 20,
      readHead: g32Suid("param-page-3"),
    });

    const combined = await handleSerializedQuery(queryRequest("list-query", {
      queryType: "GetTestListQuery",
      queryParamsJson: JSON.stringify({
        PageNumber: 1,
        PageSize: 1,
        NewestFirst: false,
        consistency: "safe",
      }),
    }), {}, { store: pagedStore() });
    expect(combined.status).toBe(200);
    const combinedBody = await combined.json<{ itemsJson: string; readHead: string; currentPage: number; pageSize: number }>();
    expect(combinedBody).toMatchObject({
      currentPage: 1,
      pageSize: 1,
      readHead: g32Suid("param-page-9"),
    });
    expect(JSON.parse(combinedBody.itemsJson)).toEqual([{ forecastId: "one" }]);

    const descending = new ListPageSpy();
    const ascending = new ListPageSpy();
    const descendingResponse = await handleSerializedQuery(queryRequest("list-query", {
      queryType: "GetTestListQuery",
      queryParamsJson: JSON.stringify({ NewestFirst: true, PageNumber: 1, PageSize: 5 }),
    }), {}, { queryBacking: "d1-mv", materializedViewQueryPort: descending });
    const ascendingResponse = await handleSerializedQuery(queryRequest("list-query", {
      queryType: "GetTestListQuery",
      queryParamsJson: JSON.stringify({ PageNumber: 1, PageSize: 5 }),
    }), {}, { queryBacking: "d1-mv", materializedViewQueryPort: ascending });
    expect(descendingResponse.status).toBe(200);
    expect(ascendingResponse.status).toBe(200);
    expect(descending.initialized).toBe(1);
    expect(ascending.initialized).toBe(1);
    expect(descending.rowReads).toEqual([]);
    expect(ascending.rowReads).toEqual([]);
    expect(descending.pages).toEqual([{
      limit: 5,
      offset: 0,
      descending: true,
      consistency: "safe",
    }]);
    expect(ascending.pages).toEqual([{
      limit: 5,
      offset: 0,
      consistency: "safe",
    }]);
  });

  it("refuses an unknown list business key before any backing access", async () => {
    await expectUnsupportedRefusal("list-query", JSON.stringify({ PageNumber: 1, roomId: "room-1" }), ["roomId", "room-1"]);
  });

  it("treats a differently cased list key as unsupported", async () => {
    await expectUnsupportedRefusal("list-query", JSON.stringify({ pageNumber: 1 }), ["pageNumber"]);
  });

  it("keeps a non-object list document on validation_error", async () => {
    const store = new FakeQueryStore();
    const response = await handleSerializedQuery(queryRequest("list-query", {
      queryType: "GetTestListQuery",
      queryParamsJson: "[]",
    }), {}, { store });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "list-query queryParamsJson must contain an object",
      code: "validation_error",
    });
    expect(store.serviceIds).toEqual([]);
  });

  it("keeps list null on the existing non-object validation_error", async () => {
    const store = new FakeQueryStore();
    const response = await handleSerializedQuery(queryRequest("list-query", {
      queryType: "GetTestListQuery",
      queryParamsJson: "null",
    }), {}, { store });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "list-query queryParamsJson must contain an object",
      code: "validation_error",
    });
    expect(store.serviceIds).toEqual([]);
  });

  it("keeps an invalid recognized list value on validation_error", async () => {
    const store = new FakeQueryStore();
    const response = await handleSerializedQuery(queryRequest("list-query", {
      queryType: "GetTestListQuery",
      queryParamsJson: JSON.stringify({ PageNumber: 0 }),
    }), {}, { store });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "PageNumber and PageSize must be positive integers, NewestFirst must be a boolean, and consistency must be safe or unsafe",
      code: "validation_error",
    });
    expect(store.serviceIds).toEqual([]);
  });
});
