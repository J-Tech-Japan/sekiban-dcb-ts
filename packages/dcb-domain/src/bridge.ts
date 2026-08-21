import {
  assertJsonValue,
  DomainAuthoringError,
  type CandidateEnvelope,
  type CommitCandidateEvent,
  type FixedNow,
  type JsonValue,
  type SnapshotReader,
} from "./types";
import { executeCommand, type ExecuteCommandResult } from "./session";
import type { CommandDefinition } from "./command";
import type { EventDefinition, RuntimeEventValue } from "./event";
import type { AuthoringDomain } from "./domain";
import type { ProjectorDefinition } from "./state";

export interface RuntimeProjectionEvent {
  readonly eventId?: string;
  readonly suid?: string;
  readonly eventType: string;
  readonly eventPayloadName?: string;
  readonly payload: unknown;
  readonly eventTags?: readonly string[];
  readonly provenance?: "g27" | "pre-g27";
}

export interface RuntimeEventDefinition {
  readonly name: string;
  readonly eventName: string;
  readonly eventPayloadName: string;
  readonly version: number;
  readonly eventType: string;
  readonly create: (payload: unknown) => RuntimeEventValue;
  readonly construct: (payload: unknown) => RuntimeEventValue;
  readonly parse: (payload: unknown) => JsonValue;
}

export interface RuntimeProjectorDefinition {
  readonly id: string;
  readonly projectorId: string;
  readonly version: number;
  readonly projectorVersion: number;
  readonly subscribedEventNames: readonly string[];
  readonly subscribedEventTypes: readonly string[];
  readonly initialState: JsonValue;
  readonly apply: (state: JsonValue, event: RuntimeProjectionEvent) => JsonValue;
  readonly reduce: (state: JsonValue, event: RuntimeProjectionEvent) => JsonValue;
  readonly serializeState: (state: JsonValue) => string;
  readonly deserializeState: (serialized: string) => JsonValue;
}

export interface RuntimeCommandDefinition {
  readonly id: string;
  readonly name: string;
  readonly parseInput: (value: unknown) => unknown;
  readonly execute: (value: unknown, options?: RuntimeCommandExecutionOptions) => RuntimeCommandOutcome | Promise<RuntimeCommandOutcome>;
  readonly handle: (value: unknown, options?: RuntimeCommandExecutionOptions) => RuntimeCommandOutcome | Promise<RuntimeCommandOutcome>;
}

export interface RuntimeCommandCandidateEvent extends CommitCandidateEvent {
  readonly provenance: "g27";
}

export interface RuntimeCommandCandidateEnvelope {
  readonly kind: "candidate-envelope";
  readonly now: FixedNow;
  readonly events: readonly RuntimeCommandCandidateEvent[];
  readonly tags: CandidateEnvelope["tags"];
  readonly readClaims: CandidateEnvelope["readClaims"];
  readonly decision: CandidateEnvelope["decision"];
}

export interface RuntimeAllocationVector {
  readonly candidates: readonly { readonly ordinal: string; readonly suid: string }[];
  readonly allocatorLineageId?: string;
}

export type RuntimeCommandPortResult =
  | { readonly kind: "accepted" }
  | { readonly kind: "consistency-conflict"; readonly error?: unknown }
  | { readonly kind: "unknown"; readonly error?: unknown; readonly attemptId?: string }
  | { readonly kind: "rejected"; readonly error?: unknown; readonly reason?: string; readonly code?: string };

export interface RuntimeCommandPort {
  /** Read-only conflict barrier. A conflict here must not enter any write port. */
  readonly conflictBarrier?: (candidate: RuntimeCommandCandidateEnvelope) => Promise<RuntimeCommandPortResult> | RuntimeCommandPortResult;
  /** Admission write gate runs after the read-only conflict barrier and before allocation. */
  readonly admit?: (candidate: RuntimeCommandCandidateEnvelope) => Promise<RuntimeCommandPortResult> | RuntimeCommandPortResult;
  /** Allocation is deliberately after admission and receives no durable id from the authoring log. */
  readonly allocate?: (candidate: RuntimeCommandCandidateEnvelope) => Promise<RuntimeAllocationVector> | RuntimeAllocationVector;
  /** Commit receives the one allocated vector and the same canonical G27 event identity. */
  readonly commit?: (candidate: RuntimeCommandCandidateEnvelope, allocation?: RuntimeAllocationVector) => Promise<RuntimeCommandPortResult> | RuntimeCommandPortResult;
  /** An unknown outcome is reconciled against the same candidate/attempt, never resubmitted as new work. */
  readonly reconcile?: (candidate: RuntimeCommandCandidateEnvelope, outcome: RuntimeCommandPortResult) => Promise<RuntimeCommandPortResult> | RuntimeCommandPortResult;
}

export interface RuntimeCommandExecutionOptions {
  readonly state?: Readonly<Record<string, JsonValue>>;
  readonly now?: FixedNow;
  readonly snapshots?: SnapshotReader;
  readonly runtimePort?: RuntimeCommandPort;
}

export interface RuntimeCommandCommitted {
  readonly kind: "committed";
  readonly value?: JsonValue;
  readonly events: readonly RuntimeCommandCandidateEvent[];
}

export interface RuntimeCommandNoop {
  readonly kind: "noop";
  readonly reason?: string;
  readonly events: readonly [];
}

export interface RuntimeCommandRejected {
  readonly kind: "rejected";
  readonly reason: string;
  readonly code: string;
  readonly events: readonly [];
}

export type RuntimeCommandOutcome = RuntimeCommandCommitted | RuntimeCommandNoop | RuntimeCommandRejected;

export interface RuntimeDomainDefinition {
  readonly events: readonly RuntimeEventDefinition[];
  readonly commands: readonly RuntimeCommandDefinition[];
  readonly projectors: readonly RuntimeProjectorDefinition[];
  readonly queries: readonly [];
  readonly materializedViews: readonly [];
  readonly eventByName: ReadonlyMap<string, RuntimeEventDefinition>;
  readonly eventByType: ReadonlyMap<string, RuntimeEventDefinition>;
  readonly __sekibanAuthoringBridge: true;
}

interface LegacyEventDefinition {
  readonly name?: string;
  readonly eventName?: string;
  readonly eventPayloadName?: string;
  readonly version?: number;
  readonly eventType?: string;
  readonly parse?: (payload: unknown) => unknown;
  readonly create?: (payload: unknown) => { readonly payload?: unknown; readonly eventName?: string; readonly eventPayloadName?: string };
  readonly construct?: (payload: unknown) => { readonly payload?: unknown; readonly eventName?: string; readonly eventPayloadName?: string };
}

interface LegacyDomainDefinition {
  readonly events?: readonly LegacyEventDefinition[];
  readonly commands?: readonly RuntimeCommandDefinition[];
  readonly projectors?: readonly RuntimeProjectorDefinition[];
}

function runtimeEventFrom(definition: EventDefinition | LegacyEventDefinition): RuntimeEventDefinition {
  const name = definition.name ?? definition.eventPayloadName;
  if (name === undefined || name.length === 0 || name.includes(":")) throw new DomainAuthoringError("EVENT_NAME_INVALID", "Runtime event name is invalid");
  const eventPayloadName = definition.eventPayloadName ?? name;
  if (eventPayloadName.length === 0 || eventPayloadName.includes(":")) throw new DomainAuthoringError("EVENT_NAME_INVALID", "Runtime event payload name is invalid");
  const version = definition.version ?? 1;
  const expectedEventType = `${eventPayloadName}:${version}`;
  const eventType = definition.eventType ?? expectedEventType;
  if (eventType !== expectedEventType) throw new DomainAuthoringError("CANONICAL_EVENT_IDENTITY_INVALID", `Runtime event identity must be ${expectedEventType}`);
  const parse = (payload: unknown): JsonValue => {
    const parsed = definition.parse === undefined
      ? definition.create?.(payload)?.payload ?? definition.construct?.(payload)?.payload ?? payload
      : definition.parse(payload);
    return assertJsonValue(parsed, "event-construction");
  };
  const create = (payload: unknown): RuntimeEventValue => Object.freeze({
    eventName: name,
    eventPayloadName,
    eventType,
    version,
    payload: parse(payload),
    tags: Object.freeze([]),
  });
  return Object.freeze({
    name,
    eventName: name,
    eventPayloadName: definition.eventPayloadName ?? name,
    version,
    eventType,
    create,
    construct: create,
    parse,
  });
}

function runtimeProjectorFrom(
  definition: ProjectorDefinition,
  events: ReadonlyMap<string, RuntimeEventDefinition>,
): RuntimeProjectorDefinition {
  const eventTypes = Object.freeze([...definition.eventTypes]);
  const eventNames = Object.freeze(eventTypes.map((eventType) => events.get(eventType)?.name ?? eventType.split(":")[0] ?? eventType));
  const initial = typeof definition.initialState === "function"
    ? (definition.initialState as () => unknown)()
    : definition.initialState;
  const apply = (state: JsonValue, event: RuntimeProjectionEvent): JsonValue => {
    const registered = events.get(event.eventType);
    if (registered === undefined || !eventTypes.includes(event.eventType)) {
      throw new DomainAuthoringError("EVENT_TYPE_UNREGISTERED", `Runtime projector received ${event.eventType}`);
    }
    const syntheticTag = definition.tag.of("__runtime__");
    const next = definition.apply(state, {
      eventType: event.eventType,
      eventName: registered.name,
      payload: registered.parse(event.payload),
      tags: [syntheticTag],
      ordinal: "runtime",
    });
    return assertJsonValue(next, "state-persistence");
  };
  const serializeState = (state: JsonValue): string => definition.serializeState(state);
  const deserializeState = (serialized: string): JsonValue => assertJsonValue(definition.deserializeState(serialized), "state-persistence");
  return Object.freeze({
    id: definition.id,
    projectorId: definition.id,
    version: definition.version,
    projectorVersion: definition.version,
    subscribedEventNames: eventNames,
    subscribedEventTypes: eventTypes,
    initialState: assertJsonValue(initial, "state-persistence"),
    apply,
    reduce: apply,
    serializeState,
    deserializeState,
  });
}

function runtimeCandidateFrom(envelope: CandidateEnvelope): RuntimeCommandCandidateEnvelope {
  return Object.freeze({
    kind: "candidate-envelope" as const,
    now: envelope.now,
    events: Object.freeze(envelope.events.map((event): RuntimeCommandCandidateEvent => Object.freeze({
      ...event,
      provenance: "g27" as const,
    }))),
    tags: envelope.tags,
    readClaims: envelope.readClaims,
    decision: envelope.decision,
  });
}

function defaultRuntimeSnapshots(options: RuntimeCommandExecutionOptions): SnapshotReader {
  if (options.snapshots !== undefined) return options.snapshots;
  const states = options.state ?? {};
  return {
    read: (projector, tag) => ({
      projectorId: projector.id,
      tag,
      head: null,
      state: states[tag.id] ?? (typeof projector.initialState === "function" ? projector.initialState() : projector.initialState),
      exists: states[tag.id] !== undefined,
    }),
  };
}

async function commitThroughRuntimePort(
  envelope: CandidateEnvelope,
  port: RuntimeCommandPort | undefined,
): Promise<RuntimeCommandPortResult> {
  if (port === undefined) return { kind: "accepted" };
  const candidate = runtimeCandidateFrom(envelope);
  const barrier = port.conflictBarrier === undefined ? { kind: "accepted" as const } : await port.conflictBarrier(candidate);
  if (barrier.kind !== "accepted") {
    return barrier.kind === "unknown" && port.reconcile !== undefined
      ? await port.reconcile(candidate, barrier)
      : barrier;
  }
  const admitted = port.admit === undefined ? { kind: "accepted" as const } : await port.admit(candidate);
  if (admitted.kind !== "accepted") {
    return admitted.kind === "unknown" && port.reconcile !== undefined
      ? await port.reconcile(candidate, admitted)
      : admitted;
  }
  const allocation = port.allocate === undefined ? undefined : await port.allocate(candidate);
  const committed = port.commit === undefined
    ? { kind: "accepted" as const }
    : await port.commit(candidate, allocation);
  return committed.kind === "unknown" && port.reconcile !== undefined
    ? await port.reconcile(candidate, committed)
    : committed;
}

function runtimeEventsFrom(result: ExecuteCommandResult): readonly RuntimeCommandCandidateEvent[] {
  return result.envelope === undefined
    ? Object.freeze([])
    : Object.freeze(result.envelope.events.map((event): RuntimeCommandCandidateEvent => Object.freeze({
      ...event,
      provenance: "g27" as const,
    })));
}

function runtimeOutcomeFrom(result: ExecuteCommandResult): RuntimeCommandOutcome {
  if (result.status === "accepted" && result.decision.kind === "done") {
    return Object.freeze({
      kind: "committed" as const,
      ...(result.decision.value === undefined ? {} : { value: result.decision.value }),
      events: runtimeEventsFrom(result),
    });
  }
  if (result.status === "discarded") {
    const reason = result.decision.kind === "none" || result.decision.kind === "reject" ? result.decision.reason : undefined;
    return Object.freeze({
      kind: "noop" as const,
      ...(reason === undefined ? {} : { reason }),
      events: Object.freeze([]) as readonly [],
    });
  }
  if (result.status === "rejected") {
    return Object.freeze({
      kind: "rejected" as const,
      reason: result.decision.kind === "reject" ? result.decision.reason : "Command was rejected",
      code: result.decision.kind === "reject" ? result.decision.code : "command_rejected",
      events: Object.freeze([]) as readonly [],
    });
  }
  return Object.freeze({
    kind: "rejected" as const,
    reason: "Command outcome is unknown and requires durable reconciliation",
    code: "unknown_outcome",
    events: Object.freeze([]) as readonly [],
  });
}

/** Adapt an authoring command into the existing runtime's three-outcome contract. */
export function adaptRuntimeCommand(command: CommandDefinition): RuntimeCommandDefinition {
  const execute = async (value: unknown, options: RuntimeCommandExecutionOptions = {}): Promise<RuntimeCommandOutcome> => {
    const result = await executeCommand(command, value, {
      timeProvider: { now: () => options.now ?? 0 },
      snapshots: defaultRuntimeSnapshots(options),
      commit: (envelope) => commitThroughRuntimePort(envelope, options.runtimePort),
    });
    return runtimeOutcomeFrom(result);
  };
  return Object.freeze({
    id: command.id,
    name: command.id,
    parseInput: command.parseInput,
    execute,
    handle: execute,
  });
}

export function toRuntimeDomain(
  domain: AuthoringDomain<readonly EventDefinition[], readonly unknown[], readonly unknown[]> | LegacyDomainDefinition,
): RuntimeDomainDefinition {
  const rawEvents = domain.events ?? [];
  const events = rawEvents.map(runtimeEventFrom);
  const byType = new Map<string, RuntimeEventDefinition>();
  for (const event of events) {
    if (byType.has(event.eventType)) throw new DomainAuthoringError("DUPLICATE_CANONICAL_EVENT_IDENTITY", `Duplicate event identity ${event.eventType}`);
    byType.set(event.eventType, event);
  }
  const byName = new Map<string, RuntimeEventDefinition>();
  for (const event of events) if (!byName.has(event.name)) byName.set(event.name, event);
  const projectors: RuntimeProjectorDefinition[] = [];
  for (const projectorValue of domain.projectors ?? []) {
    if (typeof projectorValue === "object" && projectorValue !== null && "tag" in projectorValue) {
      projectors.push(runtimeProjectorFrom(projectorValue as ProjectorDefinition, byType));
    } else {
      projectors.push(projectorValue as RuntimeProjectorDefinition);
    }
  }
  const commands = (domain.commands ?? []).map((command) =>
    typeof command === "object" && command !== null && "reads" in command
      ? adaptRuntimeCommand(command as CommandDefinition)
      : command as RuntimeCommandDefinition,
  );
  return Object.freeze({
    events: Object.freeze(events),
    commands: Object.freeze(commands),
    projectors: Object.freeze(projectors),
    queries: Object.freeze([]) as readonly [],
    materializedViews: Object.freeze([]) as readonly [],
    eventByName: byName,
    eventByType: byType,
    __sekibanAuthoringBridge: true as const,
  });
}

export const normalizeRuntimeDomain = toRuntimeDomain;
