# @sekiban/dcb-domain

`@sekiban/dcb-domain` is the runtime-free, schema-first authoring layer for
Sekiban DCB domains. It depends on `zod` and the matched `@sekiban/dcb-core`
package. Domain source imports core only as types. It does not import the
runtime, storage, transport, or host APIs.

## Install

```sh
npm install @sekiban/dcb-domain
```

The package is ESM-only and supports Node.js 20 or newer. The released 0.3.0
pins `zod` to `4.4.3` and `@sekiban/dcb-core` to `0.3.0` and is available from
npm. The `zod` pin for the
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

## Typed query authoring

`defineQueryView`, `defineQuery`, and `defineListQuery` are part of the released
matched `0.3.0` and are available from npm. Published `0.2.x` packages do not
include them.

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

`toRuntimeDomain()` compiles each authored query into a frozen runtime
registration. The view id is the query source id. The projector id is
`view.projector` when that field is present, and `view.source` otherwise. The
registration carries that projector's tag family, the projector id, and the
view id. A scalar query uses endpoint `query`. A list query uses endpoint
`list-query`. The nested execution record contains codecs and handlers only.
The bridge does not call those functions. A query-free domain still bridges an
empty frozen query list. When the source view cannot be mapped to a runtime
projector, the bridge throws `DomainAuthoringError` with code
`QUERY_SOURCE_INVALID` and message
`Query source view cannot be mapped to a runtime projector.`

Runtime composition checks `domain.queries`, `config.queries`, and
`config.queryDefinitions` before precedence. A malformed typed value fails even
when another list would have won. The error name is `RuntimeQueryDefinitionError`,
the code is `QUERY_DEFINITION_INVALID`, and the message is
`Runtime query definition is invalid.` Metadata-only query records stay on the
existing path. `RuntimeWorkerConfig.maxScanRows` sets the deployed raw scan
bound: omission uses 1000, and a positive safe integer from 1 through 10000 is
accepted. Executable queries run on the server through the existing raw V1
routes. `SekibanExecutor` can call the frozen contract directly. The released
`0.3.0` surface includes that release hardening.

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

Executable queries run on the server through raw V1 calls. The client package
accepts the frozen contract on `query` and `listQuery`.

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

The typed query authoring surface above is part of the released matched `0.3.0`
and is available from npm. It is not available in the published `0.2.x`
packages. The helpers compile
server registrations. `SekibanExecutor.query` and `listQuery` accept the
frozen `.contract` in this repository. Configured `queries` replace
`domain.queries`, so a runtime config that keeps a metadata-only record must
list the compiled registrations as well.

The earlier `@sekiban/core` and related packages belong to the older
sekiban-ts line; they are not dependencies or aliases for this package.

The first public release is `0.1.0`. The repository tag
`dcb-domain-v0.1.0` drives the provenance-enabled release workflow. The final
`npm publish --provenance --access public` is an operator action performed
only after the trusted publisher or `NPM_TOKEN` fallback has been configured.
