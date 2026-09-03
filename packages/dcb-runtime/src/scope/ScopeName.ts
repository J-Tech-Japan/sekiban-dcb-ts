/**
 * The one durable-object physical-name grammar used by the runtime.
 *
 * A scope name is deliberately not an application protocol value: C-0 makes
 * old Durable Object instances unreachable when this grammar changes.  The
 * service, class, and identity parts remain individually inspectable while
 * `/` is the only grammar separator.
 */

export const DURABLE_OBJECT_SCOPE_CLASSES = Object.freeze([
  "tag",
  "tag-state",
  "allocator",
  "bootstrap",
  "journal",
] as const);

export type DurableObjectScopeClass = (typeof DURABLE_OBJECT_SCOPE_CLASSES)[number];

export interface DurableObjectScope {
  readonly serviceId: string;
  readonly doClass: DurableObjectScopeClass;
  readonly identity: string;
}

export class ScopeNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeNameError";
  }
}

/** The existing deploy-time SDT_SERVICE_ID grammar, shared by scope names. */
export function isScopeServiceId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value);
}

function isScopeClass(value: string): value is DurableObjectScopeClass {
  return (DURABLE_OBJECT_SCOPE_CLASSES as readonly string[]).includes(value);
}

function requireScope(scope: DurableObjectScope): DurableObjectScope {
  if (!isScopeServiceId(scope.serviceId)) {
    throw new ScopeNameError("serviceId must be a valid non-empty deployment service identity");
  }
  if (!isScopeClass(scope.doClass)) {
    throw new ScopeNameError("doClass is not a registered Durable Object scope class");
  }
  if (scope.identity.length === 0 || scope.identity.includes("/")) {
    throw new ScopeNameError("identity must be a non-empty string without '/'");
  }
  return scope;
}

/** Builds the canonical `${serviceId}/${doClass}/${identity}` physical name. */
export function buildScopeName(scope: DurableObjectScope): string {
  const value = requireScope(scope);
  return `${value.serviceId}/${value.doClass}/${value.identity}`;
}

/** Parses and fully validates one canonical Durable Object physical name. */
export function parseScopeName(name: string): DurableObjectScope {
  const parts = name.split("/");
  if (parts.length !== 3) {
    throw new ScopeNameError("scope name must contain exactly three slash-delimited parts");
  }
  return requireScope({
    serviceId: parts[0]!,
    doClass: parts[1]! as DurableObjectScopeClass,
    identity: parts[2]!,
  });
}

/**
 * Keep the platform namespace call in this module so all runtime call sites
 * first pass through the one public grammar above.
 */
export interface ScopeNameNamespace<Id> {
  idFromName(name: string): Id;
}

export function scopeIdFor<Id>(namespace: ScopeNameNamespace<Id>, scope: DurableObjectScope): Id {
  return namespace.idFromName(buildScopeName(scope));
}

/** A stable component encoding inside the single opaque tag-state identity. */
export function tagStateScopeIdentity(tag: string, projectorId: string): string {
  if (tag.length === 0 || projectorId.length === 0) {
    throw new ScopeNameError("tag-state scope requires non-empty tag and projector identity");
  }
  return `${encodeURIComponent(tag)}:${encodeURIComponent(projectorId)}`;
}
