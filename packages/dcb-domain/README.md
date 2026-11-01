# @sekiban/dcb-domain

`@sekiban/dcb-domain` is the runtime-free, schema-first authoring layer for
Sekiban DCB domains. It depends on `zod` and the matched `@sekiban/dcb-core`
package. Domain source imports core only as types. It does not import the
runtime, storage, transport, or host APIs.

## Install

```sh
npm install @sekiban/dcb-domain
```

The package is ESM-only and supports Node.js 20 or newer. The 0.2.2 package
pins `zod` to `4.4.3` and `@sekiban/dcb-core` to `0.2.2`. The `zod` pin for the
0.1.x line is also `4.4.3`.

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
  // The state supplies the initial state; initial and restored states are
  // parsed through the same schema as every evolution.
  state: stateUnion(z.object({ count: z.number() }), { initial: { count: 0 } }),
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

// The bridge accepts this query-free domain.
const runtimeDomain = toRuntimeDomain(authoringDomain);
```

Events require both a Zod schema and an explicit tag derivation. `make()`
validates and brands the payload; `append()` accepts that branded payload and
derives tags from the event definition, so caller-supplied routing cannot drift.
Projectors bind their tag family at compile time. Commands declare their pure,
bounded read set and receive only `state`, `exists`, `now`, and `append`.

Sessions use one executor-captured `now`, per-(projector, tag) snapshots, a
fresh session on consistency-conflict retry, and an atomic `done` envelope.
`executeCommand` reports a conflict that exhausts `maxConflictRetries` (a
non-negative safe integer, default 1) as `status: "conflict"`, and any commit
reply other than `undefined`, `true` or `{ kind: "accepted" }` that it does not
recognise as `status: "unknown"`.
`none`, `reject`, thrown errors, and cancellation discard all tentative work.
Portable snapshots, decision logs, and the five ingress/query parse boundaries
are exported from the main entrypoint. Pure command/evolve exercises are
available from `@sekiban/dcb-domain/testing`.

The package boundary is enforced in CI by the dedicated compile-fail project,
source import/global checks, negative fixtures, and an `npm pack --dry-run`
inspection. Its runtime dependency is the pinned `zod` package. The matched
`@sekiban/dcb-core` dependency supplies structural query contracts; those
imports stay type-only.

## Typed query authoring preview

This preview is unreleased. It is bound for the matched `0.3.0` release and is
not part of the published `0.2.x` packages.

`defineQueryView`, `defineQuery`, and `defineListQuery` build frozen
definitions and frozen contracts. Params must be a strict Zod object
(`z.strictObject` or `.strict()`) and must not use a reserved control name:
`PageNumber`, `PageSize`, `NewestFirst`, `consistency`, `pageNumber`,
`pageSize`, `newestFirst`, `descending`, `waitForSortableUniqueId`, or
`signal`. Each codec exposes `encode` and `decode`. One-way Zod transforms,
including `.transform()` and `z.preprocess()`, are rejected when the definition
is created. Codecs run synchronously. A Promise or other thenable returned by
encode or decode, including a `z.default()` or `z.catch()` callback, is
rejected. After a successful encode, the value must be JSON-safe: array holes
and extra array properties are rejected, and every JSON key, including
`"__proto__"`, is kept as an own property. Handlers are synchronous. Their
inputs are readonly, and a list handler returns `readonly Readonly<Item>[]`.
A definition is also refused when its codec output cannot be copied into a
detached value (`QUERY_CODEC_OUTPUT_UNCOPYABLE`). `Date`, `Map`, and `Set`
outputs are admitted and, when a query later runs, are copied by value. They
are not frozen. Handlers receive no database, network, environment, request,
clock, paging, direction, consistency, waiting, or cancellation capability.

These definitions are not executed. `toRuntimeDomain()` throws
`DomainAuthoringError` with code `QUERY_EXECUTION_UNAVAILABLE` and message
`Typed query execution is not available in this runtime bridge.` when the
domain contains authored queries. A query-free domain still bridges.
Runtime composition rejects a typed definition found on `domain.queries`,
`config.queries`, or `config.queryDefinitions` before it converts queries. The
thrown error has name `TypedQueryExecutionUnavailableError`, code
`QUERY_EXECUTION_UNAVAILABLE`, and message
`Typed query execution is not available in runtime composition.` The class is
not exported. Ordinary query metadata that only has an id and a version is
unchanged.

A `z.codec` is accepted when both directions are synchronous functions, even if
encode is not the inverse of decode. Keeping that pair meaningful is the
author's responsibility. So is a callback that sometimes returns a Promise, and
any schema whose internals are changed after construction. Invocation still
fails closed:

- `QUERY_CODEC_UNIDIRECTIONAL` — `Query codecs do not support one-way Zod transforms.`
- `QUERY_CODEC_SCHEMA_UNSUPPORTED` — `Query codecs do not support this Zod schema node.`
- `QUERY_CODEC_ASYNC_UNSUPPORTED` — `Query codecs must encode and decode synchronously.`
- `QUERY_CODEC_NOT_JSON_SAFE` — `Query codec output must be JSON-safe.`
- `QUERY_CODEC_OUTPUT_UNCOPYABLE` — `Query codec output must support portable detached copies.`

There is no typed client call, no public scan setting, and no public runtime
query error for these contracts. The bridge and composition refusals remain.

## Versioning

The package follows semver while the major version is `0`: minor releases may
add public authoring capabilities, and patch releases are limited to fixes and
documentation. The public surface is frozen to the following entrypoints and
helpers for the `0.1.x` line:

- Main entrypoint: `domain`, `event`, `eventUnion`, `projector`, `stateUnion`,
  `command`, `done`, `none`, `reject`, `read`, `readExists`, `Session`,
  portable-snapshot serialization, the five boundary parsers, `deliveryPolicyFromDomain`,
  and the runtime-domain bridge (`toRuntimeDomain`, `adaptRuntimeCommand`,
  `RuntimeProjectionEvent`, split `RuntimeCommandPort` result types).
- Testing entrypoint: `given`, `evolveTable`, and `evolve` from
  `@sekiban/dcb-domain/testing`.
- No deep imports beyond `.` and `./testing` are supported.

The typed query authoring preview above is unreleased and bound for `0.3.0`.
It is not available in `0.2.x`. Those helpers do not execute a query and do
not add a typed client call.

The earlier `@sekiban/core` and related packages belong to the older
sekiban-ts line; they are not dependencies or aliases for this package.

The first public release is `0.1.0`. The repository tag
`dcb-domain-v0.1.0` drives the provenance-enabled release workflow. The final
`npm publish --provenance --access public` is an operator action performed
only after the trusted publisher or `NPM_TOKEN` fallback has been configured.
