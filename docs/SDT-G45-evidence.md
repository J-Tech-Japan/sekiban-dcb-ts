# SDT-G45 scalar Tag head-facts evidence

## Scope and development-stage decision

This change narrows the internal Tag Durable Object read used while assembling
a successful commit response. It adds no Worker, namespace, migration,
compatibility fence, rollback marker, or data-migration path. Per C-0, an
incompatible test database may be recreated rather than preserved.

The public V1 commit-response serializer, the S13/S14 trace-manifest rows,
and existing span assertions are unchanged. The two existing trace fixtures
only add `/head-facts` routing responses so their existing assertions can
exercise the changed internal call path without changing assertion semantics.

## AC1 — table-aware scalar read

`GET /head-facts` is a Tag DO internal read. Its SQL path is limited to this
fixed singleton set:

1. `SELECT tag FROM tag_identity WHERE singleton = 1`
2. `SELECT head_suid, version, updated_at FROM tag_control WHERE singleton = 1`
3. `SELECT head_suid FROM tag_head WHERE singleton = 1`

The real-handler Miniflare fixture records all transitive SQL statements with
the G43 measurement seam. It observes three rows read, zero rows written, and
no statement whose text references `tag_event`. Row count is supporting
evidence only; the statement set is the primary oracle. The handler retains
the established identity outcomes: missing `__tag` is 400, mismatched
immutable identity is typed 409, and absent durable state is 404.

The reader neither calls `readStoredRecord()` nor `requireG32TagRecord()` and
does not materialize a `TagRecord`.

## AC2 — response equivalence and byte preservation

For the same real, normalized SQL Tag DO state, the fixture compares
`/head-facts` and `/state` exactly on `{ head, version, updatedAt }`.
`CommitWorker.successResponse()` requests `/head-facts` once for every member
of `allTags`, preserving S13 as the stage and S14 as the per-tag child.

The deterministic two-tag fixture freezes the complete raw serializer output
from the pre-change response contract. The changed seam must produce that
same byte string exactly, rather than merely matching parsed keys or tag
order. The fixture's expected `tagWriteResults` are `room:a` version 10 at
`2026-08-29T12:00:00.000Z` and `room:b` version 11 at
`2026-08-29T12:00:00.001Z`; the test compares the entire JSON body.

## AC3 — all-points history measurement

The real handler is measured at all required history sizes on the same
physical normalized-SQL Tag DO, grown in order from 1 through 5,000 events.
The response at every point must equal the canonical scalar JSON object for
that state; response byte counts intentionally are not compared, because
`version` can grow from one to multiple digits.

| History events | Statements | `tag_event` statements | Rows read | Rows written | Canonical response rule |
| ---: | --- | ---: | ---: | ---: | --- |
| 1 | identity, control, head | 0 | 3 | 0 | exact `{head,version,updatedAt}` |
| 10 | identity, control, head | 0 | 3 | 0 | exact `{head,version,updatedAt}` |
| 100 | identity, control, head | 0 | 3 | 0 | exact `{head,version,updatedAt}` |
| 1,000 | identity, control, head | 0 | 3 | 0 | exact `{head,version,updatedAt}` |
| 5,000 | identity, control, head | 0 | 3 | 0 | exact `{head,version,updatedAt}` |

The G43 all-points row spread is `max(3,3,3,3,3) - min(3,3,3,3,3) = 0`.
Statement-set count is one across all five points. The checker rejects each
independent falsification:

- restoring `readStoredRecord()`;
- a history-proportional `tag_event` `LIMIT`;
- a constant `tag_event LIMIT 1` (flat row count is still forbidden);
- an all-points checker weakened to compare only first and last points.

`scripts/g45-head-facts-mutation-runner.mjs` applies each production mutant
to a temporary source tree, rebuilds the runtime when needed, and requires
its focused real-handler oracle to fail. The standalone fixture also asserts
the same four decisions without sharing the production implementation.

## AC4 — full-record caller audit

The audit below covers remaining route and full-record call sites in
`packages/dcb-runtime/src`. Only the commit response was a scalar-only
consumer, and it is the caller switched in this unit.

| Caller / route | Verdict | Why full record remains required |
| --- | --- | --- |
| `CommitWorker.successResponse` | **Switched** | It uses only `version` and `updatedAt` for `tagWriteResults`; it now calls `/head-facts` for every `allTags` member. |
| `SerializedReadWorker.readTag` → `/state` | Retained | It replays the tag event list into a projector; SDT-G46 owns the TagStateDO redesign. |
| `JournalDurableObject.requeryCommitRecords` → `/state` | Retained | Reconciliation verifies each candidate's `eventId` and exact payload against the per-tag event list. |
| `BootstrapCoordinatorDurableObject.verify` → `/state` | Retained | Bootstrap verification compares ordered event IDs, SUIDs, payloads, types, provenance, and tag memberships to the manifest. |
| `RepairWorker` → `/repair/facts` | Retained | Repair requires events, outbox rows, fences, epochs, and repair scope; it is a full repair fact surface, not a scalar reader. |
| Tag local mutation/alarm fallback `readStoredRecord` users | Retained | They mutate or return full legacy record/outbox state and do not cross the S13/S14 success-response seam. |

No full-record caller that only needs the three scalar facts remains
unswitched. The full `/state` path is intentionally not deleted because
SDT-G46 still needs replay semantics.

## AC5 — deployed before/after sample

No deployed-primary sampling window is claimed in this commit. The requested
artifact is a source PR, while the existing G37 sampler deploys the primary
Worker and rotates its conformance secret; that external deployment has not
been authorized by this task. This document deliberately does not invent a
50–100 request before/after result, a history length, or telemetry medians.

For context only, not as this unit's baseline or acceptance evidence,
The historical G37 speedup record reports end-state descriptive S13/S14
medians of 58/44 ms. The historical G30 384 ms figure is likewise not used as
today's baseline. Once an explicitly authorized deployed-worker sample is
run, this section must record the current-main before window and candidate
after window (50–100 requests each), client p50/p95, S13/S14 descriptive
medians, deployed provenance, and the exact tag history length.

## Verification run

Executed locally on this branch:

```text
npm run test:g45
node node_modules/vitest/vitest.mjs run --config vitest.config.ts \
  test/commit.spec.ts test/g30-trace.spec.ts test/g37-hop-reduction.spec.ts
```

The focused run passed 4 G45 tests and all four independent mutation cases;
the compatibility-focused suite passed 48 tests. Full CI remains the PR
verification record. `git diff --check` is run before PR creation.
