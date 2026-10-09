import {
  IncidentLifecycle,
  IncidentLifecycleError,
  normalizeIncidentIdentity,
  type IncidentListFilters,
} from "../completeness/IncidentLifecycle";
import {
  requestServiceIdentity,
  type ServiceIdentityProvider,
} from "../service/ServiceIdentityProvider";
import type { IncidentLifecycleState } from "../completeness/types";

export interface IncidentMaintenanceEnvironment {
  readonly D1?: D1Database;
  readonly INCIDENT_MAINTAINER_TOKEN?: string;
  readonly G11_VERIFICATION_ENABLED?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function error(status: number, code: string, message: string): Response {
  return json({ error: message, code }, status);
}

function configuredToken(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const token = value.trim();
  return token.length === 0 ? undefined : token;
}

async function digest(value: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function fixedLengthEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function authenticated(request: Request, token: string): Promise<boolean> {
  const credential = request.headers.get("authorization") ?? "";
  const suppliedToken = credential.startsWith("Bearer ") ? credential.slice("Bearer ".length) : "";
  const [expectedDigest, suppliedDigest] = await Promise.all([digest(token), digest(suppliedToken)]);
  return fixedLengthEqual(expectedDigest, suppliedDigest);
}

function boolFilter(value: string | null, name: string): boolean | undefined {
  if (value === null) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new IncidentLifecycleError("incident_invalid_filter", 400, `${name} must be true or false`);
}

function parseFilters(url: URL): IncidentListFilters {
  const allowed = new Set(["state", "owner", "unowned", "overdue", "observedAfterClose"]);
  let unknown = false;
  url.searchParams.forEach((_value, key) => {
    if (!allowed.has(key)) unknown = true;
  });
  if (unknown) throw new IncidentLifecycleError("incident_invalid_filter", 400, "Unknown incident list filter");
  const state = url.searchParams.get("state");
  if (state !== null && !["OPEN", "ACKNOWLEDGED", "CORRECTION_RECORDED", "CLOSED", "REOPENED"].includes(state)) {
    throw new IncidentLifecycleError("incident_invalid_filter", 400, "state is invalid");
  }
  const owner = url.searchParams.get("owner");
  if (owner !== null) {
    const normalizedOwner = owner.trim();
    if (normalizedOwner.length === 0) {
      throw new IncidentLifecycleError("incident_invalid_filter", 400, "owner must be non-empty");
    }
    if (new TextEncoder().encode(normalizedOwner).byteLength > 256) {
      throw new IncidentLifecycleError("incident_invalid_filter", 400, "owner is too long");
    }
  }
  const unowned = boolFilter(url.searchParams.get("unowned"), "unowned");
  const overdue = boolFilter(url.searchParams.get("overdue"), "overdue");
  const observedAfterClose = boolFilter(url.searchParams.get("observedAfterClose"), "observedAfterClose");
  return {
    ...(state === null ? {} : { state: state as IncidentLifecycleState }),
    ...(owner === null ? {} : { owner: owner.trim() }),
    ...(unowned === undefined ? {} : { unowned }),
    ...(overdue === undefined ? {} : { overdue }),
    ...(observedAfterClose === undefined ? {} : { observedAfterClose }),
  };
}

function incidentIdentityFromPath(pathname: string): string {
  const encoded = pathname.slice("/maintenance/incidents/".length);
  if (encoded.length === 0 || encoded.includes("/")) {
    throw new IncidentLifecycleError("incident_route_not_found", 404, "Incident route not found");
  }
  try {
    return normalizeIncidentIdentity(decodeURIComponent(encoded));
  } catch {
    throw new IncidentLifecycleError("incident_invalid_request", 400, "Incident identity must be URI encoded");
  }
}

export function isIncidentMaintenancePath(pathname: string): boolean {
  return pathname === "/maintenance/incidents" || pathname.startsWith("/maintenance/incidents/");
}

export async function handleIncidentMaintenance(
  request: Request,
  env: IncidentMaintenanceEnvironment,
  serviceIdentityProvider: ServiceIdentityProvider,
): Promise<Response> {
  const token = configuredToken(env.INCIDENT_MAINTAINER_TOKEN);
  if (token === undefined) {
    return error(503, "incident_maintenance_unavailable", "Incident maintenance is not configured");
  }
  if (!(await authenticated(request, token))) {
    return error(401, "incident_auth_required", "A valid incident maintenance bearer token is required");
  }

  let serviceId: string;
  try {
    serviceId = requestServiceIdentity(request, serviceIdentityProvider, {
      allowG11Verification: env.G11_VERIFICATION_ENABLED === "true",
    });
  } catch {
    return error(503, "scope.identity_missing", "A deployment service identity is required for this scope");
  }
  if (env.D1 === undefined) {
    return error(503, "incident_maintenance_unavailable", "Incident maintenance storage is unavailable");
  }
  const lifecycle = new IncidentLifecycle(env.D1);
  const url = new URL(request.url);
  try {
    if (request.method === "GET" && url.pathname === "/maintenance/incidents") {
      return json(await lifecycle.list(serviceId, parseFilters(url)));
    }
    if (request.method === "GET" && url.pathname.startsWith("/maintenance/incidents/")) {
      return json(await lifecycle.detail(serviceId, incidentIdentityFromPath(url.pathname)));
    }
    if (request.method === "POST" && url.pathname === "/maintenance/incidents/transitions") {
      let body: unknown;
      try {
        body = await request.json<unknown>();
      } catch {
        return error(400, "incident_invalid_request", "Transition request must be JSON");
      }
      const requestValue = IncidentLifecycle.parseTransition(body);
      const actor = request.headers.get("x-sdt-maintainer");
      if (actor === null) {
        return error(400, "incident_invalid_actor", "x-sdt-maintainer is required");
      }
      return json(await lifecycle.transition(serviceId, requestValue, actor));
    }
    return error(404, "incident_route_not_found", "Incident maintenance route not found");
  } catch (caught) {
    if (caught instanceof IncidentLifecycleError) return error(caught.status, caught.code, caught.message);
    return error(500, "incident_maintenance_failed", "Incident maintenance could not complete the request");
  }
}
