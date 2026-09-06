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
