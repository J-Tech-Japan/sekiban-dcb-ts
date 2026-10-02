# Bootstrap import normative contract

Bootstrap import is an explicit transition from a target that the operator has
shown to be empty to a serving target. It is separate from normal append
traffic and is exposed through the operator wrapper and the bootstrap durable
object.

## Input and preflight

`parseBootstrapDump` accepts a dump with only `events` and `manifest`. The
manifest has the version, source and target identities, high watermark, event
count, per-tag counts, content digest, and canonicalization fields checked by
`manifest.ts`. Each event has the allowed identity, payload, tag, type,
provenance, timestamp, and nullable metadata fields. Event tags are copied in
their input/emission order; they must contain unique non-empty strings, but the
parser does not sort them.

The parser rejects unknown or missing manifest fields, invalid event fields,
duplicate event identities, non-increasing SUID order, count or high-watermark
mismatches, empty service or lineage identity strings, and a `contentDigest`
that does not match `bootstrapDigest` over the manifest and event list. The
operator `plan` route forwards the body without parsing; the coordinator's
`/plan` route parses the dump before it records the plan. The operator `import`
route parses the dump and calls the provider adapter's admission before calling
the coordinator import route, so the general import flow is not a promise that
no target-store write has happened before coordinator admission.

The export adapter makes a full `readAllEvents` call without a cursor and takes
the high-watermark from that observation; later pages reapply that boundary
when a cursor is supplied.
The operator derives the source and target allocator lineages from allocator
state; callers cannot supply the target lineage. The adapter returns the
complete snapshot in the dump and page metadata, and does not add events
written after the selected high watermark.

## Admission and state machine

Before coordinator parsing, `/plan` requires an import ID, a dump object, and
explicit target evidence with boolean binding and event flags. It then parses the
dump. Evidence showing an existing binding or events is rejected. A `READY` control
record is permanent. A non-empty control record accepts only the same import ID
and manifest digest; a different plan is rejected. A fresh plan stores the dump,
sets `PLANNED`, increments `leaseEpoch`, initializes progress, and sets
`leaseUntil` to 30 seconds from planning time. Active normal commands and write
permits block a fresh plan.

The coordinator's landed state machine is:

```text
EMPTY -> PLANNED -> IMPORTING -> VERIFYING -> READY
          |          |              |
          +----------+--------------+--> FAILED (operator abort)
FAILED --import with the retained identity--> IMPORTING
```

`/import`, `/verify`, `/ready`, and `/abort` require the matching `importId`
and `leaseEpoch`. Import is allowed in `PLANNED`, `IMPORTING`, or `FAILED`, but
an expired `leaseUntil` is rejected with `bootstrap_lease_expired`. A failed
`/verify` leaves the state `VERIFYING`, and `/verify` may be retried. `/ready`
succeeds only if a verify has recorded successful matching import identity and
lease fencing. `/abort` moves an active plan to `FAILED`; it is accepted in every
state except `EMPTY` and `READY`, including `FAILED`. It checks the import ID and
`leaseEpoch`, clears `leaseUntil`, sets `failure` to `operator_abort`, and
retains the plan's dump, manifest, digest, identity, `leaseEpoch`, and progress.
A re-import with that retained identity and `leaseEpoch` replays the plan. There
is no takeover or reset route, and the code does not renew `leaseUntil` while
importing or verifying. Once the coordinator is `READY`, its bootstrap
plan/import state transitions and tag closing path do not admit another
bootstrap.

## Durable writes and completion

The coordinator groups records by tag in `localeCompare` order, preserves the
dump order within each tag, and sends bounded chunks of at most 128 events and a
sum of at most 192 KiB of each event's encoded JSON size. It sends the manifest
digest, import identity, `leaseEpoch`, target service, and candidates to each
tag. It records the last SUID for each completed tag chunk as progress, but does
not read progress to skip chunks. A re-import replays every chunk from the
start; exact replays succeed because tag admission and allocator `seed-after`
admission treat the same values as idempotent. No chunk digest is computed,
validated, or stored by the coordinator.

When the manifest high watermark is non-null, import calls allocator `seed-after`
with the import identity, `leaseEpoch`, and high watermark; a null high watermark
does not send that request. The tag admission and allocator calls are fenced by
the stored import identity and `leaseEpoch`. Import traffic is not normal arrival
traffic.

Coordinator `/verify` checks each expected tag's reported head, event count,
event ID, SUID, payload, event type, `g32` provenance, and event tag array, and
checks that the dump IDs are unique and that the dump count equals the manifest
count. The provider `BootstrapStoreAdapter.verifyBootstrap` check is narrower:
it reads the target events and compares only their total count with
`manifest.eventCount`; it does not perform full downstream identity, payload, or
tag-set equality.

The operator wrapper runs adapter admission, coordinator import and coordinator
verification, then adapter verification. It may run the optional
`afterVerifyBeforeReady` read-model hook; a hook failure prevents `/ready`, but
the coordinator does not compare read-model equality or carry a pre-import
checkpoint. `/ready` requires matching verification identity and `leaseEpoch`, closes
each manifest tag, and records `READY` with `leaseUntil: null`.

Normal writes use a durable permit keyed by `commandId` and bound to a digest.
The coordinator accepts a new permit only in `EMPTY` or `READY`, returns the
same permit for an identical retry, rejects a digest mismatch, and releases a
permit by command ID with an optional digest check. The permit is a bootstrap
barrier, not commit-outcome authority and not an ownership transfer. The
`sdt.commit/v2` permit rows remain manifest schema only; the current runtime
does not emit permit-transfer or permit-resolution trace rows.

## Fencing and compatibility fields

- The coordinator creates and stores `leaseEpoch` while handling `/plan`; the
  `/plan` request does not carry it. Requests to `/import`, `/verify`, `/ready`,
  and `/abort` carry it, as do tag bootstrap admission/close requests and the
  allocator `seed-after` request. The provider admission input also carries it.
- Permit requests (`/command/permit` and `/command/permit-release`) do not carry
  `leaseEpoch`. `/command/admit` takes only `commandId`; `/command/finalize`
  requires `leaseEpoch`; `/command/release` accepts it optionally. The command
  responses return the coordinator's current `leaseEpoch`.
- Allocator bootstrap seed requests use `leaseEpoch` together with `importId`
  and `highWatermark`.
