import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { runVerifiedTopology } from "../scripts/deploy/g26-measure.mjs";

const expectedViewCount = 2;
const expectedAllowedViews = ["ReservationProjector", "G26FanoutView02"];
const openServers = [];

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      resolve(text.length === 0 ? {} : JSON.parse(text));
    });
    request.on("error", reject);
  });
}

async function startMock(configuration) {
  const requests = [];
  let reservationId = "not-yet-reserved";
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push({ method: request.method, path: url.pathname, headers: request.headers });
    try {
      if (url.pathname === "/conformance/v1/g26-config") {
        json(response, 200, configuration);
        return;
      }
      if (url.pathname === "/api/commands/create-room" && request.method === "POST") {
        await readBody(request);
        json(response, 200, { kind: "committed" });
        return;
      }
      if (url.pathname === "/api/commands/reserve-room" && request.method === "POST") {
        const body = await readBody(request);
        reservationId = body.reservationId;
        json(response, 200, { kind: "committed" });
        return;
      }
      if (url.pathname === "/api/read/reservations" && request.method === "GET") {
        json(response, 200, { items: [{ reservationId }] });
        return;
      }
      json(response, 404, { kind: "not-found" });
    } catch (error) {
      json(response, 500, { kind: "mock-error", error: String(error) });
    }
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("mock server did not expose a TCP port");
  const instance = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))),
  };
  openServers.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

describe("SDT-G26 effective topology verification", () => {
  it("verifies the mock-served topology before measuring the opted-in list view", async () => {
    const mock = await startMock({ viewCount: expectedViewCount, allowedViews: expectedAllowedViews });
    const result = await runVerifiedTopology(mock.baseUrl, "g26-test-token", expectedViewCount, expectedAllowedViews, 1, 1, 1_000);
    expect(result.configuration).toEqual({ viewCount: expectedViewCount, allowedViews: expectedAllowedViews });
    expect(result.topology).toMatchObject({ viewCount: expectedViewCount, sampleCount: 1, controlledConcurrency: 1 });
    expect(mock.requests[0]?.path).toBe("/conformance/v1/g26-config");
    expect(mock.requests[0]?.headers.authorization).toBe("Bearer g26-test-token");
    expect(mock.requests.some((request) => request.path === "/api/read/reservations")).toBe(true);
  });

  it.each([
    ["view count", { viewCount: expectedViewCount + 1, allowedViews: expectedAllowedViews }, /G26_VIEW_COUNT mismatch/],
    ["allowed-view list", { viewCount: expectedViewCount, allowedViews: ["ReservationProjector"] }, /G26 allowed-view mismatch/],
  ])("blocks measurement on a mock-served %s mismatch", async (_label, configuration, expectedError) => {
    const mock = await startMock(configuration);
    await expect(runVerifiedTopology(mock.baseUrl, "g26-test-token", expectedViewCount, expectedAllowedViews, 1, 1, 1_000)).rejects.toThrow(expectedError);
    expect(mock.requests.filter((request) => request.path === "/api/commands/create-room")).toHaveLength(0);
    expect(mock.requests.filter((request) => request.path === "/api/commands/reserve-room")).toHaveLength(0);
  });

  it("keeps the mismatch path as a CI forced-red oracle", async () => {
    if (process.env.SDT_G26_TOPOLOGY_FORCE_FAILURE !== "1") return;
    const mock = await startMock({ viewCount: expectedViewCount + 1, allowedViews: expectedAllowedViews });
    await expect(runVerifiedTopology(mock.baseUrl, "g26-test-token", expectedViewCount, expectedAllowedViews, 1, 1, 1_000)).rejects.toThrow(/G26_VIEW_COUNT mismatch/);
    expect(mock.requests.filter((request) => request.path === "/api/commands/create-room")).toHaveLength(0);
    throw new Error("SDT-G26 topology verifier forced-red CI wiring proof");
  });
});
