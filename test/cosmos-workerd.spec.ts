import { describe, expect, it } from "vitest";

import { CosmosRestClient } from "../packages/dcb-runtime/src/store/CosmosEventStore";

function fixtureKey(): string {
  const bytes = new TextEncoder().encode("workerd-cosmos-fixture-key");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe("SDT-G12 workerd Cosmos REST path", () => {
  it("uses only Web APIs for gateway bootstrap, query, and missing-document reads", async () => {
    const calls: Array<{ url: string; method: string; headers: Headers }> = [];
    let queryPage = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), method: init?.method ?? "GET", headers });
      if (init?.method === "GET") return new Response("missing", { status: 404 });
      if (headers.get("content-type") === "application/query+json") {
        queryPage += 1;
        return new Response(JSON.stringify({ Documents: [{ id: queryPage === 1 ? "one" : "two", serviceId: "service" }] }), {
          status: 200,
          headers: queryPage === 1 ? { "x-ms-continuation": "fixture-next" } : {},
        });
      }
      return new Response(JSON.stringify({ id: "created" }), { status: 201, headers: { etag: 'W/"fixture"' } });
    }) as typeof fetch;

    const client = new CosmosRestClient({
      endpoint: "http://cosmos.test:8081",
      key: fixtureKey(),
      database: "workerd-fixture",
      fetcher,
    });
    await client.initialize();
    expect((await client.query("dcb-events", "SELECT * FROM c WHERE c.serviceId = @serviceId", [{ name: "@serviceId", value: "service" }], "service")).map((row) => row.document.id)).toEqual(["one", "two"]);
    expect(await client.read("dcb-events", "missing", "service")).toBeUndefined();
    expect(calls.length).toBe(9);
    expect(calls.every((call) => {
      const authorization = call.headers.get("authorization");
      return authorization !== null && decodeURIComponent(authorization).startsWith("type=master&ver=1.0&sig=");
    })).toBe(true);
    const queryCalls = calls.filter((call) => call.headers.get("x-ms-documentdb-isquery") === "true");
    expect(queryCalls).toHaveLength(2);
    expect(queryCalls[1]?.headers.get("x-ms-continuation")).toBe("fixture-next");
    expect(calls.at(-1)?.method).toBe("GET");
    expect(calls.at(-1)?.url).toContain("/docs/missing");
  });
});
