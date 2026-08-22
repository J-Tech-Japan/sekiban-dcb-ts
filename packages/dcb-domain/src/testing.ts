import type { EventRecord, FixedNow, JsonValue, Tag } from "./types";
import type { CommandDefinition } from "./command";
import type { EventDefinition } from "./event";
import { executeCommand } from "./session";
import type { ProjectorDefinition } from "./state";

export interface TestingEvent extends EventRecord {
  readonly payload: JsonValue;
}

export interface Expectation {
  readonly kind: "done" | "none" | "reject" | "accepted" | "discarded" | "rejected";
  readonly code?: string;
}

export interface GivenWhen {
  readonly expect: (expectation: Expectation | Expectation["kind"]) => Promise<unknown>;
}

export interface GivenBuilder {
  readonly when: (command: CommandDefinition, input: unknown) => GivenWhen;
}

function stateFor<State, Family extends string, Events extends readonly EventDefinition[]>(
  projector: ProjectorDefinition<State, Family, Events>,
  events: readonly TestingEvent[],
): State {
  let state = (typeof projector.initialState === "function"
    ? (projector.initialState as () => State)()
    : projector.initialState) as State;
  for (const event of events) state = projector.apply(state, event);
  return state as State;
}

function expectationMatches(result: Awaited<ReturnType<typeof executeCommand>>, expectation: Expectation | Expectation["kind"]): boolean {
  const expected = typeof expectation === "string" ? { kind: expectation } : expectation;
  if (expected.kind === "done") return result.decision.kind === "done";
  if (expected.kind === "none") return result.decision.kind === "none";
  if (expected.kind === "reject") return result.decision.kind === "reject" && (expected.code === undefined || result.decision.code === expected.code);
  if (expected.kind === "accepted") return result.status === "accepted";
  if (expected.kind === "discarded") return result.status === "discarded";
  return result.status === "rejected";
}

export function given<
  State,
  Family extends string,
  Events extends readonly EventDefinition[],
>(
  projector: ProjectorDefinition<State, Family, Events>,
  events: readonly TestingEvent[] = [],
  options: { readonly now?: FixedNow; readonly tag?: Tag } = {},
): GivenBuilder {
  const tag = options.tag ?? projector.tag.of("test");
  const state = stateFor(projector, events);
  return {
    when: (command, input) => ({
      expect: async (expectation) => {
        const result = await executeCommand(command, input, {
          timeProvider: { now: () => options.now ?? 0 },
          snapshots: {
            read: (requestedProjector, requestedTag) => ({
              projectorId: requestedProjector.id,
              tag: requestedTag,
              head: "test-head",
              state: requestedProjector.id === projector.id && requestedTag.id === tag.id ? state : requestedProjector.initialState,
              exists: events.length > 0,
            }),
          },
        });
        if (!expectationMatches(result, expectation)) {
          throw new Error(`Expected ${typeof expectation === "string" ? expectation : expectation.kind}, received ${result.decision.kind}/${result.status}`);
        }
        return result;
      },
    }),
  };
}

export interface EvolveTableCase<State> {
  readonly name: string;
  readonly state: State;
  readonly event: TestingEvent;
  readonly expected: State;
}

export function evolveTable<
  State,
  Family extends string,
  Events extends readonly EventDefinition[],
>(
  projector: ProjectorDefinition<State, Family, Events>,
  cases: readonly EvolveTableCase<NoInfer<State>>[],
): readonly { readonly name: string; readonly state: State }[] {
  return Object.freeze(cases.map((testCase) => {
    const actual = projector.apply(testCase.state, testCase.event);
    if (JSON.stringify(actual) !== JSON.stringify(testCase.expected)) {
      throw new Error(`Evolve table case ${testCase.name} failed`);
    }
    return Object.freeze({ name: testCase.name, state: actual });
  }));
}

export const evolve = evolveTable;
