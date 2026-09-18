import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { bootstrapDigest } from "../packages/dcb-runtime/src/bootstrap/manifest";
import type { BootstrapDump, BootstrapManifest } from "../packages/dcb-runtime/src/bootstrap/types";
import { CommitWorker } from "../packages/dcb-runtime/src/commit/CommitWorker";
import { scopeIdFor } from "../packages/dcb-runtime/src/scope/ScopeName";
import type { Env as WorkerEnv } from "../packages/dcb-runtime/src/index";
import { TEST_SERVICE_ID_HEADER } from "../packages/dcb-runtime/src/service/ServiceIdentityProvider";
import { G32_FIXTURE_TIMESTAMP, g32EventId, g32Suid, g32SuidAt } from "./helpers/g32-fixtures";

const encodedPayload = (value: unknown) => btoa(JSON.stringify(value));

function workerEnv(): WorkerEnv { return env as unknown as WorkerEnv; }

function bootstrapStub(serviceId: string): DurableObjectStub {
  const namespace = (workerEnv() as unknown as { readonly BOOTSTRAP: DurableObjectNamespace }).BOOTSTRAP;
  return namespace.get(scopeIdFor(namespace, { serviceId, doClass: "bootstrap", identity: "coordinator" }));
}

async function permitPost(serviceId: string, commandId: string, digest: string): Promise<Response> {
  const url = new URL("https://commit-worker.internal/command/permit");
  url.searchParams.set("__serviceId", serviceId);
  return bootstrapStub(serviceId).fetch(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commandId, digest }),
  }));
}

function tagStub(serviceId: string, tag: string): DurableObjectStub {
  const namespace = (workerEnv() as unknown as { readonly TAG: DurableObjectNamespace }).TAG;
  return namespace.get(scopeIdFor(namespace, { serviceId, doClass: "tag", identity: tag }));
}

function tagRequest(serviceId: string, tag: string, path: string, init?: RequestInit): Promise<Response> {
  const url = new URL(`https://tag.test${path}`);
  url.searchParams.set("__serviceId", serviceId);
  url.searchParams.set("__tag", tag);
  return tagStub(serviceId, tag).fetch(new Request(url.toString(), init));
}

async function tagPost(serviceId: string, tag: string, path: string, body: unknown): Promise<Response> {
  return tagRequest(serviceId, tag, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const suid = (n: number) => g32Suid(`g36-bootstrap-${n}`);

function dumpFor(serviceId: string, allocatorLineageId = "g36-lineage"): BootstrapDump {
  const events = [
    (() => {
      const eventId = g32EventId("g36-bootstrap-event-a");
      return { eventId, suid: suid(1), payload: JSON.stringify({ fixture: "a" }), eventTags: ["orders", "users"], eventType: "G36Fixture", provenance: { origin: "g32" as const }, timestamp: G32_FIXTURE_TIMESTAMP, causationId: null, correlationId: null, executedUser: null };
    })(),
    (() => {
      const eventId = g32EventId("g36-bootstrap-event-b");
      return { eventId, suid: suid(2), payload: JSON.stringify({ fixture: "b" }), eventTags: ["orders"], eventType: "G36Fixture", provenance: { origin: "g32" as const }, timestamp: G32_FIXTURE_TIMESTAMP, causationId: null, correlationId: null, executedUser: null };
    })(),
  ];
  const draft: Omit<BootstrapManifest, "contentDigest"> = { format: "sekiban-dcb-bootstrap", version: 1, source: { serviceId: "source", lineageId: "source-lineage" }, target: { serviceId, allocatorLineageId }, highWatermark: suid(2), eventCount: 2, tagCounts: { orders: 2, users: 1 }, canonicalization: "utf8-json-sorted-keys-v1" };
  return { manifest: { ...draft, contentDigest: bootstrapDigest({ manifest: { ...draft, contentDigest: "" }, events }) }, events };
}

async function post(serviceId: string, path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://bootstrap.test/bootstrap/${encodeURIComponent(serviceId)}${path}`, { method: "POST", headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: serviceId }, body: JSON.stringify(body) });
}

function commitRequest(tag: string, fixture: string): Request {
  return new Request("https://commit.test/api/sekiban/serialized/commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: 1, eventCandidates: [{ payload: encodedPayload({ fixture }), eventPayloadName: "G36", tags: [tag] }], consistencyTags: [] }),
  });
}

describe("SDT-G36 commit correctness", () => {
  it("tag append returns the write transaction's own version+updatedAt and replays it on duplicate", async () => {
    const serviceId = `g36-tag-${crypto.randomUUID()}`;
    const tag = `orders:g36-${crypto.randomUUID()}`;
    const firstBody = {
      attemptId: `g36-first-${crypto.randomUUID()}`,
      epoch: 0,
      candidates: [{
        eventId: g32EventId(`g36-first-event:${tag}`),
        suid: g32Suid("g36-order-1"),
        payload: JSON.stringify({ fixture: "first" }),
        eventTags: [tag],
        eventType: "G36First",
        provenance: "g32",
        allocatorLineageId: "g36-lineage",
        timestamp: G32_FIXTURE_TIMESTAMP,
      }],
    };
    const first = await tagPost(serviceId, tag, "/append", firstBody);
    expect(first.status).toBe(201);
    const firstJson = await first.json<{ status: string; version: number; updatedAt: string }>();
    expect(firstJson.status).toBe("appended");
    expect(firstJson.version).toBe(1);
    expect(typeof firstJson.updatedAt).toBe("string");

    const second = await tagPost(serviceId, tag, "/append", {
      attemptId: `g36-second-${crypto.randomUUID()}`,
      epoch: 0,
      candidates: [{
        eventId: g32EventId(`g36-second-event:${tag}`),
        suid: g32Suid("g36-order-2"),
        payload: JSON.stringify({ fixture: "second" }),
        eventTags: [tag],
        eventType: "G36Second",
        provenance: "g32",
        allocatorLineageId: "g36-lineage",
        timestamp: G32_FIXTURE_TIMESTAMP,
      }],
    });
    expect(second.status).toBe(201);
    const secondJson = await second.json<{ status: string; version: number; updatedAt: string }>();
    expect(secondJson.version).toBe(2);

    const replay = await tagPost(serviceId, tag, "/append", firstBody);
    expect(replay.status).toBe(200);
    const replayJson = await replay.json<{ status: string; version: number; updatedAt: string }>();
    expect(replayJson.status).toBe("duplicate");
    expect(replayJson.version).toBe(firstJson.version);
    expect(replayJson.updatedAt).toBe(firstJson.updatedAt);
  });

  it("commit tagWriteResults report the first append's version and writtenAt despite a later concurrent append", async () => {
    const serviceId = `g36-commit-${crypto.randomUUID()}`;
    const tag = `orders:g36c-${crypto.randomUUID()}`;
    const worker = new CommitWorker(workerEnv(), serviceId, {
      afterAppendBeforeResponse: async () => {
        const concurrent = await tagPost(serviceId, tag, "/append", {
          attemptId: `g36-concurrent-${crypto.randomUUID()}`,
          epoch: 0,
          candidates: [{
            eventId: g32EventId(`g36-concurrent-event:${tag}`),
            suid: g32SuidAt(Date.now() + 120_000, `g36-concurrent:${tag}`),
            payload: JSON.stringify({ fixture: "concurrent" }),
            eventTags: [tag],
            eventType: "G36Concurrent",
            provenance: "g32",
            allocatorLineageId: "g36-lineage",
            timestamp: new Date().toISOString(),
          }],
        });
        expect(concurrent.status).toBe(201);
      },
    });
    const response = await worker.handle(commitRequest(tag, "g36-target"));
    expect(response.status).toBe(200);
    const body = await response.json<{ tagWriteResults: Array<{ tag: string; version: number; writtenAt: string }> }>();
    expect(body.tagWriteResults).toHaveLength(1);
    expect(body.tagWriteResults[0]!.tag).toBe(tag);

    const head = await tagRequest(serviceId, tag, "/head-facts");
    expect(head.status).toBe(200);
    const facts = await head.json<{ version: number; updatedAt: string }>();
    expect(facts.version).toBe(body.tagWriteResults[0]!.version + 1);
  });

  it("rejects a different digest for the same command permit and accepts the same digest", async () => {
    const serviceId = `g36-digest-${crypto.randomUUID()}`;
    const commandId = `g36-cmd-${crypto.randomUUID()}`;
    const first = await permitPost(serviceId, commandId, "fnv1a32:same");
    expect(first.status).toBe(200);
    const again = await permitPost(serviceId, commandId, "fnv1a32:same");
    expect(again.status).toBe(200);
    const mismatch = await permitPost(serviceId, commandId, "fnv1a32:other");
    expect(mismatch.status).toBe(409);
    expect((await mismatch.json<{ code: string }>()).code).toBe("bootstrap_permit_digest_mismatch");
  });

  it("bootstrap plan is rejected while a commit holds the write permit, and the commit still writes", async () => {
    const serviceId = `g36-race-${crypto.randomUUID()}`;
    const dump = dumpFor(serviceId);
    let planStatus = 0;
    let planCode: string | undefined;
    const worker = new CommitWorker(workerEnv(), serviceId, {
      beforeAuthoritativeAppend: async () => {
        const planned = await post(serviceId, "/plan", { importId: "g36-race", dump, targetEvidence: { bindingExists: false, eventsExist: false } });
        planStatus = planned.status;
        planCode = ((await planned.json()) as { code?: string }).code;
      },
    });
    const result = await worker.handle(commitRequest("orders", "g36-race"));
    expect(planStatus).toBe(409);
    expect(planCode).toBe("bootstrap_write_permit_active");
    expect(result.status).toBe(200);
    const tagState = await SELF.fetch(`https://bootstrap.test/tags/${encodeURIComponent(serviceId)}/orders/state`, { headers: { [TEST_SERVICE_ID_HEADER]: serviceId } });
    expect(tagState.status).toBe(200);
    expect((await tagState.json<{ events: unknown[] }>()).events).toHaveLength(1);
  });
});
