import {
  DomainRegistrationError,
} from "./types";
import type { EventDefinition, EventUnion } from "./event";
import type { CommandDefinition } from "./command";
import type { ProjectorDefinition } from "./state";

export type DomainEventInput = EventDefinition | EventUnion;

/** The declared delivery classes for a view. */
export type ViewDeliveryClass = "immediate-preferred" | "queued";

const VIEW_DELIVERY_CLASSES: readonly unknown[] = Object.freeze(["immediate-preferred", "queued"] satisfies ViewDeliveryClass[]);

export interface DomainViewDefinition {
  readonly id: string;
  readonly source: string;
  readonly projector?: string;
  /** Domain-owned half of the per-view delivery policy; a view without one is `queued`. */
  readonly deliveryClass?: ViewDeliveryClass;
}

function effectiveDeliveryClass(view: DomainViewDefinition): ViewDeliveryClass {
  if (view.deliveryClass === undefined) return "queued";
  if (VIEW_DELIVERY_CLASSES.includes(view.deliveryClass)) return view.deliveryClass;
  throw new DomainRegistrationError(`View ${view.id} has an undeclared deliveryClass ${String(view.deliveryClass)}`, [view.id]);
}

/**
 * The per-view delivery policy. The domain's view declarations are the only
 * authority: each view maps to its declared deliveryClass, defaulting to `queued`.
 */
export function deliveryPolicyFromDomain(
  domainValue: { readonly views?: readonly DomainViewDefinition[] },
): Readonly<Record<string, ViewDeliveryClass>> {
  const policy = Object.create(null) as Record<string, ViewDeliveryClass>;
  for (const view of domainValue.views ?? []) {
    if (view.id in policy) {
      throw new DomainRegistrationError(`View ${view.id} is declared more than once`, [view.id]);
    }
    policy[view.id] = effectiveDeliveryClass(view);
  }
  return Object.freeze(policy);
}

export interface AuthoringDomain<
  Events extends readonly EventDefinition[] = readonly EventDefinition[],
  Projectors extends readonly unknown[] = readonly ProjectorDefinition[],
  Commands extends readonly unknown[] = readonly CommandDefinition[],
> {
  readonly events: Events;
  readonly projectors: Projectors;
  readonly commands: Commands;
  readonly views: readonly DomainViewDefinition[];
  readonly eventByType: ReadonlyMap<string, EventDefinition>;
  readonly eventByName: ReadonlyMap<string, EventDefinition>;
}

export interface DomainOptions<
  Events extends readonly DomainEventInput[] = readonly DomainEventInput[],
  Projectors extends readonly unknown[] = readonly ProjectorDefinition[],
  Commands extends readonly unknown[] = readonly CommandDefinition[],
> {
  readonly events?: Events;
  readonly eventUnions?: readonly EventUnion[];
  readonly projectors?: Projectors;
  readonly commands?: Commands;
  readonly views?: readonly DomainViewDefinition[];
}

function flattenEvents(values: readonly DomainEventInput[]): readonly EventDefinition[] {
  const result: EventDefinition[] = [];
  for (const value of values) {
    if ("kind" in value && value.kind === "event-union") result.push(...value.events);
    else result.push(value as EventDefinition);
  }
  return result;
}

export function domain<
  const Events extends readonly DomainEventInput[],
  const Projectors extends readonly unknown[],
  const Commands extends readonly unknown[],
>(
  options: DomainOptions<Events, Projectors, Commands>,
): AuthoringDomain<
  Extract<Events[number], EventDefinition> extends never
    ? readonly EventDefinition[]
    : readonly EventDefinition[],
  Projectors,
  Commands
> {
  const eventInputs: readonly DomainEventInput[] = [
    ...(options.events ?? []),
    ...(options.eventUnions ?? []),
  ];
  const events = flattenEvents(eventInputs);
  const projectors = [...(options.projectors ?? [])];
  const commands = [...(options.commands ?? [])];
  const views = [...(options.views ?? [])];
  const collisions: string[] = [];
  const identityOwners = new Map<string, string>();
  const register = (identity: string, owner: string): void => {
    const previous = identityOwners.get(identity);
    if (previous !== undefined) collisions.push(`${identity} (${previous}, ${owner})`);
    identityOwners.set(identity, owner);
  };
  for (const definition of events) register(`event:${definition.eventType}`, definition.eventType);
  for (const commandValue of commands) {
    const definition = commandValue as CommandDefinition;
    register(`command:${definition.id}`, definition.id);
  }
  for (const projectorValue of projectors) {
    const definition = projectorValue as ProjectorDefinition;
    register(`projector:${definition.id}`, definition.id);
  }
  for (const view of views) register(`view:${view.id}`, view.id);
  if (collisions.length > 0) throw new DomainRegistrationError("Domain contains duplicate definition identities", collisions);
  const eventByType = new Map<string, EventDefinition>();
  const eventByName = new Map<string, EventDefinition>();
  for (const definition of events) {
    if (eventByType.has(definition.eventType)) throw new DomainRegistrationError(`Duplicate event identity ${definition.eventType}`, [definition.eventType]);
    eventByType.set(definition.eventType, definition);
    if (!eventByName.has(definition.name)) eventByName.set(definition.name, definition);
  }
  for (const projectorValue of projectors) {
    const projector = projectorValue as ProjectorDefinition;
    for (const eventType of projector.eventTypes) {
      const definition = eventByType.get(eventType);
      if (definition === undefined) throw new DomainRegistrationError(`Projector ${projector.id} references unregistered ${eventType}`, [eventType]);
      if (definition.tagFamilies.length > 0 && !definition.tagFamilies.includes(projector.tag.family)) {
        throw new DomainRegistrationError(`Projector ${projector.id} has a source/family mismatch for ${eventType}`, [eventType]);
      }
    }
  }
  for (const view of views) {
    if (!(projectors as readonly unknown[]).some((projectorValue) => {
      const projector = projectorValue as ProjectorDefinition;
      return projector.id === view.source || projector.id === view.projector;
    })) {
      throw new DomainRegistrationError(`View ${view.id} has no registered source projector`, [view.id]);
    }
    effectiveDeliveryClass(view);
  }
  return Object.freeze({
    events: Object.freeze(events),
    projectors: Object.freeze(projectors),
    commands: Object.freeze(commands),
    views: Object.freeze(views),
    eventByType,
    eventByName,
  }) as unknown as AuthoringDomain<
    Extract<Events[number], EventDefinition> extends never
      ? readonly EventDefinition[]
      : readonly EventDefinition[],
    Projectors,
    Commands
  >;
}
