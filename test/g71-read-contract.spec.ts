import { describe, expect, it } from "vitest";

import {
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
import type { QueryProjectionStore } from "../packages/dcb-runtime/src/query/ProjectionQueryStore";
import type { ProjectionCheckpoint } from "../packages/dcb-runtime/src/store/types";
import { tagFamily, type ProjectorLike, type Tag } from "@sekiban/dcb-domain";
import { createV1Transport } from "../samples/meeting-room/src/transport";

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

describe("SDT-G71 published read contract", () => {
  it("uses the durable authority for existence across every published fetch adapter", async () => {
    const rows: readonly [string, unknown, "snapshot" | "error"][] = [
      ["empty string", "", "snapshot"],
      ["absent payload", undefined, "error"],
      ["base64 empty object", base64Json({}), "snapshot"],
      ["raw object", {}, "snapshot"],
      ["raw JSON text", JSON.stringify({ status: "ignored" }), "snapshot"],
      ["base64 sentinel", base64Json({ status: "empty" }), "snapshot"],
    ];
    for (const [name, payload, expected] of rows) {
      for (const [adapterName, makeTransport] of fetchAdapters) {
        const result = await readThroughAdapter(makeTransport, matrixTag, payload, { exists: true, lastSortableUniqueId: "" });
        if (expected === "error") {
          expect(result.error, `${name} via ${adapterName}`).toMatchObject({ code: "invalid_read_snapshot" });
          expect(result.snapshot, `${name} via ${adapterName}`).toBeUndefined();
        } else {
          expect(result.error, `${name} via ${adapterName}`).toBeUndefined();
          expect(result.snapshot?.exists, `${name} via ${adapterName}`).toBe(true);
          expect(result.snapshot?.head, `${name} via ${adapterName}`).toBeNull();
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
});
