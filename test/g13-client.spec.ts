import { defineEvent, type JsonValue } from "../packages/dcb-core/src/index";
import { handleSerializedCommit, validateCommitEnvelope, type CommitWorkerEnv } from "../packages/dcb-runtime/src/commit/CommitWorker";
import {
  ClaimLedger,
  ClaimLedgerExecutor,
  ClientError,
  SerializedDcbClient,
  type ClientCommandContext,
  type CommitEnvelope,
  type ReadonlyTagStateResponse,
  type SerializedDcbTransport,
  createHttpTransport,
  createInProcessTransport,
  preflightCommit,
} from "../packages/dcb-client/src/index";
import { afterEach, describe, expect, it, vi } from "vitest";
import { g32Suid } from "./helpers/g32-fixtures";

const snapshot = (tagGroup: string, tagContent: string, tagProjector: string, head: string, payload: Record<string, unknown> = {}): ReadonlyTagStateResponse => ({
  payload: payload as JsonValue,
  version: 1,
  lastSortedUniqueId: head,
  tagGroup,
  tagContent,
  tagProjector,
  tagPayloadName: "State",
  projectorVersion: "1",
});

const transportFor = (
  read: (tagStateId: string) => ReadonlyTagStateResponse,
  commit: (envelope: CommitEnvelope) => unknown = () => ({ writtenEvents: [] }),
): SerializedDcbTransport => ({
  readTagState: async ({ tagStateId }) => read(tagStateId),
  commit: async (envelope) => commit(envelope),
  query: async () => ({ status: 200, body: { resultJson: "{}" } }),
  listQuery: async () => ({ status: 200, body: { itemsJson: "[]", totalCount: 0, totalPages: 0, currentPage: 1, pageSize: 20 } }),
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SDT-G13 claim-ledger client", () => {
  it("caches the inseparable §5.3 snapshot and rejects incoherent projector reads", async () => {
    let reads = 0;
    const transport = transportFor((tagStateId) => {
      reads += 1;
      const [group, content, projector] = tagStateId.split(":");
      return snapshot(group, content, projector, projector === "other" ? "s-2" : "s-1");
    });
    const ledger = new ClaimLedger(transport);
    const first = await ledger.readTagState("group:content", "projector");
    const cached = await ledger.readTagState("group:content", "projector");
    expect(cached).toBe(first);
    expect(reads).toBe(1);
    await expect(ledger.readTagState("group:content", "other")).rejects.toMatchObject({ code: "incoherent_read_snapshot" });
    expect(reads).toBe(2);
  });

  it("preflights claim coverage and duplicate consistency entries before transport", () => {
    expect(() => preflightCommit({
      candidates: [{ tags: ["group:content"] }],
      consistency: [{ tag: "group:content", lastSortableUniqueId: "s-1" }, { tag: "group:content", lastSortableUniqueId: "s-1" }],
      claims: [],
    })).toThrowError(new ClientError("duplicate_consistency_entry", "More than one consistency entry was supplied for group:content"));
    expect(() => preflightCommit({
      candidates: [{ tags: ["group:other"] }],
      consistency: [],
      claims: [{ tag: "group:content", lastSortedUniqueId: "s-1" }],
    })).toThrowError(/not covered/);
  });

  it("emits the §3.1 consistency spelling accepted by the real commit runtime", async () => {
    const head = g32Suid("g13-runtime-head");
    let captured: CommitEnvelope | undefined;
    const event = defineEvent("Added");
    const executor = new ClaimLedgerExecutor({
      transport: transportFor(
        () => snapshot("group", "content", "projector", head),
        (envelope) => {
          captured = envelope;
          return { status: 200, body: { writtenEvents: [] } };
        },
      ),
    });
    const result = await executor.execute(async (context) => {
      await context.readTagState("group:content:projector");
      context.append(event, { value: 1 }, ["group:content"]);
      return { kind: "committed" };
    });
    expect(result.kind).toBe("committed");
    expect(captured?.consistency).toEqual([{ tag: "group:content", lastSortableUniqueId: head }]);

    const clientEnvelope = captured!;
    const runtimeEnvelope = {
      version: 1,
      eventCandidates: clientEnvelope.candidates.map((candidate) => ({
        payload: "e30=",
        eventPayloadName: candidate.eventPayloadName,
        tags: [...candidate.tags],
      })),
      consistencyTags: clientEnvelope.consistency,
    };
    expect(validateCommitEnvelope(runtimeEnvelope)).toHaveProperty("value");

    const runtimeEnv = {
      SDT_SERVICE_ID: "g13-client-fixture",
      JOURNAL: {
        idFromName: () => ({}),
        get: () => ({ fetch: async () => new Response("{}", { status: 500 }) }),
      },
    } as unknown as CommitWorkerEnv;
    const response = await handleSerializedCommit(new Request("https://commit.test/api/sekiban/serialized/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(runtimeEnvelope),
    }), runtimeEnv);
    const body = await response.json<{ code?: string }>();
    expect(body.code).not.toBe("malformed_commit_envelope");

    // Mutation proof: restoring the historical §5.3 spelling makes the real
    // validator reject the envelope before any durable actor is contacted.
    const spellingMutation = {
      ...runtimeEnvelope,
      consistencyTags: runtimeEnvelope.consistencyTags.map((entry) => ({
        tag: entry.tag,
        lastSortedUniqueId: entry.lastSortableUniqueId,
      })),
    };
    const mutated = await handleSerializedCommit(new Request("https://commit.test/api/sekiban/serialized/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(spellingMutation),
    }), runtimeEnv);
    expect(mutated.status).toBe(400);
    expect(await mutated.json()).toMatchObject({ code: "malformed_commit_envelope" });
  });

  it("re-executes a conflict once only when opted in, with fresh decision context", async () => {
    let executions = 0;
    let commits = 0;
    const event = defineEvent("Added");
    const transport = transportFor(
      () => snapshot("group", "content", "projector", "s-1"),
      () => {
        commits += 1;
        return commits === 1 ? { status: 409, body: { error: "conflict", code: "consistency_conflict" } } : { status: 200, body: { writtenEvents: ["e"] } };
      },
    );
    const executor = new ClaimLedgerExecutor({ transport, maxConflictRetries: 1 });
    const result = await executor.execute(async (context) => {
      executions += 1;
      await context.readTagState("group:content:projector");
      context.append(event, { execution: executions }, ["group:content"]);
      return { kind: "committed" };
    });
    expect(result).toMatchObject({ kind: "committed", attempts: 2 });
    expect(executions).toBe(2);
    expect(commits).toBe(2);
  });

  it("does not retry a consistency conflict unless the caller opts in", async () => {
    let executions = 0;
    const event = defineEvent("Added");
    const executor = new ClaimLedgerExecutor({
      transport: transportFor(
        () => snapshot("group", "content", "projector", "s-1"),
        () => ({ status: 409, body: { error: "conflict", code: "consistency_conflict" } }),
      ),
    });
    const result = await executor.execute(async (context) => {
      executions += 1;
      context.append(event, { execution: executions }, ["group:content"]);
      return { kind: "committed" };
    });
    expect(result).toMatchObject({ kind: "conflict", attempts: 1 });
    expect(executions).toBe(1);
  });

  it.each([
    ["partial", { status: 500, body: { error: "partial", code: "partial_write", partial: { missingTags: ["x"] } } }],
    ["timeout", { status: 504, body: { error: "timeout", code: "timeout" } }],
    ["transport", new Error("ambiguous")],
  ])("never retries %s even when opt-in is enabled", async (_kind, outcome) => {
    let commits = 0;
    const transport = transportFor(
      () => snapshot("group", "content", "projector", "s-1"),
      () => {
        commits += 1;
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    );
    const executor = new ClaimLedgerExecutor({ transport, maxConflictRetries: 1 });
    const event = defineEvent("Added");
    const result = await executor.execute(async (context) => {
      await context.readTagState("group:content:projector");
      context.append(event, { value: 1 }, ["group:content"]);
      return { kind: "committed" };
    });
    expect(commits).toBe(1);
    expect(result.attempts).toBe(1);
    expect(result.kind).toBe(_kind);
  });

  it("returns distinct local outcomes and honors AbortSignal", async () => {
    const controller = new AbortController();
    controller.abort();
    const executor = new ClaimLedgerExecutor({
      transport: transportFor(() => snapshot("group", "content", "projector", "s-1")),
      maxConflictRetries: 1,
    });
    const event = defineEvent("Added");
    const result = await executor.execute(async (context) => {
      context.append(event, { value: 1 }, ["group:content"]);
      return { kind: "committed" };
    }, { signal: controller.signal });
    expect(result).toMatchObject({ kind: "timeout", code: "aborted", attempts: 1 });
  });

  it("turns a hanging commit into a bounded timeout without a second attempt", async () => {
    let commits = 0;
    const executor = new ClaimLedgerExecutor({
      totalBudgetMs: 5,
      transport: transportFor(
        () => snapshot("group", "content", "projector", "s-1"),
        () => {
          commits += 1;
          return new Promise(() => undefined);
        },
      ),
    });
    const event = defineEvent("Added");
    const result = await executor.execute(async (context) => {
      context.append(event, { value: 1 }, ["group:content"]);
      return { kind: "committed" };
    });
    expect(result).toMatchObject({ kind: "timeout", attempts: 1, code: "timeout" });
    expect(commits).toBe(1);
  });
  it("SDT-G86 AC4: refuses an invalid totalBudgetMs before any command or commit call", async () => {
    const event = defineEvent("Added");
    const counts = { executions: 0, commits: 0 };
    const transport = transportFor(
      () => snapshot("group", "content", "projector", "s-1"),
      async () => {
        counts.commits += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { status: 200, body: { writtenEvents: [] } };
      },
    );
    const appendCommand = async (context: ClientCommandContext) => {
      counts.executions += 1;
      context.append(event, { value: 1 }, ["group:content"]);
      return { kind: "committed" as const };
    };
    for (const totalBudgetMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 2 ** 31]) {
      const perCall = await new ClaimLedgerExecutor({ transport }).execute(appendCommand, { totalBudgetMs });
      expect({ perCall, counts }, `per-call totalBudgetMs=${String(totalBudgetMs)}`).toMatchObject({
        perCall: { kind: "invalid", attempts: 0, code: "invalid_execute_options" },
        counts: { executions: 0, commits: 0 },
      });
      const fromDefault = await new ClaimLedgerExecutor({ transport, totalBudgetMs }).execute(appendCommand, { totalBudgetMs: 1000 });
      expect({ fromDefault, counts }, `default totalBudgetMs=${String(totalBudgetMs)}`).toMatchObject({
        fromDefault: { kind: "invalid", attempts: 0, code: "invalid_execute_options" },
        counts: { executions: 0, commits: 0 },
      });
    }
    for (const totalBudgetMs of [1000, 2147483647]) {
      counts.executions = 0;
      counts.commits = 0;
      const accepted = await new ClaimLedgerExecutor({ transport, totalBudgetMs }).execute(appendCommand);
      expect({ accepted, counts }, `accepted totalBudgetMs=${totalBudgetMs}`).toMatchObject({
        accepted: { kind: "committed" },
        counts: { executions: 1, commits: 1 },
      });
    }
  });

  it("SDT-G87 AC1: refuses non-function commands before transport", async () => {
    let commits = 0;
    const executor = new ClaimLedgerExecutor({
      transport: transportFor(
        () => snapshot("group", "content", "projector", "s-1"),
        () => {
          commits += 1;
          return { status: 200, body: {} };
        },
      ),
    });
    const result = await executor.execute({ execute: () => ({ kind: "committed", events: [] }) } as never);
    expect(result).toMatchObject({ kind: "invalid", attempts: 0, code: "unsupported_command" });
    expect(commits).toBe(0);
  });

  it("SDT-G87 AC2/AC3: ignores a JavaScript envelope and carries decision value", async () => {
    const event = defineEvent("Added");
    let captured: CommitEnvelope | undefined;
    const executor = new ClaimLedgerExecutor({
      transport: transportFor(
        () => snapshot("group", "content", "projector", "ledger-head"),
        (envelope) => {
          captured = envelope;
          return { status: 200, body: { writtenEvents: [] } };
        },
      ),
    });
    const result = await executor.execute(async (context) => {
      await context.readTagState("group:content:projector");
      context.append(event, { value: 1 }, ["group:content"]);
      return {
        kind: "committed",
        value: { accepted: true },
        envelope: {
          candidates: [],
          consistency: [{ tag: "group:content", lastSortableUniqueId: "forged-head" }],
        },
      } as never;
    });
    expect(captured).toMatchObject({
      consistency: [{ tag: "group:content", lastSortableUniqueId: "ledger-head" }],
    });
    expect(captured?.candidates).toHaveLength(1);
    expect(result).toMatchObject({ kind: "committed", value: { accepted: true } });

    const absent = await executor.execute((context) => {
      context.append(event, { value: 2 }, ["group:content"]);
      return { kind: "done" };
    });
    expect(absent.kind).toBe("committed");
    expect(absent).not.toHaveProperty("value");
  });

  it("SDT-G87 AC4: validates retry options and caps accepted values at one retry", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const event = defineEvent("Added");
    const counts = { executions: 0, commits: 0 };
    const transport = transportFor(
      () => snapshot("group", "content", "projector", "s-1"),
      () => {
        counts.commits += 1;
        return { status: 409, body: { code: "consistency_conflict", error: "conflict" } };
      },
    );
    const command = (context: ClientCommandContext) => {
      counts.executions += 1;
      context.append(event, { value: 1 }, ["group:content"]);
      return { kind: "committed" as const };
    };
    for (const [maxConflictRetries, attempts] of [[0, 1], [1, 2], [2, 2]] as const) {
      counts.executions = 0;
      counts.commits = 0;
      const result = await new ClaimLedgerExecutor({ transport }).execute(command, { maxConflictRetries });
      expect(result, String(maxConflictRetries)).toMatchObject({ kind: "conflict", attempts });
      expect(counts).toEqual({ executions: attempts, commits: attempts });
    }
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5]) {
      counts.executions = 0;
      counts.commits = 0;
      const perCall = await new ClaimLedgerExecutor({ transport }).execute(command, { maxConflictRetries: invalid });
      const fromConstructor = await new ClaimLedgerExecutor({ transport, maxConflictRetries: invalid }).execute(command, { maxConflictRetries: 1 });
      expect(perCall, `per-call ${String(invalid)}`).toMatchObject({ kind: "invalid", attempts: 0, code: "invalid_execute_options" });
      expect(fromConstructor, `constructor ${String(invalid)}`).toMatchObject({ kind: "invalid", attempts: 0, code: "invalid_execute_options" });
      expect(counts).toEqual({ executions: 0, commits: 0 });
    }
  });

  it("SDT-G87 AC5: applies bounded jitter and abandons retry on budget or abort", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const event = defineEvent("Added");
    let commits = 0;
    const conflictTransport = transportFor(
      () => snapshot("group", "content", "projector", "s-1"),
      () => {
        commits += 1;
        return commits === 1
          ? { status: 409, body: { code: "consistency_conflict" } }
          : { status: 200, body: {} };
      },
    );
    const command = (context: ClientCommandContext) => {
      context.append(event, { value: 1 }, ["group:content"]);
      return { kind: "committed" as const };
    };
    const delayed = new ClaimLedgerExecutor({ transport: conflictTransport, maxConflictRetries: 1 }).execute(command);
    await vi.advanceTimersByTimeAsync(24);
    expect(commits).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(delayed).resolves.toMatchObject({ kind: "committed", attempts: 2 });

    commits = 0;
    vi.mocked(Math.random).mockReturnValue(1);
    const budgeted = new ClaimLedgerExecutor({ transport: conflictTransport, maxConflictRetries: 1 }).execute(command, { totalBudgetMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    await expect(budgeted).resolves.toMatchObject({ kind: "timeout", code: "timeout", attempts: 1 });
    expect(commits).toBe(1);

    commits = 0;
    const controller = new AbortController();
    const aborted = new ClaimLedgerExecutor({ transport: conflictTransport, maxConflictRetries: 1 }).execute(command, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await expect(aborted).resolves.toMatchObject({ kind: "timeout", code: "aborted", attempts: 1 });
    expect(commits).toBe(1);
  });

  it("SDT-G87 AC6: combines caller and read signals at the adapter", async () => {
    const caller = new AbortController();
    const local = new AbortController();
    let adapterSignal: AbortSignal | undefined;
    let commits = 0;
    const transport: SerializedDcbTransport = {
      ...transportFor(() => snapshot("group", "content", "projector", "s-1")),
      readTagState: async (_request, signal) => {
        adapterSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
        });
      },
      commit: async () => {
        commits += 1;
        return { status: 200, body: {} };
      },
    };
    const pending = new ClaimLedgerExecutor({ transport }).execute(async (context) => {
      await context.state("group:content:projector", local.signal);
      return { kind: "noop" };
    }, { signal: caller.signal });
    await Promise.resolve();
    caller.abort();
    await expect(pending).resolves.toMatchObject({ kind: "timeout", code: "aborted" });
    expect(adapterSignal?.aborted).toBe(true);
    expect(local.signal.aborted).toBe(false);
    expect(commits).toBe(0);
  });

  it("SDT-G87 AC7: built-in adapters expose headers only on HTTP results", async () => {
    const response = () => new Response(JSON.stringify({ writtenEvents: [] }), {
      status: 200,
      headers: { "content-type": "application/json", "x-adapter": "present" },
    });
    const envelope: CommitEnvelope = { candidates: [], consistency: [] };
    const http = await createHttpTransport({
      baseUrl: "https://headers.test///",
      fetch: async () => response(),
    }).commit(envelope);
    const inProcess = await createInProcessTransport({
      fetch: async () => response(),
    }).commit(envelope);
    expect(http).toMatchObject({ status: 200, headers: { "x-adapter": "present" } });
    expect(inProcess).toMatchObject({ status: 200, headers: { "x-adapter": "present" } });

    const result = await new ClaimLedgerExecutor({
      transport: transportFor(
        () => snapshot("group", "content", "projector", "s-1"),
        () => http,
      ),
    }).execute((context) => {
      context.append("Added", {}, ["group:content"]);
      return { kind: "committed" };
    });
    expect(result).not.toHaveProperty("headers");
  });

  it("SDT-G87 AC8: SerializedDcbClient sends V1 with bound fetch and strips all trailing slashes", async () => {
    let boundToGlobal = false;
    let requestUrl = "";
    let requestBody: unknown;
    const boundFetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      boundToGlobal = this === globalThis;
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body));
      return Promise.resolve(new Response(JSON.stringify({ writtenEvents: [] }), {
        status: 200,
        headers: { "x-serialized": "present" },
      }));
    };
    vi.stubGlobal("fetch", boundFetch);
    const client = new SerializedDcbClient("https://serialized.test////");
    const result = await client.commit({
      candidates: [{
        eventId: "ignored-on-wire",
        eventPayloadName: "Added",
        payload: { value: 1 },
        tags: ["group:content"],
      }],
      consistency: [{ tag: "group:content", lastSortableUniqueId: g32Suid("g87-serialized-head") }],
    });
    expect(boundToGlobal).toBe(true);
    expect(requestUrl).toBe("https://serialized.test/api/sekiban/serialized/commit");
    expect(requestBody).toMatchObject({
      version: 1,
      eventCandidates: [{ eventPayloadName: "Added", tags: ["group:content"] }],
      consistencyTags: [{ tag: "group:content", lastSortableUniqueId: g32Suid("g87-serialized-head") }],
    });
    expect(validateCommitEnvelope(requestBody)).toHaveProperty("value");
    const oldBody = validateCommitEnvelope({
      candidates: [],
      consistency: [],
    });
    expect(oldBody).toHaveProperty("error");
    if ("error" in oldBody) {
      expect(oldBody.error.status).toBe(400);
      await expect(oldBody.error.json()).resolves.toMatchObject({ code: "malformed_commit_envelope" });
    }
    expect(result).toMatchObject({ status: 200, headers: { "x-serialized": "present" } });
  });
});
