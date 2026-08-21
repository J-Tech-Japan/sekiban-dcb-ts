import type { z } from "zod";
import {
  DomainAuthoringError,
  type DomainBoundary,
  type ParsedAt,
} from "./types";

const parsedValues = new WeakSet<object>();
const parsedPrimitives = new Map<DomainBoundary, Set<unknown>>();

export class BoundaryParseError extends DomainAuthoringError {
  readonly boundary: DomainBoundary;
  readonly finding: string;

  constructor(boundary: DomainBoundary, finding: string, message: string, options?: ErrorOptions) {
    super("BOUNDARY_PARSE_FAILED", message, options);
    this.name = "BoundaryParseError";
    this.boundary = boundary;
    this.finding = finding;
  }
}

export function parseAt<
  Boundary extends DomainBoundary,
  Schema extends z.ZodTypeAny,
>(
  boundary: Boundary,
  schema: Schema,
  value: unknown,
): ParsedAt<Boundary, z.infer<Schema>> {
  try {
    const parsed = schema.parse(value);
    if (typeof parsed === "object" && parsed !== null) parsedValues.add(parsed);
    else {
      const values = parsedPrimitives.get(boundary) ?? new Set<unknown>();
      values.add(parsed);
      parsedPrimitives.set(boundary, values);
    }
    return parsed as ParsedAt<Boundary, z.infer<Schema>>;
  } catch (error) {
    throw new BoundaryParseError(boundary, `${boundary}-parse`, `Input failed the ${boundary} parse boundary`, { cause: error });
  }
}

export function isParsedAt(value: unknown): boolean {
  return typeof value === "object" && value !== null && parsedValues.has(value);
}

export function assertParsedAt<Boundary extends DomainBoundary, Value>(
  boundary: Boundary,
  value: Value,
): ParsedAt<Boundary, Value> {
  if ((typeof value === "object" && value !== null && parsedValues.has(value)) || parsedPrimitives.get(boundary)?.has(value) === true) {
    return value as ParsedAt<Boundary, Value>;
  }
  throw new BoundaryParseError(boundary, `${boundary}-parse-bypass`, `Value did not come from the ${boundary} parser`);
}

export const parseHttpCommandInput = <Schema extends z.ZodTypeAny>(schema: Schema, value: unknown) =>
  parseAt("http-command", schema, value);

export const parseQueueMessage = <Schema extends z.ZodTypeAny>(schema: Schema, value: unknown) =>
  parseAt("queue", schema, value);

export const parseStoredEvent = <Schema extends z.ZodTypeAny>(schema: Schema, value: unknown) =>
  parseAt("stored-event", schema, value);

export const parseExternalQueryInput = <Schema extends z.ZodTypeAny>(schema: Schema, value: unknown) =>
  parseAt("external-query", schema, value);

export interface WasmRestoreDecoder<Schema extends z.ZodTypeAny> {
  readonly boundary: "wasm-restore";
  readonly decode: (bytes: Uint8Array | string) => ParsedAt<"wasm-restore", z.infer<Schema>>;
}

export function createWasmRestoreDecoder<Schema extends z.ZodTypeAny>(schema: Schema): WasmRestoreDecoder<Schema> {
  return Object.freeze({
    boundary: "wasm-restore" as const,
    decode: (bytes: Uint8Array | string) => {
      let value: unknown;
      try {
        const text = typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
        value = JSON.parse(text);
      } catch (error) {
        throw new BoundaryParseError("wasm-restore", "wasm-restore-malformed-bytes", "WASM restore bytes were not valid JSON", { cause: error });
      }
      return parseAt("wasm-restore", schema, value);
    },
  });
}

export const wasmRestoreDecoder = createWasmRestoreDecoder;

export const parseCommandIngress = parseHttpCommandInput;
export const parseQueueIngress = parseQueueMessage;
export const parseStoredEventMaterialization = parseStoredEvent;
export const parseQueryInput = parseExternalQueryInput;
