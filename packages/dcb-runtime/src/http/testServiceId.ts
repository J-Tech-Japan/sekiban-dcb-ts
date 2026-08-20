/**
 * Miniflare-only test override. `.test` is a reserved test TLD, so a deployed
 * request cannot use this to alter the production service identity.
 */
export const TEST_SERVICE_ID_HEADER = "x-sdt-g9-test-service-id";
/** Deployment verification isolation; never part of the serialized V1 body. */
export const G11_SERVICE_ID_HEADER = "x-sdt-g11-service-id";

function validVerificationServiceId(value: string | null): value is string {
  return value !== null && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value);
}

export interface ServiceIdRequestOptions {
  /**
   * Explicitly enabled only by an authenticated deployment-verification
   * lane. The default is fail-closed for production/public requests.
   */
  readonly allowG11Verification?: boolean;
  /** Server-side deployment identity; never sourced from a request header. */
  readonly configuredServiceId?: string;
}

function validConfiguredServiceId(value: string | undefined): value is string {
  return value !== undefined && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value);
}

/** A deployment identity is never inferred from a baked-in compatibility value. */
export function requireConfiguredServiceId(value: string | undefined): string {
  if (validConfiguredServiceId(value)) return value;
  throw new Error("SDT_SERVICE_ID is required and must be a non-empty deployment service identity");
}

export function serviceIdForRequest(request: Request, options: ServiceIdRequestOptions = {}): string {
  const hostname = new URL(request.url).hostname;
  const configured = request.headers.get(TEST_SERVICE_ID_HEADER);
  const g11Configured = request.headers.get(G11_SERVICE_ID_HEADER);
  const g11Allowed = hostname.endsWith(".test") || options.allowG11Verification === true;
  // This header is accepted only by the authenticated deployment-verification
  // lane (or the reserved .test host). The verification target may be a
  // bootstrapped service rather than a g11-prefixed fixture.
  if (g11Allowed && validVerificationServiceId(g11Configured)) {
    return g11Configured;
  }
  if (hostname.endsWith(".test") && configured !== null && configured.length > 0) {
    return configured;
  }
  return requireConfiguredServiceId(options.configuredServiceId);
}
