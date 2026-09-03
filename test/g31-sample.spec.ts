import { describe, expect, it } from "vitest";
// @ts-expect-error Raw browser source is the wiring fixture.
import appSource from "../samples/meeting-room/public/app.js?raw";
// @ts-expect-error Raw Cloudflare-only worker source is the deployed proxy parity fixture.
import cloudflareOnlySource from "../samples/meeting-room/src/worker.cloudflare-only.ts?raw";
// @ts-expect-error Raw runtime source is the scheduled fresh-frontier ordering fixture.
import runtimeCloudflareSource from "../packages/dcb-runtime/src/cloudflare.ts?raw";
import {
  postCommitReservationListPath,
  requestPostCommitReservationList,
} from "../samples/meeting-room/public/reservation-auto-refresh.js";
import { createMeetingRoomWorker, type MeetingRoomEnv } from "../samples/meeting-room/src/worker";
import { runMeetingRoomScheduledMaintenance } from "../samples/meeting-room/src/worker.cloudflare-only";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function assertScheduledDelegationAndFreshFrontierOrder(workerSource: string, runtimeSource: string): void {
  const workerScheduledStart = workerSource.indexOf("async scheduled(controller, env, ctx)");
  if (workerScheduledStart < 0) throw new Error("sample scheduled wrapper is missing");
  const workerScheduled = workerSource.slice(workerScheduledStart);
  if (!workerScheduled.includes("await runtime.scheduled?.(controller, env, ctx);")) {
    throw new Error("sample scheduled wrapper must delegate to runtime.scheduled");
  }

  const runtimeScheduledStart = runtimeSource.indexOf("async scheduled(_controller, env): Promise<void>");
  if (runtimeScheduledStart < 0) throw new Error("runtime scheduled handler is missing");
  const runtimeScheduled = runtimeSource.slice(runtimeScheduledStart);
  const scanIndex = runtimeScheduled.indexOf("const scan = await new GlobalCompletenessReconciler");
  const hookIndex = runtimeScheduled.indexOf("const safeLane = await options.beforeLiveProjectionPoll?.({ env, serviceId, scan });");
  const pollIndex = runtimeScheduled.indexOf("await pollLiveProjections(env, {");
  if (scanIndex < 0 || hookIndex < 0 || pollIndex < 0 || !(scanIndex < hookIndex && hookIndex < pollIndex)) {
    throw new Error("runtime scheduled order must be reconcile, fresh-frontier hook, then live poll");
  }
  if (!runtimeScheduled.includes("maximumSuid: scheduledLiveProjectionMaximumSuid(scan, safeLane?.frontierSuid),")) {
    throw new Error("live poll must use the fresh safe-lane frontier as its maximum SUID");
  }
}

describe("SDT-G31 meeting-room list auto-refresh", () => {
  it("issues one post-commit reservation list request with the commit SUID and newest-first ordering", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init });
      return response({ itemsJson: "[]", totalCount: 0 });
    };
    const suid = "suid-00000000000000000000000000000091";
    expect(postCommitReservationListPath(suid)).toBe(
      `/api/read/reservations?pageNumber=1&pageSize=20&newestFirst=true&waitForSortableUniqueId=${suid}`,
    );
    await requestPostCommitReservationList(fetchImpl, suid);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(postCommitReservationListPath(suid));
    expect((calls[0]?.init?.headers as Record<string, string>).Accept).toBe("application/json");
  });

  it("forwards the application waitFor exactly once to the runtime list-query without client headers", async () => {
    const runtimeCalls: Array<{ request: Request; body: Record<string, unknown> }> = [];
    const runtime = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request = input instanceof Request ? input : new Request(input, init);
        runtimeCalls.push({ request, body: await request.clone().json<Record<string, unknown>>() });
        return response({ itemsJson: JSON.stringify([{ reservationId: "new", roomId: "room", status: "reserved", version: 1 }]), totalCount: 1, totalPages: 1, currentPage: 1, pageSize: 20 });
      },
    };
    const fetch = createMeetingRoomWorker().fetch as unknown as (request: Request, env: MeetingRoomEnv, context: ExecutionContext) => Promise<Response>;
    const suid = "suid-00000000000000000000000000000092";
    const result = await fetch(new Request(`https://sample.test${postCommitReservationListPath(suid)}`, {
      headers: {
        authorization: "Bearer client-value",
        "x-sdt-g11-service-id": "attacker-value",
      },
    }), { RUNTIME: runtime } as unknown as MeetingRoomEnv, {} as ExecutionContext);
    expect(result.status).toBe(200);
    expect(runtimeCalls).toHaveLength(1);
    expect(new URL(runtimeCalls[0]!.request.url).pathname).toBe("/api/sekiban/serialized/list-query");
    expect(runtimeCalls[0]!.body).toEqual({
      queryType: "GetReservationListQuery",
      queryParamsJson: JSON.stringify({ PageNumber: 1, PageSize: 20, consistency: "unsafe", NewestFirst: true }),
      waitForSortableUniqueId: suid,
    });
    expect(runtimeCalls[0]!.request.headers.has("authorization")).toBe(false);
    expect(runtimeCalls[0]!.request.headers.has("x-sdt-g11-service-id")).toBe(false);
  });

  it("wires reserve/cancel to one server wait and leaves the tag-state polling banner on its existing non-list path", () => {
    const source = appSource as string;
    const refresh = source.slice(source.indexOf("async function refreshReservationsAfterCommit"), source.indexOf("async function loadReservations"));
    expect(refresh.match(/fetchReservationPage\(/g)).toHaveLength(1);
    expect(refresh).not.toContain("observeProjection");
    expect(refresh).not.toContain("setTimeout");
    expect(refresh).toContain("Use Refresh to read the latest list.");
    expect(refresh).toContain("List head");
    expect(source).toContain("async function observeProjection");
    expect(source).toContain("void sendCommand(\"reserve-room\"");
    expect(source).toContain("void sendCommand(\"cancel-reservation\"");
    const reserve = source.slice(source.indexOf('void sendCommand("reserve-room"'), source.indexOf("cancelForm.addEventListener"));
    const cancel = source.slice(source.indexOf('void sendCommand("cancel-reservation"'), source.indexOf("reservationsRefresh.addEventListener"));
    expect(reserve).toContain("refreshReservations: true");
    expect(cancel).toContain("refreshReservations: true");
  });

  it("keeps the Cloudflare-only deployed proxy on the same bounded waitFor/newest-first contract", () => {
    const source = cloudflareOnlySource as string;
    expect(source).toContain('url.searchParams.get("waitForSortableUniqueId")');
    expect(source).toContain("waitForSortableUniqueId = requestedWait ?? undefined");
    expect(source).toContain("NewestFirst: true");
    expect(source).toContain("...(waitForSortableUniqueId === undefined ? {} : { waitForSortableUniqueId })");
  });

  it("runs MV safe catch-up and receipt-GC before generic scheduled polling can fail or stall", async () => {
    const calls: string[] = [];
    await expect(runMeetingRoomScheduledMaintenance({
      catchUp: async () => { calls.push("catch-up"); },
      drainUnsafeKicks: async () => { calls.push("drain"); },
      runGenericScheduledWork: async () => {
        calls.push("generic");
        throw new Error("generic scheduled polling failed");
      },
    })).rejects.toThrow("generic scheduled polling failed");
    expect(calls).toEqual(["catch-up", "drain", "generic"]);
    const workerSource = cloudflareOnlySource as string;
    const runtimeSource = runtimeCloudflareSource as string;
    assertScheduledDelegationAndFreshFrontierOrder(workerSource, runtimeSource);

    const directCall = workerSource.replace(
      "await runtime.scheduled?.(controller, env, ctx);",
      "await runMeetingRoomScheduledMaintenance();",
    );
    expect(() => assertScheduledDelegationAndFreshFrontierOrder(directCall, runtimeSource))
      .toThrow("runtime.scheduled");

    const hook = "const safeLane = await options.beforeLiveProjectionPoll?.({ env, serviceId, scan });";
    const pollCall = `await pollLiveProjections(env, {
        registry: composition.projectors,
        storeProvider,
        serviceIdentityProvider: serviceIdentity,
        maximumSuid: scheduledLiveProjectionMaximumSuid(scan, safeLane?.frontierSuid),
        observer: options.liveProjectionPollObserver,
      });`;
    const outOfOrder = runtimeSource
      .replace(`${hook}\n      `, "")
      .replace(pollCall, `${pollCall}\n      ${hook}`);
    expect(() => assertScheduledDelegationAndFreshFrontierOrder(workerSource, outOfOrder))
      .toThrow("reconcile, fresh-frontier hook, then live poll");
  });
});
