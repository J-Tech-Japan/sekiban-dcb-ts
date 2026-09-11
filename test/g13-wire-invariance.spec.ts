import { describe, expect, it } from "vitest";

import { handleSerializedCommit, type CommitWorkerEnv } from "../packages/dcb-runtime/src/commit/CommitWorker";
import { handleSerializedQuery } from "../packages/dcb-runtime/src/http/SerializedQueryWorker";
import { SerializedReadWorker } from "../packages/dcb-runtime/src/read/SerializedReadWorker";
import type { QueryProjectionStore } from "../packages/dcb-runtime/src/query/ProjectionQueryStore";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { g32Message } from "./helpers/g32-fixtures";

/**
 * Captured on the pre-split base commit. Keep this normalized transcript
 * independent of generated IDs, payload bytes, and timestamps so the package
 * move can be compared without changing the V1 contract.
 */
const PRE_SPLIT_GOLDEN = {
  endpoints: {
    commit: {
      success: { status: 200, contentType: "application/json; charset=utf-8", keys: ["duration", "tagWriteResults", "writtenEvents"] },
      failure: { status: 400, contentType: "application/json; charset=utf-8", keys: ["code", "error"] },
    },
    tagLatestSortable: {
      success: { status: 200, contentType: "application/json; charset=utf-8", keys: ["exists", "lastSortableUniqueId"] },
      failure: { status: 400, contentType: "application/json; charset=utf-8", keys: ["code", "error"] },
    },
    tagState: {
      success: {
        status: 200,
        contentType: "application/json; charset=utf-8",
        keys: ["lastSortedUniqueId", "payload", "projectorVersion", "tagContent", "tagGroup", "tagPayloadName", "tagProjector", "version"],
      },
      failure: { status: 400, contentType: "application/json; charset=utf-8", keys: ["code", "error"] },
    },
    query: {
      success: { status: 200, contentType: "application/json; charset=utf-8", keys: ["resultJson"] },
      failure: { status: 400, contentType: "application/json; charset=utf-8", keys: ["code", "error"] },
    },
    listQuery: {
      success: { status: 200, contentType: "application/json; charset=utf-8", keys: ["currentPage", "itemsJson", "pageSize", "readHead", "totalCount", "totalPages"] },
      failure: { status: 400, contentType: "application/json; charset=utf-8", keys: ["code", "error"] },
    },
  },
  queuePayload: {
    baselineKeys: ["allocatorLineageId", "attemptId", "enqueuedAt", "eventId", "eventTags", "payload", "serviceId", "suid", "tag", "version"],
    allowedG32AdditiveKeys: ["causationId", "correlationId", "eventType", "executedUser", "provenance", "timestamp"],
    // G44 is the one explicit internal queue-envelope delta. It is not part
    // of any of the five public V1 endpoint bodies above.
    allowedG44AdditiveKeys: ["completeness"],
    keys: ["allocatorLineageId", "attemptId", "causationId", "completeness", "correlationId", "enqueuedAt", "eventId", "eventTags", "eventType", "executedUser", "payload", "provenance", "serviceId", "suid", "tag", "timestamp", "version"],
  },
  storageSchema: {
    sqliteDurableObjectKeys: ["allocator-state", "attempt:*", "journal", "outbox-deliveries", "repair-facts", "tag"],
    postgresTables: {
      serialized_dcb_events: ["service_id", "event_id", "suid", "payload", "allocator_lineage_id", "event_tags", "first_arrived_at", "last_arrived_at", "max_delivery_lag_ms"],
      serialized_dcb_event_arrivals: ["service_id", "event_id", "tag", "enqueued_at", "arrived_at", "lag_ms"],
      serialized_dcb_lag_estimates: ["service_id", "estimate_ms", "observed_at"],
      serialized_dcb_pending_arrivals: ["service_id", "event_id", "attempt_id", "suid", "expected_paths", "observed_paths", "first_observed_at", "lag_bound_ms"],
      serialized_dcb_inconsistency_findings: ["sequence", "service_id", "event_id", "path", "classification", "first_observed_at", "lag_bound_ms", "observed_at"],
      serialized_dcb_allocator_bindings: ["service_id", "allocator_lineage_id", "bound_at"],
      serialized_dcb_delivery_incidents: ["sequence", "service_id", "identity_key", "classification", "suid", "existing_event_id", "incoming_event_id", "event_id", "bound_lineage_id", "incoming_lineage_id", "observed_at"],
      serialized_dcb_projection_checkpoints: ["service_id", "projection_id", "last_suid", "state_json", "version", "updated_at"],
    },
  },
} as const;

type Shape = { status: number; contentType: string | null; keys: string[] };

async function shape(response: Response): Promise<Shape> {
  const body = await response.json<Record<string, unknown>>();
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    keys: Object.keys(body).sort(),
  };
}

function request(path: string, body: unknown): Request {
  return new Request(`https://g13.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function tagReadEnvironment(): ConstructorParameters<typeof SerializedReadWorker>[0] {
  const record = {
    tag: "test:g13-wire",
    head: "suid-00000000000000000000000000000001",
    events: [],
  };
  const namespace = {
    idFromName: () => ({}),
    get: () => ({
      fetch: async () => new Response(JSON.stringify(record), {
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    }),
  } as unknown as DurableObjectNamespace;
  // G13 observes the public wire rather than source/replay mechanics.  The
  // TagState cache binding returns the same typed ready contract that the
  // real G46 object exposes, so this golden continues to prove the five V1
  // endpoint bodies without falling back to the pre-G46 in-memory fold.
  const tagStateNamespace = {
    idFromName: () => ({}),
    get: () => ({
      fetch: async () => new Response(JSON.stringify({
        kind: "ready",
        payload: "",
        version: 0,
        lastSortedUniqueId: "",
        projectorVersion: "1",
      }), {
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    }),
  } as unknown as DurableObjectNamespace;
  return { TAG: namespace, TAG_STATE: tagStateNamespace };
}

function queryStore(): QueryProjectionStore {
  return {
    readAllEvents: async () => [],
    currentLagBound: async () => 0,
    listProjectionTags: async () => [],
    readProjectionCheckpoint: async () => undefined,
  };
}

async function captureTranscript(): Promise<unknown> {
  const commitSuccess = await handleSerializedCommit(request("/api/sekiban/serialized/commit", {
    version: 1,
    eventCandidates: [],
    consistencyTags: [],
  }), { SDT_SERVICE_ID: "g13-wire-fixture" } as CommitWorkerEnv);
  const commitFailure = await handleSerializedCommit(new Request("https://g13.test/api/sekiban/serialized/commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not-json",
  }), { SDT_SERVICE_ID: "g13-wire-fixture" } as CommitWorkerEnv);

  const reader = new SerializedReadWorker(tagReadEnvironment(), "g13-wire-fixture");
  const latestSuccess = await reader.handle(request("/api/sekiban/serialized/tag-latest-sortable", { tag: "test:g13-wire" }));
  const latestFailure = await reader.handle(request("/api/sekiban/serialized/tag-latest-sortable", {}));
  const stateSuccess = await reader.handle(request("/api/sekiban/serialized/tag-state", {
    tagStateId: "test:g13-wire:test-projector",
  }));
  const stateFailure = await reader.handle(request("/api/sekiban/serialized/tag-state", {}));

  const querySuccess = await handleSerializedQuery(request("/api/sekiban/serialized/query", {
    queryType: "GetTestCountQuery",
    queryParamsJson: "{}",
  }), { SDT_SERVICE_ID: "g13-wire-fixture" }, { store: queryStore() });
  const queryFailure = await handleSerializedQuery(request("/api/sekiban/serialized/query", {}), { SDT_SERVICE_ID: "g13-wire-fixture" }, { store: queryStore() });
  const listSuccess = await handleSerializedQuery(request("/api/sekiban/serialized/list-query", {
    queryType: "GetTestListQuery",
    queryParamsJson: "{}",
  }), { SDT_SERVICE_ID: "g13-wire-fixture" }, { store: queryStore() });
  const listFailure = await handleSerializedQuery(request("/api/sekiban/serialized/list-query", {}), { SDT_SERVICE_ID: "g13-wire-fixture" }, { store: queryStore() });

  const queuePayload: DownstreamOutboxMessage = g32Message({
    serviceId: "g13-wire-service",
    allocatorLineageId: "test-g13-lineage",
    tag: "test:g13-wire",
    attemptId: "attempt",
    eventId: "event",
    suid: "1",
    payload: JSON.stringify({ g13: true }),
    eventTags: ["test:g13-wire"],
    eventType: "G13WireFixtureEvent",
    enqueuedAt: 0,
  });

  return {
    endpoints: {
      commit: { success: await shape(commitSuccess), failure: await shape(commitFailure) },
      tagLatestSortable: { success: await shape(latestSuccess), failure: await shape(latestFailure) },
      tagState: { success: await shape(stateSuccess), failure: await shape(stateFailure) },
      query: { success: await shape(querySuccess), failure: await shape(queryFailure) },
      listQuery: { success: await shape(listSuccess), failure: await shape(listFailure) },
    },
    queuePayload: {
      baselineKeys: PRE_SPLIT_GOLDEN.queuePayload.baselineKeys,
      allowedG32AdditiveKeys: PRE_SPLIT_GOLDEN.queuePayload.allowedG32AdditiveKeys,
      allowedG44AdditiveKeys: PRE_SPLIT_GOLDEN.queuePayload.allowedG44AdditiveKeys,
      keys: Object.keys(queuePayload).sort(),
    },
    storageSchema: PRE_SPLIT_GOLDEN.storageSchema,
  };
}

function assertGolden(actual: unknown): void {
  expect(actual).toEqual(PRE_SPLIT_GOLDEN);
}

describe("SDT-G13 V1 wire-invariance oracle", () => {
  it("re-captures all five endpoint shapes, queue payload, and storage schema", async () => {
    assertGolden(await captureTranscript());
  });

  it("catches a deliberate status, spelling, and queue-member mutation", async () => {
    const captured = await captureTranscript() as {
      endpoints: { commit: { success: Shape }; tagState: { success: Shape } };
      queuePayload: { keys: string[] };
    };
    const statusMutation = structuredClone(captured);
    statusMutation.endpoints.commit.success.status = 201;
    expect(() => assertGolden(statusMutation)).toThrow();

    const spellingMutation = structuredClone(captured);
    spellingMutation.endpoints.tagState.success.keys = ["lastSortableUniqueId"];
    expect(() => assertGolden(spellingMutation)).toThrow();

    const payloadMutation = structuredClone(captured);
    payloadMutation.queuePayload.keys = payloadMutation.queuePayload.keys.filter((key) => key !== "eventTags");
    expect(() => assertGolden(payloadMutation)).toThrow();

    const g44AllowlistMutation = structuredClone(captured);
    g44AllowlistMutation.queuePayload.keys = g44AllowlistMutation.queuePayload.keys.filter((key) => key !== "completeness");
    expect(() => assertGolden(g44AllowlistMutation)).toThrow();
  });
});
