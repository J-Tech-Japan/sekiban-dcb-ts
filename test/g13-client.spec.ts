import { defineEvent, type JsonValue } from "../packages/dcb-core/src/index";
import { handleSerializedCommit, validateCommitEnvelope, type CommitWorkerEnv } from "../packages/dcb-runtime/src/commit/CommitWorker";
import {
  ClaimLedger,
  ClaimLedgerExecutor,
  ClientError,
  type CommitEnvelope,
  type ReadonlyTagStateResponse,
  type SerializedDcbTransport,
  preflightCommit,
} from "../packages/dcb-client/src/index";
import { describe, expect, it } from "vitest";

const snapshot = (tagGroup: string, tagContent: string, tagProjector: string, head: string, payload: Record<string, unknown> = {}): ReadonlyTagStateResponse => ({
  payload: payload as JsonValue,
  version: 1,
  lastSortedUniqueId: head,
  tagGroup,
  tagContent,
  tagProjector,
  tagPayloadName: "State",
  projectorVersion: 1,
});

const transportFor = (
  read: (tagStateId: string) => ReadonlyTagStateResponse,
  commit: (envelope: CommitEnvelope) => unknown = () => ({ writtenEvents: [] }),
): SerializedDcbTransport => ({
  readTagState: async ({ tagStateId }) => read(tagStateId),
  commit: async (envelope) => commit(envelope),
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
    let captured: CommitEnvelope | undefined;
    const event = defineEvent("Added");
    const executor = new ClaimLedgerExecutor({
      transport: transportFor(
        () => snapshot("group", "content", "projector", "s-1"),
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
    expect(captured?.consistency).toEqual([{ tag: "group:content", lastSortableUniqueId: "s-1" }]);

    const clientEnvelope = captured!;
    const runtimeEnvelope = {
      version: 1,
      eventCandidates: clientEnvelope.candidates.map((candidate) => ({
        payload: "eA==",
        eventPayloadName: candidate.eventPayloadName,
        tags: [...candidate.tags],
      })),
      consistencyTags: clientEnvelope.consistency,
    };
    expect(validateCommitEnvelope(runtimeEnvelope)).toHaveProperty("value");

    const runtimeEnv = {
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
});
