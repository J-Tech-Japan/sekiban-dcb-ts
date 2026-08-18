import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { handleSerializedQuery } from "../src/http/SerializedQueryWorker";
import { SERIALIZED_DCB_SERVICE_ID, serviceIdForRequest, TEST_SERVICE_ID_HEADER } from "../src/http/testServiceId";
import type { Env as WorkerEnv } from "../src/index";
import { processDownstreamDelivery } from "../src/downstream/DownstreamAdapter";
import { drainTagOutbox } from "../src/downstream/OutboxDrain";
import type { DownstreamOutboxMessage, PipelineClock } from "../src/downstream/types";
import { pollLiveProjections } from "../src/projection/LiveProjectionWorker";
import { WEATHER_FORECAST_PROJECTOR, ProjectorRegistry } from "../src/projection/ProjectorRegistry";
import { projectionIdFor } from "../src/projection/ProjectionRuntime";
import type { QueryProjectionStore } from "../src/query/ProjectionQueryStore";
import { QueryRegistry } from "../src/query/QueryRegistry";
import { PostgresEventStore } from "../src/store/PostgresEventStore";
import type { ProjectionCheckpoint, StoredEvent } from "../src/store/types";

const SERVICE_ID = "serialized-dcb-v1";
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
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function testServiceHeaders(serviceId: string): HeadersInit {
  return {
    "content-type": "application/json",
    [TEST_SERVICE_ID_HEADER]: serviceId,
  };
}

function weatherIdentity(tag: string) {
  const parts = tag.split(":");
  return {
    tag,
    tagGroup: parts[0]!,
    tagContent: parts[1]!,
    tagProjector: WEATHER_FORECAST_PROJECTOR,
  };
}

function checkpoint(tag: string, entries: unknown[], lastSuid: string): ProjectionCheckpoint {
  return {
    serviceId: SERVICE_ID,
    projectionId: projectionIdFor(weatherIdentity(tag)),
    lastSuid,
    stateJson: JSON.stringify(entries),
    version: entries.length,
    updatedAt: 1,
  };
}

function storedEvent(suid: string, eventId: string, tag: string): StoredEvent {
  return {
    serviceId: SERVICE_ID,
    eventId,
    suid,
    payload: base64Json({ forecastId: eventId }),
    eventTags: [tag],
    firstArrivedAt: 0,
    lastArrivedAt: 0,
    maxDeliveryLagMs: 0,
    arrivals: [],
  };
}

class FakeQueryStore implements QueryProjectionStore {
  readonly checkpoints = new Map<string, ProjectionCheckpoint>();
  readonly readTimes: number[] = [];
  events: StoredEvent[] = [];
  tags: string[] = [];
  lagBoundMs = 0;
  onReadAllEvents: (() => void) | undefined;

  async readAllEvents(): Promise<StoredEvent[]> {
    this.onReadAllEvents?.();
    return this.events;
  }

  async currentLagBound(): Promise<number> {
    return this.lagBoundMs;
  }

  async listProjectionTags(): Promise<string[]> {
    return this.tags;
  }

  async readProjectionCheckpoint(...input: [serviceId: string, projectionId: string]): Promise<ProjectionCheckpoint | undefined> {
    return this.checkpoints.get(input[1]);
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
  it("keeps the production service identity fixed while allowing only Miniflare test isolation", () => {
    const testServiceId = unique("g9-test-service");
    expect(serviceIdForRequest(new Request("https://query.test/", {
      headers: { [TEST_SERVICE_ID_HEADER]: testServiceId },
    }))).toBe(testServiceId);
    expect(serviceIdForRequest(new Request("https://api.example.com/", {
      headers: { [TEST_SERVICE_ID_HEADER]: testServiceId },
    }))).toBe(SERIALIZED_DCB_SERVICE_ID);
  });

  it("pins the exact 5.4/5.5 empty-success shapes and distinguishes unavailable projections", async () => {
    const store = new FakeQueryStore();
    const scalar = await handleSerializedQuery(queryRequest("query", {
      queryType: "GetWeatherForecastCountQuery",
      queryParamsJson: "{}",
    }), {}, { store });
    expect(scalar.status).toBe(200);
    expect(scalar.headers.get("content-type")).toBe(JSON_CONTENT_TYPE);
    expect(await scalar.json()).toEqual({ resultJson: JSON.stringify({ count: 0 }) });

    const list = await handleSerializedQuery(queryRequest("list-query", {
      queryType: "GetWeatherForecastListQuery",
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
    });

    const disabledRegistry = new QueryRegistry([{
      queryType: "GetWeatherForecastCountQuery",
      endpoint: "query",
      tagGroup: "weather",
      tagProjector: WEATHER_FORECAST_PROJECTOR,
      enabled: false,
    }]);
    await expectSection6(await handleSerializedQuery(queryRequest("query", {
      queryType: "GetWeatherForecastCountQuery",
      queryParamsJson: "{}",
    }), {}, { store, registry: disabledRegistry }), 503, "projection_unavailable");

    await expectSection6(await handleSerializedQuery(queryRequest("list-query", {
      queryType: "GetWeatherForecastListQuery",
      queryParamsJson: "{}",
    }), {}, { store, projectors: new ProjectorRegistry([]) }), 503, "projection_unavailable");
  });

  it("times out exactly at the SafeWindow boundary instead of fabricating an empty success", async () => {
    const store = new FakeQueryStore();
    const tag = "weather:wait-boundary";
    const requestedSuid = "suid-00000000000000000000000000000001";
    store.events = [storedEvent(requestedSuid, "wait-event", tag)];
    store.tags = [tag];
    let now = 50_000;
    store.onReadAllEvents = () => { store.readTimes.push(now); };
    const sleeps: number[] = [];

    const response = await handleSerializedQuery(queryRequest("query", {
      queryType: "GetWeatherForecastCountQuery",
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
      queryType: "GetWeatherForecastCountQuery",
      queryParamsJson: "{}",
      waitForSortableUniqueId: "suid-ceiling",
    }), {}, { store, now: () => 1_000 });
    const body = await response.clone().json<{ error: string }>();
    await expectSection6(response, 504, "timeout");
    expect(body.error).toContain("Outcome is undetermined");
    expect(body.error).toContain("reread tag heads and event/query state");
    expect(body.error).toContain("blind retry may create duplicate events");
  });

  it("keeps list pages SUID-ordered and stable while an unsafe concurrent append arrives", async () => {
    const store = new FakeQueryStore();
    const stableTag = "weather:stable-page";
    const unsafeTag = "weather:concurrent-page";
    store.tags = [stableTag];
    const stableEntries = [
      { eventId: "z-event", suid: "suid-00000000000000000000000000000001", payload: base64Json({ forecastId: "one" }) },
      { eventId: "m-event", suid: "suid-00000000000000000000000000000002", payload: base64Json({ forecastId: "two" }) },
      { eventId: "a-event", suid: "suid-00000000000000000000000000000003", payload: base64Json({ forecastId: "three" }) },
    ];
    store.checkpoints.set(checkpoint(stableTag, stableEntries, stableEntries[2]!.suid).projectionId,
      checkpoint(stableTag, stableEntries, stableEntries[2]!.suid));

    const first = await handleSerializedQuery(queryRequest("list-query", {
      queryType: "GetWeatherForecastListQuery",
      queryParamsJson: JSON.stringify({ PageNumber: 1, PageSize: 2 }),
    }), {}, { store });
    expect(first.status).toBe(200);
    const firstBody = await first.json<{ itemsJson: string; totalCount: number; totalPages: number }>();
    expect(firstBody).toMatchObject({ totalCount: 3, totalPages: 2 });

    // The source sees a concurrent append, but SafeWindow has no durable
    // checkpoint for it yet. The second page must stay in the first snapshot.
    store.events.push(storedEvent("suid-00000000000000000000000000000004", "0-event", unsafeTag));
    store.tags.push(unsafeTag);
    const second = await handleSerializedQuery(queryRequest("list-query", {
      queryType: "GetWeatherForecastListQuery",
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
    const forecastId = unique("g9-weather");
    const tag = `weather:${forecastId}`;
    const [tagGroup, tagContent] = tag.split(":");
    const commitResponse = await SELF.fetch("https://query.test/api/sekiban/serialized/commit", {
      method: "POST",
      headers: testServiceHeaders(serviceId),
      body: JSON.stringify({
        version: 1,
        eventCandidates: [{
          payload: base64Json({ forecastId, location: "Tokyo", temperatureC: 21, summary: "SDT-G9" }),
          eventPayloadName: "WeatherForecastCreated",
          tags: [tag],
        }],
        consistencyTags: [{ tag, lastSortableUniqueId: "" }],
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
      body: JSON.stringify({ tagStateId: `${tag}:${WEATHER_FORECAST_PROJECTOR}` }),
    });
    expect(tagState.status).toBe(200);
    expect(tagState.headers.get("content-type")).toBe(JSON_CONTENT_TYPE);
    expect(await tagState.json()).toMatchObject({
      lastSortedUniqueId: written.sortableUniqueIdValue,
      tagGroup,
      tagContent,
      tagProjector: WEATHER_FORECAST_PROJECTOR,
    });

    const clockNow = 1_000_000;
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
        queryType: "GetWeatherForecastCountQuery",
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
        queryType: "GetWeatherForecastListQuery",
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
    expect(Object.keys(listBody).sort()).toEqual(["currentPage", "itemsJson", "pageSize", "totalCount", "totalPages"]);
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
});
