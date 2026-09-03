import {
  ServiceIdentityMissingError,
  type ServiceIdentityProvider,
  type ServiceIdentityRequestOptions,
} from "../service/ServiceIdentityProvider";

export type ScopedControlRoute = "bootstrap" | "tag" | "operator-bootstrap";

export interface ScopedControlRouteInput {
  readonly request: Request;
  readonly provider: ServiceIdentityProvider;
  readonly pathServiceId: string;
  readonly route: ScopedControlRoute;
  readonly requestOptions?: ServiceIdentityRequestOptions;
}

export type ScopedControlRouteResult =
  | Readonly<{ readonly serviceId: string }>
  | Readonly<{ readonly response: Response }>;

function response(status: number, code: "scope.mismatch" | "scope.identity_missing", error: string): Response {
  return new Response(JSON.stringify({ code, error }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** A typed platform-fault response; no control route may invent an identity. */
export function scopeIdentityMissingResponse(): Response {
  return response(503, "scope.identity_missing", "A deployment service identity is required for this scope");
}

/**
 * Checks a path-owned identity before the caller can obtain a Durable Object
 * stub. Logs intentionally retain only the failure class and route, never the
 * configured deployment identity.
 */
export function enforceControlRouteScope(input: ScopedControlRouteInput): ScopedControlRouteResult {
  let actual: string;
  try {
    actual = input.provider.forRequest(input.request, input.requestOptions).serviceId;
  } catch (caught) {
    if (caught instanceof ServiceIdentityMissingError) {
      console.error({ schema: "sdt.scope/v1", code: "scope.identity_missing", route: input.route });
      return { response: scopeIdentityMissingResponse() };
    }
    throw caught;
  }
  if (input.pathServiceId !== actual) {
    console.warn({ schema: "sdt.scope/v1", code: "scope.mismatch", route: input.route });
    return {
      response: response(403, "scope.mismatch", "The path service identity is not authorized for this deployment"),
    };
  }
  return { serviceId: actual };
}
