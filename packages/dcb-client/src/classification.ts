import { ClientError, sanitizeTransportError } from "./errors.js";

/** The result kinds a failure can take in either executor. */
export type FailureKind = "timeout" | "unavailable" | "partial" | "conflict" | "transport" | "rejected" | "invalid";

/**
 * SDT-G86: the one code-to-kind table shared by `ClaimLedgerExecutor` and
 * `SekibanExecutor`. Each kind follows the SDT-G78 class of the code
 * (`docs/SDT-G78-evidence.md`): caller-abort and deadline/unknown codes are
 * `timeout` or `unavailable`, definite refusals are `invalid`, `rejected`,
 * `conflict` or `partial`, and malformed/unknown codes are `transport`.
 * `scripts/g78-error-classification-guard.mjs` imports the built module and
 * fails when a source-derived code has no kind or a kind outside its class.
 */
export const FAILURE_KINDS: Readonly<Record<string, FailureKind>> = Object.freeze({
  aborted: "timeout",
  timeout: "timeout",
  unknown_outcome: "timeout",
  projection_unavailable: "unavailable",
  read_unavailable: "unavailable",
  partial_write: "partial",
  consistency_conflict: "conflict",
  transport: "transport",
  http_error: "transport",
  invalid_read_snapshot: "transport",
  incoherent_read_snapshot: "transport",
  invalid_query_response: "transport",
  invalid_command_result: "transport",
  authority_unavailable: "transport",
  "credential.rejected": "rejected",
  command_rejected: "rejected",
  assert_empty_failed: "invalid",
  claim_not_in_candidate_tags: "invalid",
  domain_authoring_error: "invalid",
  duplicate_consistency_entry: "invalid",
  invalid_command_input: "invalid",
  invalid_consistency: "invalid",
  invalid_execute_options: "invalid",
  invalid_query_request: "invalid",
  "scope.mismatch": "invalid",
  unsupported_command: "invalid",
  unsupported_capability: "invalid",
  unsupported_consistency_mode: "invalid",
});

export function failureKindForCode(code: string): FailureKind | undefined {
  return Object.prototype.hasOwnProperty.call(FAILURE_KINDS, code) ? FAILURE_KINDS[code] : undefined;
}

export interface ClassifiedFailure {
  readonly kind: FailureKind;
  readonly code: string;
  readonly status?: number;
  readonly error: string;
  /** Validated partial-write facts; present only for kind `partial`. */
  readonly partial?: unknown;
}

/**
 * Classify a failure by the code of its public `ClientError`. A client error
 * with a classified code is used as it is; anything else crosses the
 * sanitizer first, so an unknown or foreign code fails closed to `transport`.
 */
export function classifyFailure(error: unknown): ClassifiedFailure {
  const publicError = error instanceof ClientError && failureKindForCode(error.code) !== undefined
    ? error
    : sanitizeTransportError(error, { fallbackCode: "transport" });
  const kind = failureKindForCode(publicError.code) ?? "transport";
  return {
    kind,
    code: publicError.code,
    status: publicError.status,
    error: publicError.message,
    ...(kind === "partial" ? { partial: publicError.partial } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function carriesCode(reply: Record<string, unknown>): boolean {
  return (isRecord(reply.body) && typeof reply.body.code === "string") || typeof reply.code === "string";
}

/**
 * The public error for a non-2xx commit reply. A reply that carries a code is
 * sanitized as it is (an unknown code becomes `transport`). Without a code, a
 * status of 500 or above is `unknown_outcome` because the write may have
 * happened; below 500 it is `http_error`, except 409 which is
 * `consistency_conflict`. Reads keep the sanitizer's own status fallback.
 */
export function commitReplyError(reply: { readonly status: number; readonly body?: unknown }): ClientError {
  const record = reply as unknown as Record<string, unknown>;
  if (!carriesCode(record) && reply.status >= 500) {
    return sanitizeTransportError(reply, { fallbackCode: "unknown_outcome", status: reply.status });
  }
  return sanitizeTransportError(reply, { fallbackCode: "http_error", status: reply.status });
}
