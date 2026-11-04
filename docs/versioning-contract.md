# Versioning contract

Consumers must treat these as four independent compatibility axes:

1. **npm package semver** — `@sekiban/dcb-core`, `@sekiban/dcb-runtime`, and
   `@sekiban/dcb-client` use semver for the TypeScript API and package-level
   compatibility. A breaking exported-type change requires a major version.
2. **Serialized protocol version** — the public HTTP and queue protocol is
   Serialized DCB V1. A protocol change is a protocol-version decision; it is
   not silently represented as an npm patch or minor release.
3. **Event/wire identity** — an event name and its payload/wire identity are
   durable data identities. Renaming an event or changing its wire payload is
   a new event identity and requires an explicit migration, not an in-place
   rename.
4. **Projector, query, and materialized-view identity** — each read-side
   definition is identified by its `(id, version)` pair. An incompatible
   projector/query/MV change uses a new pair and a rebuild; it must not reuse
   the old pair while changing its meaning.

These axes are intentionally orthogonal: a package release does not by itself
change V1, event identities, or read-side identities, and a new read-side
version does not require a new wire protocol.

## V1 commit identity

The current V1 request members `version`, `eventCandidates`, and
`consistencyTags` do not establish one operation identity across HTTP
requests. Serialized DCB V1 does not identify one commit across HTTP requests.
With no consistency expectations, the commit is unconditional. When
expectations are supplied, only listed tag heads are checked, and every
supplied reservation must succeed before any Tag append. Omitted tags are not
head-checked. A reservation conflict aborts the whole commit before an
accepted Tag append. Sending the same JSON again starts a new operation; the
runtime creates event ids and captures a write timestamp for each request. An
empty `eventCandidates` array appends nothing and does not receive those ids
or that timestamp. V1 has no server-side idempotency key for the serialized
commit. Adding a key that V1 does not read would not create that guarantee.
Changing this boundary requires a separately versioned surface. Conditional
commit v1 is available on `POST /api/sekiban/serialized/conditional-commit`.
Its request identity and caller facade are
[Conditional commit v1 request identity](write-path.md#conditional-commit-v1-request-identity)
and [Conditional commit v1](executor-facade.md#conditional-commit-v1).

The request boundary is [V1 request identity and resend boundary](write-path.md#v1-request-identity-and-resend-boundary).

Serialized query requests now reject parameters the selected query does not
accept. A metadata-only scalar query accepts only `{}`. A metadata-only list
query accepts only `PageNumber`, `PageSize`, `NewestFirst`, and `consistency`.
This is a V1 request-acceptance rule. Response envelopes, event identities, and
projector/query/materialized-view identity pairs stay the same. The typed query
API is the released matched `0.3.0` package surface and is available from npm.
V1 wire identities are unchanged.
