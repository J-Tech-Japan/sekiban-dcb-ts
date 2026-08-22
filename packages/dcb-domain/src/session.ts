import {
  assertJsonValue,
  DomainAuthoringError,
  cloneAndFreeze,
  normalizeTag,
  type CandidateEnvelope,
  type CommitCandidateEvent,
  type DecisionLog,
  type Done,
  type EventRecord,
  type EventOf,
  type FixedNow,
  type None,
  type PortableSnapshot,
  type ProjectorLike,
  type ReadClaim,
  type ReadClaimDeclaration,
  type ReadSet,
  type SnapshotReader,
  type Tag,
  type TerminalDecision,
  type TimeProvider,
} from "./types";
import {
  none,
  type CommandContext,
  type CommandDefinition,
  type StagedEvent,
} from "./command";
import type { EventDefinition } from "./event";
import type { ProjectorDefinition } from "./state";

export type SessionStatus = "OPEN" | "SEALED" | "DISCARDED";
export type TagPropagationPoint = "staged-log" | "eligible-cells" | "claim-candidate-preflight" | "sealed-envelope";

export interface TagPropagationObservation {
  readonly point: TagPropagationPoint;
  readonly eventType?: string;
  readonly tags: readonly Tag[];
}

export class SessionStateError extends DomainAuthoringError {
  constructor(message: string) {
    super("SESSION_STATE_INVALID", message);
    this.name = "SessionStateError";
  }
}

export class UndeclaredReadError extends DomainAuthoringError {
  readonly projectorId?: string;
  readonly tag: Tag;

  constructor(projectorId: string | undefined, tag: Tag) {
    super("UNDECLARED_DYNAMIC_READ", `Read of ${projectorId ?? "exists"}/${tag.id} was not declared`);
    this.name = "UndeclaredReadError";
    this.projectorId = projectorId;
    this.tag = tag;
  }
}

export class IncoherentSnapshotError extends DomainAuthoringError {
  constructor(tag: Tag, firstHead: string | null, secondHead: string | null) {
    super("INCOHERENT_SNAPSHOT", `Tag ${tag.id} was supplied with heads ${firstHead ?? "null"} and ${secondHead ?? "null"}`);
    this.name = "IncoherentSnapshotError";
  }
}

export interface SessionOptions {
  readonly now: FixedNow;
  readonly readSet: ReadSet;
  readonly snapshots?: SnapshotReader;
  readonly onPropagation?: (observation: TagPropagationObservation) => void;
}

export interface PortableSnapshotWire {
  readonly projectorId: string;
  readonly tag: string;
  readonly head: string | null;
  readonly state: unknown;
  readonly exists: boolean;
}

export function serializePortableSnapshot(snapshot: PortableSnapshot): string {
  const state = assertJsonValue(snapshot.state, "snapshot-serialization");
  return JSON.stringify({
    projectorId: snapshot.projectorId,
    tag: snapshot.tag.id,
    head: snapshot.head,
    state,
    exists: snapshot.exists,
  });
}

export function deserializePortableSnapshot(serialized: string): PortableSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new DomainAuthoringError("SNAPSHOT_SERIALIZATION_INVALID", "Portable snapshot was not valid JSON", { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DomainAuthoringError("SNAPSHOT_SERIALIZATION_INVALID", "Portable snapshot must be an object");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.projectorId !== "string" || typeof record.tag !== "string" ||
      (record.head !== null && typeof record.head !== "string") || typeof record.exists !== "boolean") {
    throw new DomainAuthoringError("SNAPSHOT_SERIALIZATION_INVALID", "Portable snapshot fields were invalid");
  }
  return Object.freeze({
    projectorId: record.projectorId,
    tag: normalizeTag(record.tag),
    head: record.head,
    state: assertJsonValue(record.state, "snapshot-deserialization"),
    exists: record.exists,
  });
}

function cellKey(projector: ProjectorLike, tag: Tag): string {
  return `${projector.id}\u0000${tag.id}`;
}

function initialState(projector: ProjectorLike): unknown {
  return typeof projector.initialState === "function"
    ? (projector.initialState as () => unknown)()
    : projector.initialState;
}

function eventEligible(
  projector: Pick<ProjectorLike, "tag" | "subscribes">,
  cellTag: Tag,
  event: CommitCandidateEvent,
): boolean {
  return event.tags.some((tag) => tag.id === cellTag.id && tag.family === projector.tag.family)
    && projector.subscribes(event.eventType);
}

interface AttachedProjector {
  readonly id: string;
  readonly tag: ProjectorLike["tag"];
  readonly subscribes: (eventType: string) => boolean;
  readonly apply: (state: unknown, event: EventRecord) => unknown;
}

function asRecord(event: StagedEvent): CommitCandidateEvent {
  return Object.freeze({
    eventType: event.eventType,
    eventName: event.event.eventPayloadName,
    payload: event.payload,
    tags: Object.freeze([...event.tags]),
    ordinal: event.ordinal,
  });
}

export class Session {
  readonly now: FixedNow;
  private statusValue: SessionStatus = "OPEN";
  private readonly readSet: ReadSet;
  private readonly snapshots?: SnapshotReader;
  private readonly onPropagation?: (observation: TagPropagationObservation) => void;
  private readonly snapshotByCell = new Map<string, PortableSnapshot>();
  private readonly overlayByCell = new Map<string, unknown>();
  private readonly headByTag = new Map<string, string | null>();
  private readonly claimsByKey = new Map<string, ReadClaim>();
  private readonly staged: StagedEvent[] = [];
  private readonly observations: TagPropagationObservation[] = [];

  constructor(options: SessionOptions) {
    this.now = options.now;
    this.readSet = options.readSet;
    this.snapshots = options.snapshots;
    this.onPropagation = options.onPropagation;
  }

  get status(): SessionStatus {
    return this.statusValue;
  }

  get stagedEvents(): readonly StagedEvent[] {
    return Object.freeze([...this.staged]);
  }

  get propagation(): readonly TagPropagationObservation[] {
    return Object.freeze([...this.observations]);
  }

  get readClaims(): readonly ReadClaim[] {
    return Object.freeze([...this.claimsByKey.values()]);
  }

  private observe(observation: TagPropagationObservation): void {
    const frozen = Object.freeze({ ...observation, tags: Object.freeze([...observation.tags]) });
    this.observations.push(frozen);
    this.onPropagation?.(frozen);
  }

  private assertOpen(): void {
    if (this.statusValue !== "OPEN") throw new SessionStateError(`Session is ${this.statusValue}`);
  }

  private assertDeclared(kind: ReadClaimDeclaration["kind"], projectorId: string | undefined, tag: Tag): void {
    if (!this.readSet.has(kind, projectorId, tag)) throw new UndeclaredReadError(projectorId, tag);
  }

  private rememberClaim(declaration: ReadClaimDeclaration, head: string | null): void {
    const key = `${declaration.kind}\u0000${declaration.projectorId ?? ""}\u0000${declaration.tag.id}`;
    this.claimsByKey.set(key, Object.freeze({
      kind: declaration.kind,
      ...(declaration.projectorId === undefined ? {} : { projectorId: declaration.projectorId }),
      tag: declaration.tag,
      head,
    }));
  }

  private async loadSnapshot<State, Family extends string, Events extends readonly EventDefinition[]>(projector: ProjectorDefinition<State, Family, Events>, tag: Tag): Promise<PortableSnapshot<State>> {
    const key = cellKey(projector, tag);
    const cached = this.snapshotByCell.get(key);
    if (cached !== undefined) return cached as PortableSnapshot<State>;
    const supplied = this.snapshots === undefined
      ? { projectorId: projector.id, tag, head: null, state: initialState(projector), exists: false }
      : await this.snapshots.read(projector, tag);
    const suppliedTag = normalizeTag(supplied.tag);
    if (suppliedTag.id !== tag.id || supplied.projectorId !== projector.id) {
      throw new DomainAuthoringError("SNAPSHOT_IDENTITY_INVALID", `Snapshot identity did not match ${projector.id}/${tag.id}`);
    }
    const existingHead = this.headByTag.get(tag.id);
    if (existingHead !== undefined && existingHead !== supplied.head) {
      throw new IncoherentSnapshotError(tag, existingHead, supplied.head);
    }
    this.headByTag.set(tag.id, supplied.head);
    this.snapshotByCell.set(key, supplied);
    return supplied as PortableSnapshot<State>;
  }

  private async stateFor<State, Family extends string, Events extends readonly EventDefinition[]>(projector: ProjectorDefinition<State, Family, Events>, tag: Tag): Promise<State> {
    this.assertOpen();
    this.assertDeclared("state", projector.id, tag);
    this.attachProjector(projector);
    const key = cellKey(projector, tag);
    const overlay = this.overlayByCell.get(key);
    if (overlay !== undefined) return overlay as State;
    const snapshot = await this.loadSnapshot(projector, tag);
    let state = snapshot.state as State;
    for (const staged of this.staged) {
      const record = asRecord(staged);
      if (!eventEligible(projector, tag, record)) continue;
      state = projector.apply(state, record) as State;
      this.observe({ point: "eligible-cells", eventType: record.eventType, tags: record.tags });
    }
    this.overlayByCell.set(key, state);
    this.rememberClaim({ kind: "state", projectorId: projector.id, tag }, snapshot.head);
    return state;
  }

  private async existsFor(tag: Tag): Promise<boolean> {
    this.assertOpen();
    this.assertDeclared("exists", undefined, tag);
    const snapshotExists = this.snapshots?.exists === undefined ? undefined : await this.snapshots.exists(tag);
    const stagedExists = this.staged.some((event) => event.tags.some((candidate) => candidate.id === tag.id));
    // A host-provided `exists=false` is the base snapshot result, not a veto
    // over an event already staged in this session.
    const result = (snapshotExists ?? this.snapshotByCellHasTag(tag)) || stagedExists;
    const head = this.headByTag.get(tag.id) ?? null;
    this.rememberClaim({ kind: "exists", tag }, head);
    return result;
  }

  private snapshotByCellHasTag(tag: Tag): boolean {
    return [...this.snapshotByCell.values()].some((snapshot) => snapshot.tag.id === tag.id && snapshot.exists);
  }

  async preload(): Promise<void> {
    this.assertOpen();
    for (const declaration of this.readSet.claims) {
      if (declaration.kind === "state") {
        const projector = this.findProjector(declaration.projectorId);
        await this.stateFor(projector, declaration.tag);
      } else {
        await this.existsFor(declaration.tag);
      }
    }
  }

  private findProjector(projectorId: string | undefined): ProjectorDefinition {
    if (projectorId === undefined) throw new DomainAuthoringError("PROJECTOR_ID_REQUIRED", "A state read requires a projector");
    const declaration = this.readSet.claims.find((claim) => claim.projectorId === projectorId && claim.projector !== undefined);
    if (declaration?.projector !== undefined) return declaration.projector as ProjectorDefinition;
    throw new DomainAuthoringError("PROJECTOR_NOT_IN_READ_SET", `Projector ${projectorId} was not attached to this session`);
  }

  private readonly readSetProjectors = new Map<string, AttachedProjector>();

  private attachProjector<State, Family extends string, Events extends readonly EventDefinition[]>(projector: ProjectorDefinition<State, Family, Events>): void {
    this.readSetProjectors.set(projector.id, {
      id: projector.id,
      tag: projector.tag,
      subscribes: projector.subscribes,
      apply: (state: unknown, event: EventRecord) => projector.apply(state as State, event),
    });
  }

  attachProjectors(projectors: readonly ProjectorDefinition[]): void {
    for (const projector of projectors) this.attachProjector(projector);
  }

  context(projectors: readonly ProjectorDefinition[] = []): CommandContext {
    this.attachProjectors(projectors);
    return Object.freeze({
      state: <State, Family extends string, Events extends readonly EventDefinition[]>(projector: ProjectorDefinition<State, Family, Events>, tag: Tag<Family>) =>
        this.stateFor(projector, tag),
      exists: <Family extends string>(tag: Tag<Family>) => this.existsFor(tag),
      now: () => this.now,
      append: <Event extends EventDefinition>(event: Event, payload: EventOf<Event>) => this.append(event, payload),
    });
  }

  append<Event extends EventDefinition>(event: Event, payload: EventOf<Event>): void {
    this.assertOpen();
    const parsed = event.make(payload);
    const derivedTags = event.tags(parsed).map(normalizeTag);
    const ordinal = String(this.staged.length);
    const staged = Object.freeze({
      event,
      eventType: event.eventType,
      payload: parsed,
      tags: Object.freeze(derivedTags),
      ordinal,
    }) as StagedEvent<Event>;
    this.staged.push(staged);
    this.observe({ point: "staged-log", eventType: event.eventType, tags: derivedTags });
    const record = asRecord(staged);
    for (const [key, snapshot] of this.snapshotByCell) {
      const separator = key.indexOf("\u0000");
      const projectorId = key.slice(0, separator);
      const tagId = key.slice(separator + 1);
      if (!record.tags.some((tag) => tag.id === tagId)) continue;
      const projector = this.readSetProjectors.get(projectorId);
      if (projector === undefined || !eventEligible(projector, snapshot.tag, record)) continue;
      const previous = this.overlayByCell.get(key) ?? snapshot.state;
      const next = projector.apply(previous, record);
      this.overlayByCell.set(key, next);
      this.observe({ point: "eligible-cells", eventType: event.eventType, tags: record.tags });
    }
  }

  private candidateTags(): readonly Tag[] {
    const tags = new Map<string, Tag>();
    for (const event of this.staged) for (const tag of event.tags) tags.set(tag.id, tag);
    for (const tag of this.readSet.tags) tags.set(tag.id, tag);
    return Object.freeze([...tags.values()]);
  }

  seal(decision: Done): CandidateEnvelope {
    this.assertOpen();
    const tags = this.candidateTags();
    this.observe({ point: "claim-candidate-preflight", tags });
    const envelope = Object.freeze({
      kind: "candidate-envelope" as const,
      now: this.now,
      events: Object.freeze(this.staged.map(asRecord)),
      tags,
      readClaims: this.readClaims,
      decision,
    });
    this.observe({ point: "sealed-envelope", tags });
    this.statusValue = "SEALED";
    return envelope;
  }

  discard(reason = "discarded"): None | TerminalDecision {
    this.assertOpen();
    this.staged.splice(0, this.staged.length);
    this.overlayByCell.clear();
    this.statusValue = "DISCARDED";
    return reason.length === 0 ? none() : none(reason);
  }

  finish(decision: TerminalDecision): CandidateEnvelope | undefined {
    if (decision.kind === "done") return this.seal(decision);
    this.discard(decision.kind === "none" ? decision.reason ?? "none" : decision.reason);
    return undefined;
  }

  decisionLog(decision: TerminalDecision): DecisionLog {
    return Object.freeze({
      now: this.now,
      events: Object.freeze(this.staged.map(asRecord)),
      readClaims: this.readClaims,
      terminal: decision,
    });
  }
}

export type CommitAttemptResult =
  | { readonly kind: "accepted" }
  | { readonly kind: "consistency-conflict" }
  | { readonly kind: "unknown"; readonly error?: unknown }
  | { readonly kind: "rejected"; readonly error?: unknown };

export interface ExecuteCommandOptions {
  readonly timeProvider?: TimeProvider;
  readonly snapshots?: SnapshotReader;
  readonly commit?: (envelope: CandidateEnvelope) => Promise<unknown> | unknown;
  readonly maxConflictRetries?: number;
  readonly onPropagation?: (observation: TagPropagationObservation) => void;
}

export interface ExecuteCommandResult {
  readonly status: "accepted" | "discarded" | "unknown" | "rejected";
  readonly attempts: number;
  readonly now: FixedNow;
  readonly decision: TerminalDecision;
  readonly envelope?: CandidateEnvelope;
  readonly log: DecisionLog;
  readonly session: Session;
  readonly error?: unknown;
}

function classifyCommitResult(value: unknown): CommitAttemptResult {
  if (value === undefined || value === true) return { kind: "accepted" };
  if (typeof value !== "object" || value === null) return { kind: "accepted" };
  const record = value as Record<string, unknown>;
  if (record.kind === "consistency-conflict" || record.kind === "conflict" || record.code === "consistency_conflict") {
    return { kind: "consistency-conflict" };
  }
  if (record.kind === "unknown" || record.kind === "timeout" || record.code === "unknown_outcome") {
    return { kind: "unknown", error: value };
  }
  if (record.kind === "rejected" || record.kind === "invalid") return { kind: "rejected", error: value };
  return { kind: "accepted" };
}

export async function executeCommand<
  Command extends CommandDefinition,
>(command: Command, input: unknown, options: ExecuteCommandOptions = {}): Promise<ExecuteCommandResult> {
  const fixedNow = options.timeProvider?.now() ?? 0;
  const maxRetries = Math.max(0, Math.floor(options.maxConflictRetries ?? 1));
  const parsed = command.parseInput(input);
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const readSet = command.reads(parsed);
    const session = new Session({
      now: fixedNow,
      readSet,
      snapshots: options.snapshots,
      onPropagation: options.onPropagation,
    });
    try {
      await session.preload();
      const context = session.context([]);
      const decision = await command.handle(parsed, context);
      const envelope = session.finish(decision);
      const log = session.decisionLog(decision);
      if (envelope === undefined) {
        return Object.freeze({ status: decision.kind === "reject" ? "rejected" : "discarded", attempts, now: fixedNow, decision, log, session });
      }
      if (options.commit === undefined) {
        return Object.freeze({ status: "accepted" as const, attempts, now: fixedNow, decision, envelope, log, session });
      }
      const commitResult = classifyCommitResult(await options.commit(envelope));
      if (commitResult.kind === "consistency-conflict" && attempts <= maxRetries) continue;
      if (commitResult.kind === "unknown") return Object.freeze({ status: "unknown" as const, attempts, now: fixedNow, decision, envelope, log, session, error: commitResult.error });
      if (commitResult.kind === "rejected") return Object.freeze({ status: "rejected" as const, attempts, now: fixedNow, decision, envelope, log, session, error: commitResult.error });
      return Object.freeze({ status: "accepted" as const, attempts, now: fixedNow, decision, envelope, log, session });
    } catch (error) {
      if (session.status === "OPEN") session.discard("throw");
      throw error;
    }
  }
}

export const runCommand = executeCommand;
export const runSession = executeCommand;
export const executePortableCommand = executeCommand;

export function serializeDecisionLog(log: DecisionLog): string {
  return JSON.stringify(cloneAndFreeze(log));
}
