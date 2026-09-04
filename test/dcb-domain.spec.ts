import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BoundaryParseError,
  DomainRegistrationError,
  Session,
  assertParsedAt,
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
  reject,
  stateUnion,
  states,
  serializeDecisionLog,
  serializePortableSnapshot,
  tagFamily,
  toRuntimeDomain,
  deserializePortableSnapshot,
  UndeclaredReadError,
  type Tag,
} from "@sekiban/dcb-domain";
import {
  composeRuntime,
  createRuntimeCommitPort,
  registeredEventParsers,
} from "../packages/dcb-runtime/src/composition";
import { evolveTable, given } from "@sekiban/dcb-domain/testing";

const order = tagFamily("order");
const audit = tagFamily("audit");
const placed = event("OrderPlaced", z.object({ orderId: z.string() }), {
  tags: (payload) => [order.of(payload.orderId)],
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

const orderMirrorProjector = projector<{ readonly kind: "mirror" }, "order", [typeof placed, typeof cancelled]>({
  id: "order-mirror-projector",
  version: 1,
  tag: order,
  events: [placed, cancelled],
  initialState: { kind: "mirror" },
  handlers: {
    OrderPlaced: (state) => state,
    OrderCancelled: (state) => state,
  },
});

describe("SDT-G28 authoring surface", () => {
  it("parses schema-first events, derives tags once, and builds a union", () => {
    const payload = placed.make({ orderId: "o-1" });
    expect(payload.orderId).toBe("o-1");
    expect(placed.eventType).toBe("OrderPlaced");
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
    expect(orderProjector.eventTypes).toEqual(["OrderPlaced", "OrderCancelled"]);
    const registered = domain({ events: [placed, cancelled], projectors: [orderProjector] });
    expect(registered.eventByType.get("OrderPlaced")).toBe(placed);
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
    expect(result.envelope?.events[0]?.eventType).toBe("OrderPlaced");
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

  it("makes eager and late replay equivalent for the exact eligible 2x2 cells", async () => {
    const unsubscribedProjector = projector<{ readonly count: number }, "order", [typeof cancelled]>({
      id: "unsubscribed-order-projector",
      tag: order,
      events: [cancelled],
      initialState: { count: 0 },
      handlers: { OrderCancelled: (state) => ({ count: state.count + 1 }) },
    });
    const wrongFamilyProjector = projector<{ readonly count: number }, "audit", [typeof placed]>({
      id: "wrong-family-projector",
      tag: audit,
      events: [placed],
      initialState: { count: 0 },
      handlers: { OrderPlaced: (state) => ({ count: state.count + 1 }) },
    });
    const readSetForCells = readSet(
      read(orderProjector, order.of("cell-a")),
      read(orderProjector, order.of("cell-b")),
      read(unsubscribedProjector, order.of("cell-a")),
      read(wrongFamilyProjector, audit.of("cell-a")),
    );
    const snapshots = {
      read: (projectorValue: { readonly id: string }, tag: Tag) => ({
        projectorId: projectorValue.id,
        tag,
        head: `${tag.id}-head`,
        state: projectorValue.id === orderProjector.id ? { kind: "empty" } : { count: 0 },
        exists: false,
      }),
    };
    const eager = new Session({ now: 0, readSet: readSetForCells, snapshots });
    await eager.preload();
    eager.append(placed, placed.make({ orderId: "cell-a" }));
    const eagerValues = await Promise.all([
      eager.context().state(orderProjector, order.of("cell-a")),
      eager.context().state(orderProjector, order.of("cell-b")),
      eager.context().state(unsubscribedProjector, order.of("cell-a")),
      eager.context().state(wrongFamilyProjector, audit.of("cell-a")),
    ]);

    const late = new Session({ now: 0, readSet: readSetForCells, snapshots });
    late.append(placed, placed.make({ orderId: "cell-a" }));
    const lateValues = await Promise.all([
      late.context().state(orderProjector, order.of("cell-a")),
      late.context().state(orderProjector, order.of("cell-b")),
      late.context().state(unsubscribedProjector, order.of("cell-a")),
      late.context().state(wrongFamilyProjector, audit.of("cell-a")),
    ]);

    expect(eagerValues).toEqual(lateValues);
    expect(eagerValues).toEqual([
      { kind: "placed", orderId: "cell-a" },
      { kind: "empty" },
      { count: 0 },
      { count: 0 },
    ]);
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

  it("captures a changing injected clock once before the retry loop", async () => {
    const command = (await import("@sekiban/dcb-domain")).command({
      id: "changing-clock-order",
      input: z.object({ orderId: z.string() }),
      reads: (input) => read(orderProjector, order.of(input.orderId)),
      handle: (input, context) => {
        context.append(placed, placed.make(input));
        return done();
      },
    });
    let clockCalls = 0;
    let commitCalls = 0;
    const envelopes: Array<{ readonly now: string | number | bigint }> = [];
    const result = await executeCommand(command, { orderId: "changing-clock" }, {
      maxConflictRetries: 1,
      timeProvider: { now: () => ++clockCalls },
      commit: (envelope) => {
        envelopes.push(envelope);
        commitCalls += 1;
        return commitCalls === 1 ? { kind: "consistency-conflict" } : { kind: "accepted" };
      },
    });
    expect(result.status).toBe("accepted");
    expect(clockCalls).toBe(1);
    expect(envelopes.map((envelope) => envelope.now)).toEqual([1, 1]);
    expect(result.log).not.toHaveProperty("suid");
    expect(result.log.events[0]).not.toHaveProperty("eventId");
    expect(JSON.parse(serializeDecisionLog(result.log))).not.toHaveProperty("suid");
  });

  it("keeps business-clock changes orthogonal to canonical order identity", async () => {
    const timed = event("BusinessTimed", z.object({ orderId: z.string(), businessAt: z.number() }), {
      tags: (payload) => [order.of(payload.orderId)],
    });
    const timedCommand = (await import("@sekiban/dcb-domain")).command({
      id: "business-clock-order",
      input: z.object({ orderId: z.string() }),
      reads: () => readExists(order.of("business-clock")),
      handle: (input, context) => {
        const now = context.now();
        if (typeof now !== "number") return reject("invalid-state", "business clock must be numeric");
        context.append(timed, timed.make({ orderId: input.orderId, businessAt: now }));
        return done();
      },
    });
    const first = await executeCommand(timedCommand, { orderId: "clock-order" }, { timeProvider: { now: () => 10 } });
    const second = await executeCommand(timedCommand, { orderId: "clock-order" }, { timeProvider: { now: () => 20 } });
    expect(first.envelope?.events[0]).toMatchObject({ eventType: "BusinessTimed", payload: { businessAt: 10 }, tags: [{ id: "order:clock-order" }] });
    expect(second.envelope?.events[0]).toMatchObject({ eventType: "BusinessTimed", payload: { businessAt: 20 }, tags: [{ id: "order:clock-order" }] });
    expect(first.envelope?.events[0]).not.toHaveProperty("eventId");
    expect(second.envelope?.events[0]).not.toHaveProperty("suid");
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

  it("preserves stored multi-tag values through late replay and all propagation points", async () => {
    let currentTags: readonly Tag[] = [order.of("stored-a"), audit.of("stored-a")];
    const storedEvent = event("StoredMultiTag", z.object({ id: z.string() }), {
      tags: () => currentTags,
    });
    const storedOrderProjector = projector<{ readonly count: number }, "order", [typeof storedEvent]>({
      id: "stored-order-projector",
      tag: order,
      events: [storedEvent],
      initialState: { count: 0 },
      handlers: { StoredMultiTag: (state) => ({ count: state.count + 1 }) },
    });
    const storedAuditProjector = projector<{ readonly count: number }, "audit", [typeof storedEvent]>({
      id: "stored-audit-projector",
      tag: audit,
      events: [storedEvent],
      initialState: { count: 0 },
      handlers: { StoredMultiTag: (state) => ({ count: state.count + 1 }) },
    });
    const canonical = [order.of("stored-a"), audit.of("stored-a")];
    const observations: Array<{ point: string; tags: readonly Tag[] }> = [];
    const session = new Session({
      now: 0,
      readSet: readSet(
        read(storedOrderProjector, order.of("stored-a")),
        read(storedAuditProjector, audit.of("stored-a")),
      ),
      onPropagation: (observation) => observations.push(observation),
    });
    session.append(storedEvent, storedEvent.make({ id: "stored-a" }));
    currentTags = [order.of("changed-by-v2")];
    expect(await session.context().state(storedOrderProjector, order.of("stored-a"))).toEqual({ count: 1 });
    expect(await session.context().state(storedAuditProjector, audit.of("stored-a"))).toEqual({ count: 1 });
    const envelope = session.seal(done());
    expect(session.stagedEvents[0]?.tags.map((tag) => tag.id)).toEqual(canonical.map((tag) => tag.id));
    expect(observations.map(({ point }) => point)).toEqual([
      "staged-log",
      "eligible-cells",
      "eligible-cells",
      "claim-candidate-preflight",
      "sealed-envelope",
    ]);
    for (const observation of observations) expect(observation.tags).toEqual(canonical);
    expect(envelope.tags).toEqual(canonical);
  });

  it("keeps read-only A, appended B, per-tag heads, and the whole-log seal independent", async () => {
    const session = new Session({
      now: 0,
      readSet: readExists(order.of("read-only-a")),
      snapshots: {
        read: (projectorValue, tag) => ({ projectorId: projectorValue.id, tag, head: "head-a", state: { kind: "empty" }, exists: false }),
        exists: () => false,
      },
    });
    await session.preload();
    session.append(placed, placed.make({ orderId: "append-b" }));
    session.append(placed, placed.make({ orderId: "append-c" }));
    const envelope = session.seal(done());
    expect(envelope.events).toHaveLength(2);
    expect(envelope.tags.map((tag) => tag.id)).toEqual(["order:append-b", "order:append-c", "order:read-only-a"]);
    expect(envelope.readClaims).toMatchObject([{ kind: "exists", tag: { id: "order:read-only-a" }, head: "" }]);

    const sameTag = new Session({
      now: 0,
      readSet: readSet(read(orderProjector, order.of("same")), read(orderMirrorProjector, order.of("same"))),
      snapshots: {
        read: (projectorValue, tag) => ({ projectorId: projectorValue.id, tag, head: projectorValue.id === orderProjector.id ? "head-1" : "head-2", state: projectorValue.id === orderProjector.id ? { kind: "empty" } : { kind: "mirror" }, exists: false }),
      },
    });
    await expect(sameTag.preload()).rejects.toThrow(/heads head-1 and head-2/);

    const differentTags = new Session({
      now: 0,
      readSet: readSet(read(orderProjector, order.of("head-a")), read(orderProjector, order.of("head-b"))),
      snapshots: {
        read: (projectorValue, tag) => ({ projectorId: projectorValue.id, tag, head: tag.id === "order:head-a" ? "head-a" : "head-b", state: { kind: "empty" }, exists: false }),
      },
    });
    await expect(differentTags.preload()).resolves.toBeUndefined();
    expect(differentTags.readClaims.map((claim) => [claim.tag.id, claim.head])).toEqual([["order:head-a", "head-a"], ["order:head-b", "head-b"]]);
  });

  it("discards 0/1/N tentative events without entering the commit port", async () => {
    const discardCommand = (await import("@sekiban/dcb-domain")).command({
      id: "discard-counted-events",
      input: z.object({ count: z.number().int().min(0).max(3) }),
      reads: () => read(orderProjector, order.of("discard-count")),
      handle: (input, context) => {
        for (let index = 0; index < input.count; index += 1) context.append(placed, placed.make({ orderId: `discard-${index}` }));
        return none(`discard-${input.count}`);
      },
    });
    let commitCalls = 0;
    for (const count of [0, 1, 3]) {
      const result = await executeCommand(discardCommand, { count }, { commit: () => { commitCalls += 1; } });
      expect(result.status).toBe("discarded");
      expect(result.session.status).toBe("DISCARDED");
      expect(result.session.stagedEvents).toEqual([]);
    }
    expect(commitCalls).toBe(0);
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
    expect(runtime.events[0]?.eventType).toBe("OrderPlaced");
    expect(runtime.projectors[0]?.subscribedEventTypes).toEqual(["OrderPlaced", "OrderCancelled"]);
    const state = runtime.projectors[0]?.apply({ kind: "empty" }, {
      eventType: "OrderPlaced",
      payload: { orderId: "o-5" },
    });
    expect(state).toEqual({ kind: "placed", orderId: "o-5" });
    const composed = composeRuntime(runtime).projectors.resolve("order-projector");
    expect(composed).toBeDefined();
    const composedState = composed!.apply({ kind: "empty" }, {
      eventId: "e-5",
      suid: "suid-00000000000000000000000000000005",
      payload: JSON.stringify({ orderId: "o-5" }),
      eventTags: ["order:o-5"],
      eventType: "OrderPlaced",
      provenance: "g32",
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

  it("does not accept a value parsed at another ingress boundary", () => {
    const schema = z.object({ value: z.string() });
    const parsedAtHttp = parseHttpCommandInput(schema, { value: "http" });
    let downstreamCalls = 0;
    let failure: unknown;
    try {
      const parsedAtQueue = assertParsedAt("queue", parsedAtHttp as unknown);
      downstreamCalls += 1;
      expect(parsedAtQueue).toBeDefined();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(BoundaryParseError);
    expect((failure as BoundaryParseError).finding).toBe("queue-parse-bypass");
    expect(downstreamCalls).toBe(0);
  });

  it("adapts authored commands through admission, allocation, commit, and reconcile ports", async () => {
    const authoredCommand = (await import("@sekiban/dcb-domain")).command({
      id: "runtime-place-order",
      input: z.object({ orderId: z.string() }),
      reads: (input) => read(orderProjector, order.of(input.orderId)),
      handle: (input, context) => {
        context.append(placed, placed.make(input));
        return done({ orderId: input.orderId });
      },
    });
    const runtime = toRuntimeDomain(domain({ events: [placed, cancelled], projectors: [orderProjector], commands: [authoredCommand] }));
    const runtimeCommand = runtime.commands[0]!;
    let barriers = 0;
    let admissions = 0;
    let allocations = 0;
    let commits = 0;
    const port = {
      conflictBarrier: (candidate: { readonly events: readonly { readonly eventType: string; readonly provenance: string }[] }) => {
        barriers += 1;
        expect(candidate.events[0]).toMatchObject({ eventType: "OrderPlaced", provenance: "g32" });
        return barriers === 1 ? { kind: "consistency-conflict" as const } : { kind: "accepted" as const };
      },
      admit: (candidate: { readonly events: readonly { readonly eventType: string; readonly provenance: string }[] }) => {
        admissions += 1;
        expect(candidate.events[0]).toMatchObject({ eventType: "OrderPlaced", provenance: "g32" });
        return { kind: "accepted" as const };
      },
      allocate: (candidate: { readonly events: readonly { readonly eventType: string; readonly provenance: string }[] }) => {
        allocations += 1;
        expect(candidate.events[0]).toMatchObject({ eventType: "OrderPlaced", provenance: "g32" });
        return { candidates: [{ ordinal: "0", suid: "suid-runtime-vector-1" }], allocatorLineageId: "runtime-lineage" };
      },
      commit: (candidate: { readonly events: readonly { readonly eventType: string; readonly provenance: string }[] }, allocation?: { readonly candidates: readonly { readonly suid: string }[] }) => {
        commits += 1;
        expect(candidate.events[0]).not.toHaveProperty("eventId");
        expect(candidate.events[0]).not.toHaveProperty("suid");
        expect(allocation?.candidates[0]?.suid).toBe("suid-runtime-vector-1");
        return { kind: "accepted" as const };
      },
    };
    const outcome = await runtimeCommand.execute({ orderId: "runtime-order" }, { now: 17, runtimePort: port });
    expect(outcome).toMatchObject({ kind: "committed", value: { orderId: "runtime-order" } });
    expect(barriers).toBe(2);
    expect(admissions).toBe(1);
    expect(allocations).toBe(1);
    expect(commits).toBe(1);

    let reconciles = 0;
    let unknownAdmissions = 0;
    let unknownAllocations = 0;
    let unknownCommits = 0;
    let firstCandidate: unknown;
    let firstAllocation: unknown;
    const unknownOutcome = await runtimeCommand.execute({ orderId: "runtime-unknown" }, {
      runtimePort: {
        admit: () => {
          unknownAdmissions += 1;
          return { kind: "accepted" as const, attemptId: "same-attempt" };
        },
        allocate: () => {
          unknownAllocations += 1;
          return { attemptId: "same-attempt", candidates: [{ ordinal: "0", suid: "suid-runtime-vector-2" }] };
        },
        commit: (candidate, allocation) => {
          unknownCommits += 1;
          firstCandidate = candidate;
          firstAllocation = allocation;
          return { kind: "unknown" as const, attemptId: "same-attempt" };
        },
        reconcile: (context, outcomeValue) => {
          reconciles += 1;
          // The inverse mutation that constructs a fresh candidate for
          // reconcile must fail these identity and zero-new-work assertions.
          expect(context.candidate).toBe(firstCandidate);
          expect(context.allocation).toBe(firstAllocation);
          expect(context.candidateKey).toEqual(expect.any(String));
          expect(context.attemptId).toBe("same-attempt");
          expect(Object.isFrozen(context)).toBe(true);
          expect(Object.isFrozen(context.candidate)).toBe(true);
          expect(context.allocation === undefined || Object.isFrozen(context.allocation)).toBe(true);
          expect(outcomeValue).toMatchObject({ kind: "unknown", attemptId: "same-attempt" });
          return { kind: "accepted" as const };
        },
      },
    });
    expect(unknownOutcome.kind).toBe("committed");
    expect(reconciles).toBe(1);
    expect(unknownAdmissions).toBe(1);
    expect(unknownAllocations).toBe(1);
    expect(unknownCommits).toBe(1);
  });

  it("routes composed authored commands through the real runtime commit path", async () => {
    const authoredCommand = (await import("@sekiban/dcb-domain")).command({
      id: "runtime-real-command",
      input: z.object({ orderId: z.string() }),
      reads: (input) => read(orderProjector, order.of(input.orderId)),
      handle: (input, context) => {
        context.append(placed, placed.make(input));
        return done({ orderId: input.orderId });
      },
    });
    const runtimeDomain = toRuntimeDomain(domain({
      events: [placed, cancelled],
      projectors: [orderProjector],
      commands: [authoredCommand],
    }));
    const composed = composeRuntime(runtimeDomain);
    expect(composed.commands.resolve("runtime-real-command")).toBeDefined();

    const paths: string[] = [];
    const tracedNamespace = (namespace: DurableObjectNamespace): DurableObjectNamespace => ({
      idFromName: (name: string) => namespace.idFromName(name),
      get: (id: DurableObjectId) => {
        const stub = namespace.get(id);
        return {
          fetch: async (input: RequestInfo, init?: RequestInit) => {
            const inputValue: unknown = input;
            const url = inputValue instanceof Request
              ? inputValue.url
              : inputValue instanceof URL
                ? inputValue.toString()
                : String(inputValue);
            paths.push(new URL(url).pathname);
            return stub.fetch(input, init);
          },
        } as unknown as DurableObjectStub;
      },
    } as unknown as DurableObjectNamespace);
    const testEnv = env as unknown as {
      JOURNAL: DurableObjectNamespace;
      TAG: DurableObjectNamespace;
      ALLOCATOR: DurableObjectNamespace;
      BOOTSTRAP: DurableObjectNamespace;
    };
    const runtimeEnv = {
      ...env,
      JOURNAL: tracedNamespace(testEnv.JOURNAL),
      TAG: tracedNamespace(testEnv.TAG),
      ALLOCATOR: tracedNamespace(testEnv.ALLOCATOR),
      BOOTSTRAP: tracedNamespace(testEnv.BOOTSTRAP),
    } as unknown as Parameters<typeof createRuntimeCommitPort>[0];
    const port = createRuntimeCommitPort(runtimeEnv, {
      registeredEventParsers: registeredEventParsers(runtimeDomain),
    });
    const outcome = await composed.commands.execute(
      "runtime-real-command",
      { orderId: `runtime-real-${crypto.randomUUID()}` },
      { now: 17, runtimePort: port },
    );

    expect(outcome).toMatchObject({ kind: "committed" });
    // G41 keeps the authored command on the real CommitWorker path while
    // proving that the command no longer resolves the retired JOURNAL saga.
    expect(paths).not.toContain("/admit");
    // G56 carries the explicit empty-SUID assertion through the real acquire
    // reservation path before the initial append.
    expect(paths).toContain("/acquire");
    expect(paths).toContain("/allocate");
    expect(paths).toContain("/append");
  });

  it("attributes each parse bypass to its own boundary before downstream dispatch", () => {
    const schema = z.object({ value: z.string() });
    const cases = [
      ["http-command", (value: unknown) => parseHttpCommandInput(schema, value)],
      ["queue", (value: unknown) => parseQueueMessage(schema, value)],
      ["stored-event", (value: unknown) => parseStoredEvent(schema, value)],
      ["external-query", (value: unknown) => parseExternalQueryInput(schema, value)],
    ] as const;
    for (const [boundary, parse] of cases) {
      let downstreamCalls = 0;
      let failure: unknown;
      try {
        const parsed = parse({ value: 42 });
        assertParsedAt(boundary, parsed);
        downstreamCalls += 1;
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(BoundaryParseError);
      expect((failure as BoundaryParseError).finding).toBe(`${boundary}-parse`);
      expect(downstreamCalls).toBe(0);
    }
    let wasmDownstreamCalls = 0;
    const decoder = createWasmRestoreDecoder(schema);
    let wasmFailure: unknown;
    try {
      const parsed = decoder.decode(JSON.stringify({ value: 42 }));
      assertParsedAt("wasm-restore", parsed);
      wasmDownstreamCalls += 1;
    } catch (error) {
      wasmFailure = error;
    }
    expect(wasmFailure).toBeInstanceOf(BoundaryParseError);
    expect((wasmFailure as BoundaryParseError).finding).toBe("wasm-restore-parse");
    expect(wasmDownstreamCalls).toBe(0);
  });

  it("records all four canonical tag propagation points", async () => {
    const observations: Array<{ readonly point: string; readonly tags: readonly Tag[] }> = [];
    const session = new Session({
      now: 0,
      readSet: read(orderProjector, order.of("o-6")),
      onPropagation: (observation) => observations.push(observation),
    });
    await session.preload();
    session.append(placed, placed.make({ orderId: "o-6" }));
    session.seal(done());
    expect(observations.map(({ point }) => point)).toEqual(["staged-log", "eligible-cells", "claim-candidate-preflight", "sealed-envelope"]);
    for (const observation of observations) expect(observation.tags).toEqual([order.of("o-6")]);
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
