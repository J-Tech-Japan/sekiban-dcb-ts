import { env, runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";

import type { AllocationVector, ClosedPrefixCertificate } from "../../packages/dcb-runtime/src/allocator/types";
import { scopeIdFor } from "../../packages/dcb-runtime/src/scope/ScopeName";
import { CommitWorker, type CommitWorkerEnv } from "../../packages/dcb-runtime/src/commit/CommitWorker";
import { G32_FIXTURE_TIMESTAMP, g32EventId, g32Suid } from "./g32-fixtures";

export const G77_PINNED_MAIN = "2fb1c1f7c603d56fb2a2b33db715a499ddfc8a99";

export type G77MatrixClassification = "BR" | "MR" | "PG";

export interface G77Receipt {
  readonly rowId: string;
  readonly classification: G77MatrixClassification;
  readonly sourcePin: string;
  readonly assertion: string;
  readonly boundary?: Record<string, unknown>;
  readonly postcondition?: string;
}

export function g77Receipt(
  rowId: string,
  classification: G77MatrixClassification,
  assertion: string,
  boundary?: Record<string, unknown>,
): G77Receipt {
  return { rowId, classification, sourcePin: G77_PINNED_MAIN, assertion, boundary };
}

export function tags(): DurableObjectNamespace {
  const namespace = (env as unknown as { readonly TAG?: DurableObjectNamespace }).TAG;
  if (namespace === undefined) throw new Error("G77 needs the Tag Durable Object namespace");
  return namespace;
}

export function allocator(): DurableObjectNamespace {
  const namespace = (env as unknown as { readonly ALLOCATOR?: DurableObjectNamespace }).ALLOCATOR;
  if (namespace === undefined) throw new Error("G77 needs the Allocator Durable Object namespace");
  return namespace;
}

export function tagStub(serviceId: string, tag: string): DurableObjectStub {
  return tags().get(scopeIdFor(tags(), { serviceId, doClass: "tag", identity: tag }));
}

export function allocatorStub(serviceId: string): DurableObjectStub {
  return allocator().get(scopeIdFor(allocator(), { serviceId, doClass: "allocator", identity: "allocator" }));
}

export async function tagRequest(serviceId: string, tag: string, path: string, init?: RequestInit): Promise<Response> {
  const url = new URL(`https://tag.test${path}`);
  url.searchParams.set("__serviceId", serviceId);
  url.searchParams.set("__tag", tag);
  return tagStub(serviceId, tag).fetch(new Request(url.toString(), init));
}

export async function tagPost(serviceId: string, tag: string, path: string, body: unknown): Promise<Response> {
  return tagRequest(serviceId, tag, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function allocatorGet(serviceId: string, path: string): Promise<Response> {
  return allocatorStub(serviceId).fetch(new Request(`https://allocator.test${path}`));
}

export async function allocatorPost(serviceId: string, path: string, body?: unknown): Promise<Response> {
  return allocatorStub(serviceId).fetch(new Request(`https://allocator.test${path}`, {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

export function commitRequest(
  tags: readonly string[],
  options: {
    readonly fault?: string;
    readonly attemptId?: string;
    readonly consistencyHeads?: readonly string[];
  } = {},
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.fault !== undefined) headers.set("x-sdt-g4-test-fault", options.fault);
  if (options.attemptId !== undefined) headers.set("x-sdt-g4-test-attempt-id", options.attemptId);
  const heads = options.consistencyHeads ?? tags.map((_, index) => g32Suid(`g77-head-${index}`));
  return new Request("https://commit.test/api/sekiban/serialized/commit", {
    method: "POST",
    headers,
    body: JSON.stringify({
      version: 1,
      eventCandidates: [{
        payload: btoa(JSON.stringify({ fixture: "g77-closed-prefix-producer" })),
        eventPayloadName: "G77ClosedPrefixEvent",
        tags,
      }],
      consistencyTags: tags.map((tag, index) => ({ tag, lastSortableUniqueId: heads[index]! })),
    }),
  });
}

export function commitWorker(
  serviceId: string,
  hooks: ConstructorParameters<typeof CommitWorker>[2] = {},
  workerEnv: CommitWorkerEnv = env as unknown as CommitWorkerEnv,
): CommitWorker {
  return new CommitWorker(workerEnv, serviceId, hooks);
}

export function commitWorkerEnv(overrides: Partial<CommitWorkerEnv> = {}): CommitWorkerEnv {
  return { ...(env as unknown as CommitWorkerEnv), ...overrides };
}

export async function seedObservedTagHead(serviceId: string, tag: string, seed: string): Promise<string> {
  const initialized = await tagPost(serviceId, tag, "/acquire", {
    attemptId: `g77-seed:${seed}`,
    epoch: 0,
    eventTags: [tag],
    consistencyTags: [],
  });
  expect(initialized.status).toBe(200);
  const head = g32Suid(`g77-seed-head:${seed}`);
  await runInDurableObject(tagStub(serviceId, tag), async (_instance, state) => {
    const updatedAt = new Date().toISOString();
    state.storage.sql.exec(
      "UPDATE tag_control SET head_suid = ?, version = version + 1, updated_at = ? WHERE singleton = 1",
      head,
      updatedAt,
    );
    state.storage.sql.exec(
      "UPDATE tag_head SET service_id = ?, head_suid = ? WHERE singleton = 1",
      serviceId,
      head,
    );
  });
  const facts = await tagRequest(serviceId, tag, "/head-facts");
  expect(facts.status).toBe(200);
  return (await facts.json<{ head: string }>()).head;
}

export async function readTagState(serviceId: string, tag: string): Promise<{
  events: Array<{ eventId: string }>;
  activeReservation: { attemptId: string; epoch: number } | null;
}> {
  const response = await tagRequest(serviceId, tag, "/state");
  expect(response.status).toBe(200);
  return response.json();
}

export async function readAllocation(serviceId: string, attemptId: string): Promise<Response> {
  return allocatorGet(serviceId, `/attempts/${encodeURIComponent(attemptId)}`);
}

export async function expireTagReservation(serviceId: string, tag: string, expiresAt: number): Promise<void> {
  expect((await tagPost(serviceId, tag, "/debug/clock", { nowMs: expiresAt + 1 })).status).toBe(200);
  expect((await tagPost(serviceId, tag, "/debug/alarm", {})).status).toBe(200);
}

export async function readCertificate(serviceId: string): Promise<ClosedPrefixCertificate> {
  const response = await allocatorGet(serviceId, `/__internal/g77/certificate?serviceId=${encodeURIComponent(serviceId)}`);
  expect(response.status).toBe(200);
  return response.json();
}

export async function triggerReconcile(serviceId: string): Promise<{ processed: number; rearmAt: number }> {
  const response = await allocatorPost(serviceId, "/__internal/g77/reconcile-now", {});
  expect(response.status).toBe(200);
  return response.json();
}

export async function probeG77Capabilities(serviceId: string): Promise<{
  issuanceLedger: boolean;
  certificateRoute: boolean;
  resolveRoute: boolean;
  reconcilerRoute: boolean;
  migrationCut: boolean;
  legacyInventoryRoute: boolean;
  migrationProofRoute: boolean;
  reconcileNowRoute: boolean;
  tagInspect: boolean;
}> {
  const response = await allocatorGet(serviceId, "/__internal/g77/capabilities");
  if (response.status !== 200) {
    return {
      issuanceLedger: false,
      certificateRoute: false,
      resolveRoute: false,
      reconcilerRoute: false,
      migrationCut: false,
      legacyInventoryRoute: false,
      migrationProofRoute: false,
      reconcileNowRoute: false,
      tagInspect: false,
    };
  }
  const body = await response.json<Record<string, boolean>>();
  const tagResponse = await tagPost(serviceId, "room:g77:probe", "/__internal/g77/capabilities", {});
  const tagBody = tagResponse.status === 200
    ? await tagResponse.json<Record<string, boolean>>()
    : {};
  return {
    issuanceLedger: body.issuanceLedger === true,
    certificateRoute: body.certificateRoute === true,
    resolveRoute: body.resolveRoute === true,
    reconcilerRoute: body.reconcilerRoute === true,
    migrationCut: body.migrationCut === true,
    legacyInventoryRoute: body.legacyInventoryRoute === true,
    migrationProofRoute: body.migrationProofRoute === true,
    reconcileNowRoute: body.reconcileNowRoute === true,
    tagInspect: tagBody.inspectTarget === true,
  };
}

export async function probeIssuanceRegistration(
  serviceId: string,
  attemptId: string,
  candidateIndex = 0,
): Promise<{
  envelope: boolean;
  unresolvedIndex: boolean;
  issuedIndex: boolean;
  exactCount: boolean;
  recoverySchedule: boolean;
}> {
  const response = await allocatorGet(
    serviceId,
    `/__internal/g77/registration/${encodeURIComponent(attemptId)}/${candidateIndex}`,
  );
  if (response.status !== 200) {
    return {
      envelope: false,
      unresolvedIndex: false,
      issuedIndex: false,
      exactCount: false,
      recoverySchedule: false,
    };
  }
  return response.json();
}

export interface AppendCallFact {
  readonly tag: string;
  readonly attemptId: string;
  readonly epoch: number;
}

export function forwardingTagNamespace(
  appends: AppendCallFact[],
  handlers: {
    readonly acquire?: (tag: string, request: Request) => Promise<Response>;
    readonly append?: (tag: string, request: Request, realStub: DurableObjectStub) => Promise<Response>;
    readonly cancel?: (tag: string, request: Request) => Promise<Response>;
  } = {},
): DurableObjectNamespace {
  const real = tags();
  return {
    idFromName(name: string): DurableObjectId {
      return real.idFromName(name);
    },
    get(id: DurableObjectId): DurableObjectStub {
      const realStub = real.get(id);
      return {
        async fetch(request: Request): Promise<Response> {
          const url = new URL(request.url);
          const tag = url.searchParams.get("__tag") ?? String(id);
          if (url.pathname === "/append") {
            const body = await request.clone().json<{ attemptId: string; epoch: number }>();
            appends.push({ tag, attemptId: body.attemptId, epoch: body.epoch });
            if (handlers.append !== undefined) return handlers.append(tag, request, realStub);
          }
          if (url.pathname === "/acquire" && handlers.acquire !== undefined) {
            return handlers.acquire(tag, request);
          }
          if (url.pathname === "/cancel" && handlers.cancel !== undefined) {
            return handlers.cancel(tag, request);
          }
          return realStub.fetch(request);
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

export async function allocateDirect(
  serviceId: string,
  attemptId: string,
  eventId: string,
  membership?: readonly string[],
): Promise<AllocationVector> {
  const body: Record<string, unknown> = {
    attemptId,
    candidates: [{ candidateIndex: 0, eventId, ...(membership !== undefined ? { targetTags: [...membership] } : {}) }],
  };
  const response = await allocatorPost(serviceId, "/allocate", body);
  expect(response.status).toBe(201);
  return response.json();
}

export function candidateEventId(seed: string): string {
  return g32EventId(`g77-${seed}`);
}

export { g32EventId, g32Suid, G32_FIXTURE_TIMESTAMP };
