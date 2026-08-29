import type { TagEvent } from "../tag/types";
import { assertSortableUniqueId } from "../allocator/SortableUniqueId";

export const TEST_TAG_STATE_PROJECTOR = "test-projector";

export interface ProjectionEvent {
  eventId: string;
  suid: string;
  payload: string;
  eventTags: readonly string[];
  eventType: string;
  provenance: "g32";
}

/**
 * Projectors are TypeScript values registered at deploy time. The HTTP input
 * can select only an already registered ID; it can never install code or a
 * reducer dynamically.
 */
export interface TagStateProjector {
  readonly id: string;
  readonly tagPayloadName: string;
  readonly projectorVersion: string;
  initialState(): unknown;
  apply(state: unknown, event: ProjectionEvent): unknown;
  serializeState(state: unknown): string;
  deserializeState(serialized: string): unknown;
  payload(state: unknown): string;
  version(state: unknown): number;
}

export interface TagStateIdentity {
  tag: string;
  tagGroup: string;
  tagContent: string;
  tagProjector: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function base64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

interface EventHistoryStateEntry {
  eventId: string;
  payload: string;
  suid: string;
}

function eventHistoryStateFrom(value: unknown): EventHistoryStateEntry[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry) =>
      typeof entry === "object" && entry !== null &&
      isNonEmptyString((entry as Record<string, unknown>).eventId) &&
      typeof (entry as Record<string, unknown>).payload === "string" &&
      isNonEmptyString((entry as Record<string, unknown>).suid))
  ) {
    throw new Error("Event-history projector durable state was malformed");
  }
  return value.map((entry) => {
    const record = entry as Record<string, unknown>;
    return {
      eventId: record.eventId as string,
      payload: record.payload as string,
      suid: record.suid as string,
    };
  });
}

function eventHistoryProjector(id: string, tagPayloadName: string): TagStateProjector {
  return {
    id,
    tagPayloadName,
    projectorVersion: "1",
    initialState: () => [],
    apply(state, event): EventHistoryStateEntry[] {
      const current = eventHistoryStateFrom(state);
      return [...current, { eventId: event.eventId, payload: event.payload, suid: event.suid }];
    },
    serializeState(state): string {
      return JSON.stringify(eventHistoryStateFrom(state));
    },
    deserializeState(serialized): EventHistoryStateEntry[] {
      return eventHistoryStateFrom(JSON.parse(serialized));
    },
    payload(state): string {
      return base64Json(eventHistoryStateFrom(state));
    },
    version(state): number {
      return eventHistoryStateFrom(state).length;
    },
  };
}

const TEST_PROJECTOR = eventHistoryProjector(TEST_TAG_STATE_PROJECTOR, "SerializedDcbTestTagState");
export class ProjectorRegistry {
  private readonly projectors: ReadonlyMap<string, TagStateProjector>;

  constructor(projectors: readonly TagStateProjector[]) {
    const entries = new Map<string, TagStateProjector>();
    for (const projector of projectors) {
      if (entries.has(projector.id)) {
        throw new Error(`Projector ${projector.id} was registered more than once`);
      }
      entries.set(projector.id, projector);
    }
    this.projectors = entries;
  }

  resolve(projectorId: string): TagStateProjector | undefined {
    return this.projectors.get(projectorId);
  }

  registered(): readonly TagStateProjector[] {
    return [...this.projectors.values()];
  }
}

/** The test-only default registry; production consumers compose their own domain. */
export const DEPLOYED_TAG_STATE_PROJECTORS: readonly TagStateProjector[] = [
  TEST_PROJECTOR,
];
export const DEPLOYED_PROJECTOR_REGISTRY = new ProjectorRegistry(DEPLOYED_TAG_STATE_PROJECTORS);

/** Parse the public tag-state identifier without consulting a projector authority. */
export function tagStateIdentitySyntaxFrom(tagStateId: string): { value?: TagStateIdentity; error?: string } {
  const parts = tagStateId.split(":");
  if (parts.length !== 3 || !parts.every(isNonEmptyString)) {
    return { error: "tagStateId must be group:content:projector" };
  }
  const [tagGroup, tagContent, tagProjector] = parts;
  return {
    value: {
      tag: `${tagGroup}:${tagContent}`,
      tagGroup: tagGroup!,
      tagContent: tagContent!,
      tagProjector: tagProjector!,
    },
  };
}

export function tagStateIdentityFrom(
  tagStateId: string,
  registry: ProjectorRegistry = DEPLOYED_PROJECTOR_REGISTRY,
): { value?: TagStateIdentity; error?: string } {
  const parsed = tagStateIdentitySyntaxFrom(tagStateId);
  if (parsed.value === undefined) return parsed;
  const { tagProjector } = parsed.value;
  if (registry.resolve(tagProjector!) === undefined) {
    return { error: "tagStateId names an unregistered projector" };
  }
  return parsed;
}

export function projectionEventFromTagEvent(event: TagEvent): ProjectionEvent {
  assertSortableUniqueId(event.suid);
  return {
    eventId: event.eventId,
    suid: event.suid,
    payload: event.payload,
    eventTags: event.eventTags,
    eventType: event.eventType,
    provenance: "g32",
  };
}
