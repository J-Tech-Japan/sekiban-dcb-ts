# @sekiban/dcb-domain

`@sekiban/dcb-domain` is the runtime-free, schema-first authoring layer for
Sekiban DCB domains. It depends on `zod` only and does not import the runtime,
storage, transport, or host APIs.

## Install

```sh
npm install @sekiban/dcb-domain zod
```

The package is ESM-only and supports Node.js 20 or newer. The `zod` runtime
dependency is pinned to `4.4.3` for the 0.1.x line.

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
inspection. Its only runtime dependency is the pinned `zod` package.

## Versioning

The package follows semver while the major version is `0`: minor releases may
add public authoring capabilities, and patch releases are limited to fixes and
documentation. The public surface is frozen to the following entrypoints and
helpers for the `0.1.x` line:

- Main entrypoint: `domain`, `event`, `eventUnion`, `projector`, `stateUnion`,
  `command`, `done`, `none`, `reject`, `read`, `readExists`, `Session`,
  portable-snapshot serialization, the five boundary parsers, and the
  runtime-domain bridge (`toRuntimeDomain`).
- Testing entrypoint: `given`, `evolveTable`, and `evolve` from
  `@sekiban/dcb-domain/testing`.
- No deep imports beyond `.` and `./testing` are supported.

The earlier `@sekiban/core` and related packages belong to the older
sekiban-ts line; they are not dependencies or aliases for this package.

The first public release is `0.1.0`. The repository tag
`dcb-domain-v0.1.0` drives the provenance-enabled release workflow. The final
`npm publish --provenance --access public` is an operator action performed
only after the trusted publisher or `NPM_TOKEN` fallback has been configured.
