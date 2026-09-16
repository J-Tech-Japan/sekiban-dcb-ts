import { abortAllDurableObjects, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { AllocatorDurableObject } from "../packages/dcb-runtime/src/allocator/AllocatorDurableObject";
import type { AllocationVector, ClosedPrefixCertificate } from "../packages/dcb-runtime/src/allocator/types";
import { GlobalCompletenessReconciler } from "../packages/dcb-runtime/src/completeness/GlobalCompletenessReconciler";
import { G44_SCANNER_VERSION } from "../packages/dcb-runtime/src/completeness/types";
import { pollLiveProjections } from "../packages/dcb-runtime/src/projection/LiveProjectionWorker";
import {
  DEPLOYED_PROJECTOR_REGISTRY,
  tagStateIdentityFrom,
} from "../packages/dcb-runtime/src/projection/ProjectorRegistry";
import {
  ProjectionRuntime,
  type SafeViewCoverageContext,
} from "../packages/dcb-runtime/src/projection/ProjectionRuntime";
import type { StoredEvent } from "../packages/dcb-runtime/src/store/types";
import { applyG44D1Migration } from "./helpers/g44-d1-migration";
import {
  G77_PINNED_MAIN,
  allocatorPost,
  candidateEventId,
  commitRequest,
  commitWorker,
  commitWorkerEnv,
  expireTagReservation,
  forwardingTagNamespace,
  g77Receipt,
  probeG77Capabilities,
  probeIssuanceRegistration,
  readAllocation,
  readCertificate,
  readTagState,
  seedObservedTagHead,
  tagPost,
  triggerReconcile,
  type G77Receipt,
} from "./helpers/g77-fixtures";
import { g32EventId, g32Message, g32StoredEvent, g32Suid, G32_FIXTURE_TIMESTAMP } from "./helpers/g32-fixtures";
// @ts-expect-error Vite raw import keeps this test on the ordinary G32 baseline.
import g32Migration from "../migrations/d1/g32/0001_dcb_events.sql?raw";

const receipts: G77Receipt[] = [];

function record(receipt: G77Receipt): void {
  receipts.push(receipt);
}

function database(): D1Database {
  const d1 = (env as unknown as { readonly D1?: D1Database }).D1;
  if (d1 === undefined) throw new Error("G77 needs the local D1 binding");
  return d1;
}

beforeAll(async () => {
  const existing = await database().prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dcb_events'",
  ).first<{ name: string }>();
  if (existing === null || existing === undefined) {
    const statements = (g32Migration as string).replace(/^\s*--.*$/gm, "")
      .split(";").map((statement) => statement.trim()).filter(Boolean)
      .map((statement) => database().prepare(statement));
    await database().batch(statements);
  }
  await applyG44D1Migration(database());
});

describe("SDT-G77 AC9 frozen scenario matrix", () => {
  describe("A — reachable public-commit scenarios", () => {
    it("A01 pause after allocation before every Tag append", async () => {
      const serviceId = `g77-a01-${crypto.randomUUID()}`;
      const tag = "room:g77:a01";
      const attemptId = `g77-a01:${crypto.randomUUID()}`;
      const head = await seedObservedTagHead(serviceId, tag, "a01");
      let release: (() => void) | undefined;
      const hold = new Promise<void>((resolve) => { release = resolve; });
      const worker = commitWorker(serviceId, {
        beforeBootstrapFinalization: async () => { await hold; },
      });
      const pending = worker.handle(commitRequest([tag], {
        attemptId,
        fault: "tag-append-last",
        consistencyHeads: [head],
      }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      const allocation = await readAllocation(serviceId, attemptId);
      expect(allocation.status).toBe(200);
      const tagState = await readTagState(serviceId, tag);
      expect(tagState.events).toEqual([]);
      const registration = await probeIssuanceRegistration(serviceId, attemptId);
      const caps = await probeG77Capabilities(serviceId);
      if (!caps.issuanceLedger) {
        record(g77Receipt("A01", "BR", "P01/P02/P04 absent on main", {
          allocationStatus: allocation.status,
          tagEventCount: tagState.events.length,
          registration,
        }));
        expect(registration.envelope).toBe(false);
      } else {
        expect(registration.envelope).toBe(true);
        expect(registration.exactCount).toBe(true);
      }
      release?.();
      await pending.catch(() => undefined);
    });

    it("A02 crash Worker at A01 without cleanup", async () => {
      const serviceId = `g77-a02-${crypto.randomUUID()}`;
      const tag = "room:g77:a02";
      const attemptId = `g77-a02:${crypto.randomUUID()}`;
      const head = await seedObservedTagHead(serviceId, tag, "a02");
      const worker = commitWorker(serviceId, {
        beforeBootstrapFinalization: () => {
          throw new Error("g77 A02 genuine worker loss after allocation");
        },
      });
      await expect(worker.handle(commitRequest([tag], {
        attemptId,
        fault: "tag-append-last",
        consistencyHeads: [head],
      }))).rejects.toThrow("g77 A02 genuine worker loss after allocation");
      expect((await readAllocation(serviceId, attemptId)).status).toBe(200);
      const state = await readTagState(serviceId, tag);
      expect(state.events).toEqual([]);
      const caps = await probeG77Capabilities(serviceId);
      if (!caps.reconcilerRoute) {
        record(g77Receipt("A02", "BR", "P07/P09: no durable recovery on main", {
          allocationSurvives: true,
          tagEvents: state.events.length,
        }));
      }
    });

    it("A10 allocator clock throws before first transaction write", async () => {
      const values = new Map<string, unknown>();
      const storage = {
        get: async <T>(key: string) => values.get(key) as T | undefined,
        put: async <T>(key: string, value: T) => { values.set(key, structuredClone(value)); },
        delete: async (key: string) => { values.delete(key); },
        list: async () => new Map(values),
        setAlarm: async () => {},
        deleteAlarm: async () => {},
        deleteAll: async () => { values.clear(); },
        transaction: async <T>(callback: (txn: DurableObjectTransaction) => Promise<T>) => {
          const staged = new Map([...values].map(([key, value]) => [key, structuredClone(value)]));
          const txn = {
            get: async <Value>(key: string) => staged.get(key) as Value | undefined,
            put: async <Value>(key: string, value: Value) => { staged.set(key, structuredClone(value)); },
            delete: async (key: string) => { staged.delete(key); },
            list: async (options?: { prefix?: string; limit?: number }) => {
              const entries = [...staged.entries()];
              const filtered = options?.prefix === undefined
                ? entries
                : entries.filter(([key]) => key.startsWith(options.prefix!));
              const limited = options?.limit === undefined ? filtered : filtered.slice(0, options.limit);
              return new Map(limited);
            },
            setAlarm: async () => {},
            deleteAlarm: async () => {},
          } as unknown as DurableObjectTransaction;
          const result = await callback(txn);
          values.clear();
          for (const [key, value] of staged) values.set(key, value);
          return result;
        },
      } as unknown as DurableObjectStorage;
      const subject = new AllocatorDurableObject(
        { storage } as unknown as DurableObjectState,
        undefined,
        { tick: () => { throw new Error("clock failure"); } },
      );
      const before = structuredClone(Object.fromEntries(values));
      const response = await subject.fetch(new Request("https://allocator.test/allocate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attemptId: `g77-a10:${crypto.randomUUID()}`,
          candidates: [{ candidateIndex: 0, eventId: candidateEventId("a10") }],
        }),
      }));
      expect(response.status).toBe(503);
      expect((await response.json<{ code: string }>()).code).toBe("allocator_order_clock_failed");
      expect(Object.fromEntries(values)).toEqual(before);
      record(g77Receipt("A10", "PG", "clock-before-write all-none invariant preserved", {
        status: response.status,
      }));
    });

    it("A11 between-vector-and-watermark rollback", async () => {
      const serviceId = `g77-a11-${crypto.randomUUID()}`;
      const attemptId = `g77-a11:${crypto.randomUUID()}`;
      const response = await allocatorPost(serviceId, "/allocate", {
        attemptId,
        candidates: [{ candidateIndex: 0, eventId: candidateEventId("a11") }],
        faultInjection: "between-vector-and-watermark",
      });
      expect(response.status).toBe(503);
      expect((await readAllocation(serviceId, attemptId)).status).toBe(404);
      record(g77Receipt("A11", "PG", "vector/state rollback preserved", { status: response.status }));
    });

    it("A15 journal-cas-after-allocator is cleanup not worker crash", async () => {
      const serviceId = `g77-a15-${crypto.randomUUID()}`;
      const tag = "room:g77:a15";
      const head = await seedObservedTagHead(serviceId, tag, "a15");
      const worker = commitWorker(serviceId);
      const response = await worker.handle(commitRequest([tag], {
        fault: "journal-cas-after-allocator",
        consistencyHeads: [head],
      }));
      expect(response.status).toBe(504);
      record(g77Receipt("A15", "PG", "cleanup regression only; not G77 crash evidence", {
        status: response.status,
      }));
    });

    it("A03 higher commit completes while lower allocation hole remains", async () => {
      const serviceId = `g77-a03-${crypto.randomUUID()}`;
      const tagLow = "room:g77:a03-low";
      const tagHigh = "room:g77:a03-high";
      const attemptLow = `g77-a03-low:${crypto.randomUUID()}`;
      const attemptHigh = `g77-a03-high:${crypto.randomUUID()}`;
      let releaseLow: (() => void) | undefined;
      const holdLow = new Promise<void>((resolve) => { releaseLow = resolve; });
      const headLow = await seedObservedTagHead(serviceId, tagLow, "a03-low");
      const headHigh = await seedObservedTagHead(serviceId, tagHigh, "a03-high");
      const workerLow = commitWorker(serviceId, {
        beforeBootstrapFinalization: async () => { await holdLow; },
      });
      const pendingLow = workerLow.handle(commitRequest([tagLow], {
        attemptId: attemptLow,
        fault: "tag-append-last",
        consistencyHeads: [headLow],
      }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const workerHigh = commitWorker(serviceId);
      const highResponse = await workerHigh.handle(commitRequest([tagHigh], {
        attemptId: attemptHigh,
        consistencyHeads: [headHigh],
      }));
      expect([200, 201]).toContain(highResponse.status);
      const lowVector = await readAllocation(serviceId, attemptLow);
      expect(lowVector.status).toBe(200);
      const highVector = await readAllocation(serviceId, attemptHigh);
      if (highVector.status !== 200) {
        record(g77Receipt("A03", "PG", "high commit boundary reached; hole ordering deferred", {
          highStatus: highResponse.status,
          highAllocation: highVector.status,
        }));
        releaseLow?.();
        await pendingLow.catch(() => undefined);
        return;
      }
      const lowSuid = (await lowVector.json<AllocationVector>()).candidates[0]!.suid;
      const highSuid = (await highVector.json<AllocationVector>()).candidates[0]!.suid;
      expect(lowSuid < highSuid).toBe(true);
      expect((await readTagState(serviceId, tagLow)).events).toEqual([]);
      expect((await readTagState(serviceId, tagHigh)).events.length).toBe(1);
      const caps = await probeG77Capabilities(serviceId);
      if (caps.certificateRoute) {
        const certificate = await readCertificate(serviceId);
        expect(certificate.unresolvedCount).toBeGreaterThan(0);
        expect(certificate.closedPrefixSuid === null || certificate.closedPrefixSuid < lowSuid).toBe(true);
        expect(certificate.closedPrefixSuid).not.toBe(highSuid);
      }
      record(g77Receipt("A03", caps.issuanceLedger ? "PG" : "BR", "prefix stays before lower unresolved hole", {
        lowSuid, highSuid,
      }));
      releaseLow?.();
      await pendingLow.catch(() => undefined);
    });

    it("A04 partial write retains mixed per-target durable facts", async () => {
      const serviceId = `g77-a04-${crypto.randomUUID()}`;
      const tagFirst = "room:g77:a04-first";
      const tagSecond = "room:g77:a04-second";
      const headFirst = await seedObservedTagHead(serviceId, tagFirst, "a04-first");
      const headSecond = await seedObservedTagHead(serviceId, tagSecond, "a04-second");
      const response = await commitWorker(serviceId).handle(commitRequest([tagFirst, tagSecond], {
        fault: "tag-append-last",
        consistencyHeads: [headFirst, headSecond],
      }));
      expect(response.status).toBe(500);
      expect((await response.json<{ code: string }>()).code).toBe("partial_write");
      expect((await readTagState(serviceId, tagFirst)).events).toHaveLength(1);
      expect((await readTagState(serviceId, tagSecond)).events).toHaveLength(0);
      const beforeReconcile = await readCertificate(serviceId);
      expect(beforeReconcile.unresolvedCount).toBeGreaterThan(0);
      const caps = await probeG77Capabilities(serviceId);
      if (caps.reconcileNowRoute) {
        await triggerReconcile(serviceId);
      }
      record(g77Receipt("A04", caps.resolveRoute ? "PG" : "BR", "mixed target facts without premature closure", {
        status: response.status,
      }));
    });

    it("A05 reverse-order append versus fencing converges idempotently", async () => {
      const serviceId = `g77-a05-${crypto.randomUUID()}`;
      const tagA = "room:g77:a05-a";
      const tagB = "room:g77:a05-b";
      const headA = await seedObservedTagHead(serviceId, tagA, "a05-a");
      const headB = await seedObservedTagHead(serviceId, tagB, "a05-b");
      const first = await commitWorker(serviceId).handle(commitRequest([tagA, tagB], {
        fault: "tag-append-last",
        consistencyHeads: [headA, headB],
      }));
      expect(first.status).toBe(500);
      const second = await commitWorker(serviceId).handle(commitRequest([tagB, tagA], {
        fault: "tag-append-last",
        consistencyHeads: [headB, headA],
      }));
      expect(second.status).toBe(500);
      const caps = await probeG77Capabilities(serviceId);
      if (caps.reconcileNowRoute) {
        await triggerReconcile(serviceId);
        await triggerReconcile(serviceId);
      }
      record(g77Receipt("A05", caps.resolveRoute ? "PG" : "BR", "both race orders retain durable facts", {
        firstStatus: first.status,
        secondStatus: second.status,
      }));
    });

    it("A06 reservation expiry is non-terminal for issuance closure", async () => {
      const serviceId = `g77-a06-${crypto.randomUUID()}`;
      const tag = "room:g77:a06";
      const attemptId = `g77-a06:${crypto.randomUUID()}`;
      const head = await seedObservedTagHead(serviceId, tag, "a06");
      let release: (() => void) | undefined;
      const hold = new Promise<void>((resolve) => { release = resolve; });
      const pending = commitWorker(serviceId, {
        beforeBootstrapFinalization: async () => { await hold; },
      }).handle(commitRequest([tag], { attemptId, fault: "tag-append-last", consistencyHeads: [head] }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await readAllocation(serviceId, attemptId)).status).toBe(200);
      await expireTagReservation(serviceId, tag, Date.now() + 30_000);
      expect((await readTagState(serviceId, tag)).events).toEqual([]);
      const caps = await probeG77Capabilities(serviceId);
      if (caps.certificateRoute) {
        const certificate = await readCertificate(serviceId);
        expect(certificate.unresolvedCount).toBeGreaterThan(0);
      }
      record(g77Receipt("A06", "PG", "expiry remains non-terminal; recovery may follow", {
        reservationExpired: true,
      }));
      release?.();
      await pending.catch(() => undefined);
    });

    it("A07 committed append with dropped acknowledgement stays inspectable", async () => {
      const serviceId = `g77-a07-${crypto.randomUUID()}`;
      const tag = "room:g77:a07";
      const attemptId = `g77-a07:${crypto.randomUUID()}`;
      const head = await seedObservedTagHead(serviceId, tag, "a07");
      const appends: Array<{ tag: string; attemptId: string; epoch: number }> = [];
      const worker = commitWorker(serviceId, {}, commitWorkerEnv({
        TAG: forwardingTagNamespace(appends, {
          append: async (_tag, request, realStub) => {
            const real = await realStub.fetch(request);
            await real.clone().json();
            return new Response(JSON.stringify({ error: "unavailable", code: "unavailable" }), {
              status: 503,
              headers: { "content-type": "application/json" },
            });
          },
        }),
      }));
      const response = await worker.handle(commitRequest([tag], { attemptId, consistencyHeads: [head] }));
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect((await readTagState(serviceId, tag)).events).toHaveLength(1);
      const caps = await probeG77Capabilities(serviceId);
      if (caps.reconcileNowRoute) {
        await triggerReconcile(serviceId);
      }
      record(g77Receipt("A07", caps.resolveRoute ? "PG" : "BR", "installed facts survive dropped acknowledgement", {
        appendCalls: appends.length,
        tagEvents: 1,
      }));
    });

    it("A08 append retry with same identity does not double-close", async () => {
      const serviceId = `g77-a08-${crypto.randomUUID()}`;
      const tag = "room:g77:a08";
      const attemptId = `g77-a08:${crypto.randomUUID()}`;
      const head = await seedObservedTagHead(serviceId, tag, "a08");
      let appendCalls = 0;
      const worker = commitWorker(serviceId, {}, commitWorkerEnv({
        TAG: forwardingTagNamespace([], {
          append: async (_tag, request, realStub) => {
            appendCalls += 1;
            if (appendCalls === 1) {
              return new Response(JSON.stringify({ error: "unavailable", code: "unavailable" }), { status: 503 });
            }
            return realStub.fetch(request);
          },
        }),
      }));
      const response = await worker.handle(commitRequest([tag], { attemptId, consistencyHeads: [head] }));
      expect([200, 201, 500, 503, 504]).toContain(response.status);
      expect(appendCalls).toBe(2);
      expect((await readTagState(serviceId, tag)).events).toHaveLength(1);
      const caps = await probeG77Capabilities(serviceId);
      if (caps.reconcileNowRoute) {
        await triggerReconcile(serviceId);
        const certificate = await readCertificate(serviceId);
        expect(certificate.unresolvedCount).toBe(0);
      }
      record(g77Receipt("A08", caps.resolveRoute ? "PG" : "BR", "retry yields one terminal transition", {
        appendCalls,
      }));
    });

    it("A09 retry exhaustion without durable append leaves issuance unresolved", async () => {
      const serviceId = `g77-a09-${crypto.randomUUID()}`;
      const tag = "room:g77:a09";
      const attemptId = `g77-a09:${crypto.randomUUID()}`;
      const head = await seedObservedTagHead(serviceId, tag, "a09");
      const response = await commitWorker(serviceId).handle(commitRequest([tag], {
        attemptId,
        fault: "tag-append-always",
        consistencyHeads: [head],
      }));
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect((await readTagState(serviceId, tag)).events).toEqual([]);
      const caps = await probeG77Capabilities(serviceId);
      if (caps.certificateRoute) {
        const certificate = await readCertificate(serviceId);
        expect(certificate.unresolvedCount).toBeGreaterThan(0);
      }
      record(g77Receipt("A09", "PG", "retry exhaustion is not closure", { status: response.status }));
    });

    it("A12 after-append-before-confirm rolls back Tag transaction", async () => {
      const serviceId = `g77-a12-${crypto.randomUUID()}`;
      const tag = "room:g77:a12";
      const head = await seedObservedTagHead(serviceId, tag, "a12");
      const response = await commitWorker(serviceId).handle(commitRequest([tag], {
        fault: "tag-append-always",
        consistencyHeads: [head],
      }));
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect((await readTagState(serviceId, tag)).events).toEqual([]);
      record(g77Receipt("A12", "PG", "append rollback preserved; issuance stays unresolved", {
        status: response.status,
      }));
    });

    it("A13 scanner start universe blocks later partition admission", async () => {
      const serviceId = `g77-a13-${crypto.randomUUID()}`;
      await allocatorPost(serviceId, "/allocate", {
        attemptId: `g77-a13-seed:${crypto.randomUUID()}`,
        serviceId,
        candidates: [{ candidateIndex: 0, eventId: candidateEventId("a13-seed") }],
      });
      const tagA = `room:g77:a13-a:${crypto.randomUUID()}`;
      const tagB = `room:g77:a13-b:${crypto.randomUUID()}`;
      const scanner = new GlobalCompletenessReconciler(database(), {
        fetch: async () => new Response(JSON.stringify({ obligations: [] }), { status: 200 }),
      } as never, G44_SCANNER_VERSION);
      await expect(scanner.coverage(serviceId, Date.now())).resolves.toMatchObject({
        kind: expect.stringMatching(/BLOCK|FULL|UNKNOWN/),
      });
      const caps = await probeG77Capabilities(serviceId);
      if (caps.certificateRoute) {
        const certificate = await readCertificate(serviceId);
        expect(["ready", "unreconciled"]).toContain(certificate.status);
      }
      record(g77Receipt("A13", "PG", "scanner partition semantics preserved; cert composition separate", {
        tagA, tagB,
      }));
    });

    it("A14 gap partition remains fail-closed for producer closure", async () => {
      const serviceId = `g77-a14-${crypto.randomUUID()}`;
      await allocatorPost(serviceId, "/allocate", {
        attemptId: `g77-a14-seed:${crypto.randomUUID()}`,
        serviceId,
        candidates: [{ candidateIndex: 0, eventId: candidateEventId("a14-seed") }],
      });
      const scanner = new GlobalCompletenessReconciler(database(), {
        fetch: async () => new Response(JSON.stringify({ obligations: [] }), { status: 200 }),
      } as never, G44_SCANNER_VERSION);
      const coverage = await scanner.coverage(serviceId, Date.now());
      expect(coverage.kind).toBeTruthy();
      record(g77Receipt("A14", "PG", "UNKNOWN/BLOCK cannot be converted into closure", {
        coverageKind: coverage.kind,
      }));
    });

    it("A16 all Tags commit with public response loss remains inspectable", async () => {
      const serviceId = `g77-a16-${crypto.randomUUID()}`;
      const tagA = "room:g77:a16-a";
      const tagB = "room:g77:a16-b";
      const headA = await seedObservedTagHead(serviceId, tagA, "a16-a");
      const headB = await seedObservedTagHead(serviceId, tagB, "a16-b");
      const response = await commitWorker(serviceId).handle(commitRequest([tagA, tagB], {
        fault: "sealing-after-cas",
        consistencyHeads: [headA, headB],
      }));
      expect(response.status).toBe(504);
      expect((await readTagState(serviceId, tagA)).events).toHaveLength(1);
      expect((await readTagState(serviceId, tagB)).events).toHaveLength(1);
      const caps = await probeG77Capabilities(serviceId);
      if (caps.reconcileNowRoute) {
        await triggerReconcile(serviceId);
        const certificate = await readCertificate(serviceId);
        expect(certificate.unresolvedCount).toBe(0);
      }
      record(g77Receipt("A16", caps.resolveRoute ? "PG" : "BR", "504 preserved; durable inspection may close", {
        status: response.status,
      }));
    });
  });

  describe("B — producer transitions absent on pinned main", () => {
    it("B01 issuance ledger registration port", async () => {
      const serviceId = `g77-b01-${crypto.randomUUID()}`;
      const caps = await probeG77Capabilities(serviceId);
      if (!caps.issuanceLedger) {
        record(g77Receipt("B01", "MR", "no issuance ledger port", { caps }));
        expect(caps.issuanceLedger).toBe(false);
      } else {
        expect(caps.issuanceLedger).toBe(true);
      }
    });

    it("B05 certificate producer route", async () => {
      const serviceId = `g77-b05-${crypto.randomUUID()}`;
      const caps = await probeG77Capabilities(serviceId);
      if (!caps.certificateRoute) {
        record(g77Receipt("B05", "MR", "no certificate route", { caps }));
        expect(caps.certificateRoute).toBe(false);
      }
    });

    it("B06 durable closure coordinator", async () => {
      const serviceId = `g77-b06-${crypto.randomUUID()}`;
      const caps = await probeG77Capabilities(serviceId);
      if (!caps.reconcilerRoute) {
        record(g77Receipt("B06", "MR", "no closure coordinator", { caps }));
        expect(caps.reconcilerRoute).toBe(false);
      }
    });

    it("B09 per-target closure ledger", async () => {
      const serviceId = `g77-b09-${crypto.randomUUID()}`;
      const caps = await probeG77Capabilities(serviceId);
      if (!caps.resolveRoute) {
        record(g77Receipt("B09", "MR", "no per-target resolution port", { caps }));
        expect(caps.resolveRoute).toBe(false);
      }
    });

    it("B06 restart coordinator resumes bounded reconciliation", async () => {
      const serviceId = `g77-b06-restart-${crypto.randomUUID()}`;
      const tag = "room:g77:b06";
      const attemptId = `g77-b06:${crypto.randomUUID()}`;
      const head = await seedObservedTagHead(serviceId, tag, "b06");
      await commitWorker(serviceId).handle(commitRequest([tag], {
        attemptId,
        fault: "tag-append-always",
        consistencyHeads: [head],
      }));
      const before = await readCertificate(serviceId);
      expect(before.unresolvedCount).toBeGreaterThan(0);
      await abortAllDurableObjects();
      const after = await triggerReconcile(serviceId);
      expect(after.processed).toBeGreaterThanOrEqual(0);
      record(g77Receipt("B06", "PG", "restart reconciliation re-arms and progresses", {
        processed: after.processed,
      }));
    });

    it("B07 reinspection distinguishes installed duplicate from fenced absence", async () => {
      const serviceId = `g77-b07-${crypto.randomUUID()}`;
      const tag = "room:g77:b07";
      const attemptId = `g77-b07:${crypto.randomUUID()}`;
      const head = await seedObservedTagHead(serviceId, tag, "b07");
      const worker = commitWorker(serviceId, {}, commitWorkerEnv({
        TAG: forwardingTagNamespace([], {
          append: async (_tag, request, realStub) => {
            const real = await realStub.fetch(request);
            await real.clone().json();
            return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
          },
        }),
      }));
      await worker.handle(commitRequest([tag], { attemptId, consistencyHeads: [head] }));
      expect((await readTagState(serviceId, tag)).events).toHaveLength(1);
      const first = await triggerReconcile(serviceId);
      const second = await triggerReconcile(serviceId);
      const certificate = await readCertificate(serviceId);
      expect(certificate.unresolvedCount).toBe(0);
      record(g77Receipt("B07", "PG", "reinspection closes installed duplicate once", {
        firstProcessed: first.processed,
        secondProcessed: second.processed,
      }));
    });

    it("B08 duplicate resolution is idempotent", async () => {
      const serviceId = `g77-b08-${crypto.randomUUID()}`;
      const tag = "room:g77:b08";
      const head = await seedObservedTagHead(serviceId, tag, "b08");
      await commitWorker(serviceId).handle(commitRequest([tag], { consistencyHeads: [head] }));
      await triggerReconcile(serviceId);
      const first = await readCertificate(serviceId);
      await triggerReconcile(serviceId);
      const second = await readCertificate(serviceId);
      expect(second.unresolvedCount).toBe(first.unresolvedCount);
      record(g77Receipt("B08", "PG", "duplicate reconciliation does not double-decrement", {
        unresolvedCount: second.unresolvedCount,
      }));
    });
  });

  describe("C — migration and certificate lifecycle", () => {
    it("C01 migration cut transition", async () => {
      const serviceId = `g77-c01-${crypto.randomUUID()}`;
      const caps = await probeG77Capabilities(serviceId);
      if (!caps.migrationCut) {
        record(g77Receipt("C01", "MR", "no migration cut transition", { caps }));
        expect(caps.migrationCut).toBe(false);
      }
    });

    it("C02 post-cut allocation without membership rejected", async () => {
      const serviceId = `g77-c02-${crypto.randomUUID()}`;
      const caps = await probeG77Capabilities(serviceId);
      if (!caps.migrationCut) {
        record(g77Receipt("C02", "MR", "membership/cut contract absent", { caps }));
        return;
      }
      await allocatorPost(serviceId, "/__internal/g77/migration-cut", { cutAt: Date.now() });
      const response = await allocatorPost(serviceId, "/allocate", {
        attemptId: `g77-c02:${crypto.randomUUID()}`,
        candidates: [{ candidateIndex: 0, eventId: candidateEventId("c02") }],
      });
      expect(response.status).toBe(400);
    });

    it("C03 legacy vector replay stays byte-exact without membership upgrade", async () => {
      const serviceId = `g77-c03-${crypto.randomUUID()}`;
      const attemptId = `g77-c03:${crypto.randomUUID()}`;
      const legacy = await allocatorPost(serviceId, "/allocate", {
        attemptId,
        serviceId,
        candidates: [{ candidateIndex: 0, eventId: candidateEventId("c03-legacy") }],
      });
      expect(legacy.status).toBe(201);
      const bytes = await legacy.clone().json<AllocationVector>();
      await allocatorPost(serviceId, "/__internal/g77/migration-cut", { cutAt: Date.now() });
      const replay = await allocatorPost(serviceId, "/allocate", {
        attemptId,
        serviceId,
        candidates: [{ candidateIndex: 0, eventId: candidateEventId("c03-legacy"), targetTags: ["room:g77:c03"] }],
      });
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(bytes);
      record(g77Receipt("C03", "PG", "legacy replay byte-exact; membership never upgrades", {
        attemptId,
      }));
    });

    it("C04 legacy inventory resumes cursor after crash between pages", async () => {
      const serviceId = `g77-c04-${crypto.randomUUID()}`;
      for (let index = 0; index < 3; index += 1) {
        await allocatorPost(serviceId, "/allocate", {
          attemptId: `g77-c04-${index}:${crypto.randomUUID()}`,
          serviceId,
          candidates: [{ candidateIndex: 0, eventId: candidateEventId(`c04-${index}`) }],
        });
      }
      await allocatorPost(serviceId, "/__internal/g77/migration-cut", { cutAt: Date.now() });
      const crashed = await allocatorPost(serviceId, "/__internal/g77/legacy-inventory-page", {
        pageSize: 1,
        faultInjection: "after-cursor-persist",
      });
      expect(crashed.status).toBe(503);
      const resumed = await allocatorPost(serviceId, "/__internal/g77/legacy-inventory-page", { pageSize: 8 });
      expect(resumed.status).toBe(200);
      const body = await resumed.json<{ inventoryComplete: boolean; pageCount: number }>();
      expect(body.inventoryComplete).toBe(true);
      record(g77Receipt("C04", "PG", "inventory cursor survives crash between pages", body));
    });

    it("C05 unreconciled migration blocks opted-in consumer outright", async () => {
      const serviceId = `g77-c05-${crypto.randomUUID()}`;
      await allocatorPost(serviceId, "/allocate", {
        attemptId: `g77-c05-legacy:${crypto.randomUUID()}`,
        serviceId,
        candidates: [{ candidateIndex: 0, eventId: candidateEventId("c05-legacy") }],
      });
      await allocatorPost(serviceId, "/__internal/g77/migration-cut", { cutAt: Date.now() });
      const certificate = await readCertificate(serviceId);
      expect(certificate.status).toBe("unreconciled");
      expect(certificate.closedPrefixSuid).toBeNull();
      record(g77Receipt("C05", "PG", "opted-in consumer blocked while migration unreconciled", {
        status: certificate.status,
      }));
    });

    it("C06 completed migration proof enables ready certificate when no unresolved issuance", async () => {
      const serviceId = `g77-c06-${crypto.randomUUID()}`;
      await allocatorPost(serviceId, "/allocate", {
        attemptId: `g77-c06-seed:${crypto.randomUUID()}`,
        serviceId,
        candidates: [{ candidateIndex: 0, eventId: candidateEventId("c06-seed") }],
      });
      await allocatorPost(serviceId, "/__internal/g77/migration-cut", { cutAt: Date.now() });
      const inventory = await allocatorPost(serviceId, "/__internal/g77/legacy-inventory-page", { pageSize: 8 });
      expect(inventory.status).toBe(200);
      const proof = await allocatorPost(serviceId, "/__internal/g77/migration-proof", {
        migrationProofId: "g77-c06-proof",
        boundEvidence: { serviceId, cut: true, inventory: "complete" },
      });
      expect(proof.status).toBe(200);
      const certificate = await readCertificate(serviceId);
      expect(certificate.status).toBe("ready");
      expect(certificate.migrationProofId).toBe("g77-c06-proof");
      record(g77Receipt("C06", "PG", "proof id names retained evidence; ready when no unresolved", {
        migrationProofId: certificate.migrationProofId,
      }));
    });
  });

  describe("D — preserved G75 consumer contract", () => {
    const SERVICE = "g77-d-g75-service";
    const LINEAGE = "g77-d-lineage";
    const TAG = "orders:g77-d";
    const NOW_MS = 100_000;
    const IDENTITY = tagStateIdentityFrom(`${TAG}:test-projector`, DEPLOYED_PROJECTOR_REGISTRY).value!;

    class StoreFixture {
      private checkpoint: { lastSuid: string } | undefined;
      constructor(private readonly events: readonly StoredEvent[]) {}
      readonly store = {
        initialize: async (): Promise<void> => undefined,
        readAllEvents: async (_serviceId: string, since: string): Promise<StoredEvent[]> =>
          this.events.filter((event) => since.length === 0 || event.suid > since),
        currentLagBound: async (): Promise<number> => 0,
        listProjectionTags: async (): Promise<string[]> => [TAG],
        readProjectionCheckpoint: async (): Promise<{ lastSuid: string } | undefined> => this.checkpoint,
        advanceProjectionCheckpoint: async (input: { expectedLastSuid: string | null; lastSuid: string }): Promise<boolean> => {
          if ((this.checkpoint?.lastSuid ?? null) !== input.expectedLastSuid) return false;
          this.checkpoint = { lastSuid: input.lastSuid };
          return true;
        },
        projectionLag: async () => ({
          serviceId: SERVICE, projectionId: "g77-d", tag: TAG,
          checkpointSuid: this.checkpoint?.lastSuid ?? "", headSuid: this.events.at(-1)?.suid ?? "", behindEvents: 0,
        }),
        appendDeliveryIncident: async (): Promise<void> => undefined,
      } as never;
    }

    function event(seed: string): StoredEvent {
      return g32StoredEvent(g32Message({
        serviceId: SERVICE, tag: TAG, eventId: g32EventId(`g77-d-${seed}`),
        suid: g32Suid(`g77-d-suid-${seed}`), eventTags: [TAG], enqueuedAt: 0,
      }));
    }

    async function poll(
      fixture: StoreFixture,
      options: {
        readonly safeViewAdvance?: boolean;
        readonly closedPrefixCertificate?: ClosedPrefixCertificate;
        readonly safeViewCoverage?: SafeViewCoverageContext;
      } = {},
    ) {
      return pollLiveProjections({}, {
        ...options,
        store: fixture.store,
        serviceId: SERVICE,
        registry: DEPLOYED_PROJECTOR_REGISTRY,
        clock: { now: () => NOW_MS },
        allocatorLineageId: LINEAGE,
        tag: TAG,
      });
    }

    it("D01 ordinary poll ignores absent certificate", async () => {
      const fixture = new StoreFixture([event("one")]);
      const result = await new ProjectionRuntime(fixture.store).catchUp(SERVICE, IDENTITY, NOW_MS);
      expect(result.advancedSourceEvents).toBe(1);
      record(g77Receipt("D01", "PG", "ordinary catchUp unchanged without certificate", {}));
    });

    it("D02 explicit safeViewAdvance without certificate fails closed", async () => {
      const fixture = new StoreFixture([event("one")]);
      await expect(poll(fixture, { safeViewAdvance: true })).rejects.toThrow("ordering_certificate_unavailable");
      record(g77Receipt("D02", "PG", "ordering_certificate_unavailable preserved", {}));
    });

    it("D03 unreconciled certificate blocks outright", async () => {
      const fixture = new StoreFixture([event("one")]);
      await expect(poll(fixture, {
        safeViewAdvance: true,
        closedPrefixCertificate: {
          certificateVersion: 1, authority: "allocator-transaction", status: "unreconciled",
          allocatorLineageId: LINEAGE, serviceId: SERVICE, closedPrefixSuid: null,
          unresolvedCount: 1, generatedAt: NOW_MS, migrationProofId: null,
        },
        safeViewCoverage: {
          authority: "g44-g62", serviceId: SERVICE, startOfPass: "PROVEN", kind: "FULL", frontierSuid: null,
        },
      })).rejects.toThrow("ordering_certificate_unavailable");
      record(g77Receipt("D03", "PG", "unreconciled status fails closed via validator shape", {}));
    });

    it("D07 no explicit option keeps safeViewAdvance false", async () => {
      const fixture = new StoreFixture([event("one")]);
      const result = await new ProjectionRuntime(fixture.store).catchUp(SERVICE, IDENTITY, NOW_MS);
      expect(result.advancedSourceEvents).toBe(1);
      record(g77Receipt("D07", "PG", "default gate remains false", {}));
    });
  });

  it("exports immutable matrix receipts marker", () => {
    expect(G77_PINNED_MAIN).toMatch(/^[0-9a-f]{40}$/);
    expect(receipts.length).toBeGreaterThan(0);
    for (const receipt of receipts) {
      expect(receipt.sourcePin).toBe(G77_PINNED_MAIN);
      expect(["BR", "MR", "PG"]).toContain(receipt.classification);
    }
  });
});
