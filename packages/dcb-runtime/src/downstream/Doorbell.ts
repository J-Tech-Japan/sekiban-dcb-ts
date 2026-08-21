import type { DownstreamOutboxMessage } from "./types";

export type DeliveryClass = "immediate-preferred" | "queued";
export type DirectDoorbellDegradation = "fail-fast" | "queued-degraded";
export type DirectDoorbellReceiverMode = "separate" | "self";
export type DirectDoorbellFailureKind = "non-2xx" | "throw" | "timeout" | "cancel";

/** Structural RPC surface used by a non-public Worker service binding. */
export interface DownstreamDoorbellBinding {
  deliver(message: DownstreamOutboxMessage): Promise<unknown>;
}

export interface DirectDoorbellDeploymentConfig {
  readonly deliveryClass: DeliveryClass;
  readonly enabled: boolean;
  readonly allowedViews: readonly string[];
  readonly maxServiceBindingInvocations: number;
  readonly degradation: DirectDoorbellDegradation;
  readonly receiverMode: DirectDoorbellReceiverMode;
  readonly selfBindingPreflightProof: boolean;
}

export interface DirectDoorbellPreflightResult {
  readonly status: "ready" | "queued-degraded" | "fail-fast" | "disabled";
  readonly reason: string;
  readonly estimatedInvocations: number;
  readonly topologyInvocations: number;
  readonly allowedViews: readonly string[];
}

export const MAX_SERVICE_BINDING_INVOCATIONS_PER_REQUEST = 32;

export function classifyDirectDoorbellFailure(error: unknown): DirectDoorbellFailureKind {
  const value = String(error).toLowerCase();
  if (value.includes("timeout") || value.includes("deadline")) return "timeout";
  if (value.includes("cancel") || value.includes("abort")) return "cancel";
  if (value.includes("non-2xx") || value.includes("status 4") || value.includes("status 5")) return "non-2xx";
  return "throw";
}

function envString(env: Record<string, unknown>, key: string): string | undefined {
  const value = env[key];
  return typeof value === "string" ? value : undefined;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${value} is not a boolean deployment setting`);
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.length === 0) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive safe integer`);
  return parsed;
}

function parseAllowedViews(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim().length === 0) return [];
  return [...new Set(value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
}

/** Resolve the deployment half of the two-layer opt-in without touching a V1 body. */
export function readDirectDoorbellConfig(
  env: Record<string, unknown>,
  domainDeliveryClass: DeliveryClass = "queued",
): DirectDoorbellDeploymentConfig {
  const deliveryClassValue = envString(env, "DELIVERY_CLASS");
  const deliveryClass = deliveryClassValue === undefined
    ? domainDeliveryClass
    : deliveryClassValue === "queued" || deliveryClassValue === "immediate-preferred"
      ? deliveryClassValue
      : (() => { throw new Error("DELIVERY_CLASS must be queued or immediate-preferred"); })();
  const receiverModeValue = envString(env, "DIRECT_DOORBELL_RECEIVER_MODE") ?? "separate";
  if (receiverModeValue !== "separate" && receiverModeValue !== "self") {
    throw new Error("DIRECT_DOORBELL_RECEIVER_MODE must be separate or self");
  }
  const degradationValue = envString(env, "DIRECT_DOORBELL_DEGRADATION") ?? "fail-fast";
  if (degradationValue !== "fail-fast" && degradationValue !== "queued-degraded") {
    throw new Error("DIRECT_DOORBELL_DEGRADATION must be fail-fast or queued-degraded");
  }
  return {
    deliveryClass,
    enabled: parseBoolean(envString(env, "DIRECT_DOORBELL"), false),
    allowedViews: parseAllowedViews(envString(env, "DIRECT_DOORBELL_ALLOWED_VIEWS")),
    maxServiceBindingInvocations: parsePositiveInteger(
      envString(env, "DIRECT_DOORBELL_MAX_INVOCATIONS"),
      MAX_SERVICE_BINDING_INVOCATIONS_PER_REQUEST,
      "DIRECT_DOORBELL_MAX_INVOCATIONS",
    ),
    degradation: degradationValue,
    receiverMode: receiverModeValue,
    selfBindingPreflightProof: parseBoolean(envString(env, "DIRECT_DOORBELL_SELF_BINDING_PROOF"), false),
  };
}

/**
 * Deployment preflight is intentionally pure so CI can exercise it without a
 * live Worker. The conservative topology count is retained even when the
 * default separate receiver reduces actual per-request recursion risk.
 */
export function preflightDirectDoorbell(
  config: DirectDoorbellDeploymentConfig,
  configuredImmediateViewCount = config.allowedViews.length,
): DirectDoorbellPreflightResult {
  const topologyInvocations = Math.max(1, configuredImmediateViewCount + 1);
  const estimatedInvocations = topologyInvocations;
  const degrade = (reason: string): DirectDoorbellPreflightResult => ({
    status: config.degradation === "queued-degraded" ? "queued-degraded" : "fail-fast",
    reason,
    estimatedInvocations,
    topologyInvocations,
    allowedViews: config.allowedViews,
  });
  if (config.deliveryClass === "queued") {
    return {
      status: "disabled",
      reason: "domain_delivery_class_queued",
      estimatedInvocations,
      topologyInvocations,
      allowedViews: config.allowedViews,
    };
  }
  if (!config.enabled) return degrade("deployment_direct_doorbell_disabled");
  if (config.allowedViews.length === 0) return degrade("immediate_preferred_requires_allowed_views");
  if (config.maxServiceBindingInvocations > MAX_SERVICE_BINDING_INVOCATIONS_PER_REQUEST) {
    return degrade("configured_service_binding_budget_exceeds_platform_limit");
  }
  if (topologyInvocations > config.maxServiceBindingInvocations || topologyInvocations > MAX_SERVICE_BINDING_INVOCATIONS_PER_REQUEST) {
    return degrade("configured_immediate_view_topology_exceeds_service_binding_budget");
  }
  if (config.receiverMode === "self" && !config.selfBindingPreflightProof) {
    return degrade("self_binding_requires_recursion_and_route_privacy_preflight_proof");
  }
  return {
    status: "ready",
    reason: "direct_doorbell_capability_ready",
    estimatedInvocations,
    topologyInvocations,
    allowedViews: config.allowedViews,
  };
}

export function selectDirectDoorbellViews<T extends { readonly id: string }>(
  views: readonly T[],
  config: DirectDoorbellDeploymentConfig,
): readonly T[] {
  if (config.deliveryClass !== "immediate-preferred" || !config.enabled) return [];
  const allowed = new Set(config.allowedViews);
  return views.filter((view) => allowed.has(view.id));
}

/** Stable bytes used by local and deployed byte-equality oracles. */
export function downstreamEnvelopeBytes(message: DownstreamOutboxMessage): string {
  return JSON.stringify(message);
}
