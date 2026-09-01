import { SELF, createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  G42_JOURNAL_PROBE_IDENTITY_PREFIX,
  G42_JOURNAL_PROBE_INTERNAL_PREFIX,
  G42_JOURNAL_PROBE_LOGICAL_KEY_PREFIX,
  G42_JOURNAL_PROBE_PATH,
  G42_JOURNAL_PROBE_SCHEMA,
  runG42JournalProbeTrial,
} from "@sekiban/dcb-runtime/cloudflare";
import { JournalDurableObject } from "../packages/dcb-runtime/src/journal/JournalDurableObject";
import { G42_JOURNAL_PROBE_ALARM_KEY } from "../packages/dcb-runtime/src/journal/JournalFirstTouchProbe";
import primaryWorker from "../samples/meeting-room/src/worker.cloudflare-only";
import type { MeetingRoomCloudflareEnv } from "../samples/meeting-room/src/worker.cloudflare-env";

const TOKEN = "g42-conformance-fixture-token";

function identity(suffix: string): string {
  return `${G42_JOURNAL_PROBE_IDENTITY_PREFIX}${suffix.padEnd(32, "0").slice(0, 32)}`;
}

function logicalKey(suffix: string): string {
  return `${G42_JOURNAL_PROBE_LOGICAL_KEY_PREFIX}${suffix.padEnd(32, "1").slice(0, 32)}`;
}

function trial(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schema: G42_JOURNAL_PROBE_SCHEMA,
    action: "trial",
    trialId: "g42-p1-primary-0001",
    blockId: "g42-p1-block-01",
    cell: "A",
    physicalIdentity: identity("a"),
    logicalKey: logicalKey("a"),
    warmupLogicalKey: logicalKey("a"),
    payload: "p".repeat(64),
    alarmMode: "on",
    mediator: "none",
    ...overrides,
  };
}

function request(
  path: string = G42_JOURNAL_PROBE_PATH,
  init: RequestInit = {},
): Request {
  return new Request(`https://g42.test${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    body: JSON.stringify(trial()),
    ...init,
  });
}

function fakeNamespace(calls: { idFromName: number; get: number; fetch: number }): DurableObjectNamespace {
  return {
    idFromName: () => {
      calls.idFromName += 1;
      return { toString: () => "g42-fake" } as DurableObjectId;
    },
    get: () => {
      calls.get += 1;
      return {
        fetch: async (incoming: Request): Promise<Response> => {
          calls.fetch += 1;
          const path = new URL(incoming.url).pathname;
          const body = await incoming.json<Record<string, unknown>>();
          const action = path.endsWith("/write")
            ? "write"
            : path.endsWith("/cleanup")
              ? "cleanup"
              : path.endsWith("/state")
                ? "state"
                : "inventory";
          const status = action === "state" ? 404 : 200;
          return Response.json({
            schema: G42_JOURNAL_PROBE_SCHEMA,
            action,
            activation: {
              activationId: "g42-activation-a",
              activationFirst: true,
              constructorToHandlerMs: 1,
              firstStorageReadMs: action === "write" ? 1 : null,
            },
            handlerWallMs: 1,
            transactionWallMs: action === "write" ? 1 : null,
            requestBytes: JSON.stringify(body).length,
            recordBytes: action === "write" ? 8 : null,
            alarmStateBefore: null,
            alarmDueAt: action === "write" ? Date.now() + 60_000 : null,
            setAlarmCalls: action === "write" ? 1 : 0,
            ...(action === "write" ? { logicalKey: body.logicalKey } : {}),
            ...(body.expectedWarmupLogicalKey === undefined ? {} : { expectedWarmupKeyPresent: true }),
            ...(action === "state" ? { logicalKey: body.logicalKey, keyPresent: false } : {}),
            ...(action === "inventory" ? { inventory: [], productionJournalPresent: false } : {}),
          }, { status });
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

function guardedEnv(component: string | undefined, calls: { idFromName: number; get: number; fetch: number }): MeetingRoomCloudflareEnv {
  return {
    G32_COMPONENT: component,
    CONFORMANCE_TOKEN: TOKEN,
    JOURNAL: fakeNamespace(calls),
  } as unknown as MeetingRoomCloudflareEnv;
}

async function invoke(
  component: string | undefined,
  calls: { idFromName: number; get: number; fetch: number },
  incoming: Request,
): Promise<Response> {
  return primaryWorker.fetch!(incoming as never, guardedEnv(component, calls), createExecutionContext());
}

async function journalRequest(attemptId: string, path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://g42-journal.test/journals/${encodeURIComponent(attemptId)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function internalBody(action: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: G42_JOURNAL_PROBE_SCHEMA,
    action,
    trialId: "g42-p1-internal-0001",
    ...extra,
  };
}

function directStorage(): {
  readonly storage: DurableObjectStorage;
  readonly alarm: () => number | null;
  readonly value: (key: string) => unknown;
} {
  const values = new Map<string, unknown>();
  let alarmAt: number | null = null;
  const direct = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => { values.set(key, structuredClone(value)); },
    delete: async (key: string) => { values.delete(key); },
    getAlarm: async () => alarmAt,
    setAlarm: async (at: number) => { alarmAt = at; },
    deleteAlarm: async () => { alarmAt = null; },
  };
  return {
    storage: {
      ...direct,
      transaction: async <T>(callback: (transaction: DurableObjectTransaction) => Promise<T>) => callback(direct as unknown as DurableObjectTransaction),
    } as unknown as DurableObjectStorage,
    alarm: () => alarmAt,
    value: (key) => values.get(key),
  };
}

describe("SDT-G42 Journal first-touch conformance probe", () => {
  it.each([
    ["missing credential", "primary", new Request(`https://g42.test${G42_JOURNAL_PROBE_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(trial()) })],
    ["wrong credential", "primary", request(undefined, { headers: { authorization: "Bearer wrong", "content-type": "application/json" } })],
    ["receiver component", "receiver", request()],
    ["missing component", undefined, request()],
    ["unknown component", "unknown", request()],
    ["wrong method", "primary", request(undefined, { method: "GET", body: undefined })],
    ["wrong path", "primary", request("/conformance/v1/g42/not-journal-first-touch")],
    ["wrong query", "primary", request(`${G42_JOURNAL_PROBE_PATH}?unexpected=1`)],
    ["wrong content-type", "primary", request(undefined, { headers: { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" } })],
    ["wrong body schema", "primary", request(undefined, { body: JSON.stringify({ ...trial(), schema: "wrong" }) })],
  ] as const)("rejects %s before JOURNAL namespace work", async (_name, component, incoming) => {
    const calls = { idFromName: 0, get: 0, fetch: 0 };
    const response = await invoke(component, calls, incoming);
    expect(response.status).not.toBe(200);
    expect(calls).toEqual({ idFromName: 0, get: 0, fetch: 0 });
  });

  it("uses the JOURNAL namespace exactly for an authorized exact A control", async () => {
    const calls = { idFromName: 0, get: 0, fetch: 0 };
    const response = await invoke("primary", calls, request());
    expect(response.status).toBe(200);
    expect(calls).toEqual({ idFromName: 1, get: 1, fetch: 1 });
    await expect(response.json()).resolves.toMatchObject({
      schema: G42_JOURNAL_PROBE_SCHEMA,
      cell: "A",
      treatmentCompliance: { measuredActivationFirst: true, alarmSetExactlyOnce: true },
    });
  });

  it("retains the existing G32 final fence before JOURNAL namespace lookup", async () => {
    const calls = { idFromName: 0, get: 0, fetch: 0 };
    const env = {
      ...guardedEnv("primary", calls),
      // Deliberately incomplete final-fence configuration: the route must
      // fail at the inherited fence rather than bypassing it for G42.
      G32_CUTOVER_PHASE: "final-g32",
    } as MeetingRoomCloudflareEnv;
    const response = await primaryWorker.fetch!(request() as never, env, createExecutionContext());
    expect(response.status).toBe(503);
    expect(calls).toEqual({ idFromName: 0, get: 0, fetch: 0 });
  });

  it("keeps probe records out of production JOURNAL_KEY and makes cleanup idempotent", async () => {
    const physical = identity("b");
    const key = logicalKey("b");
    const write = await journalRequest(physical, `${G42_JOURNAL_PROBE_INTERNAL_PREFIX}/write`, internalBody("write", {
      cell: "A",
      logicalKey: key,
      recordKind: "measure",
      payload: "x".repeat(64),
      alarmMode: "on",
    }));
    expect(write.status).toBe(200);
    const normalState = await SELF.fetch(`https://g42-journal.test/journals/${encodeURIComponent(physical)}/state`);
    expect(normalState.status).toBe(404);

    const cleanup = () => journalRequest(physical, `${G42_JOURNAL_PROBE_INTERNAL_PREFIX}/cleanup`, internalBody("cleanup"));
    expect((await cleanup()).status).toBe(200);
    expect((await cleanup()).status).toBe(200);
    const inventory = await journalRequest(physical, `${G42_JOURNAL_PROBE_INTERNAL_PREFIX}/inventory`, internalBody("inventory"));
    await expect(inventory.json()).resolves.toMatchObject({
      inventory: [],
      alarmDueAt: null,
      productionJournalPresent: false,
    });
  });

  it("requires the D warmup record before a post-idle measurement can write", async () => {
    const physical = identity("d");
    const warmupKey = logicalKey("d0");
    const measureKey = logicalKey("d1");
    const measure = () => journalRequest(physical, `${G42_JOURNAL_PROBE_INTERNAL_PREFIX}/write`, internalBody("write", {
      cell: "D",
      logicalKey: measureKey,
      recordKind: "measure",
      payload: "x".repeat(64),
      alarmMode: "on",
    }));
    expect((await measure()).status).toBe(409);
    const warmup = await journalRequest(physical, `${G42_JOURNAL_PROBE_INTERNAL_PREFIX}/write`, internalBody("write", {
      cell: "D",
      logicalKey: warmupKey,
      recordKind: "warmup",
      payload: "x".repeat(64),
      alarmMode: "off",
    }));
    expect(warmup.status).toBe(200);
    const measured = await measure();
    expect(measured.status).toBe(200);
    await expect(measured.json()).resolves.toMatchObject({ expectedWarmupKeyPresent: true, logicalKey: measureKey });
  });

  it("records C as an actual missing-key /state 404 before the measured write", async () => {
    const physical = identity("c");
    const key = logicalKey("c");
    const state = await journalRequest(physical, `${G42_JOURNAL_PROBE_INTERNAL_PREFIX}/state`, internalBody("state", { logicalKey: key }));
    expect(state.status).toBe(404);
    await expect(state.json()).resolves.toMatchObject({ action: "state", logicalKey: key, keyPresent: false });
  });

  it("keeps A and D measured internal request bytes equal while proving D warmup", async () => {
    const calls = { idFromName: 0, get: 0, fetch: 0 };
    const a = trial({ trialId: "g42-p1-primary-0002", physicalIdentity: identity("e"), logicalKey: logicalKey("e") });
    const d = trial({
      trialId: "g42-p1-primary-0003",
      cell: "D",
      physicalIdentity: identity("f"),
      logicalKey: logicalKey("f"),
      warmupLogicalKey: logicalKey("f0"),
    });
    const aReceipt = await runG42JournalProbeTrial(fakeNamespace(calls), a as never, "SJC");
    const dReceipt = await runG42JournalProbeTrial(fakeNamespace(calls), d as never, "SJC");
    expect(aReceipt.measured.requestBytes).toBe(dReceipt.measured.requestBytes);
    expect(dReceipt.treatmentCompliance.distinctLogicalKey).toBe(true);
  });

  it("requires the same fixed-width caller envelope shape for A and D", () => {
    const a = trial({ trialId: "g42-p1-primary-0004", physicalIdentity: identity("g"), logicalKey: logicalKey("g"), warmupLogicalKey: logicalKey("g") });
    const d = trial({ trialId: "g42-p1-primary-0005", cell: "D", physicalIdentity: identity("h"), logicalKey: logicalKey("h"), warmupLogicalKey: logicalKey("h0") });
    expect(JSON.stringify(a).length).toBe(JSON.stringify(d).length);
  });

  it("makes an uncleaned probe alarm inert before any production recovery binding", async () => {
    const storage = directStorage();
    let recoveryPortCalls = 0;
    const env = new Proxy({}, {
      get() {
        recoveryPortCalls += 1;
        throw new Error("G42 probe alarm must not access production recovery ports");
      },
    });
    const journal = new JournalDurableObject({ storage: storage.storage } as unknown as DurableObjectState, env as never);
    const response = await journal.fetch(new Request(`https://g42-journal.test${G42_JOURNAL_PROBE_INTERNAL_PREFIX}/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(internalBody("write", {
        cell: "A",
        logicalKey: logicalKey("c"),
        recordKind: "measure",
        payload: "x".repeat(64),
        alarmMode: "on",
      })),
    }));
    expect(response.status).toBe(200);
    expect(storage.alarm()).not.toBeNull();
    await journal.alarm();
    expect(recoveryPortCalls).toBe(0);
    expect(storage.alarm()).toBeNull();
    expect(storage.value(G42_JOURNAL_PROBE_ALARM_KEY)).toBeUndefined();
  });
});
