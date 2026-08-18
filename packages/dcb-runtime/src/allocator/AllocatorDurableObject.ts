import type {
  AllocatedCandidate,
  AllocationCandidate,
  AllocationVector,
  AllocatorState,
} from "./types";

const STATE_KEY = "allocator-state";
const ATTEMPT_KEY_PREFIX = "attempt:";
const SUID_PREFIX = "suid-";
const SUID_DIGITS = 32;
const SUID_LIMIT = 10n ** BigInt(SUID_DIGITS);

type JsonObject = Record<string, unknown>;

interface AllocateInput {
  attemptId: string;
  candidates: AllocationCandidate[];
  faultInjection?: "between-vector-and-watermark";
}

interface AllocationSuccess {
  vector: AllocationVector;
  created: boolean;
}

class AllocationTransactionFault extends Error {}

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

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function attemptKey(attemptId: string): string {
  return `${ATTEMPT_KEY_PREFIX}${attemptId}`;
}

function currentState(): AllocatorState {
  return { schemaVersion: 1, allocatedWatermark: null };
}

function nowIso(): string {
  return new Date().toISOString();
}

function encodeSuid(value: bigint): string {
  return `${SUID_PREFIX}${value.toString().padStart(SUID_DIGITS, "0")}`;
}

function decodeSuid(suid: string): bigint {
  const digits = suid.slice(SUID_PREFIX.length);
  if (!suid.startsWith(SUID_PREFIX) || !new RegExp(`^\\d{${SUID_DIGITS}}$`).test(digits)) {
    throw new Error("Persisted allocator watermark is not a valid SUID");
  }
  return BigInt(digits);
}

function nextSuids(watermark: string | null, count: number): string[] {
  const base = watermark === null ? 0n : decodeSuid(watermark);
  const end = base + BigInt(count);
  if (end >= SUID_LIMIT) {
    throw new Error("Allocator SUID range is exhausted");
  }
  return Array.from({ length: count }, (_, index) => encodeSuid(base + BigInt(index + 1)));
}

function allocateFrom(value: unknown): { value?: AllocateInput; error?: string } {
  if (!isObject(value) || !isNonEmptyString(value.attemptId) || !Array.isArray(value.candidates)) {
    return { error: "attemptId and candidates are required" };
  }
  if (value.candidates.length === 0) {
    return { error: "an allocation requires at least one candidate" };
  }

  const candidates: AllocationCandidate[] = [];
  for (const rawCandidate of value.candidates) {
    if (
      !isObject(rawCandidate) ||
      !isNonNegativeInteger(rawCandidate.candidateIndex) ||
      !isNonEmptyString(rawCandidate.eventId)
    ) {
      return { error: "each candidate needs a non-negative candidateIndex and non-empty eventId" };
    }
    candidates.push({
      candidateIndex: rawCandidate.candidateIndex,
      eventId: rawCandidate.eventId,
    });
  }

  const ordered = [...candidates].sort((left, right) => left.candidateIndex - right.candidateIndex);
  if (new Set(ordered.map((candidate) => candidate.candidateIndex)).size !== ordered.length) {
    return { error: "candidateIndex values must be unique" };
  }
  if (new Set(ordered.map((candidate) => candidate.eventId)).size !== ordered.length) {
    return { error: "eventId values must be unique within an attempt" };
  }
  if (!ordered.every((candidate, index) => candidate.candidateIndex === index)) {
    return { error: "candidateIndex values must form a complete zero-based sequence" };
  }

  const faultInjection = value.faultInjection;
  if (faultInjection !== undefined && faultInjection !== "between-vector-and-watermark") {
    return { error: "unsupported faultInjection" };
  }

  return { value: { attemptId: value.attemptId, candidates: ordered, faultInjection } };
}

/**
 * A single service-wide allocator. Every allocation uses this one Durable
 * Object instance, so the transaction that writes an attempt vector and the
 * allocated watermark is serialized and atomic.
 */
export class AllocatorDurableObject implements DurableObject {
  constructor(private readonly ctx: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/state") {
      return json((await this.ctx.storage.get<AllocatorState>(STATE_KEY)) ?? currentState());
    }
    if (request.method === "GET" && url.pathname.startsWith("/attempts/")) {
      let attemptId: string;
      try {
        attemptId = decodeURIComponent(url.pathname.slice("/attempts/".length));
      } catch {
        return error(400, "invalid_attempt_id", "Attempt ID must be URI encoded");
      }
      if (attemptId.length === 0) {
        return error(400, "invalid_attempt_id", "Attempt ID is required");
      }
      const vector = await this.ctx.storage.get<AllocationVector>(attemptKey(attemptId));
      return vector === undefined
        ? error(404, "allocation_not_found", "No durable allocation exists for this attempt")
        : json(vector);
    }
    if (request.method === "POST" && url.pathname === "/allocate") {
      return this.allocate(request);
    }
    return error(404, "allocator_route_not_found", "Allocator route was not found");
  }

  private async allocate(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json<unknown>();
    } catch {
      return error(400, "invalid_allocation", "Request body must be JSON");
    }
    const parsed = allocateFrom(body);
    if (parsed.value === undefined) {
      return error(400, "invalid_allocation", parsed.error ?? "Invalid allocation request");
    }
    const input = parsed.value;

    try {
      const result = await this.ctx.storage.transaction(async (txn): Promise<AllocationSuccess> => {
        const existing = await txn.get<AllocationVector>(attemptKey(input.attemptId));
        if (existing !== undefined) {
          return { vector: existing, created: false };
        }

        const state = (await txn.get<AllocatorState>(STATE_KEY)) ?? currentState();
        const suids = nextSuids(state.allocatedWatermark, input.candidates.length);
        const candidates: AllocatedCandidate[] = input.candidates.map((candidate, index) => ({
          ...candidate,
          suid: suids[index]!,
        }));
        const vector: AllocationVector = {
          attemptId: input.attemptId,
          candidates,
          allocatedAt: nowIso(),
        };
        const updatedState: AllocatorState = {
          schemaVersion: 1,
          allocatedWatermark: candidates[candidates.length - 1]!.suid,
        };

        await txn.put(attemptKey(input.attemptId), vector);
        if (input.faultInjection === "between-vector-and-watermark") {
          throw new AllocationTransactionFault("Simulated interruption before transaction commit");
        }
        await txn.put(STATE_KEY, updatedState);
        return { vector, created: true };
      });
      return json(result.vector, result.created ? 201 : 200);
    } catch (failure) {
      if (failure instanceof AllocationTransactionFault) {
        return error(
          503,
          "simulated_allocation_crash",
          "Simulated interruption before durable allocation transaction commit",
        );
      }
      return error(500, "allocator_failure", "Allocator could not persist the full allocation vector");
    }
  }
}
