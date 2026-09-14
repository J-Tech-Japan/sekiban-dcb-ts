import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ClientError,
  ClaimLedgerExecutor,
  createHttpTransport,
  createSekibanExecutor,
  type ClientCommandContext,
  type SerializedDcbTransport,
} from "../packages/dcb-client/src/index";
import { command, done, event, readSet, tagFamily } from "@sekiban/dcb-domain";

const queryRequest = { queryType: "G78Fixture", queryParamsJson: "{}" };

function baseTransport(overrides: Partial<SerializedDcbTransport> = {}): SerializedDcbTransport {
  return {
    readTagState: async () => ({
      payload: "",
      version: 0,
      lastSortedUniqueId: "",
      tagGroup: "fixture",
      tagContent: "tag",
      tagProjector: "projector",
    }),
    commit: async () => ({ status: 200, body: {} }),
    query: async () => ({ resultJson: "{}" }),
    listQuery: async () => ({ itemsJson: "[]", totalCount: 0, totalPages: 0, currentPage: 1, pageSize: 1 }),
    ...overrides,
  };
}

async function appendFixture(context: ClientCommandContext): Promise<{ readonly kind: "committed"; readonly value: { readonly accepted: true } }> {
  context.append("G78FixtureEvent", { accepted: true }, ["g78:fixture"]);
  return { kind: "committed", value: { accepted: true } };
}

function abortError(): Error {
  return Object.assign(new Error("caller cancelled"), { name: "AbortError" });
}

const g86Tags = tagFamily("g86");
const g86Appended = event("G86ParityAppended", z.object({ id: z.string() }), {
  tags: (payload) => [g86Tags.of(payload.id)],
});
const g86AppendCommand = command({
  id: "g86-parity-append",
  input: z.object({ id: z.string() }),
  reads: () => readSet(),
  handle: (input, context) => {
    context.append(g86Appended, g86Appended.make({ id: input.id }));
    return done();
  },
});

interface G86Outcome {
  readonly kind: string;
  readonly code?: string;
  readonly status?: number;
}

interface G86ParityRow {
  readonly reply: string;
  readonly commit: () => Promise<unknown>;
  readonly expected: G86Outcome;
  readonly partial?: unknown;
}

const g86PartialFacts = Object.freeze({
  retryable: false,
  writtenEventIds: ["g86-written"],
  failedEventIds: ["g86-failed"],
  writtenTags: ["g86:parity"],
  missingTags: [],
  eventsDeleted: false,
});

const g86ParityRows: readonly G86ParityRow[] = [
  { reply: "2xx", commit: async () => ({ status: 200, body: { writtenEvents: [] } }), expected: { kind: "committed", status: 200 } },
  { reply: "409 no code", commit: async () => ({ status: 409, body: { error: "conflict" } }), expected: { kind: "conflict", code: "consistency_conflict", status: 409 } },
  { reply: "409 consistency_conflict", commit: async () => ({ status: 409, body: { code: "consistency_conflict", error: "conflict" } }), expected: { kind: "conflict", code: "consistency_conflict", status: 409 } },
  { reply: "400 no code", commit: async () => ({ status: 400, body: { error: "bad request" } }), expected: { kind: "transport", code: "http_error", status: 400 } },
  { reply: "400 command_rejected", commit: async () => ({ status: 400, body: { code: "command_rejected", error: "rejected" } }), expected: { kind: "rejected", code: "command_rejected", status: 400 } },
  { reply: "422 unknown code", commit: async () => ({ status: 422, body: { code: "g86_unknown_code", error: "unknown" } }), expected: { kind: "transport", code: "transport", status: 422 } },
  { reply: "500 no code", commit: async () => ({ status: 500, body: { error: "internal" } }), expected: { kind: "timeout", code: "unknown_outcome", status: 500 } },
  { reply: "500 internal_error", commit: async () => ({ status: 500, body: { code: "internal_error", error: "internal" } }), expected: { kind: "transport", code: "transport", status: 500 } },
  {
    reply: "500 partial_write (validated partial body)",
    commit: async () => ({ status: 500, body: { code: "partial_write", error: "partial", partial: g86PartialFacts } }),
    expected: { kind: "partial", code: "partial_write", status: 500 },
    partial: g86PartialFacts,
  },
  { reply: "503 no code", commit: async () => ({ status: 503, body: { error: "unavailable" } }), expected: { kind: "timeout", code: "unknown_outcome", status: 503 } },
  { reply: "503 projection_unavailable", commit: async () => ({ status: 503, body: { code: "projection_unavailable", error: "unavailable" } }), expected: { kind: "unavailable", code: "projection_unavailable", status: 503 } },
  { reply: "504 no code", commit: async () => ({ status: 504, body: { error: "gateway timeout" } }), expected: { kind: "timeout", code: "unknown_outcome", status: 504 } },
  { reply: "thrown TypeError", commit: async () => { throw new TypeError("fetch failed"); }, expected: { kind: "transport", code: "transport" } },
  { reply: "thrown AbortError", commit: async () => { throw abortError(); }, expected: { kind: "timeout", code: "aborted" } },
  {
    reply: "thrown foreign error carrying partial_write",
    commit: async () => { throw Object.assign(new Error("foreign partial"), { name: "ClientError", code: "partial_write", partial: g86PartialFacts }); },
    expected: { kind: "partial", code: "partial_write" },
    partial: g86PartialFacts,
  },
];

function g86Outcome(result: { readonly kind: string; readonly code?: string; readonly status?: number }): G86Outcome {
  return {
    kind: result.kind,
    ...(result.code === undefined ? {} : { code: result.code }),
    ...(result.status === undefined ? {} : { status: result.status }),
  };
}

function g86Cell(outcome: G86Outcome): string {
  return `${outcome.kind} / ${outcome.code ?? "-"} / ${outcome.status ?? "-"}`;
}

function g86CallerAction(kind: string): string {
  if (kind === "committed") return "committed";
  if (kind === "conflict") return "reread and recompute";
  if (kind === "rejected" || kind === "invalid") return "fix the request";
  return "reconcile, never blindly reissue";
}

function assertNoForeignTransportDetail(value: unknown, secret: string): asserts value is ClientError {
  expect(value).toBeInstanceOf(ClientError);
  const error = value as ClientError & Record<string, unknown>;
  expect(error.code).toBe("transport");
  expect(error.status).toBe(502);
  expect(error.message).toBe("Transport request failed");
  expect(error.name).toBe("ClientError");
  expect(error.cause).toBeUndefined();
  expect(error.headers).toBeUndefined();
  expect(error.detail).toBeUndefined();
  expect(error.extra).toBeUndefined();
  expect(error.partial).toBeUndefined();
  expect(JSON.stringify(error)).not.toContain(secret);
}

describe("SDT-G78 public error classification", () => {
  it("AC3/AC4: preserves caller abort, deadline, definite refusal and unknown outcome distinctly", async () => {
    let dispatchedBeforeAbort = false;
    const beforeAbort = new AbortController();
    beforeAbort.abort();
    const beforeTransport = createHttpTransport({
      baseUrl: "https://g78.example.test",
      fetch: async (_input, init) => {
        if (init?.signal?.aborted) throw abortError();
        dispatchedBeforeAbort = true;
        throw new Error("unexpected dispatch");
      },
    });
    await expect(createSekibanExecutor(beforeTransport).query(queryRequest, { signal: beforeAbort.signal }))
      .rejects.toMatchObject({ code: "aborted" });
    expect(dispatchedBeforeAbort).toBe(false);

    let dispatchedAfterAbort = false;
    const afterAbort = new AbortController();
    const afterTransport = createHttpTransport({
      baseUrl: "https://g78.example.test",
      fetch: async (_input, init) => new Promise((_resolve, reject) => {
        dispatchedAfterAbort = true;
        init?.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
      }),
    });
    const afterPromise = createSekibanExecutor(afterTransport).query(queryRequest, { signal: afterAbort.signal });
    await Promise.resolve();
    afterAbort.abort();
    await expect(afterPromise).rejects.toMatchObject({ code: "aborted" });
    expect(dispatchedAfterAbort).toBe(true);

    const deadline = await new ClaimLedgerExecutor({ transport: baseTransport(), totalBudgetMs: 0 }).execute(appendFixture);
    expect(deadline).toMatchObject({ kind: "timeout", code: "timeout" });

    const refusal = await new ClaimLedgerExecutor({
      transport: baseTransport({ commit: async () => ({ status: 403, body: { code: "credential.rejected", error: "refused" } }) }),
    }).execute(appendFixture);
    expect(refusal).toMatchObject({ kind: "rejected", code: "credential.rejected" });

    const unknown = await new ClaimLedgerExecutor({
      transport: baseTransport({ commit: async () => ({ status: 504, body: { code: "unknown_outcome", error: "deadline" } }) }),
    }).execute(appendFixture);
    expect(unknown).toMatchObject({ kind: "timeout", code: "unknown_outcome" });
  });

  it("AC4: redacts all foreign transport detail at the public read boundary", async () => {
    const secret = "g78-secret-read-message";
    const secretCause = "g78-secret-read-cause";
    const secretHeader = "g78-secret-read-header";
    const secretExtra = "g78-secret-read-extra";
    const foreignSamePackage = Object.assign(
      new ClientError("transport", secret, {
        status: 502,
        partial: { committed: false, secret: secretExtra },
        cause: { secretCause },
      }),
      { headers: { "x-secret": secretHeader }, detail: secretExtra, extra: secretExtra },
    );
    const foreignStructural = {
      name: "ClientError",
      code: "transport",
      status: 502,
      message: secret,
      cause: { secretCause },
      headers: { "x-secret": secretHeader },
      partial: { committed: false, secret: secretExtra },
      detail: secretExtra,
      extra: secretExtra,
    };
    const foreignHttp = {
      status: 502,
      headers: { "x-secret": secretHeader },
      body: {
        code: "transport",
        error: secret,
        partial: { committed: false, secret: secretExtra },
        cause: { secretCause },
        detail: secretExtra,
      },
    };
    for (const candidate of [foreignSamePackage, foreignStructural, foreignHttp]) {
      const transport = baseTransport({
        query: async () => {
          if (candidate.status !== undefined && "body" in candidate) return candidate;
          throw candidate;
        },
      });
      const error = await createSekibanExecutor(transport).query(queryRequest).catch((value: unknown) => value);
      assertNoForeignTransportDetail(error, secret);
      expect(JSON.stringify(error)).not.toContain(secretCause);
      expect(JSON.stringify(error)).not.toContain(secretHeader);
      expect(JSON.stringify(error)).not.toContain(secretExtra);
    }
  });

  it("AC4: arbitrary foreign error codes fail closed to the transport class", async () => {
    const secret = "g78-secret-unknown-code";
    const error = await createSekibanExecutor(baseTransport({
      query: async () => {
        throw {
          code: "credential-secret-code",
          status: 503,
          message: secret,
          cause: { secret },
          headers: { "x-secret": secret },
        };
      },
    })).query(queryRequest).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ClientError);
    expect(error).toMatchObject({ code: "transport", status: 503, message: "Transport request failed" });
    expect((error as ClientError & { readonly cause?: unknown }).cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("AC4: foreign command partial-write keeps only validated retry metadata", async () => {
    const secretMessage = "g78-secret-partial-message";
    const secretCause = "g78-secret-partial-cause";
    const secretHeader = "g78-secret-partial-header";
    const secretExtra = "g78-secret-partial-extra";
    const foreign = Object.assign(new Error(secretMessage), {
      name: "ClientError",
      code: "partial_write",
      status: 500,
      cause: { secretCause },
      headers: { "x-secret": secretHeader },
      partial: {
        retryable: false,
        writtenEventIds: ["safe-written"],
        failedEventIds: ["safe-failed"],
        writtenTags: ["g78:fixture"],
        missingTags: [],
        eventsDeleted: false,
        secret: secretExtra,
      },
      extra: secretExtra,
    });
    const result = await new ClaimLedgerExecutor({
      transport: baseTransport({ commit: async () => { throw foreign; } }),
    }).execute(appendFixture);
    expect(result).toMatchObject({
      kind: "partial",
      status: 500,
      code: "partial_write",
      error: "The command was partially written",
      partial: {
        retryable: false,
        writtenEventIds: ["safe-written"],
        failedEventIds: ["safe-failed"],
        writtenTags: ["g78:fixture"],
        missingTags: [],
        eventsDeleted: false,
      },
    });
    const publicResult = result as unknown as Record<string, unknown>;
    expect(publicResult.cause).toBeUndefined();
    expect(publicResult.headers).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(secretMessage);
    expect(JSON.stringify(result)).not.toContain(secretCause);
    expect(JSON.stringify(result)).not.toContain(secretHeader);
    expect(JSON.stringify(result)).not.toContain(secretExtra);
  });

  it("SDT-G86 AC2: classifies identical commit replies identically through both executors", async () => {
    const observed: { readonly row: G86ParityRow; readonly ledger: G86Outcome; readonly facade: G86Outcome; readonly ledgerPartial: unknown; readonly facadePartial: unknown }[] = [];
    for (const row of g86ParityRows) {
      const ledger = await new ClaimLedgerExecutor({ transport: baseTransport({ commit: row.commit }) }).execute(appendFixture);
      const facade = await createSekibanExecutor(baseTransport({ commit: row.commit })).execute(g86AppendCommand, { id: "parity" });
      observed.push({
        row,
        ledger: g86Outcome(ledger),
        facade: g86Outcome(facade),
        ledgerPartial: (ledger as { readonly partial?: unknown }).partial,
        facadePartial: (facade as { readonly partial?: unknown }).partial,
      });
    }
    const table = [
      "| adapter reply | expected kind / code / status | ClaimLedgerExecutor | SekibanExecutor | caller action |",
      "| --- | --- | --- | --- | --- |",
      ...observed.map(({ row, ledger, facade }) =>
        `| ${row.reply} | ${g86Cell(row.expected)} | ${g86Cell(ledger)} | ${g86Cell(facade)} | ${g86CallerAction(row.expected.kind)} |`),
    ].join("\n");
    console.log(`SDT-G86 AC2 commit outcome table\n${table}`);
    for (const { row, ledger, facade, ledgerPartial, facadePartial } of observed) {
      expect(ledger, `${row.reply} via ClaimLedgerExecutor`).toEqual(row.expected);
      expect(facade, `${row.reply} via SekibanExecutor`).toEqual(row.expected);
      if (row.partial !== undefined) {
        expect(ledgerPartial, `${row.reply} partial via ClaimLedgerExecutor`).toEqual(row.partial);
        expect(facadePartial, `${row.reply} partial via SekibanExecutor`).toEqual(row.partial);
      }
    }
  });

  it("AC3/AC4: rejects malformed public responses without turning them into absence or refusal", async () => {
    const malformed = createSekibanExecutor(baseTransport({ query: async () => ({ resultJson: 42 as unknown as string }) }));
    await expect(malformed.query(queryRequest)).rejects.toMatchObject({ code: "invalid_query_response" });
  });
});
