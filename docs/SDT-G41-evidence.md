# SDT-G41 Journal-free serialized commit evidence

## Scope and development-stage decision

This change removes the attempt-level `JOURNAL` Durable Object from the normal
serialized-commit path. It does not remove the Journal class, its binding, or
the named non-commit callers: the authenticated G42 first-touch probe and the
RepairWorker workset/audit routes remain. The direct Journal diagnostic/test
surface is retained only where the duty inventory records a live caller.

The repository is in the stated C-0 development stage. No migration or compatibility fence
was added: a test database may be reset when the old
attempt-record format is no longer readable. This PR creates neither a new
Worker/namespace nor a production compatibility layer.

`RepairWorker` continues to exercise its named non-commit Journal workset and
audit routes against an explicitly seeded **legacy** workset in
`test/repair.spec.ts`. That fixture first observes the real G41 Tag-owned
partial outcome and then invokes the retained Journal API itself; it does not
make normal CommitWorker attempts create Journal records. This is a test of a
surviving surface, not a data migration or compatibility layer.

The complete finite duty table is committed in
[`contracts/g41-journal-duty-inventory.json`](../contracts/g41-journal-duty-inventory.json).
Its route set is checked independently against `JournalDurableObject.fetch` by
`scripts/g41-journal-contract-check.mjs`; each route is classified exactly once
as `MOVED`, `NO_LONGER_REQUIRED`, or `STILL_REQUIRED` with durable fields,
callers, reason, and fixture.

The former single Journal terminal outcome is explicitly retired. A commit now
uses per-tag reservations and append receipts as durable facts; a mixed outcome
is a typed `partial_write`, and the source obligation registry is the
delivery-independent discovery authority. Historic `sdt.commit/v1` S04/S05
identifiers remain zero-work observations because their frozen G30 schema is
separately owned; the **actual `journal.admit` and `journal.transition` remote
hops are removed**. They do not resolve a Journal namespace, create a Journal
actor span, or establish a terminal record. Replacing that frozen trace schema
is a host-owned follow-up, not a target-side weakening of the existing G30
gate.

The public serialized-commit V1 wire is preserved separately from that retired
authority: the request route/envelope and the complete, refused, failed,
`partial_write`, and undetermined response shapes remain the existing public
contract. Only the attempt-level Journal record is no longer their internal
authority. The inventory fixes both `publicCommitWire.request` and
`publicCommitWire.response` to `PRESERVED`, and the checker rejects a change.

### Retained Journal surfaces

The inventory records a post-G41 disposition for every implemented Journal
route. The G42 private probe and the RepairWorker workset/observation APIs are
named **live non-commit** callers. `GET /state` remains a direct diagnostic
surface. The old direct terminal, admit, transition, reservation-failure,
reconcile, takeover, and alarm APIs are retained only as test/diagnostic dead
code for a later Journal-cleanup unit; normal commits do not create a record
that can reach them. `/fault` is test-only. This is deliberately a plain
follow-up marker, not a staged-retirement ledger or a replacement-green gate.

## Acceptance-criteria mapping

| AC | Change | Structural proof |
| --- | --- | --- |
| AC1 | `contracts/g41-journal-duty-inventory.json` records the pre-change-main `7cc38a4` exact Journal route/duty universe, with the public V1 request/response wire separately fixed as preserved and the single terminal Journal outcome explicitly retired. | `g41-journal-contract-check` independently derives the handler route set, checks count/set equality and one classification per route, caller/field/fixture evidence, public-wire fields, and retired terminal authority. |
| AC2 | `CommitWorker` has no `JOURNAL` resolution, while tag reservation/append remains its positive path. | `AC2: performs zero JOURNAL namespace calls while the Tag positive control is live` counts fake namespace `idFromName/get/fetch` calls as exactly zero/nonzero. The production mutant that restores a Journal lookup is red. |
| AC3 | Prepare failure force-tombstones every successfully reserved tag; commit failure force-tombstones all tags, writes each missing tag's local `partial_write` fence, and preserves committed facts plus the primary `partial_write`. | Focused fake-namespace tests cover reservation refusal, cancel-ack loss, missing-tag fence installation, stale epoch rejection by a real Tag DO, and partial outcome preservation. |
| AC4 | Four explicit failure boundaries replace Journal alarm convergence: after reservations/before allocation; allocation/before first append; between tag appends; all appends/response loss. | `test/g41-journal-removal.spec.ts` proves vectors/tombstones/outcomes at every boundary. The between-append case writes one real source obligation with `AUTO_DRAIN_OUTBOX=false`, retains the missing Tag's local partial fence, verifies zero D1 delivery/receipt rows, then G44 finds it from the source registry. |
| AC5 | A production before/after sample is intentionally not claimed here. | **AC5 deployment sampling is deferred** by the operator ruling until the single post-G41 deployment run. G42's 234.0 ms is cited only as the advisory authorization, never as this unit's measured result; no G30/G37 numbers are presented as a current baseline. |
| AC6 | `JournalDurableObject`, binding, G42 probe, and RepairWorker remain only as named non-commit surfaces. | Contract checker proves the G42 and RepairWorker callers and the G38 tombstone binding assertion remain, while CommitWorker's normal path has no Journal operation. |
| AC7 | Host design records need a follow-up write-back. | The target repository cannot modify host-owned `means/06, means/07, and means/08`; this evidence and the canonical report record that pending host-side sync. |
| AC8 | G44 merged authority is used, not reimplemented. | The boundary-3 fixture reads source obligation facts directly from the Tag DO and receives `GLOBAL_ARRAY_RECEIPT_ABSENT` from `GlobalCompletenessReconciler` with delivery disabled. |

### Boundary facts

| Boundary | Durable authority after the interruption | Client outcome | G44 / alarm consequence |
| --- | --- | --- | --- |
| 1. reservations → allocation | Acquired tags are force-tombstoned; no allocator vector exists. | 504 undetermined; no blind retry. | The Tag scheduler is rearmed after cancellation (and has no pending reservation to expire); no source obligation and no G44 finding are expected. |
| 2. allocation → first append | Allocator vector may exist as an orphan; every prepared tag is force-tombstoned. | 504 undetermined. | The vector is retained for allocator-side inspection, not Journal takeover; Tag cancellation re-arms its local scheduler and no committed source obligation means no G44 finding is expected. |
| 3. between tag appends | Written tag event/membership/obligation remains durable; missing tag has no fabricated event but retains its local `(attemptId, epoch=0, partial_write)` fence. | 500 `partial_write`, `eventsDeleted:false`, written/missing tags enumerated. | The successful local append is contingent on the Tag DO's one-alarm `rearmScheduler` transition. Its first retry is immediately due, so a test harness may consume it before a later `getAlarm` observation; the durable pending obligation is the non-racy convergence fact. G44 source registry reads `declaredTagSet` and local committed membership with zero D1 delivery/receipt rows, then opens `GLOBAL_ARRAY_RECEIPT_ABSENT`; the missing Tag's fence keeps the read/repair frontier explicit. |
| 4. all appends → response | All tag-local append receipts and their source obligations can be durable even if the response is lost. | 504 undetermined; caller rereads tag heads/query state. | No synthetic terminal Journal response exists. Normal G44 receipt reconciliation remains independent of response delivery. |

`GLOBAL_ARRAY_RECEIPT_ABSENT` is the stable G44 incident type. The source row
it scans is the actual declared-versus-local-membership evidence; the finding
means its required global receipt is absent. This does not invent a second
global reconciliation policy.

## Commands and expected retained evidence

The PR lane runs:

```text
npm run test:g41
  build packages
  g41 contract checker + checker self-test
  G41 namespace/boundary fixtures
  focused production mutation runner
```

The CI `ci-g41` job runs this same lane and a forced-red wiring proof. `verify`
depends on `ci-g41`, so a failure or skip remains a required-context failure.
The mutation runner independently red-proves:

1. restoring a `JOURNAL.idFromName/get/fetch` lookup in `CommitWorker`;
2. removing the force-tombstone prepare cleanup; and
3. claiming that a partial write deleted its committed events.

The normal command output is committed in CI logs and reproduced locally before
PR creation. SDT-G44 had landed at
`beb71a3a58b32b09dc9b98708678c25887a95736` before this implementation
started. There is no deployed latency claim in this document, and no
performance or protocol gate is relaxed.
