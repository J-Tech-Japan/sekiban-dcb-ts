# SDT-G13 versioning contract

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
