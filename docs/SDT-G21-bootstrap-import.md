# SDT-G21 bootstrap-import core

The bootstrap core is provider-neutral. A provider adapter must first export a
complete `sekiban-dcb-bootstrap` version 1 dump and establish the fresh-target
evidence; those adapter and operator surfaces belong to SDT-G22.

Bootstrap-related command results use the [result and repair
matrix](architecture.md#result-and-repair-matrix); this document defines the
authority transition, not a second result taxonomy.

The public bootstrap contract is [the repository-owned normative document](../contracts/bootstrap-import-normative.md).

`parseBootstrapDump` is the all-or-nothing dump-validation boundary. The plan
operation comes first: the target coordinator's `/plan` parses the dump, checks
explicit fresh-target evidence, and persists the plan and dump. During the
later import operation, the operator also parses the dump before the provider
adapter performs PipelineStore admission. That separate provider-side write is
not coordinator state- or epoch-gated. The coordinator `/import` then validates
the matching import ID, fencing epoch, and import state before it performs the
Tag and allocator import writes. Parsing rejects unknown or missing fields, bad
canonical digest, duplicate EventIds, non-ascending SUIDs, count/tag-count
mismatch, and a high-watermark mismatch.

`BootstrapCoordinatorDurableObject` is named by target service ID. Its durable
control record linearizes normal command admission with `EMPTY -> PLANNED` and
persists the import ID, digest, fencing epoch, lease, manifest, and progress.
The separate Tag DO `/bootstrap/admit` operation never writes an outbox row and
is permanently closed by READY for that Tag import route. The coordinator's
import route is likewise closed by READY; this does not close provider-adapter
PipelineStore admission, which is a separate route and state boundary.
`AllocatorDurableObject` owns `seed-after`, which is idempotent only for the
same import and rejects any allocator already seeded or allocating.

## Authority transition

The target must be fresh and bound to the intended service identity before Tag
or allocator import writes. The coordinator moves through `EMPTY`, `PLANNED`,
`IMPORTING`, `VERIFYING`, and `READY`; `FAILED` is an operator-abort state,
and a same-plan import may resume from `FAILED` when its import ID and fencing
epoch still match. Each coordinator phase is durable and fenced.

During `IMPORTING`, normal command admission is closed, each target Tag admits
the import, and the importer writes the event, membership, and head facts
directly to Tag authority. Progress is recorded by tag and chunk. The target
allocator is seeded from the validated high watermark only after tag import,
so a normal allocation cannot overlap the imported range.

The coordinator `/verify` compares each imported Tag's head, event count, and
event fields (`eventId`, `suid`, payload, event type, fixed `g32` provenance,
and `eventTags`) with the validated dump, then compares the dump event count
with the manifest. The operator wrapper adds the provider adapter's verification
(currently a provider event-count check) and an optional read-model hook before
calling `/ready`; `/verify` itself does not reread TagState, completeness,
global-store facts, or allocator state. Only successful coordinator verification
and those wrapper checks may enter `READY`, after which normal command admission
is released. An empty dump does not manufacture an event or a sentinel head;
the first normal allocation establishes the next authority fact.

An import failure after `/import` has entered `IMPORTING` does not
automatically transition to `FAILED`: the coordinator remains fenced in
`IMPORTING`, where the operator can resume the import or abort it. A failure
after `/import` reaches `VERIFYING` stays fenced in `VERIFYING`: before `/ready`
starts closing Tag import routes the operator can abort and import again from
`FAILED`; after that, the operator retries `/ready` with the same import ID and
fencing epoch through the scoped `/bootstrap/{serviceId}/ready` control route,
because the operator wrapper exposes only plan, import, status, abort, and
export. Only the operator `/abort` route writes `FAILED` with
`operator_abort`; abort retains the failed plan and does not clear target state.
The normal write path remains the Tag authority path described in the
[architecture guide](architecture.md#two-authoritative-scopes).

The G21 CI lane is `npm run test:g21`. The deterministic routing proof is
`npm run test:g21:forced-red`; it intentionally exits non-zero only when the
explicit environment flag is set, demonstrating that the new lane reaches the
workflow test source without changing normal CI behavior.
