/** The production V1 service identity is fixed by the compatibility contract. */
export const SERIALIZED_DCB_SERVICE_ID = "serialized-dcb-v1";

/**
 * Miniflare-only test override. `.test` is a reserved test TLD, so a deployed
 * request cannot use this to alter the production service identity.
 */
export const TEST_SERVICE_ID_HEADER = "x-sdt-g9-test-service-id";
/** Deployment verification isolation; never part of the serialized V1 body. */
export const G11_SERVICE_ID_HEADER = "x-sdt-g11-service-id";

function validG11ServiceId(value: string | null): value is string {
  return value !== null && /^g11-[A-Za-z0-9-]{8,96}$/.test(value);
}

export interface ServiceIdRequestOptions {
  /**
   * Explicitly enabled only by an authenticated deployment-verification
   * lane. The default is fail-closed for production/public requests.
   */
  readonly allowG11Verification?: boolean;
}

export function serviceIdForRequest(request: Request, options: ServiceIdRequestOptions = {}): string {
  const hostname = new URL(request.url).hostname;
  const configured = request.headers.get(TEST_SERVICE_ID_HEADER);
  const g11Configured = request.headers.get(G11_SERVICE_ID_HEADER);
  const g11Allowed = hostname.endsWith(".test") || options.allowG11Verification === true;
  if (g11Allowed && validG11ServiceId(g11Configured)) {
    return g11Configured;
  }
  return hostname.endsWith(".test") && configured !== null && configured.length > 0
    ? configured
    : SERIALIZED_DCB_SERVICE_ID;
}
