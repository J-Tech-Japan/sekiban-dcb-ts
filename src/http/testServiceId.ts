/** The production V1 service identity is fixed by the compatibility contract. */
export const SERIALIZED_DCB_SERVICE_ID = "serialized-dcb-v1";

/**
 * Miniflare-only test override. `.test` is a reserved test TLD, so a deployed
 * request cannot use this to alter the production service identity.
 */
export const TEST_SERVICE_ID_HEADER = "x-sdt-g9-test-service-id";

export function serviceIdForRequest(request: Request): string {
  const configured = request.headers.get(TEST_SERVICE_ID_HEADER);
  return new URL(request.url).hostname.endsWith(".test") && configured !== null && configured.length > 0
    ? configured
    : SERIALIZED_DCB_SERVICE_ID;
}
