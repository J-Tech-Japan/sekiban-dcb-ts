import { describe, expect, it } from "vitest";
import * as client from "../packages/dcb-client/src/index";
import type {
  SekibanCloudTransportOptions,
  SerializedDcbTransport,
} from "../packages/dcb-client/src/index";
import {
  assertG78CloudRequest,
  buildG78CloudRequest,
  G78_CLOUD_OPERATIONS,
} from "./helpers/g78-cloud-contract";

const options: Pick<SekibanCloudTransportOptions, "BaseUrl" | "ServiceId"> = {
  BaseUrl: "https://cloud.example.test///",
  ServiceId: "tenant-42",
};

describe("SDT-G78 cloud ownership and scoped contract", () => {
  it("AC1: leaves only the options type at the dcb-client root", () => {
    const typedOptions: SekibanCloudTransportOptions = {
      ...options,
      CredentialId: "contract-only-id",
      CredentialSecret: "contract-only-secret",
    };
    expect(typedOptions.ServiceId).toBe("tenant-42");
    expect("createSekibanCloudTransport" in client).toBe(false);
  });

  it("AC2: pins every cloud operation to the service path and matching header", () => {
    for (const operation of G78_CLOUD_OPERATIONS) {
      const request = buildG78CloudRequest(options, operation);
      expect(() => assertG78CloudRequest(request, options)).not.toThrow();
      expect(request.url).toBe(`https://cloud.example.test/api/tenant-42/sekiban/serialized/${operation}`);
      expect(request.headers["X-Sekiban-Service-Id"]).toBe("tenant-42");
    }
  });

  it("AC2: rejects an unscoped route and a path/header disagreement", () => {
    const scoped = buildG78CloudRequest(options, "query");
    expect(() => assertG78CloudRequest({ ...scoped, url: "https://cloud.example.test/api/sekiban/serialized/query" }, options)).toThrow(/scoped URL|unscoped/);
    expect(() => assertG78CloudRequest({ ...scoped, headers: { "X-Sekiban-Service-Id": "other-tenant" } }, options)).toThrow(/service header/);
  });

  it("AC1: keeps the shared transport boundary type-only and runtime-local transports available", () => {
    const transport: SerializedDcbTransport = {
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
    };
    expect(transport.readTagState).toBeTypeOf("function");
    expect(client.createHttpTransport).toBeTypeOf("function");
    expect(client.createInProcessTransport).toBeTypeOf("function");
  });
});
