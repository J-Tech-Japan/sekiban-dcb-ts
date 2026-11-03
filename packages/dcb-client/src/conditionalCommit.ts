import {
  CONDITIONAL_COMMIT_VERSION,
  ConditionalCommitProtocolError,
  canonicalizeConditionalCommitPayload,
  defineTag,
  parseSerializedConditionalCommitRequest,
} from "@sekiban/dcb-core";
import type {
  ConditionalCommitInDoubtReason,
  ConditionalCommitResult,
  ConditionalCommitValidationCode,
  ConditionalWrittenEvent,
  EventDefinition,
  JsonValue,
  SerializedConditionalCommitRequest,
  TagInput,
} from "@sekiban/dcb-core";
import type { CommitHttpResult, SerializedDcbTransport } from "./index.js";
import { ClientError, sanitizeTransportError } from "./errors.js";

export type { SerializedConditionalCommitRequest };

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const VALIDATION_CODES = [
  "conditional_commit_invalid_json",
  "conditional_commit_unknown_member",
  "conditional_commit_invalid_version",
  "conditional_commit_invalid_envelope",
  "conditional_commit_invalid_key",
  "conditional_commit_invalid_candidate",
  "conditional_commit_invalid_base64",
  "conditional_commit_invalid_utf8",
  "conditional_commit_invalid_payload_json",
  "conditional_commit_payload_root_not_object",
  "conditional_commit_payload_not_canonicalizable",
  "conditional_commit_event_not_registered",
  "conditional_commit_invalid_tag_count",
  "conditional_commit_size_limit_exceeded",
] as const satisfies readonly ConditionalCommitValidationCode[];

const IN_DOUBT_REASONS = [
  "winner_unreadable",
  "ambiguous_after_append",
  "committed_state_unverified",
  "live_precondition_blocked",
  "bootstrap_epoch_changed",
] as const satisfies readonly ConditionalCommitInDoubtReason[];

const KEY_REUSE_MESSAGE = "The idempotency key is already bound to a different operation.";
const UNSUPPORTED_MESSAGE = "Conditional commit is not supported by this deployment.";
const IN_DOUBT_MESSAGE = "The conditional commit outcome is not yet verified; resend the same prepared request.";
const CORRUPT_MESSAGE = "The durable conditional commit state could not be verified.";
const INVALID_RESPONSE_MESSAGE = "The conditional commit response is invalid.";
const INVALID_ERROR_RESPONSE_MESSAGE = "The conditional commit error response is invalid.";

const preparedConditionalCommitBrand: unique symbol = Symbol("sekiban.dcb.preparedConditionalCommit");

export interface ConditionalCommitInput<TPayload extends JsonValue = JsonValue> {
  readonly idempotencyKey: string;
  readonly event: EventDefinition<TPayload>;
  readonly payload: unknown;
  readonly tag: TagInput;
}

export interface ConditionalCommitOptions {
  readonly signal?: AbortSignal;
}

export type PreparedConditionalCommit = Readonly<SerializedConditionalCommitRequest> & {
  readonly [preparedConditionalCommitBrand]: true;
};

const UNSUPPORTED_RESULT: ConditionalCommitResult = {
  version: 1,
  outcome: "Unsupported",
  code: "conditional_commit_unsupported",
  error: UNSUPPORTED_MESSAGE,
  retryable: false,
};

function validationMessage(code: ConditionalCommitValidationCode): string {
  return new ConditionalCommitProtocolError(code).message;
}

function clientError(code: ConditionalCommitValidationCode): ClientError {
  return new ClientError(code, validationMessage(code));
}

function toClient(error: ConditionalCommitProtocolError): ClientError {
  return new ClientError(error.code, error.message);
}

function isValidationCode(value: unknown): value is ConditionalCommitValidationCode {
  return typeof value === "string" && (VALIDATION_CODES as readonly string[]).includes(value);
}

function isInDoubtReason(value: unknown): value is ConditionalCommitInDoubtReason {
  return typeof value === "string" && (IN_DOUBT_REASONS as readonly string[]).includes(value);
}

function encodeBase64(bytes: Uint8Array): string {
  let output = "";
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const chunk = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    output += BASE64_ALPHABET[(chunk >>> 18) & 63]
      + BASE64_ALPHABET[(chunk >>> 12) & 63]
      + BASE64_ALPHABET[(chunk >>> 6) & 63]
      + BASE64_ALPHABET[chunk & 63];
  }
  if (index < bytes.length) {
    const first = bytes[index] ?? 0;
    const second = index + 1 < bytes.length ? bytes[index + 1] ?? 0 : 0;
    const chunk = (first << 16) | (second << 8);
    output += BASE64_ALPHABET[(chunk >>> 18) & 63];
    output += BASE64_ALPHABET[(chunk >>> 12) & 63];
    output += index + 1 < bytes.length ? BASE64_ALPHABET[(chunk >>> 6) & 63] : "=";
    output += "=";
  }
  return output;
}

function isCanonicalBase64(text: unknown): text is string {
  if (typeof text !== "string" || text.length === 0 || text.length % 4 !== 0) return false;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const body = text.slice(0, text.length - padding);
  if ([...body].some((char) => !BASE64_ALPHABET.includes(char))) return false;
  const decodedLength = (text.length / 4) * 3 - padding;
  const bytes = new Uint8Array(decodedLength);
  let offset = 0;
  for (let index = 0; index < text.length; index += 4) {
    const last = index + 4 >= text.length;
    const values = [0, 1, 2, 3].map((shift) => {
      const char = text[index + shift] ?? "";
      if (last && char === "=") return 0;
      const found = BASE64_ALPHABET.indexOf(char);
      return found;
    });
    if (values.some((value) => value < 0)) return false;
    const chunk = ((values[0] ?? 0) << 18) | ((values[1] ?? 0) << 12) | ((values[2] ?? 0) << 6) | (values[3] ?? 0);
    const produced = last ? 3 - padding : 3;
    bytes[offset] = (chunk >>> 16) & 0xff;
    if (produced > 1) bytes[offset + 1] = (chunk >>> 8) & 0xff;
    if (produced > 2) bytes[offset + 2] = chunk & 0xff;
    offset += produced;
  }
  return offset === decodedLength && encodeBase64(bytes) === text;
}

function freezeGraph(value: unknown, seen: WeakSet<object> = new WeakSet()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) freezeGraph(descriptor.value, seen);
  }
}

freezeGraph(UNSUPPORTED_RESULT);

function isPrepared(value: object): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, preparedConditionalCommitBrand);
  return descriptor !== undefined && descriptor.enumerable === false && descriptor.value === true;
}

function assertShell(input: ConditionalCommitInput<JsonValue>): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw clientError("conditional_commit_invalid_envelope");
  }
  if (typeof input.idempotencyKey !== "string") throw clientError("conditional_commit_invalid_key");
  const event: unknown = input.event;
  if (typeof event !== "object" || event === null || typeof (event as { parse?: unknown }).parse !== "function") {
    throw clientError("conditional_commit_invalid_candidate");
  }
  if (typeof input.event.eventPayloadName !== "string") throw clientError("conditional_commit_invalid_candidate");
  if (!Object.prototype.hasOwnProperty.call(input, "tag") && !("tag" in input)) {
    throw clientError("conditional_commit_invalid_candidate");
  }
}

export function prepareConditionalCommit<T extends JsonValue>(
  input: ConditionalCommitInput<T>,
): PreparedConditionalCommit {
  assertShell(input);
  let parsed: unknown;
  try {
    parsed = input.event.parse(input.payload);
  } catch (error) {
    if (error instanceof ConditionalCommitProtocolError) throw toClient(error);
    throw clientError("conditional_commit_invalid_candidate");
  }
  let canonical: Uint8Array;
  try {
    canonical = canonicalizeConditionalCommitPayload(parsed);
  } catch (error) {
    if (error instanceof ConditionalCommitProtocolError) throw toClient(error);
    throw clientError("conditional_commit_payload_not_canonicalizable");
  }
  const payload = encodeBase64(canonical);
  let tag: string;
  try {
    tag = defineTag(input.tag).tag;
  } catch (error) {
    if (error instanceof ConditionalCommitProtocolError) throw toClient(error);
    throw clientError("conditional_commit_invalid_candidate");
  }
  let validated: SerializedConditionalCommitRequest;
  try {
    validated = parseSerializedConditionalCommitRequest({
      version: CONDITIONAL_COMMIT_VERSION,
      idempotencyKey: input.idempotencyKey,
      eventCandidate: {
        payload,
        eventPayloadName: input.event.eventPayloadName,
        tags: [tag],
      },
    });
  } catch (error) {
    if (error instanceof ConditionalCommitProtocolError) throw toClient(error);
    throw clientError("conditional_commit_invalid_candidate");
  }
  Object.defineProperty(validated, preparedConditionalCommitBrand, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  freezeGraph(validated);
  return validated as PreparedConditionalCommit;
}

function boundedStatus(status: number): number | undefined {
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

function invalidResponse(status: number): never {
  const statusOption = boundedStatus(status);
  throw new ClientError(
    "conditional_commit_invalid_response",
    INVALID_RESPONSE_MESSAGE,
    statusOption === undefined ? undefined : { status: statusOption },
  );
}

function invalidError(status: number): never {
  const statusOption = boundedStatus(status);
  throw new ClientError(
    "conditional_commit_invalid_error_response",
    INVALID_ERROR_RESPONSE_MESSAGE,
    statusOption === undefined ? undefined : { status: statusOption },
  );
}

function closed(value: unknown, keys: readonly string[], reject: () => never): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) reject();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) reject();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length) reject();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (!own.includes(key)) reject();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || descriptor.get !== undefined
      || descriptor.set !== undefined
      || !("value" in descriptor)
    ) {
      reject();
    }
    result[key] = descriptor.value;
  }
  return result;
}

function closedItems(value: unknown, length: number, reject: () => never): unknown[] {
  if (!Array.isArray(value) || value.length !== length) reject();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) reject();
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined
    || lengthDescriptor.enumerable === true
    || lengthDescriptor.get !== undefined
    || lengthDescriptor.set !== undefined
  ) {
    reject();
  }
  const indexKeys = keys.filter((key) => key !== "length");
  if (indexKeys.length !== length) reject();
  const items: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    if (!indexKeys.includes(String(index))) reject();
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || descriptor.get !== undefined
      || descriptor.set !== undefined
      || !("value" in descriptor)
    ) {
      reject();
    }
    items.push(descriptor.value);
  }
  return items;
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT = /^[0-9a-f]{64}$/;

function uuidV7(value: unknown): value is string {
  return typeof value === "string" && UUID_V7.test(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function readReceipt(value: unknown, reject: () => never) {
  const record = closed(value, ["winnerEventId", "winnerSortableUniqueId", "operationFingerprint"], reject);
  if (!uuidV7(record.winnerEventId) || !nonEmpty(record.winnerSortableUniqueId) || typeof record.operationFingerprint !== "string" || !FINGERPRINT.test(record.operationFingerprint)) {
    reject();
  }
  return {
    winnerEventId: record.winnerEventId,
    winnerSortableUniqueId: record.winnerSortableUniqueId,
    operationFingerprint: record.operationFingerprint,
  };
}

function readWrittenEvent(value: unknown, reject: () => never): ConditionalWrittenEvent {
  const record = closed(value, ["payload", "sortableUniqueIdValue", "id", "eventMetadata", "tags", "eventPayloadName"], reject);
  const metadata = closed(record.eventMetadata, ["causationId", "correlationId", "executedUser"], reject);
  const tags = closedItems(record.tags, 1, reject);
  const tag = tags[0];
  if (
    !isCanonicalBase64(record.payload)
    || !nonEmpty(record.sortableUniqueIdValue)
    || !uuidV7(record.id)
    || !nonEmpty(metadata.causationId)
    || metadata.correlationId !== "SerializedCommit"
    || metadata.executedUser !== "SerializedSekibanExecutor"
    || typeof tag !== "string"
    || tag.length === 0
    || !nonEmpty(record.eventPayloadName)
  ) {
    reject();
  }
  return {
    payload: record.payload,
    sortableUniqueIdValue: record.sortableUniqueIdValue,
    id: record.id,
    eventMetadata: {
      causationId: metadata.causationId,
      correlationId: "SerializedCommit",
      executedUser: "SerializedSekibanExecutor",
    },
    tags: [tag],
    eventPayloadName: record.eventPayloadName,
  };
}

function readAppended(body: unknown, status: number): ConditionalCommitResult {
  const record = closed(body, ["version", "outcome", "receipt", "writtenEvents"], () => invalidResponse(status));
  if (record.version !== 1 || record.outcome !== "Appended") invalidResponse(status);
  const receipt = readReceipt(record.receipt, () => invalidResponse(status));
  const events = closedItems(record.writtenEvents, 1, () => invalidResponse(status));
  const written = readWrittenEvent(events[0], () => invalidResponse(status));
  if (written.id !== receipt.winnerEventId || written.sortableUniqueIdValue !== receipt.winnerSortableUniqueId) {
    invalidResponse(status);
  }
  const result: ConditionalCommitResult = {
    version: 1,
    outcome: "Appended",
    receipt,
    writtenEvents: [written],
  };
  freezeGraph(result);
  return result;
}

function readAlready(body: unknown, status: number): ConditionalCommitResult {
  const record = closed(body, ["version", "outcome", "receipt", "writtenEvents"], () => invalidResponse(status));
  if (record.version !== 1 || record.outcome !== "AlreadyCommittedSameOperation") invalidResponse(status);
  const receipt = readReceipt(record.receipt, () => invalidResponse(status));
  closedItems(record.writtenEvents, 0, () => invalidResponse(status));
  const result: ConditionalCommitResult = {
    version: 1,
    outcome: "AlreadyCommittedSameOperation",
    receipt,
    writtenEvents: [],
  };
  freezeGraph(result);
  return result;
}

function readConflict(body: unknown, status: number): ConditionalCommitResult {
  const record = closed(body, ["version", "outcome", "code", "error", "retryable"], () => invalidError(status));
  if (
    record.version !== 1
    || record.outcome !== "KeyReuseConflict"
    || record.code !== "conditional_commit_key_reuse_conflict"
    || record.error !== KEY_REUSE_MESSAGE
    || record.retryable !== false
  ) {
    invalidError(status);
  }
  const result: ConditionalCommitResult = {
    version: 1,
    outcome: "KeyReuseConflict",
    code: "conditional_commit_key_reuse_conflict",
    error: KEY_REUSE_MESSAGE,
    retryable: false,
  };
  freezeGraph(result);
  return result;
}

function readUnsupported(body: unknown, status: number): ConditionalCommitResult {
  const record = closed(body, ["version", "outcome", "code", "error", "retryable"], () => invalidError(status));
  if (
    record.version !== 1
    || record.outcome !== "Unsupported"
    || record.code !== "conditional_commit_unsupported"
    || record.error !== UNSUPPORTED_MESSAGE
    || record.retryable !== false
  ) {
    invalidError(status);
  }
  const result: ConditionalCommitResult = {
    version: 1,
    outcome: "Unsupported",
    code: "conditional_commit_unsupported",
    error: UNSUPPORTED_MESSAGE,
    retryable: false,
  };
  freezeGraph(result);
  return result;
}

function throwValidation(body: unknown, status: number): never {
  const record = closed(body, ["version", "code", "error", "retryable"], () => invalidError(status));
  if (record.version !== 1 || !isValidationCode(record.code) || record.error !== validationMessage(record.code) || record.retryable !== false) {
    invalidError(status);
  }
  throw new ClientError(record.code, validationMessage(record.code), { status: 400 });
}

function throwInDoubt(body: unknown, status: number): never {
  const record = closed(body, ["version", "code", "error", "retryable", "reason"], () => invalidError(status));
  if (
    record.version !== 1
    || record.code !== "conditional_commit_in_doubt"
    || record.error !== IN_DOUBT_MESSAGE
    || record.retryable !== true
    || !isInDoubtReason(record.reason)
  ) {
    invalidError(status);
  }
  throw new ClientError("conditional_commit_in_doubt", IN_DOUBT_MESSAGE, {
    status: 503,
    retryable: true,
    reason: record.reason,
  });
}

function throwCorrupt(body: unknown, status: number): never {
  const record = closed(body, ["version", "code", "error", "retryable"], () => invalidError(status));
  if (
    record.version !== 1
    || record.code !== "conditional_commit_committed_state_corrupt"
    || record.error !== CORRUPT_MESSAGE
    || record.retryable !== false
  ) {
    invalidError(status);
  }
  throw new ClientError("conditional_commit_committed_state_corrupt", CORRUPT_MESSAGE, { status: 500 });
}

export function parseConditionalCommitHttpResult(result: CommitHttpResult): ConditionalCommitResult {
  const status = result.status;
  if (status === 201) return readAppended(result.body, status);
  if (status === 200) return readAlready(result.body, status);
  if (status === 409) return readConflict(result.body, status);
  if (status === 501) return readUnsupported(result.body, status);
  if (status === 400) throwValidation(result.body, status);
  if (status === 503) throwInDoubt(result.body, status);
  if (status === 500) throwCorrupt(result.body, status);
  if (typeof status === "number" && status >= 200 && status < 300) invalidResponse(status);
  throw sanitizeTransportError(result, { status, fallbackCode: "http_error" });
}

export async function commitPreparedConditionallyThroughTransport(
  transport: SerializedDcbTransport,
  request: PreparedConditionalCommit,
  options?: ConditionalCommitOptions,
): Promise<ConditionalCommitResult> {
  if (typeof request !== "object" || request === null || !isPrepared(request)) {
    throw clientError("conditional_commit_invalid_candidate");
  }
  if (options !== undefined && (typeof options !== "object" || options === null || Array.isArray(options))) {
    throw clientError("conditional_commit_invalid_envelope");
  }
  const member = transport.conditionalCommit;
  if (member === undefined) return UNSUPPORTED_RESULT;
  if (typeof member !== "function") throw sanitizeTransportError(transport);
  let httpResult: CommitHttpResult;
  try {
    httpResult = await member.call(transport, request, options?.signal);
  } catch (error) {
    throw sanitizeTransportError(error);
  }
  if (typeof httpResult !== "object" || httpResult === null || typeof httpResult.status !== "number") {
    throw sanitizeTransportError(httpResult);
  }
  return parseConditionalCommitHttpResult(httpResult);
}
