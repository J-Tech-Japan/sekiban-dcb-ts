import { BindingExclusionLookupClient } from "../downstream/ExclusionLookup";
import { RepairWorker, RepairWorkerFailure, type RepairExecutionInput, type RepairFault, type RepairMode } from "../repair/RepairWorker";
import { cloudflareTracing } from "../trace/CloudflareTracing";

type JsonObject = Record<string, unknown>;

export interface OperatorRepairEnv {
  JOURNAL: DurableObjectNamespace;
  TAG: DurableObjectNamespace;
  REPAIR_OPERATOR_TOKEN: string;
  REPAIR_EXCLUSION_LOOKUP?: Fetcher;
  SDT_SERVICE_ID?: string;
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

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function uniqueStrings(value: unknown, name: string): { value?: string[]; error?: string } {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isNonEmptyString)) {
    return { error: `${name} must be a non-empty array of non-empty strings` };
  }
  if (new Set(value).size !== value.length) {
    return { error: `${name} values must be unique` };
  }
  return { value: [...value] };
}

function executionFrom(value: unknown, testFault?: RepairFault): { value?: RepairExecutionInput; error?: string } {
  if (!isObject(value) || !isNonEmptyString(value.actor)) {
    return { error: "actor is required" };
  }
  const attemptIds = uniqueStrings(value.attemptIds, "attemptIds");
  const tags = uniqueStrings(value.tags, "tags");
  if (attemptIds.value === undefined || tags.value === undefined) {
    return { error: attemptIds.error ?? tags.error };
  }
  const mode: RepairMode = value.mode === undefined ? "dry-run" : value.mode as RepairMode;
  if (mode !== "dry-run" && mode !== "execute") {
    return { error: "mode must be dry-run or execute" };
  }
  const maxItems = value.maxItems === undefined ? 100 : value.maxItems;
  if (typeof maxItems !== "number" || !Number.isSafeInteger(maxItems) || maxItems <= 0 || maxItems > 1_000) {
    return { error: "maxItems must be a positive safe integer no greater than 1000" };
  }
  if (value.checkpoint !== undefined && !isNonEmptyString(value.checkpoint)) {
    return { error: "checkpoint must be a non-empty string when present" };
  }
  return {
    value: {
      attemptIds: attemptIds.value,
      tags: tags.value,
      actor: value.actor,
      // Store an auditable operator identity, never the bearer secret itself.
      owner: `operator:${value.actor}`,
      mode,
      maxItems,
      ...(value.checkpoint === undefined ? {} : { checkpoint: value.checkpoint }),
      ...(testFault === undefined ? {} : { fault: testFault }),
    },
  };
}

function testFaultFromRequest(request: Request): RepairFault | undefined {
  if (new URL(request.url).hostname !== "repair.test") {
    return undefined;
  }
  const value = request.headers.get("x-sdt-g6-test-fault");
  return value === "after-lease-before-prepare" ||
    value === "after-prepare-before-apply" ||
    value === "after-apply-before-observation" ||
    value === "after-verify-before-audit" ||
    value === "after-audit-before-clear" ||
    value === "after-clear-before-final-observation"
    ? value
    : undefined;
}

/** Authenticated, bounded control-plane command; it is not a V1 public wire endpoint. */
export async function handleOperatorRepair(request: Request, env: OperatorRepairEnv): Promise<Response> {
  if (request.method !== "POST") {
    return error(404, "operator_repair_route_not_found", "Operator repair requires POST");
  }
  const token = env.REPAIR_OPERATOR_TOKEN;
  if (!isNonEmptyString(token) || request.headers.get("authorization") !== `Bearer ${token}`) {
    return error(401, "operator_auth_required", "A valid operator repair bearer token is required");
  }
  let body: unknown;
  try {
    body = await request.json<unknown>();
  } catch {
    return error(400, "invalid_operator_repair_request", "Operator repair request must be JSON");
  }
  const parsed = executionFrom(body, testFaultFromRequest(request));
  if (parsed.value === undefined) {
    return error(400, "invalid_operator_repair_request", parsed.error ?? "Invalid operator repair request");
  }
  try {
    const worker = new RepairWorker(
      env,
      new BindingExclusionLookupClient(env.REPAIR_EXCLUSION_LOOKUP),
      env.SDT_SERVICE_ID,
      { nativeTracing: cloudflareTracing() },
    );
    const result = await worker.execute(parsed.value);
    return json(result, result.interrupted === undefined ? 200 : 202);
  } catch (failure) {
    const message = failure instanceof RepairWorkerFailure
      ? failure.message
      : "Operator repair could not determine a durable repair result";
    return error(500, "operator_repair_failed", message);
  }
}
