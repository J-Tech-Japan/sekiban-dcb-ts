import {
  DomainDefinitionError,
  JsonValidationError,
  assertJsonValue,
  defineCommand,
  defineDomain,
  defineEvent,
  defineProjector,
  defineTag,
  done,
  noop,
} from "../packages/dcb-core/src/index";
import { describe, expect, it } from "vitest";

describe("SDT-G13 dcb-core definitions", () => {
  it("rejects non-JSON values at each required boundary", () => {
    expect(() => assertJsonValue(Number.NaN, "event-construction")).toThrow(JsonValidationError);
    expect(() => assertJsonValue(Number.POSITIVE_INFINITY, "state-persistence")).toThrow(JsonValidationError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => assertJsonValue(cyclic, "command-input")).toThrow(JsonValidationError);
    expect(() => assertJsonValue(undefined, "command-input")).toThrow(JsonValidationError);
    expect(() => assertJsonValue(new Date(), "event-construction")).toThrow(JsonValidationError);
  });

  it("validates event construction, closes projector subscriptions, and ignores unknown wire events", () => {
    const created = defineEvent<{ value: number }>({
      name: "Created",
      eventPayloadName: "CreatedPayload",
      parse: (value) => {
        if (typeof value !== "object" || value === null || typeof (value as { value?: unknown }).value !== "number") {
          throw new Error("value is required");
        }
        return value as { value: number };
      },
    });
    expect(created.create({ value: 2 })).toMatchObject({ eventName: "Created", eventPayloadName: "CreatedPayload" });
    expect(() => created.create({ value: Number.NaN })).toThrow(JsonValidationError);
    const projector = defineProjector({
      id: "counter",
      version: 1,
      initialState: { count: 0 },
      subscribedEventNames: [created.name],
      handlers: {
        Created: (state, event) => ({ count: state.count + (event.payload as { value: number }).value }),
      },
    });
    expect(projector.apply(projector.initialState, { eventName: "Unknown", payload: { value: 5 } })).toEqual({ count: 0 });
    expect(projector.apply(projector.initialState, created.create({ value: 2 }))).toEqual({ count: 2 });
    expect(() => defineProjector({ id: "broken", initialState: {}, subscribedEventNames: ["Created"], handlers: {} })).toThrow(/missing handlers/);
  });

  it("accumulates all command appends into one committed outcome", () => {
    const first = defineEvent("First");
    const second = defineEvent("Second");
    const command = defineCommand({
      id: "append-twice",
      parseInput: (value: unknown) => {
        if (typeof value !== "object" || value === null || typeof (value as { tag?: unknown }).tag !== "string") throw new Error("tag required");
        return value as { tag: string };
      },
      handler: (input, context) => {
        context.assertEmpty(input.tag);
        context.append(first, { n: 1 }, [input.tag]);
        context.append(second, { n: 2 }, [input.tag]);
        return context.done({ accepted: true });
      },
    });
    const outcome = command.execute({ tag: "g13:one" });
    expect(outcome.kind).toBe("committed");
    expect(outcome.events).toHaveLength(2);
    expect(outcome.events.map((event) => event.event.name)).toEqual(["First", "Second"]);
    expect(() => command.execute({ tag: "g13:one", extra: Number.NaN })).toThrow(JsonValidationError);
    expect(noop("nothing").kind).toBe("noop");
  });

  it("SDT-G88 AC8: builds the committed outcome from kind, value and events only", () => {
    const appended = defineEvent("G88Appended");
    const parseInput = (value: unknown) => {
      if (typeof value !== "object" || value === null || typeof (value as { mode?: unknown }).mode !== "string") throw new Error("mode required");
      return value as { mode: "context" | "exported" | "literal" };
    };
    const command = defineCommand({
      id: "g88-done-state",
      parseInput,
      handler: (input, context) => {
        context.append(appended, { n: 1 }, ["g88:done"]);
        if (input.mode === "context") return context.done({ accepted: "context" });
        if (input.mode === "exported") {
          // @ts-expect-error SDT-G88 removed the state parameter from dcb-core done.
          return done({ accepted: "exported" }, { leaked: true });
        }
        const withState = { kind: "committed" as const, value: { accepted: "literal" }, state: { leaked: true } };
        return withState;
      },
    });
    for (const mode of ["context", "exported", "literal"] as const) {
      const outcome = command.execute({ mode });
      expect(outcome, mode).not.toHaveProperty("state");
      expect(Object.keys(outcome).sort(), mode).toEqual(["events", "kind", "value"]);
      expect(outcome, mode).toMatchObject({ kind: "committed", value: { accepted: mode }, events: [{ event: { name: "G88Appended" } }] });
    }
    // @ts-expect-error SDT-G88 removed the state parameter from dcb-core done.
    expect(done({ accepted: true }, { leaked: true })).not.toHaveProperty("state");
  });

  it("reports every duplicate family in one typed domain error", () => {
    const event = defineEvent("DuplicateEvent");
    const projector = defineProjector({ id: "duplicate-projector", version: 2, initialState: {}, handlers: {} });
    const query = { id: "duplicate-query", version: 1 } as const;
    const mv = { id: "duplicate-mv", version: 1 } as const;
    let failure: unknown;
    try {
      defineDomain({
        events: [event, event],
        projectors: [projector, projector],
        queries: [query, query],
        materializedViews: [mv, mv],
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DomainDefinitionError);
    const collisions = (failure as DomainDefinitionError).collisions;
    expect(collisions.map((collision) => collision.kind)).toEqual(expect.arrayContaining([
      "event-name",
      "projector-id",
      "query-id",
      "materialized-view-id",
      "version-pair",
    ]));
  });

  it("normalizes tag identity without allowing a second spelling", () => {
    expect(defineTag("group", "content")).toEqual({ id: "group:content", tag: "group:content", group: "group", content: "content" });
    expect(defineTag("group:content")).toEqual(defineTag({ tag: "group:content" }));
  });
});
