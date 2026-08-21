import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BoundaryParseError,
  DomainRegistrationError,
  Session,
  createWasmRestoreDecoder,
  domain,
  done,
  event,
  eventUnion,
  executeCommand,
  none,
  parseExternalQueryInput,
  parseHttpCommandInput,
  parseQueueMessage,
  parseStoredEvent,
  projector,
  read,
  readExists,
  readSet,
  stateUnion,
  states,
  serializePortableSnapshot,
  tagFamily,
  toRuntimeDomain,
  deserializePortableSnapshot,
  UndeclaredReadError,
  type Tag,
} from "@sekiban/dcb-domain";
import { composeRuntime } from "../packages/dcb-runtime/src/composition";
import { evolveTable, given } from "@sekiban/dcb-domain/testing";

const order = tagFamily("order");
const audit = tagFamily("audit");
const placed = event("OrderPlaced", z.object({ orderId: z.string() }), {
  tags: (payload) => [order.of(payload.orderId)],
  version: 2,
});
const cancelled = event("OrderCancelled", z.object({ orderId: z.string() }), {
  tags: (payload) => [order.of(payload.orderId)],
});
const union = eventUnion("kind", [placed, cancelled]);

type OrderState =
  | { readonly kind: "empty" }
  | { readonly kind: "placed"; readonly orderId: string };

const orderProjector = projector<OrderState, "order", [typeof placed, typeof cancelled]>({
  id: "order-projector",
  version: 1,
  tag: order,
  events: [placed, cancelled],
  state: stateUnion(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("empty") }),
    z.object({ kind: z.literal("placed"), orderId: z.string() }),
  ]), { initial: { kind: "empty" } }),
  initialState: { kind: "empty" },
  handlers: {
    OrderPlaced: (_state, eventValue) => ({ kind: "placed", orderId: eventValue.payload.orderId }),
    OrderCancelled: () => ({ kind: "empty" }),
  },
});

describe("SDT-G28 authoring surface", () => {
  it("parses schema-first events, derives tags once, and builds a union", () => {
    const payload = placed.make({ orderId: "o-1" });
    expect(payload.orderId).toBe("o-1");
    expect(placed.version).toBe(2);
    expect(placed.eventType).toBe("OrderPlaced:2");
    expect(placed.tags(payload).map((tag) => tag.id)).toEqual(["order:o-1"]);
    expect(union.parse({ orderId: "o-1" }).orderId).toBe("o-1");
    expect(() => placed.make({ orderId: 1 })).toThrow();
    const status = states([
      z.object({ kind: z.literal("open") }),
      z.object({ kind: z.literal("closed") }),
    ], { initial: { kind: "open" } });
    expect(() => status.parse({ kind: "unknown" })).toThrow();
    const opened = event("Opened", z.object({ kind: z.literal("opened"), id: z.string() }), {
      tags: (value) => [order.of(value.id)],
    });
    const closed = event("Closed", z.object({ kind: z.literal("closed"), id: z.string() }), {
      tags: (value) => [order.of(value.id)],
    });
    const discriminated = eventUnion("kind", [opened, closed]);
    expect(discriminated.schema.parse({ kind: "closed", id: "o-1" })).toMatchObject({ kind: "closed" });
    expect(() => discriminated.parse({ kind: "unknown", id: "o-1" })).toThrow();
  });

  it("enforces projector coverage and domain identity registration", () => {
    expect(orderProjector.eventTypes).toEqual(["OrderPlaced:2", "OrderCancelled:1"]);
    const registered = domain({ events: [placed, cancelled], projectors: [orderProjector] });
    expect(registered.eventByType.get("OrderPlaced:2")).toBe(placed);
    expect(() => domain({ events: [placed, placed] })).toThrow(DomainRegistrationError);
  });

  it("runs a command through OPEN to SEALED with automatic tags and fixed now", async () => {
    const command = (await import("@sekiban/dcb-domain")).command({
      id: "place-order",
      input: z.object({ orderId: z.string() }),
      reads: (input) => read(orderProjector, order.of(input.orderId)),
      handle: async (input, context) => {
        const state = await context.state(orderProjector, order.of(input.orderId));
        if (state.kind === "placed") return none("already placed");
        context.append(placed, placed.make(input));
        return done({ orderId: input.orderId });
      },
    });
    const committed: unknown[] = [];
    const result = await executeCommand(command, { orderId: "o-2" }, {
      timeProvider: { now: () => "fixed-now" },
      snapshots: {
        read: (projectorValue, tag) => ({
          projectorId: projectorValue.id,
          tag,
          head: "head-1",
          state: { kind: "empty" },
          exists: false,
        }),
      },
      commit: (envelope) => {
        committed.push(envelope);
        return { kind: "accepted" };
      },
    });
    expect(result.status).toBe("accepted");
    expect(result.now).toBe("fixed-now");
    expect(result.envelope?.tags.map((tag) => tag.id)).toEqual(["order:o-2"]);
    expect(result.envelope?.events[0]?.eventType).toBe("OrderPlaced:2");
    expect(result.envelope?.events[0]).not.toHaveProperty("eventId");
    expect(committed).toHaveLength(1);
    expect(result.session.status).toBe("SEALED");
    await given(orderProjector).when(command, { orderId: "o-kit" }).expect("done");
  });

  it("drops all tentative work on none and never calls the commit port", async () => {
    const command = (await import("@sekiban/dcb-domain")).command({
      id: "discard-order",
      input: z.object({ orderId: z.string() }),
      reads: (input) => read(orderProjector, order.of(input.orderId)),
      handle: async (input, context) => {
        context.append(cancelled, cancelled.make(input));
        return none("operator cancelled");
      },
    });
    let commitCalls = 0;
    const result = await executeCommand(command, { orderId: "o-3" }, {
      snapshots: {
        read: (projectorValue, tag) => ({ projectorId: projectorValue.id, tag, head: null, state: { kind: "empty" }, exists: false }),
      },
      commit: () => {
        commitCalls += 1;
        return { kind: "accepted" };
      },
    });
    expect(result.status).toBe("discarded");
    expect(result.session.status).toBe("DISCARDED");
    expect(result.session.stagedEvents).toEqual([]);
    expect(commitCalls).toBe(0);
  });

  it("includes read-only tags, reflects staged exists, and enforces lifecycle guards", async () => {
    const session = new Session({
      now: 5,
      readSet: readExists(order.of("o-exists")),
      snapshots: {
        read: (projectorValue, tag) => ({ projectorId: projectorValue.id, tag, head: null, state: { kind: "empty" }, exists: false }),
        exists: () => false,
      },
    });
    await session.preload();
    expect(await session.context().exists(order.of("o-exists"))).toBe(false);
    session.append(placed, placed.make({ orderId: "o-exists" }));
    expect(await session.context().exists(order.of("o-exists"))).toBe(true);
    const envelope = session.seal(done());
    expect(envelope.tags.map((tag) => tag.id)).toEqual(["order:o-exists"]);
    expect(() => session.append(placed, placed.make({ orderId: "o-exists" }))).toThrow();
    expect(() => session.seal(done())).toThrow();
    const dynamicSession = new Session({ now: 0, readSet: read(orderProjector, order.of("declared")) });
    await expect(dynamicSession.context().state(orderProjector, order.of("undeclared"))).rejects.toThrow(UndeclaredReadError);
  });

  it("retries a consistency conflict with a fresh session and one fixed now", async () => {
    const command = (await import("@sekiban/dcb-domain")).command({
      id: "retry-order",
      input: z.object({ orderId: z.string() }),
      reads: (input) => read(orderProjector, order.of(input.orderId)),
      handle: async (input, context) => {
        context.append(placed, placed.make(input));
        return done();
      },
    });
    const envelopes: Array<{ readonly now: string | number | bigint; readonly tags: readonly { readonly id: string }[] }> = [];
    let calls = 0;
    const result = await executeCommand(command, { orderId: "o-4" }, {
      maxConflictRetries: 1,
      timeProvider: { now: () => "one-now" },
      snapshots: {
        read: (projectorValue, tag) => ({ projectorId: projectorValue.id, tag, head: "same-head", state: { kind: "empty" }, exists: false }),
      },
      commit: (envelope) => {
        envelopes.push(envelope);
        calls += 1;
        return calls === 1 ? { kind: "consistency-conflict" } : { kind: "accepted" };
      },
    });
    expect(result.status).toBe("accepted");
    expect(result.attempts).toBe(2);
    expect(envelopes.map((envelope) => envelope.now)).toEqual(["one-now", "one-now"]);
    expect(envelopes.map((envelope) => envelope.tags.map((tag) => tag.id))).toEqual([["order:o-4"], ["order:o-4"]]);
  });

  it("keeps the stored tag derivation authoritative during late replay", async () => {
    let target: Tag = order.of("old");
    const dynamic = event("DynamicEvent", z.object({ id: z.string() }), { tags: () => [target] });
    const secondProjector = projector<{ readonly kind: "count" }, "order", [typeof dynamic]>({
      id: "second-order-projector",
      tag: order,
      events: [dynamic],
      initialState: { kind: "count" },
      handlers: { DynamicEvent: (state) => state },
    });
    const session = new Session({
      now: 0,
      readSet: readSet(read(orderProjector, order.of("old")), read(secondProjector, order.of("old"))),
      snapshots: {
        read: (projectorValue, tag) => ({
          projectorId: projectorValue.id,
          tag,
          head: "h",
          state: projectorValue.id === secondProjector.id ? { kind: "count" } : { kind: "empty" },
          exists: false,
        }),
      },
    });
    await session.preload();
    session.append(dynamic, dynamic.make({ id: "x" }));
    target = audit.of("new");
    const state = await session.context().state(secondProjector, order.of("old"));
    expect(state.kind).toBe("count");
    expect(session.stagedEvents[0]?.tags.map((tag) => tag.id)).toEqual(["order:old"]);
  });

  it("keeps parse boundaries fail-closed and bridges without changing V1 shape", () => {
    expect(parseHttpCommandInput(z.object({ value: z.string() }), { value: "http" }).value).toBe("http");
    expect(parseQueueMessage(z.object({ value: z.string() }), { value: "queue" }).value).toBe("queue");
    expect(parseStoredEvent(z.object({ value: z.string() }), { value: "stored" }).value).toBe("stored");
    expect(parseExternalQueryInput(z.object({ value: z.string() }), { value: "query" }).value).toBe("query");
    const decoder = createWasmRestoreDecoder(z.object({ version: z.number() }));
    expect(decoder.decode(JSON.stringify({ version: 1 })).version).toBe(1);
    expect(() => decoder.decode("not-json")).toThrow(BoundaryParseError);
    const runtime = toRuntimeDomain(domain({ events: [placed, cancelled], projectors: [orderProjector] }));
    expect(runtime.events[0]?.eventType).toBe("OrderPlaced:2");
    expect(runtime.projectors[0]?.subscribedEventTypes).toEqual(["OrderPlaced:2", "OrderCancelled:1"]);
    const state = runtime.projectors[0]?.apply({ kind: "empty" }, {
      eventType: "OrderPlaced:2",
      payload: { orderId: "o-5" },
    });
    expect(state).toEqual({ kind: "placed", orderId: "o-5" });
    const composed = composeRuntime(runtime).projectors.resolve("order-projector");
    expect(composed).toBeDefined();
    const composedState = composed!.apply({ kind: "empty" }, {
      eventId: "e-5",
      suid: "suid-00000000000000000000000000000005",
      payload: btoa(JSON.stringify({ orderId: "o-5" })),
      eventTags: ["order:o-5"],
      eventType: "OrderPlaced:2",
      provenance: "g27",
    });
    expect(composedState).toEqual({ kind: "placed", orderId: "o-5" });
    const snapshot = deserializePortableSnapshot(serializePortableSnapshot({
      projectorId: orderProjector.id,
      tag: order.of("o-5"),
      head: "h-5",
      state: { kind: "placed", orderId: "o-5" },
      exists: true,
    }));
    expect(snapshot.tag.id).toBe("order:o-5");
  });

  it("records all four canonical tag propagation points", async () => {
    const observations: string[] = [];
    const session = new Session({
      now: 0,
      readSet: read(orderProjector, order.of("o-6")),
      onPropagation: (observation) => observations.push(observation.point),
    });
    await session.preload();
    session.append(placed, placed.make({ orderId: "o-6" }));
    session.seal(done());
    expect(new Set(observations)).toEqual(new Set(["staged-log", "eligible-cells", "claim-candidate-preflight", "sealed-envelope"]));
  });

  it("ships a pure testing kit for command and evolve-table exercises", async () => {
    const eventRecord = {
      eventType: placed.eventType,
      eventName: placed.name,
      payload: placed.make({ orderId: "o-table" }),
      tags: [order.of("o-table")],
      ordinal: "0",
    };
    const table = evolveTable(orderProjector, [{
      name: "place",
      state: { kind: "empty" },
      event: eventRecord,
      expected: { kind: "placed", orderId: "o-table" },
    }]);
    expect(table[0]?.state).toEqual({ kind: "placed", orderId: "o-table" });
  });
});
