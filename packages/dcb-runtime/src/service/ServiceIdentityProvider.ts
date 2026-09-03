import { isScopeServiceId } from "../scope/ScopeName";

/** Miniflare-only request override. `.test` cannot be a deployed host. */
export const TEST_SERVICE_ID_HEADER = "x-sdt-g9-test-service-id";
/** Authenticated deployment-verification identity override. */
export const G11_SERVICE_ID_HEADER = "x-sdt-g11-service-id";

export type ServiceIdentityBehavior =
  | "deployment"
  | "test-tld-header"
  | "g11-verification-header";

export interface ServiceIdentityResolution {
  readonly serviceId: string;
  readonly behavior: ServiceIdentityBehavior;
}

export interface ServiceIdentityRequestOptions {
  /** Explicitly enables the authenticated G11 deployment-verification header. */
  readonly allowG11Verification?: boolean;
}

export interface ServiceIdentityProvider {
  /** Resolve the configured deployment identity without request overrides. */
  readonly deployment: () => ServiceIdentityResolution;
  /** Resolve identity for a request, with `.test` and G11 behaviour explicit. */
  readonly forRequest: (
    request: Request,
    options?: ServiceIdentityRequestOptions,
  ) => ServiceIdentityResolution;
}

export interface ServiceIdentityEnvironment {
  readonly SDT_SERVICE_ID?: string;
}

export class ServiceIdentityMissingError extends Error {
  constructor(message = "SDT_SERVICE_ID is required and must be a non-empty deployment service identity") {
    super(message);
    this.name = "ServiceIdentityMissingError";
  }
}

function requireServiceId(value: string | undefined): string {
  if (isScopeServiceId(value)) return value;
  throw new ServiceIdentityMissingError();
}

function providerFor(readConfiguredServiceId: () => string | undefined): ServiceIdentityProvider {
  const deployment = (): ServiceIdentityResolution => ({
    serviceId: requireServiceId(readConfiguredServiceId()),
    behavior: "deployment",
  });
  return Object.freeze({
    deployment,
    forRequest(request: Request, options: ServiceIdentityRequestOptions = {}): ServiceIdentityResolution {
      const hostname = new URL(request.url).hostname;
      const g11ServiceId = request.headers.get(G11_SERVICE_ID_HEADER);
      const testServiceId = request.headers.get(TEST_SERVICE_ID_HEADER);
      const g11Allowed = hostname.endsWith(".test") || options.allowG11Verification === true;
      if (g11Allowed && isScopeServiceId(g11ServiceId)) {
        return { serviceId: g11ServiceId, behavior: "g11-verification-header" };
      }
      if (hostname.endsWith(".test") && isScopeServiceId(testServiceId)) {
        return { serviceId: testServiceId, behavior: "test-tld-header" };
      }
      return deployment();
    },
  } satisfies ServiceIdentityProvider);
}

/** The deployed default: the Worker environment is the identity authority. */
export function envServiceIdentity(env: ServiceIdentityEnvironment): ServiceIdentityProvider {
  return providerFor(() => env.SDT_SERVICE_ID);
}

/**
 * Host seam for embedding runtimes and tests. It has the same request
 * behaviour as the environment-backed provider; only its configured source
 * differs.
 */
export function injectableServiceIdentity(
  serviceId: string | undefined | (() => string | undefined),
): ServiceIdentityProvider {
  return providerFor(typeof serviceId === "function" ? serviceId : () => serviceId);
}

export function requireServiceIdentity(provider: ServiceIdentityProvider): string {
  return provider.deployment().serviceId;
}

export function requestServiceIdentity(
  request: Request,
  provider: ServiceIdentityProvider,
  options: ServiceIdentityRequestOptions = {},
): string {
  return provider.forRequest(request, options).serviceId;
}
