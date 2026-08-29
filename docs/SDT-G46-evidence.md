# SDT-G46 TagStateDO evidence

## Scope and deployment disposition

SDT-G46 moves the existing tag-state read cache into an in-place, SQLite-backed
`TagStateDurableObject`, keyed by the length-prefixed tuple
`(serviceId, tag, projectorId)`.  The existing Tag Durable Object remains the
sole event-source authority; this change adds neither a public Worker route nor
a second source-query implementation.

This is C-0 test-stage work.  The implementation intentionally contains no
legacy record conversion, mixed-version fence, rollback marker, isolated
namespace, or compatibility reader.  The test DB may be reset when the SQLite
schema changes.

AC8 deployed before/after sampling is deferred by the 2026-08-29 operator
ruling until G41 lands.  This document deliberately claims no deployed latency
or throughput number and does not reuse G30/G37 measurements as a baseline.

## Source authority and boundedness

`TagStateDurableObject.readSource` reaches the existing Tag DO only through a
private direct-DO adapter at `__internal/g46/tag-state-incremental`. That
**G43 incremental source** adapter invokes `g43TagStateIncrementalCatchUp`; it is not a Worker route and
does not expose `/state` or `g43TagStateRebuild` to the TagState call universe.
Both Worker tag forwarders reject the adapter's `__internal/g46` path before
they resolve a Tag namespace, so the transport header cannot be replayed by a
public caller.
`g43TagStateIncrementalCatchUp` calls G45 `readHeadFacts` on every page: its
first page freezes `through`, and later pages retain that frontier while
checking identity/control/head consistency.

The entrypoint installs the deployed `composition.projectors` registry for
the TagState object.  TagStateDO has no default/test-registry fallback: an
isolate without that installation returns the typed registry failure instead
of folding with a different projector authority.

## Read-response compatibility

For a `READY` tag state, the public tag-state success body retains the prior
eight fields in the same serialization order: `payload`, `version`,
`lastSortedUniqueId`, `tagGroup`, `tagContent`, `tagProjector`,
`tagPayloadName`, and `projectorVersion`.  No success field was added or
renamed.  The client-visible change is limited to the intentionally typed
non-success outcomes required by AC5 (for example, an unknown projector is
now `404 tag_state_unknown_projector` rather than a generic validation
failure); the existing V1 success-wire test remains the oracle.

The G46 measurement fixture drives the real G43/G45 seam at history sizes
1, 10, 100, 1,000, and 5,000, consumes every cursor through the frozen
frontier, and verifies `rowsRead <= returnedRows + 3` at every point.  Its
`EXPLAIN QUERY PLAN` oracle requires the closed `suid > cursor AND suid <=
through` predicate to use `tag_event_suid_idx` and reject a table scan.  This
is a bounded page/source statement, not an O(1) claim for an arbitrary
historical replay.

## Acceptance mapping

| AC | Implementation authority | Structural oracle |
| --- | --- | --- |
| AC1 | `TagStateDurableObject`, `tag_state_identity`, `tag_state_cache`, composition registry installation | `composition-selected projector authority` fixture; config/migration checks |
| AC2 | `g43TagStateIncrementalCatchUp` + G45 `readHeadFacts`; direct-DO adapter | normal delta/frozen-frontier fixture; all-history source measurement and mutation runner |
| AC3 | `READY`/`REBUILDING` cache fields and transactional checkpoints | before/after checkpoint, resume, and lost-response fixture |
| AC4 | authored `projectorVersion` governs cache invalidation | unchanged-author-version stale-cache-risk assertion |
| AC5 | distinct unknown-projector, registry, source/frontier, cache-corruption outcomes | typed failure fixture including G45 identity conflict as `tag_state_source_frontier_failure` (409) |
| AC6 | `SerializedReadWorker.tagState` addresses `TAG_STATE` and preserves V1 success fields | `read.spec.ts` V1 shape checks plus route structural guard |
| AC7 | cache deletion starts source-backed replay only | cache-loss/rebuild fixture |
| AC8 | operator-approved deferred deployment sampling | explicit non-fabrication disposition above |
| AC9 | C-0 in-place implementation | scope statement above and contract guard |

## Required gates

`npm run test:g46` runs the structural checker and self-test, the real
Miniflare read/source fixtures, and nine production mutation cases.  The
mutations independently prove that CI rejects an origin reproject on normal
delta, bypassing G45 head facts, an unknown source path, serving a partial
replay, masquerading each of the four typed non-success outcomes, and an
endpoint-only measurement checker.  `ci-g46` runs that lane and
its forced-red reachability proof; `verify` aggregates `ci-g46` with all other
required split jobs.

The frozen-frontier path preserves G45's failure contract: a
`TagIdentityConflict` never becomes an empty state; it is returned as typed
`tag_state_source_frontier_failure` with HTTP 409.
