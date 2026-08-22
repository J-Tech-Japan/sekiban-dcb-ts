import type { z } from "zod";
import {
  DomainAuthoringError,
  V1_REJECT_ERROR_CODES,
  type EventOf,
  type FixedNow,
  type JsonValue,
  type ReadClaimDeclaration,
  type ReadSet,
  type Reject,
  type RejectKind,
  type Tag,
  type TerminalDecision,
} from "./types";
import type { EventDefinition } from "./event";
import type { ProjectorDefinition, ProjectorState } from "./state";

export interface CommandContext {
  readonly state: <State, Family extends string, Events extends readonly EventDefinition[]>(
    projector: ProjectorDefinition<State, Family, Events>,
    tag: Tag<Family>,
  ) => Promise<State>;
  readonly exists: <Family extends string>(tag: Tag<Family>) => Promise<boolean>;
  readonly now: () => FixedNow;
  readonly append: <Event extends EventDefinition>(event: Event, payload: EventOf<Event>) => void;
}

export interface StagedEvent<Event extends EventDefinition = EventDefinition> {
  readonly event: Event;
  readonly eventType: string;
  readonly payload: EventOf<Event>;
  readonly tags: readonly Tag[];
  readonly ordinal: string;
}

export function read<State, Family extends string, Events extends readonly EventDefinition[]>(
  projector: ProjectorDefinition<State, Family, Events>,
  tag: Tag<Family>,
): ReadSet {
  return readSet({ kind: "state", projectorId: projector.id, projector, tag });
}

export function readExists<Family extends string>(tag: Tag<Family>): ReadSet {
  return readSet({ kind: "exists", tag });
}

export const readTag = readExists;

export function readSet(...declarations: readonly (ReadClaimDeclaration | ReadSet)[]): ReadSet {
  const flattened = declarations.flatMap((declaration) => "claims" in declaration ? [...declaration.claims] : [declaration]);
  const claims = flattened.map((declaration) => Object.freeze({
    ...declaration,
    tag: Object.freeze(declaration.tag),
  }));
  const tags = [...new Map(claims.map((claim) => [claim.tag.id, claim.tag])).values()];
  const has = (kind: ReadClaimDeclaration["kind"], projectorId: string | undefined, tag: Tag): boolean =>
    claims.some((claim) =>
      claim.kind === kind &&
      claim.tag.id === tag.id &&
      (kind === "exists" || claim.projectorId === projectorId));
  return Object.freeze({ claims: Object.freeze(claims), tags: Object.freeze(tags), has });
}

export interface CommandDefinition<
  Id extends string = string,
  InputSchema extends z.ZodTypeAny = z.ZodTypeAny,
> {
  readonly id: Id;
  readonly input: InputSchema;
  readonly parseInput: (value: unknown) => z.infer<InputSchema>;
  readonly reads: (input: z.infer<InputSchema>) => ReadSet;
  readonly handle: (
    input: z.infer<InputSchema>,
    context: CommandContext,
  ) => TerminalDecision | Promise<TerminalDecision>;
  readonly execute: (
    input: unknown,
    context: CommandContext,
  ) => TerminalDecision | Promise<TerminalDecision>;
}

export interface CommandOptions<
  InputSchema extends z.ZodTypeAny,
> {
  readonly id: string;
  readonly input: InputSchema;
  readonly reads: (input: z.infer<InputSchema>) => ReadSet;
  readonly handle: (
    input: z.infer<InputSchema>,
    context: CommandContext,
  ) => TerminalDecision | Promise<TerminalDecision>;
}

export function command<
  const Id extends string,
  InputSchema extends z.ZodTypeAny,
>(
  options: CommandOptions<InputSchema> & { readonly id: Id },
): CommandDefinition<Id, InputSchema> {
  if (options.id.length === 0) throw new DomainAuthoringError("COMMAND_ID_REQUIRED", "Command id is required");
  const parseInput = (value: unknown): z.infer<InputSchema> => {
    try {
      return options.input.parse(value);
    } catch (error) {
      throw new DomainAuthoringError("COMMAND_INPUT_INVALID", `Command ${options.id} input was rejected`, { cause: error });
    }
  };
  const execute = (value: unknown, context: CommandContext) => {
    const parsed = parseInput(value);
    const declarations = options.reads(parsed);
    if (!declarations || typeof declarations.has !== "function") {
      throw new DomainAuthoringError("READ_SET_INVALID", `Command ${options.id} reads() must return a ReadSet`);
    }
    return options.handle(parsed, context);
  };
  return Object.freeze({
    id: options.id,
    input: options.input,
    parseInput,
    reads: options.reads,
    handle: options.handle,
    execute,
  });
}

export function done<Value extends JsonValue = JsonValue>(value?: Value): Extract<TerminalDecision, { readonly kind: "done" }> {
  return Object.freeze({ kind: "done" as const, ...(value === undefined ? {} : { value }) }) as Extract<TerminalDecision, { readonly kind: "done" }>;
}

export function none(reason?: string): Extract<TerminalDecision, { readonly kind: "none" }> {
  return Object.freeze({ kind: "none" as const, ...(reason === undefined ? {} : { reason }) }) as Extract<TerminalDecision, { readonly kind: "none" }>;
}

export function reject<Kind extends RejectKind, Details = unknown>(
  rejectKind: Kind,
  reason: string,
  details?: Details,
): Reject<Kind, Details> {
  return Object.freeze({
    kind: "reject" as const,
    rejectKind,
    reason,
    code: V1_REJECT_ERROR_CODES[rejectKind],
    ...(details === undefined ? {} : { details }),
  }) as Reject<Kind, Details>;
}

export const terminal = { done, none, reject } as const;

export type CommandInput<Definition extends CommandDefinition> =
  Definition extends CommandDefinition<string, infer Schema> ? z.infer<Schema> : never;

export type CommandState<Definition extends CommandDefinition> =
  Definition extends CommandDefinition<string, z.ZodTypeAny>
    ? ProjectorState<ProjectorDefinition>
    : never;

export type CommandDecision = TerminalDecision;
