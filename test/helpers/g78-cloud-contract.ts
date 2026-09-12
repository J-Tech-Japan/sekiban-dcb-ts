import contract from "../fixtures/g78-cloud-transport-contract.json";
import type { SekibanCloudTransportOptions } from "../../packages/dcb-client/src/index";

export const G78_CLOUD_OPERATIONS = Object.freeze([...contract.operations] as unknown as readonly [
  "commit",
  "tag-state",
  "tag-latest-sortable",
  "query",
  "list-query",
]);

export type G78CloudOperation = (typeof G78_CLOUD_OPERATIONS)[number];

export interface G78CloudRequest {
  readonly operation: G78CloudOperation;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function buildG78CloudRequest(
  options: Pick<SekibanCloudTransportOptions, "BaseUrl" | "ServiceId">,
  operation: G78CloudOperation,
): G78CloudRequest {
  return Object.freeze({
    operation,
    url: `${trimTrailingSlash(options.BaseUrl)}/api/${options.ServiceId}/sekiban/serialized/${operation}`,
    headers: Object.freeze({ [contract.serviceHeader]: options.ServiceId }),
  });
}

export function assertG78CloudRequest(
  request: G78CloudRequest,
  options: Pick<SekibanCloudTransportOptions, "BaseUrl" | "ServiceId">,
): void {
  if (!G78_CLOUD_OPERATIONS.includes(request.operation)) {
    throw new Error(`G78 operation is not in the golden contract: ${request.operation}`);
  }
  const expectedUrl = `${trimTrailingSlash(options.BaseUrl)}/api/${options.ServiceId}/sekiban/serialized/${request.operation}`;
  if (request.url !== expectedUrl) {
    throw new Error(`G78 scoped URL mismatch: expected ${expectedUrl}, received ${request.url}`);
  }
  const expectedServiceId = request.headers[contract.serviceHeader];
  if (expectedServiceId !== options.ServiceId) {
    throw new Error(`G78 service header mismatch: expected ${options.ServiceId}, received ${expectedServiceId ?? "<missing>"}`);
  }
  const parsed = new URL(request.url);
  if (parsed.pathname === `/api/sekiban/serialized/${request.operation}`) {
    throw new Error("G78 unscoped cloud route is not conforming");
  }
  if (parsed.pathname !== `/api/${options.ServiceId}/sekiban/serialized/${request.operation}`) {
    throw new Error(`G78 path scope mismatch: ${parsed.pathname}`);
  }
}
