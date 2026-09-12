import { describe, expect, it } from "vitest";

import {
  ClientError,
  ClaimLedgerExecutor,
  createHttpTransport,
  createSekibanExecutor,
  type ClientCommandContext,
  type SerializedDcbTransport,
} from "../packages/dcb-client/src/index";

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

  it("AC3/AC4: preserves typed fields across package copies and keeps sanitized detail out of the public error", async () => {
    const secret = "g78-secret-must-not-escape";
    const foreignTypedTransport = baseTransport({
      query: async () => {
        throw {
          name: "ClientError",
          code: "transport",
          status: 502,
          message: "sanitized transport failure",
          partial: { committed: false },
          detail: secret,
        };
      },
    });
    const error = await createSekibanExecutor(foreignTypedTransport).query(queryRequest).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ClientError);
    expect(error).toMatchObject({ code: "transport", status: 502, partial: { committed: false } });
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("AC3/AC4: rejects malformed public responses without turning them into absence or refusal", async () => {
    const malformed = createSekibanExecutor(baseTransport({ query: async () => ({ resultJson: 42 as unknown as string }) }));
    await expect(malformed.query(queryRequest)).rejects.toMatchObject({ code: "invalid_query_response" });
  });
});
