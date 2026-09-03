import {
  G11_SERVICE_ID_HEADER,
  TEST_SERVICE_ID_HEADER,
  injectableServiceIdentity,
  requireServiceIdentity,
  requestServiceIdentity,
} from "../service/ServiceIdentityProvider";

export { G11_SERVICE_ID_HEADER, TEST_SERVICE_ID_HEADER };

export interface ServiceIdRequestOptions {
  /**
   * Explicitly enabled only by an authenticated deployment-verification
   * lane. The default is fail-closed for production/public requests.
   */
  readonly allowG11Verification?: boolean;
  /** Server-side deployment identity; never sourced from a request header. */
  readonly configuredServiceId?: string;
}

/**
 * Compatibility entry point for existing hosts. New composition uses the
 * ServiceIdentityProvider seam directly.
 */
export function requireConfiguredServiceId(value: string | undefined): string {
  return requireServiceIdentity(injectableServiceIdentity(value));
}

export function serviceIdForRequest(request: Request, options: ServiceIdRequestOptions = {}): string {
  return requestServiceIdentity(request, injectableServiceIdentity(options.configuredServiceId), {
    allowG11Verification: options.allowG11Verification,
  });
}
