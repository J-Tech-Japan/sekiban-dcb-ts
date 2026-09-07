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

If the pass reaches the first event still inside the existing SafeWindow, it
records that event's SUID, `lastArrivedAt + SafeWindow` deadline, and
`safe_window_fence` stop reason. The service-scoped Bootstrap Durable Object
coalesces the earliest outstanding deadline and owns a Durable Object alarm.
The alarm re-enters the same single-flight pass with `fence-expiry`; it is a
bounded delayed trigger, not a polling loop. A non-SETTLED coverage decision
or another retryable catch-up stop schedules a bounded exponential
`coverage-retry` alarm instead. Alarm state is observation/scheduling state
only: G44 frontier proof, SafeWindow, Queue disposition, MV ordering, and the
cron backstop semantics are unchanged.

The additive `serialized_dcb_safe_lane_passes` ledger records each delivery,
fence-expiry, coverage-retry, or cron request as `scheduled`, `running`,
`completed`, `failed`, or `coalesced`, with observed lifecycle times, the
coverage decision/frontier, stop deadline/reason, and safe-head snapshots
before and after the pass. Ledger writes and head snapshots are best-effort
observations: a missing observer table cannot change Queue acknowledgement,
G44 certification, or safe catch-up. The Queue callback is a
notification-only hook and defers both the observer write and scheduler start
through `waitUntil`; the commit and Queue disposition never await the safe
pass.
