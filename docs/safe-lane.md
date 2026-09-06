# Safe-lane scheduling

SDT-G67 keeps the existing cron schedule as the safe-lane backstop and adds an
event-driven kick after a Queue `recordDelivery` result has been durably
stored. The Queue wrapper invokes the kick hook even when the ordinary G44
views are held by `BLOCK/UNSETTLED`; a record-delivery failure does not invoke
it. The meeting-room Worker registers only the promise with the active
`ExecutionContext.waitUntil`, so coverage and materialized-view D1 work never
delays the Queue acknowledgement or retry decision.

Kicks are single-flight per service in a Worker isolate. A delivery arriving
while a pass is running sets one rerun bit, allowing the follow-up pass to see
the later durable event without running overlapping catch-up operations. The
kick calls the same fresh coverage, retained-frontier and materialized-view
catch-up body used by cron; it changes when the pass runs, not what a proven
frontier certifies. `BLOCK/UNSETTLED` therefore remains bounded by the last
proven frontier and never advances a safe head across an unproven gap.

The additive `serialized_dcb_safe_lane_passes` ledger records each kick or
cron request as `scheduled`, `running`, `completed`, `failed`, or `coalesced`,
with observed lifecycle times, the coverage decision/frontier, and safe-head
snapshots before and after the pass. Ledger writes and head snapshots are
best-effort observations: a missing observer table cannot change Queue
acknowledgement, G44 certification, or safe catch-up. The Queue callback is a
notification-only hook and defers both the observer write and scheduler start
through `waitUntil`; the commit and Queue disposition never await the safe
pass.
