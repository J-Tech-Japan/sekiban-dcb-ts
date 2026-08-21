# @sekiban/dcb-domain

`@sekiban/dcb-domain` is the runtime-free, schema-first authoring layer for
Sekiban DCB domains. It depends on `zod` only and does not import the runtime,
storage, transport, or host APIs.

```ts
import { z } from "zod";
import {
  command,
  done,
  domain,
  event,
  projector,
  read,
  stateUnion,
  tagFamily,
  toRuntimeDomain,
} from "@sekiban/dcb-domain";

const order = tagFamily("order");
const placed = event("OrderPlaced", z.object({ orderId: z.string() }), {
  tags: (value) => [order.of(value.orderId)],
  version: 2,
});

const orderProjector = projector({
  id: "orders",
  tag: order,
  events: [placed],
  state: stateUnion(z.object({ count: z.number() }), { initial: { count: 0 } }),
  initialState: { count: 0 },
  handlers: {
    OrderPlaced: (state) => ({ count: state.count + 1 }),
  },
});

const place = command({
  id: "place-order",
  input: z.object({ orderId: z.string() }),
  reads: (input) => read(orderProjector, order.of(input.orderId)),
  handle: async (input, ctx) => {
    ctx.append(placed, placed.make(input));
    return done();
  },
});

const authoringDomain = domain({
  events: [placed],
  projectors: [orderProjector],
  commands: [place],
});

// The bridge is the only adapter needed by the existing runtime.
const runtimeDomain = toRuntimeDomain(authoringDomain);
```

Events require both a Zod schema and an explicit tag derivation. `make()`
validates and brands the payload; `append()` accepts that branded payload and
derives tags from the event definition, so caller-supplied routing cannot drift.
Projectors bind their tag family at compile time. Commands declare their pure,
bounded read set and receive only `state`, `exists`, `now`, and `append`.

Sessions use one executor-captured `now`, per-(projector, tag) snapshots, a
fresh session on consistency-conflict retry, and an atomic `done` envelope.
`none`, `reject`, thrown errors, and cancellation discard all tentative work.
Portable snapshots, decision logs, and the five ingress/query parse boundaries
are exported from the main entrypoint. Pure command/evolve exercises are
available from `@sekiban/dcb-domain/testing`.

The package boundary is enforced in CI by the dedicated compile-fail project,
source import/global checks, negative fixtures, and an `npm pack --dry-run`
inspection. The package has no runtime dependency by design.
