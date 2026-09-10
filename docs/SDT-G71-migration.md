# SDT-G71 0.2.0 migration contract

`@sekiban/dcb-core`, `@sekiban/dcb-domain`, and `@sekiban/dcb-client` move as
one matched set from the working `0.1.x` line to `0.2.0`. The packages keep the
same V1 wire endpoints and command envelope; this is a client read-contract
release, not a response/retry or runtime storage migration.

## Read contract

`createSekibanExecutor` reads the `tag-latest-sortable` response first. Its
`exists` boolean is authoritative and is not inferred from a state payload or
the empty sentinel. `readState` then reads the tag-state response and returns
the projector state only after its consumed `lastSortedUniqueId` covers the
captured authority head. The bounded retry is two authority/state observations;
failure to reach the captured frontier is a typed `read_unavailable` error.

An adapter without `readTagLatestSortable` receives a typed
`unsupported_capability` error. HTTP refusal is classified before body
normalization, so a refusal cannot become an invalid or absent snapshot.

## Consistency and heads

Only `listQuery` accepts `{ consistency: "safe" | "unsafe" }`. The executor
places that option in the existing serialized `queryParamsJson.consistency`
field, rejects malformed values and conflicts with an embedded value, and
rejects the option on tag-state, latest-sortable, and generic `query` reads.
The generic query result has no fabricated head. A list response may carry
`readHead`, which is the active safe checkpoint for a safe page or the maximum
SUID reflected by that particular unsafe page.

## Consumer migration

1. Update the three packages together to `0.2.0`; do not mix a `0.1.x` core or
   domain package with the `0.2.0` client.
2. Keep `readTagLatestSortable` on every transport used by
   `createSekibanExecutor`, or handle `unsupported_capability` explicitly.
3. Move list consistency from ad-hoc generic read options to
   `executor.listQuery(request, { consistency: "safe" | "unsafe" })`.
4. Treat `readState(...).exists` and `exists(...).exists` as the durable Tag
   existence fact. A real existing tag with an empty head is not absent.
5. Use `readHead` only on list-query responses and do not derive a head for a
   generic query result.

The current package still exposes the pre-existing
`createSekibanCloudTransport` factory in `@sekiban/dcb-client@0.2.0`; its
ownership move, scoped URL contract, and cloud-specific error preservation are
SDT-G78 work and are deliberately not changed by G71. Consumers adopting the
G71 read contract can therefore migrate the generic HTTP/in-process executor
surface independently, while the cloud import remains on its existing export
until G78 publishes its matching package contract.

The release workflow remains credential-free unless the operator explicitly
selects a publish path. This change does not publish packages, create tags,
or handle credentials.
