const SAFE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  aborted: "The request was aborted",
  // G71's published authority wire shape predates this boundary sanitizer.
  // Keep that documented code finite and stable while still replacing its
  // transport-supplied message with this canonical safe wording.
  authority_unavailable: "The read authority is unavailable",
  assert_empty_failed: "The tag-state was not empty",
  claim_not_in_candidate_tags: "The consistency claim is not covered by the candidate tags",
  command_rejected: "The command was rejected",
  consistency_conflict: "The command conflicted with current state",
  "credential.rejected": "Credentials were rejected",
  duplicate_consistency_entry: "The commit contained duplicate consistency entries",
  http_error: "The HTTP response was not successful",
  incoherent_read_snapshot: "The read observations were incoherent",
  invalid_command_input: "The command input was invalid",
  invalid_command_result: "The command result was invalid",
  invalid_consistency: "The consistency option was invalid",
  invalid_query_request: "The query request was invalid",
  invalid_query_response: "The query response was invalid",
  invalid_read_snapshot: "The read snapshot was invalid",
  partial_write: "The command was partially written",
  projection_unavailable: "The mapped query projection is unavailable",
  "scope.mismatch": "The executor and transport scopes do not match",
  timeout: "Execution timed out",
  transport: "Transport request failed",
  unknown_outcome: "The command outcome is unknown",
  unsupported_capability: "The transport lacks a required capability",
  unsupported_consistency_mode: "Consistency is unsupported for this read",
  read_unavailable: "The read did not reach a coherent authority",
});

const KNOWN_CODES = new Set(Object.keys(SAFE_MESSAGES));

export class ClientError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly partial?: unknown;

  constructor(code: string, message: string, options?: { readonly status?: number; readonly partial?: unknown; readonly cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ClientError";
    this.code = code;
    this.status = options?.status;
    this.partial = options?.partial;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

function safeStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > 4096) return undefined;
  if (!value.every((item) => typeof item === "string" && item.length <= 512)) return undefined;
  return Object.freeze([...value]);
}

function safePartial(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  const result: Record<string, unknown> = {};
  for (const key of ["writtenEventIds", "failedEventIds", "writtenTags", "missingTags"]) {
    const entries = safeStringArray(value[key]);
    if (entries !== undefined) result[key] = entries;
  }
  for (const key of ["retryable", "eventsDeleted", "committed"]) {
    if (typeof value[key] === "boolean") result[key] = value[key];
  }
  return Object.keys(result).length === 0 ? undefined : Object.freeze(result);
}

function canonicalMessage(code: string, rawMessage: unknown): string {
  // The raw value is deliberately accepted only so callers can pass through a
  // foreign error without first inspecting its message. It is never returned.
  void rawMessage;
  return SAFE_MESSAGES[code] ?? SAFE_MESSAGES.transport;
}

function abortLike(value: unknown): boolean {
  return isRecord(value) && value.name === "AbortError";
}

function bodyOf(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return value !== undefined && isRecord(value.body) ? value.body : undefined;
}

export interface TransportErrorSanitizationOptions {
  /** Fallback used when the transport supplied no documented error code. */
  readonly fallbackCode?: string;
  /** HTTP status supplied by the transport envelope, when applicable. */
  readonly status?: unknown;
}

/**
 * Convert an error crossing an injected transport boundary into a fresh,
 * finite-shape public error. Raw messages, headers, causes, and extension
 * fields are intentionally not copied. Only validated partial-write facts are
 * retained because callers use them to avoid blind retries.
 */
export function sanitizeTransportError(
  error: unknown,
  options: TransportErrorSanitizationOptions = {},
): ClientError {
  const source = isRecord(error) ? error : undefined;
  const body = bodyOf(source);
  const rawCode = body !== undefined && typeof body.code === "string"
    ? body.code
    : source !== undefined && typeof source.code === "string" ? source.code : undefined;
  const rawMessage = body !== undefined ? body.error : source?.message;
  const status = boundedStatus(options.status !== undefined ? options.status : source?.status);
  const explicitUnknownCode = rawCode !== undefined && !KNOWN_CODES.has(rawCode);
  let code: string;
  if (abortLike(error)) {
    code = "aborted";
  } else if (explicitUnknownCode) {
    code = "transport";
  } else if (rawCode !== undefined && KNOWN_CODES.has(rawCode)) {
    code = rawCode;
  } else if (options.fallbackCode !== undefined && KNOWN_CODES.has(options.fallbackCode)) {
    if (options.fallbackCode === "http_error" && status === 504) code = "unknown_outcome";
    else if (options.fallbackCode === "http_error" && status === 503) code = "projection_unavailable";
    else if (options.fallbackCode === "http_error" && status === 409) code = "consistency_conflict";
    else code = options.fallbackCode;
  } else {
    code = "transport";
  }
  const rawPartial = body !== undefined ? body.partial : source?.partial;
  const partial = code === "partial_write" ? safePartial(rawPartial) : undefined;
  const safeOptions = {
    ...(status === undefined ? {} : { status }),
    ...(partial === undefined ? {} : { partial }),
  };
  return new ClientError(code, canonicalMessage(code, rawMessage), safeOptions);
}
