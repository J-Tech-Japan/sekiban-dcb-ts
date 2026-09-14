import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ClientError,
  createHttpTransport,
  createInProcessTransport,
  createSekibanExecutor,
  SerializedDcbClient,
  type ReadonlyTagStateResponse,
  type SerializedDcbTransport,
} from "../packages/dcb-client/src";
import { SerializedReadWorker } from "../packages/dcb-runtime/src/read/SerializedReadWorker";
import { handleSerializedQuery } from "../packages/dcb-runtime/src/http/SerializedQueryWorker";
import { projectionIdFor } from "../packages/dcb-runtime/src/projection/ProjectionRuntime";
import { ProjectorRegistry, projectionEventFromTagEvent, type TagStateProjector } from "../packages/dcb-runtime/src/projection/ProjectorRegistry";
import { TagDurableObject } from "../packages/dcb-runtime/src/tag/TagDurableObject";
import { scopeIdFor } from "../packages/dcb-runtime/src/scope/ScopeName";
import type { QueryProjectionStore } from "../packages/dcb-runtime/src/query/ProjectionQueryStore";
import type { ProjectionCheckpoint } from "../packages/dcb-runtime/src/store/types";
import type { TagRecord } from "../packages/dcb-runtime/src/tag/types";
import {
  command,
  done,
  DomainAuthoringError,
  event,
  projector as defineProjector,
  read,
  stateUnion,
  tagFamily,
  type ProjectorLike,
  type SnapshotReader,
  type Tag,
} from "@sekiban/dcb-domain";
import { createV1Transport } from "../samples/meeting-room/src/transport";
import { createRoomCommand } from "../samples/meeting-room/src/domain";
import { g32EventId, g32Suid, G32_FIXTURE_TIMESTAMP } from "./helpers/g32-fixtures";

const tags = tagFamily("g71");
const matrixTag = tags.of("matrix");
const projector: ProjectorLike = {
  id: "G71MatrixProjector",
  version: 1,
  tag: tags,
  initialState: { status: "empty", value: null },
  subscribes: () => true,
  apply: (state) => state,
};

const g86ReadTag = tags.of("g86-read");
const g86Recorded = event("G86ReadRecorded", z.object({ value: z.string() }), { tags: () => [g86ReadTag] });
const g86ReadProjector = defineProjector({
  id: "G86ReadProjector",
  tag: tags,
  events: [g86Recorded],
  state: stateUnion(z.object({ status: z.string() }), { initial: { status: "empty" } }),
  handlers: { G86ReadRecorded: (state) => state },
});
const g86ReadCommand = command({
  id: "g86-read-command",
  input: z.object({ value: z.string() }),
  reads: () => read(g86ReadProjector, g86ReadTag),
  handle: async (input, context) => {
    await context.state(g86ReadProjector, g86ReadTag);
    context.append(g86Recorded, g86Recorded.make({ value: input.value }));
    return done();
  },
});

function base64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stateResponse(tag: Tag, payload: unknown, head = ""): ReadonlyTagStateResponse {
  return {
    payload: payload as ReadonlyTagStateResponse["payload"],
    version: head.length === 0 ? 0 : 1,
    lastSortedUniqueId: head,
    tagGroup: tag.group,
    tagContent: tag.value,
    tagProjector: projector.id,
    tagPayloadName: `${projector.id}State`,
    projectorVersion: String(projector.version),
  };
}

function transportWith(
  authority: SerializedDcbTransport["readTagLatestSortable"],
  state: SerializedDcbTransport["readTagState"],
): SerializedDcbTransport {
  return {
    readTagLatestSortable: authority,
    readTagState: state,
    commit: async () => ({ status: 200, body: {} }),
    query: async () => ({ status: 200, body: { resultJson: "{}" } }),
    listQuery: async () => ({
      status: 200,
      body: { itemsJson: "[]", totalCount: 0, totalPages: 0, currentPage: 1, pageSize: 20, readHead: "" },
    }),
  };
}

type FetchAdapterFactory = (fetcher: typeof fetch) => SerializedDcbTransport;

const fetchAdapters: readonly [string, FetchAdapterFactory][] = [
  ["http transport", (fetcher) => createHttpTransport({ baseUrl: "https://g71.test", fetch: fetcher })],
  ["sample V1 fetch transport", (fetcher) => createV1Transport({ fetch: fetcher })],
  ["in-process transport", (fetcher) => createInProcessTransport({ fetch: fetcher })],
  ["exported SerializedDcbClient", (fetcher) => new SerializedDcbClient("https://g71.test", fetcher)],
];

function requestBody(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("request body was not an object");
  return value as Record<string, unknown>;
}

async function readThroughAdapter(
  makeTransport: FetchAdapterFactory,
  tag: Tag,
  payload: unknown,
  authority: { readonly exists: boolean; readonly lastSortableUniqueId: string },
  stateHead = authority.lastSortableUniqueId,
): Promise<{ readonly snapshot?: Awaited<ReturnType<ReturnType<typeof createSekibanExecutor>["readState"]>>; readonly calls: readonly string[]; readonly error?: unknown }> {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const requestValue = input instanceof Request ? input : new Request(input, init);
    const path = new URL(requestValue.url).pathname;
    calls.push(path);
    const body = requestValue.method === "POST" ? requestBody(await requestValue.clone().json()) : {};
    if (path.endsWith("/tag-latest-sortable")) return response(authority);
    if (path.endsWith("/tag-state")) {
      expect(body.tagStateId).toBe(`${tag.id}:${projector.id}`);
      return response(stateResponse(tag, payload, stateHead));
    }
    return response({ code: "not_found", error: "unexpected path" }, 404);
  };
  const executor = createSekibanExecutor(makeTransport(fetcher));
  try {
    return { snapshot: await executor.readState(projector, tag), calls };
  } catch (error) {
    return { error, calls };
  }
}

function runtimeTagStorage(): DurableObjectStorage {
  const values = new Map<string, unknown>();
  const transaction: DurableObjectTransaction = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => { values.set(key, value); },
    delete: async (key: string) => values.delete(key),
    list: async () => new Map(),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  } as unknown as DurableObjectTransaction;
  return {
    get: transaction.get,
    put: transaction.put,
    delete: transaction.delete,
    deleteAll: async () => { values.clear(); },
    list: transaction.list,
    setAlarm: transaction.setAlarm,
    deleteAlarm: transaction.deleteAlarm,
    transaction: async <T>(callback: (txn: DurableObjectTransaction) => Promise<T>) => callback(transaction),
  } as unknown as DurableObjectStorage;
}

interface RuntimeTagFixture {
  readonly namespace: DurableObjectNamespace;
  readonly stub: (serviceId: string, tag: string) => DurableObjectStub;
}

function runtimeTagFixture(): RuntimeTagFixture {
  const objects = new Map<string, TagDurableObject>();
  const namespace = {
    idFromName(name: string): DurableObjectId {
      return { toString: () => name } as unknown as DurableObjectId;
    },
    get(id: DurableObjectId): DurableObjectStub {
      const key = id.toString();
      let object = objects.get(key);
      if (object === undefined) {
        const storage = runtimeTagStorage();
        object = new TagDurableObject({ storage, waitUntil: () => {} } as unknown as DurableObjectState, {} as never);
        objects.set(key, object);
      }
      return { fetch: (request: Request) => object!.fetch(request) } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
  return {
    namespace,
    stub(serviceId, tag) {
      return namespace.get(scopeIdFor(namespace, { serviceId, doClass: "tag", identity: tag }));
    },
  };
}

const integrationProjector: ProjectorLike = {
  id: "G71IntegrationProjector",
  version: 1,
  tag: tags,
  initialState: { status: "empty", value: null },
  subscribes: (eventType) => eventType === "G71Accepted",
  apply: (state) => state,
};

function integrationState(value: unknown): { readonly status: string; readonly value: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("G71 integration state must be an object");
  }
  return value as { readonly status: string; readonly value: unknown };
}

const integrationRuntimeProjector: TagStateProjector = {
  id: integrationProjector.id,
  tagPayloadName: "G71IntegrationProjectorState",
  projectorVersion: "1",
  initialState: () => ({ status: "empty", value: null }),
  apply: (state, event) => event.eventType === "G71Accepted"
    ? { status: "accepted", value: (JSON.parse(event.payload) as { readonly value: unknown }).value }
    : state,
  serializeState: (state) => JSON.stringify(integrationState(state)),
  deserializeState: (serialized) => integrationState(JSON.parse(serialized)),
  payload: (state) => base64Json(integrationState(state)),
  version: (state) => integrationState(state).status === "empty" ? 0 : 1,
};

interface RuntimeReadFixture {
  readonly serviceId: string;
  readonly tagRuntime: RuntimeTagFixture;
  readonly reader: SerializedReadWorker;
  readonly fetch: typeof fetch;
  readonly stateReads: () => number;
}

function runtimeReadFixture(): RuntimeReadFixture {
  const serviceId = "g11-g71-runtime";
  const tagRuntime = runtimeTagFixture();
  let stateReadCount = 0;
  const tagStateNamespace = {
    idFromName(name: string): DurableObjectId {
      return { toString: () => name } as unknown as DurableObjectId;
    },
    get(): DurableObjectStub {
      return {
        fetch: async (request: Request) => {
          stateReadCount += 1;
          const body = await request.json() as { readonly serviceId: string; readonly tag: string; readonly projectorId: string };
          if (body.projectorId !== integrationRuntimeProjector.id) {
            return response({ code: "tag_state_unknown_projector", error: "unknown projector" }, 404);
          }
          const tagResponse = await tagRuntime.stub(body.serviceId, body.tag).fetch(new Request(
            `https://runtime.internal/state?__tag=${encodeURIComponent(body.tag)}&__serviceId=${encodeURIComponent(body.serviceId)}`,
          ));
          if (tagResponse.status !== 200) return tagResponse;
          const record = await tagResponse.json() as TagRecord;
          let state = integrationRuntimeProjector.initialState();
          for (const event of record.events) {
            state = integrationRuntimeProjector.apply(state, projectionEventFromTagEvent(event));
          }
          return response({
            kind: "ready",
            payload: integrationRuntimeProjector.payload(state),
            version: integrationRuntimeProjector.version(state),
            lastSortedUniqueId: record.head,
            tagGroup: body.tag.split(":")[0],
            tagContent: body.tag.split(":")[1],
            tagProjector: integrationRuntimeProjector.id,
            tagPayloadName: integrationRuntimeProjector.tagPayloadName,
            projectorVersion: integrationRuntimeProjector.projectorVersion,
          });
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
  const reader = new SerializedReadWorker(
    { TAG: tagRuntime.namespace, TAG_STATE: tagStateNamespace },
    serviceId,
    new ProjectorRegistry([integrationRuntimeProjector]),
  );
  const fetcher: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path.endsWith("/tag-latest-sortable") || path.endsWith("/tag-state")) return reader.handle(request);
    return response({ code: "not_found", error: `unexpected runtime path ${path}` }, 404);
  };
  return { serviceId, tagRuntime, reader, fetch: fetcher, stateReads: () => stateReadCount };
}

async function appendRuntimeTag(
  fixture: RuntimeReadFixture,
  tag: Tag,
  eventType: "G71Accepted" | "G71Ignored",
  value: string,
  ordinal: number,
): Promise<string> {
  const suid = g32Suid(`g71-runtime-${ordinal}`);
  const result = await fixture.tagRuntime.stub(fixture.serviceId, tag.id).fetch(new Request(
    `https://runtime.internal/append?__tag=${encodeURIComponent(tag.id)}&__serviceId=${encodeURIComponent(fixture.serviceId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        attemptId: `g71-runtime-attempt-${ordinal}`,
        epoch: 0,
        candidates: [{
          eventId: g32EventId(`g71-runtime-event-${ordinal}`),
          suid,
          payload: JSON.stringify({ value }),
          eventTags: [tag.id],
          eventType,
          provenance: "g32",
          timestamp: G32_FIXTURE_TIMESTAMP,
          allocatorLineageId: "g71-runtime-lineage",
        }],
      }),
    },
  ));
  if (result.status !== 201) throw new Error(`G71 runtime append failed with ${result.status}`);
  return suid;
}

describe("SDT-G71 published read contract", () => {
  it("uses the durable authority for existence across every published fetch adapter", async () => {
    const rows: readonly [string, unknown, "snapshot" | "error", unknown][] = [
      ["empty string", "", "snapshot", ""],
      ["absent payload", undefined, "error", undefined],
      ["base64 empty object", base64Json({}), "snapshot", {}],
      ["raw object", {}, "snapshot", {}],
      ["raw JSON text", JSON.stringify({ status: "ignored" }), "snapshot", { status: "ignored" }],
      ["base64 sentinel", base64Json({ status: "empty" }), "snapshot", projector.initialState],
    ];
    for (const [name, payload, expected, expectedState] of rows) {
      for (const [adapterName, makeTransport] of fetchAdapters) {
        const result = await readThroughAdapter(makeTransport, matrixTag, payload, { exists: true, lastSortableUniqueId: "" });
        if (expected === "error") {
          expect(result.error, `${name} via ${adapterName}`).toMatchObject({ code: "invalid_read_snapshot" });
          expect(result.snapshot, `${name} via ${adapterName}`).toBeUndefined();
        } else {
          expect(result.error, `${name} via ${adapterName}`).toBeUndefined();
          expect(result.snapshot?.exists, `${name} via ${adapterName}`).toBe(true);
          expect(result.snapshot?.head, `${name} via ${adapterName}`).toBeNull();
          expect(result.snapshot?.state, `${name} via ${adapterName}`).toEqual(expectedState);
        }
        expect(result.calls, `${name} via ${adapterName}`).toEqual([
          "/api/sekiban/serialized/tag-latest-sortable",
          "/api/sekiban/serialized/tag-state",
        ]);
      }
    }
  });

  it("keeps an authoritative absence distinct and short-circuits tag-state", async () => {
    let stateCalls = 0;
    const executor = createSekibanExecutor(transportWith(
      async () => ({ exists: false, lastSortableUniqueId: "" }),
      async () => {
        stateCalls += 1;
        return stateResponse(matrixTag, base64Json({ shouldNot: "be read" }));
      },
    ));
    await expect(executor.readState(projector, matrixTag)).resolves.toMatchObject({
      exists: false,
      head: null,
      state: projector.initialState,
    });
    await expect(executor.exists(matrixTag)).resolves.toMatchObject({ exists: false, head: null });
    expect(stateCalls).toBe(0);
  });

  it("linearizes an authoritative absence before a concurrent first append", async () => {
    let authorityCalls = 0;
    let stateCalls = 0;
    const executor = createSekibanExecutor(transportWith(
      async () => {
        authorityCalls += 1;
        return authorityCalls === 1
          ? { exists: false, lastSortableUniqueId: "" }
          : { exists: true, lastSortableUniqueId: "suid-first-append" };
      },
      async () => {
        stateCalls += 1;
        return stateResponse(matrixTag, base64Json({ status: "created" }), "suid-first-append");
      },
    ));
    await expect(executor.readState(projector, matrixTag)).resolves.toMatchObject({ exists: false, head: null });
    await expect(executor.exists(matrixTag)).resolves.toMatchObject({ exists: true, head: "suid-first-append" });
    expect(stateCalls).toBe(0);
  });

  it("retains an existing empty object, ignored-event state, and sentinel state as existing", async () => {
    const cases: readonly [string, unknown, string, unknown][] = [
      ["empty object", base64Json({}), "", {}],
      ["projector ignores event", base64Json({ status: "empty" }), "g71-event", projector.initialState],
      ["sentinel with empty head", base64Json({ status: "empty" }), "", projector.initialState],
    ];
    for (const [name, payload, head, expectedState] of cases) {
      const executor = createSekibanExecutor(transportWith(
        async () => ({ exists: true, lastSortableUniqueId: head }),
        async () => stateResponse(matrixTag, payload, head),
      ));
      const result = await executor.readState(projector, matrixTag);
      expect(result.exists, name).toBe(true);
      expect(result.head, name).toBe(head.length === 0 ? null : head);
      expect(result.state, name).toEqual(expectedState);
    }
  });

  it("does not suppress authority failures and reports a missing capability", async () => {
    const failing = createSekibanExecutor(transportWith(
      async () => ({ status: 503, body: { code: "authority_unavailable", error: "authority unavailable" } }),
      async () => stateResponse(matrixTag, base64Json({})),
    ));
    await expect(failing.readState(projector, matrixTag)).rejects.toMatchObject({ code: "authority_unavailable", status: 503 });
    await expect(failing.exists(matrixTag)).rejects.toMatchObject({ code: "authority_unavailable", status: 503 });

    const withCapability = transportWith(async () => ({ exists: true, lastSortableUniqueId: "" }), async () => stateResponse(matrixTag, base64Json({})));
    const withoutAuthority = { ...withCapability, readTagLatestSortable: undefined };
    const unsupported = createSekibanExecutor(withoutAuthority);
    await expect(unsupported.readState(projector, matrixTag)).rejects.toMatchObject({ code: "unsupported_capability", status: 501 });
    await expect(unsupported.exists(matrixTag)).rejects.toMatchObject({ code: "unsupported_capability", status: 501 });
  });

  it("SDT-G86 AC3: classifies a failure raised while execute reads through the shared table", async () => {
    const readyState = (): ReadonlyTagStateResponse => ({
      ...stateResponse(g86ReadTag, base64Json({ status: "ready" }), ""),
      tagProjector: g86ReadProjector.id,
    });
    const cases: readonly {
      readonly name: string;
      readonly authority?: SerializedDcbTransport["readTagLatestSortable"];
      readonly state?: SerializedDcbTransport["readTagState"];
      readonly snapshots?: SnapshotReader;
      readonly expected: { readonly kind: string; readonly code: string; readonly status?: number };
      readonly calls: readonly string[];
    }[] = [
      {
        name: "read-through without the authority capability",
        authority: undefined,
        expected: { kind: "invalid", code: "unsupported_capability", status: 501 },
        calls: [],
      },
      {
        name: "authority 503 without a code",
        authority: async () => ({ status: 503, body: { error: "authority down" } }),
        expected: { kind: "unavailable", code: "projection_unavailable", status: 503 },
        calls: ["authority"],
      },
      {
        name: "authority reply carrying authority_unavailable",
        authority: async () => ({ status: 503, body: { code: "authority_unavailable", error: "authority unavailable" } }),
        expected: { kind: "transport", code: "authority_unavailable", status: 503 },
        calls: ["authority"],
      },
      {
        name: "thrown transport failure during the authority read",
        authority: async () => { throw new TypeError("fetch failed"); },
        expected: { kind: "transport", code: "transport" },
        calls: ["authority"],
      },
      {
        name: "tag-state 503 without a code",
        state: async () => ({ status: 503, body: { error: "state down" } }),
        expected: { kind: "unavailable", code: "projection_unavailable", status: 503 },
        calls: ["authority", "tag-state"],
      },
      {
        name: "supplied SnapshotReader raising read_unavailable",
        snapshots: { read: () => { throw new ClientError("read_unavailable", "reader did not converge", { status: 503 }); } },
        expected: { kind: "unavailable", code: "read_unavailable", status: 503 },
        calls: [],
      },
      {
        name: "supplied SnapshotReader throwing a plain error",
        snapshots: { read: () => { throw new Error("reader exploded"); } },
        expected: { kind: "transport", code: "transport" },
        calls: [],
      },
    ];
    for (const testCase of cases) {
      const calls: string[] = [];
      const hasAuthority = !("authority" in testCase) || testCase.authority !== undefined;
      const transport: SerializedDcbTransport = {
        ...transportWith(
          async (request, signal) => {
            calls.push("authority");
            return testCase.authority === undefined ? { exists: true, lastSortableUniqueId: "" } : testCase.authority(request, signal);
          },
          async (request, signal) => {
            calls.push("tag-state");
            return testCase.state === undefined ? readyState() : testCase.state(request, signal);
          },
        ),
        commit: async () => {
          calls.push("commit");
          return { status: 200, body: {} };
        },
      };
      const executor = createSekibanExecutor(hasAuthority ? transport : { ...transport, readTagLatestSortable: undefined });
      const result = await executor.execute(g86ReadCommand, { value: "x" }, testCase.snapshots === undefined ? {} : { snapshots: testCase.snapshots });
      expect({ kind: result.kind, code: result.code, status: result.status }, testCase.name).toEqual(testCase.expected);
      expect(calls, testCase.name).toEqual(testCase.calls);
    }

    const noCalls: string[] = [];
    const quiet = createSekibanExecutor({
      ...transportWith(async () => { noCalls.push("authority"); return { exists: true, lastSortableUniqueId: "" }; }, async () => { noCalls.push("tag-state"); return readyState(); }),
      commit: async () => { noCalls.push("commit"); return { status: 200, body: {} }; },
    });
    await expect(quiet.execute(g86ReadCommand, { value: "x" }, { snapshots: [], readMode: "snapshot-only" })).resolves.toMatchObject({ kind: "invalid", code: "executor.snapshot_missing" });
    await expect(quiet.execute(g86ReadCommand, { value: 42 } as never)).resolves.toMatchObject({ kind: "invalid", code: "invalid_command_input" });
    const authoring = command({
      id: "g86-authoring-error",
      input: z.object({}),
      reads: () => read(g86ReadProjector, g86ReadTag),
      handle: () => { throw new DomainAuthoringError("G86_HANDLER_AUTHORING", "handler authoring failed"); },
    });
    await expect(quiet.execute(authoring, {}, { snapshots: [], readMode: "snapshot-only" })).resolves.toMatchObject({ kind: "invalid", code: "executor.snapshot_missing" });
    await expect(quiet.execute(authoring, {})).resolves.toMatchObject({ kind: "invalid", code: "domain_authoring_error", error: "G86_HANDLER_AUTHORING" });
    const undeclared = command({
      id: "g86-undeclared-read",
      input: z.object({}),
      reads: () => read(g86ReadProjector, g86ReadTag),
      handle: async (_input, context) => {
        await context.state(g86ReadProjector, tags.of("g86-undeclared"));
        return done();
      },
    });
    await expect(quiet.execute(undeclared, {})).resolves.toMatchObject({ kind: "invalid", code: "domain_authoring_error", error: "UNDECLARED_DYNAMIC_READ" });
    expect(noCalls.filter((call) => call === "commit")).toEqual([]);
  });

  it("bounds authority/frontier reconciliation instead of combining mismatched observations", async () => {
    const authorities = ["g71-head-2", "g71-head-2"];
    const states = ["g71-head-1", "g71-head-2"];
    const recovering = createSekibanExecutor(transportWith(
      async () => ({ exists: true, lastSortableUniqueId: authorities.shift() ?? "g71-head-2" }),
      async () => stateResponse(matrixTag, base64Json({ version: 2 }), states.shift() ?? "g71-head-2"),
    ));
    await expect(recovering.readState(projector, matrixTag)).resolves.toMatchObject({ exists: true, head: "g71-head-2" });

    const stale = createSekibanExecutor(transportWith(
      async () => ({ exists: true, lastSortableUniqueId: "g71-head-2" }),
      async () => stateResponse(matrixTag, base64Json({ version: 1 }), "g71-head-1"),
    ));
    await expect(stale.readState(projector, matrixTag)).rejects.toMatchObject({ code: "read_unavailable", status: 503 });
  });

  it("carries list consistency through every adapter and refuses it elsewhere", async () => {
    const request = {
      queryType: "GetG71ListQuery",
      queryParamsJson: JSON.stringify({ PageNumber: 1, PageSize: 20 }),
    };
    for (const [adapterName, makeTransport] of fetchAdapters) {
      const bodies: Record<string, unknown>[] = [];
      const fetcher: typeof fetch = async (input, init) => {
        const requestValue = input instanceof Request ? input : new Request(input, init);
        bodies.push(requestBody(await requestValue.clone().json()));
        return response({ itemsJson: "[]", totalCount: 0, totalPages: 0, currentPage: 1, pageSize: 20, readHead: "" });
      };
      const executor = createSekibanExecutor(makeTransport(fetcher));
      await expect(executor.listQuery(request, { consistency: "unsafe" })).resolves.toMatchObject({ readHead: "" });
      expect(JSON.parse(String(bodies[0]!.queryParamsJson)).consistency, adapterName).toBe("unsafe");
    }

    const transport = transportWith(async () => ({ exists: true, lastSortableUniqueId: "" }), async () => stateResponse(matrixTag, base64Json({})));
    const executor = createSekibanExecutor(transport);
    await expect(executor.readState(projector, matrixTag, { consistency: "safe" } as never)).rejects.toMatchObject({ code: "unsupported_consistency_mode" });
    await expect(executor.exists(matrixTag, { consistency: "unsafe" } as never)).rejects.toMatchObject({ code: "unsupported_consistency_mode" });
    await expect(executor.query({ queryType: "q", queryParamsJson: JSON.stringify({ consistency: "safe" }) })).rejects.toMatchObject({ code: "unsupported_consistency_mode" });
    await expect(executor.listQuery({ ...request, queryParamsJson: JSON.stringify({ consistency: "unsafe" }) }, { consistency: "safe" })).rejects.toMatchObject({ code: "consistency_conflict" });
    await expect(executor.listQuery({ ...request, queryParamsJson: "not-json" }, { consistency: "safe" })).rejects.toMatchObject({ code: "invalid_query_request" });
  });

  it("keeps refusal, abort, and transport failures distinguishable at the read boundary", async () => {
    const refusal = createSekibanExecutor(transportWith(
      async () => ({ status: 503, body: { code: "authority_unavailable", error: "authority unavailable" } }),
      async () => stateResponse(matrixTag, base64Json({})),
    ));
    await expect(refusal.exists(matrixTag)).rejects.toMatchObject({ code: "authority_unavailable", status: 503 });

    const aborted = createSekibanExecutor(transportWith(
      async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); },
      async () => stateResponse(matrixTag, base64Json({})),
    ));
    await expect(aborted.exists(matrixTag)).rejects.toMatchObject({ code: "aborted" });

    const transportFailure = createSekibanExecutor(transportWith(
      async () => { throw new Error("connection lost"); },
      async () => stateResponse(matrixTag, base64Json({})),
    ));
    await expect(transportFailure.exists(matrixTag)).rejects.toMatchObject({ code: "transport" });
  });

  it("reports operation-specific list heads without fabricating a generic-query head", async () => {
    const tag = "test:g71-head";
    const projectionIdentity = {
      tag,
      tagGroup: "test",
      tagContent: "g71-head",
      tagProjector: "test-projector",
    };
    const checkpoint: ProjectionCheckpoint = {
      serviceId: "g71-head-service",
      projectionId: projectionIdFor(projectionIdentity),
      lastSuid: "g71-head-2",
      stateJson: JSON.stringify([
        { eventId: "event-1", suid: "g71-head-1", payload: JSON.stringify({ value: 1 }) },
        { eventId: "event-2", suid: "g71-head-2", payload: JSON.stringify({ value: 2 }) },
      ]),
      version: 2,
      updatedAt: 1,
    };
    const store: QueryProjectionStore = {
      readAllEvents: async () => [],
      currentLagBound: async () => 0,
      listProjectionTags: async () => [tag],
      readProjectionCheckpoint: async (_serviceId, projectionId) => projectionId === checkpoint.projectionId ? checkpoint : undefined,
    };
    const request = (consistency: "safe" | "unsafe") => new Request("https://g71.test/api/sekiban/serialized/list-query", {
      method: "POST",
      headers: { "content-type": "application/json", "x-sdt-g11-service-id": "g71-head-service" },
      body: JSON.stringify({
        queryType: "GetTestListQuery",
        queryParamsJson: JSON.stringify({ PageNumber: 1, PageSize: 1, consistency }),
      }),
    });
    const safe = await handleSerializedQuery(request("safe"), {}, { store });
    const unsafe = await handleSerializedQuery(request("unsafe"), {}, { store });
    expect(await safe.json()).toMatchObject({ readHead: "g71-head-2", totalCount: 2, totalPages: 2 });
    expect(await unsafe.json()).toMatchObject({ readHead: "g71-head-1", totalCount: 2, totalPages: 2 });
  });

  it("uses one checkpoint observation for memory page rows and its safe head", async () => {
    const tag = "test:g71-atomic-page";
    const identity = {
      tag,
      tagGroup: "test",
      tagContent: "g71-atomic-page",
      tagProjector: "test-projector",
    };
    const first = {
      serviceId: "g71-atomic-service",
      projectionId: projectionIdFor(identity),
      lastSuid: "g71-head-1",
      stateJson: JSON.stringify([{ eventId: "event-1", suid: "g71-head-1", payload: JSON.stringify({ value: 1 }) }]),
      version: 1,
      updatedAt: 1,
    } satisfies ProjectionCheckpoint;
    const later = { ...first, lastSuid: "g71-head-2", version: 2, updatedAt: 2 };
    let checkpointReads = 0;
    const store: QueryProjectionStore = {
      readAllEvents: async () => [],
      currentLagBound: async () => 0,
      listProjectionTags: async () => [tag],
      readProjectionCheckpoint: async () => {
        checkpointReads += 1;
        return checkpointReads === 1 ? first : later;
      },
    };
    const page = await handleSerializedQuery(new Request("https://g71.test/api/sekiban/serialized/list-query", {
      method: "POST",
      headers: { "content-type": "application/json", "x-sdt-g11-service-id": "g71-atomic-service" },
      body: JSON.stringify({
        queryType: "GetTestListQuery",
        queryParamsJson: JSON.stringify({ PageNumber: 1, PageSize: 1, consistency: "safe" }),
      }),
    }), {}, { store });
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({
      itemsJson: JSON.stringify([{ value: 1 }]),
      totalCount: 1,
      readHead: "g71-head-1",
    });
    expect(checkpointReads).toBe(1);
  });

  it("carries an empty checkpoint head even when the page contains no rows", async () => {
    const tag = "test:g71-empty-page";
    const identity = {
      tag,
      tagGroup: "test",
      tagContent: "g71-empty-page",
      tagProjector: "test-projector",
    };
    const store: QueryProjectionStore = {
      readAllEvents: async () => [],
      currentLagBound: async () => 0,
      listProjectionTags: async () => [tag],
      readProjectionCheckpoint: async () => ({
        serviceId: "g71-empty-service",
        projectionId: projectionIdFor(identity),
        lastSuid: "g71-empty-head",
        stateJson: "[]",
        version: 4,
        updatedAt: 4,
      }),
    };
    const page = await handleSerializedQuery(new Request("https://g71.test/api/sekiban/serialized/list-query", {
      method: "POST",
      headers: { "content-type": "application/json", "x-sdt-g11-service-id": "g71-empty-service" },
      body: JSON.stringify({
        queryType: "GetTestListQuery",
        queryParamsJson: JSON.stringify({ PageNumber: 1, PageSize: 20, consistency: "safe" }),
      }),
    }), {}, { store });
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({ itemsJson: "[]", totalCount: 0, totalPages: 0, readHead: "g71-empty-head" });
  });

  it("keeps generic query headless while preserving list and tag-state heads", async () => {
    const transport = transportWith(
      async () => ({ exists: true, lastSortableUniqueId: "tag-head" }),
      async () => stateResponse(matrixTag, base64Json({}), "tag-head"),
    );
    const executor = createSekibanExecutor({
      ...transport,
      query: async () => ({ status: 200, body: { resultJson: "{}" } }),
      listQuery: async () => ({ status: 200, body: { itemsJson: "[]", totalCount: 0, totalPages: 0, currentPage: 1, pageSize: 20, readHead: "list-head" } }),
    });
    await expect(executor.readState(projector, matrixTag)).resolves.toMatchObject({ head: "tag-head" });
    await expect(executor.listQuery({ queryType: "q", queryParamsJson: "{}" })).resolves.toMatchObject({ readHead: "list-head" });
    const query = await executor.query({ queryType: "q", queryParamsJson: "{}" });
    expect(query).toEqual({ resultJson: "{}" });
    expect(query).not.toHaveProperty("readHead");
  });

  it("derives latest-sortable existence from the durable Tag record even with an empty head", async () => {
    const record = { tag: "g71:durable", head: "", events: [] };
    const namespace = {
      idFromName: () => ({}),
      get: () => ({
        fetch: async () => response(record),
      }),
    } as unknown as DurableObjectNamespace;
    const reader = new SerializedReadWorker({ TAG: namespace }, "g71-runtime");
    const result = await reader.handle(new Request("https://runtime.test/api/sekiban/serialized/tag-latest-sortable", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag: record.tag }),
    }));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ exists: true, lastSortableUniqueId: "" });
  });

  it("drives absent, appended, and ignored real Tag records through every read adapter", async () => {
    const fixture = runtimeReadFixture();
    const absentTag = tags.of("runtime-absent");
    const ignoredTag = tags.of("runtime-ignored");
    const acceptedTag = tags.of("runtime-accepted");
    const ignoredHead = await appendRuntimeTag(fixture, ignoredTag, "G71Ignored", "ignored", 1);
    const acceptedHead = await appendRuntimeTag(fixture, acceptedTag, "G71Accepted", "accepted", 2);

    for (const [adapterName, makeTransport] of fetchAdapters) {
      const transport = makeTransport(fixture.fetch);
      const executor = createSekibanExecutor(transport);
      const stateReadsBeforeAbsence = fixture.stateReads();
      await expect(executor.readState(integrationProjector, absentTag), adapterName).resolves.toMatchObject({
        exists: false,
        head: null,
        state: integrationProjector.initialState,
      });
      expect(fixture.stateReads(), `${adapterName} absent short-circuit`).toBe(stateReadsBeforeAbsence);

      await expect(executor.readState(integrationProjector, ignoredTag), adapterName).resolves.toMatchObject({
        exists: true,
        head: ignoredHead,
        state: integrationProjector.initialState,
      });
      await expect(executor.readState(integrationProjector, acceptedTag), adapterName).resolves.toMatchObject({
        exists: true,
        head: acceptedHead,
        state: { status: "accepted", value: "accepted" },
      });
    }
    // The Tag objects and their event histories are real within this bounded
    // runtime fixture. The tag-state namespace is an explicit local projection
    // substitution: it uses the same durable record and projector contract but
    // does not claim to run a deployed SQLite TagState Durable Object.
    expect(fixture.stateReads()).toBe(8);
  });

  it("exercises a held projection through sample and executor listQuery paths", async () => {
    const fixture = runtimeReadFixture();
    const queryTag = "test:g71-held-projection";
    const queryIdentity = {
      tag: queryTag,
      tagGroup: "test",
      tagContent: "g71-held-projection",
      tagProjector: "test-projector",
    };
    const checkpointState: { value?: ProjectionCheckpoint } = {};
    const queryStore: QueryProjectionStore = {
      readAllEvents: async () => [],
      currentLagBound: async () => 0,
      listProjectionTags: async () => [queryTag],
      readProjectionCheckpoint: async () => checkpointState.value,
    };
    const queryFetch: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/list-query") || path.endsWith("/query")) {
        return handleSerializedQuery(request, { SDT_SERVICE_ID: fixture.serviceId }, { store: queryStore });
      }
      return response({ code: "not_found", error: `unexpected query path ${path}` }, 404);
    };
    const queryAdapters: readonly [string, FetchAdapterFactory][] = [
      ["sample V1 fetch transport", (fetcher) => createV1Transport({ fetch: fetcher }, fixture.serviceId)],
      ["HTTP executor transport", (fetcher) => createHttpTransport({ baseUrl: "https://g71.test", fetch: fetcher })],
      ["in-process executor transport", (fetcher) => createInProcessTransport({ fetch: fetcher }, { serviceId: fixture.serviceId })],
      ["exported SerializedDcbClient", (fetcher) => new SerializedDcbClient("https://g71.test", fetcher)],
    ];
    const request = {
      queryType: "GetTestListQuery",
      queryParamsJson: JSON.stringify({ PageNumber: 1, PageSize: 20 }),
    };
    const list = async (transport: SerializedDcbTransport, consistency: "safe" | "unsafe") => {
      const executor = createSekibanExecutor(transport);
      return executor.listQuery(request, { consistency });
    };

    // A source commit creates the Tag while the projection is deliberately
    // held. Both consistency lanes must report an honest empty page/head.
    const firstHead = await appendRuntimeTag(fixture, tags.of("g71-held-projection"), "G71Accepted", "first", 3);
    for (const [name, makeTransport] of queryAdapters) {
      const transport = makeTransport(queryFetch);
      await expect(list(transport, "safe"), `${name} held safe`).resolves.toMatchObject({ itemsJson: "[]", totalCount: 0, readHead: "" });
      await expect(list(transport, "unsafe"), `${name} held unsafe`).resolves.toMatchObject({ itemsJson: "[]", totalCount: 0, readHead: "" });
    }

    checkpointState.value = {
      serviceId: fixture.serviceId,
      projectionId: projectionIdFor(queryIdentity),
      lastSuid: firstHead,
      stateJson: JSON.stringify([{ eventId: "g71-held-event-1", suid: firstHead, payload: JSON.stringify({ value: "first" }) }]),
      version: 1,
      updatedAt: 1,
    };
    for (const [name, makeTransport] of queryAdapters) {
      const transport = makeTransport(queryFetch);
      await expect(list(transport, "safe"), `${name} projected safe`).resolves.toMatchObject({
        itemsJson: JSON.stringify([{ value: "first" }]),
        totalCount: 1,
        readHead: firstHead,
      });
      await expect(list(transport, "unsafe"), `${name} projected unsafe`).resolves.toMatchObject({
        itemsJson: JSON.stringify([{ value: "first" }]),
        totalCount: 1,
        readHead: firstHead,
      });
    }

    // A second source commit advances the real Tag, but the held checkpoint
    // remains the only page authority. No adapter may pair the old row with a
    // later head, which is the F1 race proof in the deployed-shaped path.
    await appendRuntimeTag(fixture, tags.of("g71-held-projection"), "G71Accepted", "second", 4);
    for (const [name, makeTransport] of queryAdapters) {
      const transport = makeTransport(queryFetch);
      await expect(list(transport, "safe"), `${name} post-commit safe`).resolves.toMatchObject({ readHead: firstHead, totalCount: 1 });
      await expect(list(transport, "unsafe"), `${name} post-commit unsafe`).resolves.toMatchObject({ readHead: firstHead, totalCount: 1 });
    }
  });
});
