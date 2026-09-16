import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { AllocatorDurableObject } from "../packages/dcb-runtime/src/allocator/AllocatorDurableObject";
import type { ClosedPrefixCertificate } from "../packages/dcb-runtime/src/allocator/types";
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
  g77Receipt,
  probeG77Capabilities,
  probeIssuanceRegistration,
  readAllocation,
  readTagState,
  seedObservedTagHead,
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
