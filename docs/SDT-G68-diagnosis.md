# SDT-G68: SafeWindow arrival-fence diagnosis

Closes #131

## Scope and conclusion

This is a documentation-only SDT-G68 diagnosis. No product behavior,
SafeWindow constant, frontier rule, test, deployment, reset, Cloudflare
resource, or protected worker was changed.

The retained W145/W150 receipts show that a later Queue delivery of an event
already seen by the G65 direct ring can update the durable arrival high-water
and restart the SafeWindow fence. G67 remains fail-closed and eventually
effective: an early fence-expiry wake re-reads durable state, refuses to pass
a still-fresh strict-SUID event, and schedules or retains the applicable later
follow-up. This explains the long safe-visibility tail without implying a
frontier or reader defect.

The central design fact is narrower than “duplicates are harmless.” A second
arrival of the same event supplies no new event identity and no earlier-SUID
information: the event identity and strict SUID are already known, and
`FirstArrivedAt` remains the earliest observation. It does, however, supply a
new observed delivery on the guarantee path. The current conservative
`LastArrivedAt = MAX(...)` fact cannot prove that no other earlier-SUID event
will arrive later, so a duplicate can legitimately restart the current fence.
Shortening that fence therefore requires a separate sound closure proof; a
timer or duplicate detection alone is not sufficient.

## Retained evidence and identity

The source receipts are retained in the W152 workspace under the paths below;
the hashes are recorded here so this document does not manufacture a new
cohort or silently rewrite raw evidence.

| Receipt | SHA-256 |
| --- | --- |
| `.g67-w142/.artifacts/sdt-g67-fence-expiry-arm-wake-145-candidate-cohort.json` | `f5d03c2e16be3a7f1fc0994120a5b4fccdd9f83666052685ea90ebb8412f59d1` |
| `.g67-w142/.artifacts/sdt-g67-fence-expiry-arm-wake-145-candidate-safe-pass-ledger.json` | `548ea3915b61bc96c004fc8322f9e4bd1c3da1677874d2d046ef97170e974f68` |
| `.g67-w142/.artifacts/sdt-g67-fence-expiry-arm-wake-145-candidate-safe-history-corrected.json` | `6aa28d90d39d3b9e488bd38c18209193fb1c1bfdbf780b3152b637823cf2d1d9` |
| `.g67-w142/.artifacts/sdt-g67-w150-w155-attribution.json` | `e606110f45f50ec46058e9a09f74ff99051e3af57994df744890cd54f7049896` |
| `.g67-w142/.artifacts/sdt-g67-w150-w155-cohort.json` | `c79d262e731b01aa9db2f23f72c6a1148080f95e02bae3b0913104c0b7849060` |

W145 used candidate `d596192f3b0ddb0ab6b70d10ed8b8c04cd5489ae`. W150 supplied
the complete per-commit RING/Queue attribution for source
`766f5d328a6615582338ce52965f5017702182eb`. W150 recorded 10/10 direct rings
as `rung`, 10/10 direct applies as `applied`, and later Queue observations
for every sample. W145 supplied the earlier fence-expiry pass ledger,
including target-SUID deadline observations. Its public receipt did not retain
a per-commit ring timestamp; that missing field is not inferred from W145.

The W150 wrapper receipts used for this repair are the retained outputs
`sdt-g67-w150-w155-pipeline-events.json`, `...-passes.json`,
`...-admission.json`, `...-rings.json`, `...-hops.json`,
`...-subhops.json`, `...-unsafe-writer.json`,
`...-mv-unsafe-receipts.json`, and `...-pipeline-global.json` under the same
`.g67-w142/.artifacts/` directory. They contain observed ring, Queue, batch,
global-receipt, pass, and public-read clocks. They do **not** contain a
`serialized_dcb_event_arrivals` or `dcb_event_ops` export with the individual
arrival source/identity and `arrived_at` values. There is also no retained
W150 lag-estimate receipt. Those omissions determine the limits below.

For every W150 reservation row, the durable identity is
`serviceId=sekiban-dcb-g60-w155-c`, `partitionTag=room:g58-room-54c4f4ea-95c`,
and the message tag is the same room tag. The ring receipt carries the
direct/fast source and attempt identity; the later hop receipt carries the
Queue source and consumer invocation. The reservation rows have
`obligationSequence` 2 through 11 in SUID order. Those source and obligation
identities are retained, but they still do not provide the missing individual
arrival `arrived_at` rows.

## W150 paired clocks and per-pass joins

The following tables are derived from the retained W150 receipts only. All
times are epoch milliseconds. `global receipt` means the first durable
`serialized_dcb_global_receipts.received_at` observed for the target; it is
not silently renamed to `FirstArrivedAt`. `fast batch` and `Queue batch` are
the observed durable `record-delivery-batch-committed` boundaries. `Q invoke`
is the Queue consumer invocation start. `ring finish` is the direct-ring
completion. Thus the tables distinguish the available durable boundaries,
while the unavailable per-arrival clock remains explicitly marked below.

### Durable boundary join

| # | event ID | target SUID | command / enqueue / ring finish | first global receipt | fast batch | Queue send / invoke / batch / last | selected final LastArrivedAt |
| ---: | --- | --- | --- | ---: | ---: | --- | ---: |
| 1 | `01a07882-1b74-7f3c-bf92-ebedf1c1b08f` | `063924324988440000001041685361` | 1788728187764 / 1788728188648 / 1788728188677 | 1788728189324 | 1788728190585 | 1788728189276 / 1788728191520 / 1788728192234 / 1788728194098 | 1788728214260 |
| 2 | `01a07882-504b-77d6-89cc-89c1a68a40b2` | `063924325002491000000522510130` | 1788728201291 / 1788728202707 / 1788728202735 | 1788728202873 | 1788728205592 | 1788728203275 / 1788728205016 / 1788728205977 / 1788728206502 | 1788728225529 |
| 3 | `01a07882-84af-7c82-a086-086e161e7269` | `063924325015429000001832279219` | 1788728214703 / 1788728215640 / 1788728215670 | 1788728215832 | 1788728217701 | 1788728216260 / 1788728218226 / 1788728219453 / 1788728220229 | 1788728226897 |
| 4 | `01a07882-b6fa-759f-931b-0ed14f98d2b0` | `063924325028310000001361936111` | 1788728227578 / 1788728228525 / 1788728228555 | 1788728228696 | 1788728230370 | 1788728229082 / 1788728230236 / 1788728231084 / 1788728231539 | 1788728256877 |
| 5 | `01a07882-e894-7ce7-b8fc-68380b6e2612` | `063924325040941000000145805155` | 1788728240276 / 1788728241158 / 1788728241186 | 1788728241338 | 1788728243622 | 1788728241755 / 1788728242955 / 1788728243959 / 1788728244625 | 1788728258702 |
| 6 | `01a07883-1984-7c82-b973-4cd418f48312` | `063924325053570000000144395544` | 1788728252804 / 1788728253780 / 1788728253808 | 1788728253933 | 1788728254915 | 1788728254381 / 1788728256222 / 1788728256901 / 1788728260060 | 1788728269553 |
| 7 | `01a07883-4b19-712c-a45b-859d6d509075` | `063924325066798000000328411432` | 1788728265497 / 1788728267168 / 1788728267200 | 1788728267413 | 1788728269741 | 1788728267788 / 1788728270380 / 1788728271317 / 1788728271945 | 1788728302505 |
| 8 | `01a07883-802b-7956-b125-a9f923cf0687` | `063924325079863000000389715198` | 1788728279083 / 1788728280087 / 1788728280194 | 1788728280284 | 1788728281467 | 1788728280693 / 1788728281890 / 1788728282642 / 1788728283256 | 1788728304474 |
| 9 | `01a07883-b196-72db-988c-de7f99efce1d` | `063924325092487000001163035396` | 1788728291734 / 1788728292703 / 1788728292732 | 1788728292859 | 1788728294646 | 1788728293265 / 1788728294466 / 1788728295434 / 1788728296060 | 1788728314889 |
| 10 | `01a07883-e437-75d5-8363-c3007df2f4f8` | `063924325105572000001455364113` | 1788728304695 / 1788728305793 / 1788728305822 | 1788728305948 | 1788728307843 | 1788728306441 / 1788728307602 / 1788728308591 / 1788728309342 | 1788728334252 |

The W150 receipts do not contain the durable `dcb_event_ops`/arrival export,
so **FirstArrivedAt, each individual `arrived_at`, arrival source, and
arrival identity are unavailable for every row**. The `enqueuedAt` in the
ring message is a producer/message field, not a substitute. The `LastArrivedAt`
column above is the selected applying-pass high-water, not an inferred first
arrival. This is the exact F1 evidence gap.

### Applying-pass join

The selected pass is joined by target event/SUID and the retained
`actualApplyingPass`/`catch_up_result_json`. `dynamicLagBoundMs` is the
pass's reported estimate, not a reconstructed arrival lag. `safe observed` is
the retained public safe-read clock. `residual after apply` is
`safe observed - appliedAt`; it is an observed residual, not proof that this
pass alone caused the public read. Rows 8 and 10 have a negative
`safe observed - pass completed` residual in the retained receipts, showing
that the selected pass row and public-read row are not a fully causal join;
they are retained as a limitation rather than normalized away.

| # | pass ID / trigger | LastArrivedAt / SafeWindow / lag estimate | fence eligible / applied / completed | safe observed / residual after apply | safe ms |
| ---: | --- | --- | --- | --- | ---: |
| 1 | `delivery:1788728232621:e57ce47b-16ef-44b1-839e-df139766760f` / delivery | 1788728214260 / 20000 / 6344 | 1788728234260 / 1788728237749 / 1788728238327 | 1788728310701 / 72952 | 120646 |
| 2 | `delivery:1788728238927:6ec91a28-e3dc-4699-a5b6-e3aac546205f` / delivery | 1788728225529 / 20000 / 2315 | 1788728245529 / 1788728247091 / 1788728247777 | 1788728310701 / 63610 | 107132 |
| 3 | `delivery:1788728247885:d15fa7e8-3610-40f6-ab8e-f04dd42911d9` / delivery | 1788728226897 / 20000 / 5191 | 1788728246897 / 1788728250634 / 1788728251105 | 1788728310701 / 60067 | 94055 |
| 4 | `delivery:1788728276040:3fa287f5-4e40-4559-9c3c-700ea6280030` / delivery | 1788728256877 / 20000 / 4996 | 1788728276877 / 1788728279718 / 1788728281318 | 1788728310701 / 30983 | 81342 |
| 5 | `delivery:1788728276040:3fa287f5-4e40-4559-9c3c-700ea6280030` / delivery | 1788728258702 / 20000 / 4996 | 1788728278702 / 1788728279828 / 1788728281318 | 1788728310701 / 30873 | 68758 |
| 6 | `delivery:1788728287842:593a1550-5f15-432b-9c04-f23b5bd68d08` / delivery | 1788728269553 / 20000 / 849 | 1788728289553 / 1788728292714 / 1788728294192 | 1788728310701 / 17987 | 56172 |
| 7 | `delivery:1788728318170:225cc0f2-b93b-4d97-90d0-e05a81459596` / delivery | 1788728302505 / 20000 / 5782 | 1788728322505 / 1788728323252 / 1788728323836 | 1788728325709 / 2457 | 57551 |
| 8 | `delivery:1788728327600:ce34bf6e-124e-4b40-a531-3d70ff931dd2` / delivery | 1788728304474 / 23685 / 23685 | 1788728328159 / 1788728332241 / 1788728333966 | 1788728333702 / 1461 | 52957 |
| 9 | `delivery:1788728334062:0c682bb7-b0d9-4720-819a-7acebd4b58cf` / delivery | 1788728314889 / 23799 / 23799 | 1788728338688 / 1788728339397 / 1788728340193 | 1788728341368 / 1971 | 47812 |
| 10 | `fence-expiry:1788728349761:68ee4fb2-9fda-4564-997a-d0b2849a7f61` / fence-expiry | 1788728334252 / 20000 / 0 | 1788728354252 / 1788728367146 / 1788728375216 | 1788728368329 / 1183 | 61657 |

The selected applying-pass join is therefore useful evidence, but it is not a
claim that every public safe read is causally attributable to that row. In
particular, a later arrival can create a later pass and the public polling
read can observe another already-safe state. No unsupported clock is filled
with ring finish, Queue invocation, authored `dcb_events.Timestamp`, or
caller `received_at`.

## W145 deadline movement retained in the comparison

The W145 ledger joins retained `ReservationProjector` deferred-event rows to
its ten public target SUIDs. A dash means the raw ledger has no matching
deferred row; it does not mean that no delivery occurred. W145 does not have
the W150 per-commit ring/arrival export, so this table is retained as deadline
movement evidence, not merged into the W150 per-pass joins.

| # | target SUID | first LastArrivedAt | last LastArrivedAt | first deadline | last deadline | observations | applying trigger | safe ms |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| 1 | `063924303401363000000733478993` | 1788706613066 | 1788706628593 | 1788706633066 | 1788706648593 | 9 | delivery | 120301 |
| 2 | `063924303414009000001717756093` | 1788706637996 | 1788706637996 | 1788706657996 | 1788706657996 | 3 | delivery | 107763 |
| 3 | `063924303426861000000188920526` | 1788706645615 | 1788706660851 | 1788706665615 | 1788706680851 | 7 | — | 94947 |
| 4 | `063924303439546000001231320882` | — | — | — | — | 0 | delivery | 82165 |
| 5 | `063924303452535000001508669489` | 1788706678516 | 1788706678516 | 1788706698516 | 1788706698516 | 8 | — | 69065 |
| 6 | `063924303466085000000150351593` | — | — | — | — | 0 | delivery | 55576 |
| 7 | `063924303479017000000317492971` | 1788706697967 | 1788706697967 | 1788706717967 | 1788706717967 | 9 | delivery | 45196 |
| 8 | `063924303491771000001694545127` | 1788706721489 | 1788706721489 | 1788706741489 | 1788706741489 | 9 | delivery | 49888 |
| 9 | `063924303504592000002074552862` | 1788706736538 | 1788706736538 | 1788706756538 | 1788706756538 | 3 | — | 74240 |
| 10 | `063924303518086000000966797386` | — | — | — | — | 0 | fence-expiry | 61375 |

W145 rows 1 and 3 show direct durable movement of 15,527 ms and 15,236 ms;
the deadline moved by the same amount because the observed SafeWindow was
20,000 ms. These rows support the retained diagnosis but do not repair the
W150 missing-arrival-clock or homogeneous-AC1 gaps.

## Available distributions and named estimate-raising candidates

Because the individual arrival table and W150 lag-estimate receipt were not
retained, the requested actual arrival-lag distribution cannot be computed.
The following are the nearest honest receipt-derived substitutes, all
nearest-rank percentiles over n=10:

| Observed quantity | n | p50 ms | p95 ms | max ms | Interpretation |
| --- | ---: | ---: | ---: | ---: | --- |
| selected `LastArrivedAt - message.enqueuedAt` | 10 | 24387 | 35337 | 35337 | high-water extension; not actual arrival lag |
| selected `LastArrivedAt - Queue invocation` | 10 | 20513 | 32125 | 32125 | post-invocation high-water extension; source/identity unavailable |
| Queue invocation - message enqueuedAt | 10 | 2281 | 3212 | 3212 | observed Queue invocation delay |
| first global receipt - message enqueuedAt | 10 | 180 | 676 | 676 | observed durable global-receipt delay |
| selected pass `dynamicLagBoundMs` | 10 | 5191 | 23799 | 23799 | pass estimate, not reconstructed arrival lag |
| safe observed - selected appliedAt | 10 | 17987 | 72952 | 72952 | public-read residual after selected apply |

Rows with the largest selected high-water/estimate values are named by the
retained identity: row 7 event
`01a07882-4b19-712c-a45b-859d6d509075`, SUID
`063924325066798000000328411432`, selected `LastArrivedAt=1788728302505`
and estimate `5782`; row 8 event
`01a07883-802b-7956-b125-a9f923cf0687`, SUID
`063924325079863000000389715198`, estimate `23685`; row 9 event
`01a07883-b196-72db-988c-de7f99efce1d`, SUID
`063924325092487000001163035396`, estimate `23799`; and row 10 event
`01a07883-e437-75d5-8363-c3007df2f4f8`, SUID
`063924325105572000001455364113`, selected high-water lag `28459`.
The receipts do not identify which concrete arrival raised each estimate, so
these are named high-water candidates, not asserted estimate-raising arrival
identities. An actual `serialized_dcb_event_arrivals`/`dcb_event_ops` export
joined to the pass ID is the remaining evidence needed.

## W145 and AC1 population mapping

W145 retained ten public rows and a fence-expiry/pass ledger. W150 retained a
separate ten-row public cohort with complete RING/Queue/pass attribution.
Together they are 20 retained rows, but they are **not one homogeneous
20-commit cohort**: they ran in different windows and W145 lacks the W150
per-commit arrival/ring columns. They therefore cannot be reported as the
AC1 required twenty-commit population. The exact remaining gap is a single
authorized cohort of at least 20 commits, or an equivalently contract-defined
population, with the arrival export, source/identity, SafeWindow/lag estimate,
actual applying pass, and safe observation joined losslessly. No such cohort
was rerun here.

## Source-level causal trace

Read-only inspection of the retained G67 source found this sequence:

1. `packages/dcb-runtime/src/store/D1EventStore.ts` upserts `dcb_event_ops`
   with `FirstArrivedAt = MIN(...)` and `LastArrivedAt = MAX(...)`. The
   `serialized_dcb_event_arrivals` row likewise uses `arrived_at = MAX(...)`.
   Queue delivery alone updates `serialized_dcb_lag_estimates`.
2. The G65 receiver support records the direct ring and applies the delivery
   core asynchronously. The later Queue path invokes the same core with
   `deliverySource='queue'`, so both paths can touch the same arrival facts.
3. `packages/dcb-runtime/src/mv/MaterializedViewCatchUp.ts` walks events in
   strict SUID order and returns `safe_window_fence` at the first event whose
   `lastArrivedAt` is newer than `now - safeWindowMs`, with
   `deferredDeadlineAt = lastArrivedAt + safeWindowMs`. It does not skip a
   lower-SUID event to apply a later one.
4. The sample Worker schedules the G67 fence-expiry/coverage retry from the
   returned deadline. The Durable Object owns one alarm key; an earlier alarm
   is retained when a later request is submitted. On alarm, state is re-read,
   an early alarm is re-armed, and an eligible alarm runs the normal
   single-flight pass. Delivery/fence/cron triggers coalesce through the
   existing kick scheduler.

An earlier alarm is therefore safe but not final while `LastArrivedAt` moves:
the pass re-evaluates durable state and waits for the final post-arrival
deadline. The strict-SUID frontier cannot advance across the unproven gap.

## Candidate comparison and recommendation

The diagnosis permits at most these three candidate changes plus the
do-nothing option. None was implemented. “Generation tagging alone preserves
the deadline”: it can identify stale timer work, but it cannot certify that an
earlier-SUID event will not arrive and therefore cannot shorten the current
`LastArrivedAt + SafeWindow` deadline.

| Option | Mechanism | Soundness preconditions | Proof plan / red mutants | Contract and parity impact | Residual cost/failure mode |
| --- | --- | --- | --- | --- | --- |
| Do nothing (recommended now) | Keep the current MAX-arrival fence and G67 re-evaluation; improve only future observability. | Existing strict SUID order, G44 SETTLED requirement, SafeWindow assumption, and Queue/DLQ guarantee remain authoritative. | Use the missing arrival export and one homogeneous >=20 cohort later; retain stale-alarm, BLOCK/UNSETTLED, and skipped-frontier mutants. | No G11/G44/G62 behavior or C# parity change. | Preserves safe tail and repeated work; current receipts cannot prove a shorter deadline. |
| Arrival-generation tagging | Persist a monotonic generation when durable MAX changes; alarms carry generation and stale alarms re-read/reschedule. | Generation update is atomic with arrival high-water; stale generation never advances a checkpoint; current fence remains the certification rule. | Deliver duplicate and out-of-order arrivals around alarms; remove generation check and require the stale-timer guard to go red. | Observability/coalescing only; no G11/G44/G62 semantic or C# parity change. | Does not shorten the fence by itself; adds durable state and migration/compatibility cost. |
| Earlier-SUID closure certificate | Shorten the first-arrival fence only after a durable certificate proves every in-scope obligation at or below target is terminal with no retry/DLQ path. | Complete partition discovery, exact strict-SUID scope, no pending retry, and G44 SETTLED are all proved atomically. | Omit a partition, insert a delayed earlier SUID, or retain a retry/DLQ obligation; each must keep the frontier blocked. | High G11/G44/G62 and C# parity impact; requires a separate design/ruling. | Certificate maintenance is expensive; an omitted partition would make the optimization unsound, so fallback must be current fencing. |
| Conservative quiet/high-water certificate | Use durable Queue lag high-water plus arrival generation; shorten only after conservative unseen-earlier-SUID quiet bound and G44 settlement. | The lag bound covers every allowed delivery path and a new duplicate invalidates the generation. | Delay earlier-SUID delivery beyond the bound, duplicate after quiet, and remove generation invalidation; all must remain fail-closed. | Changes SafeWindow certification assumptions and likely G11/G44/G62/C# parity; separate ruling required. | May still wait nearly as long, and a wrong bound is a frontier-soundness defect. |

### Recorded engineering dissent (verbatim)

Recommendation: do nothing behaviorally until the missing arrival clocks and a
homogeneous AC1 population are captured. Generation tagging is a useful
future observability option, but **generation tagging alone preserves the
deadline** and is not a latency repair. The closure and quiet certificates
are future design work, not authorized implementation in this PR.

## Design Decision: first-arrival fencing under a true bound

WAKE-155 records the following design decision for the later G69 behavior;
this G68 PR does not implement it. Let `E` be the target event, let `t0(E)`
be its first durable arrival in D1, and let `W` be a true enqueue-to-arrival
bound for every allowed delivery path. If an earlier-SUID event `E-prime` was
enqueued before `E` reached D1, then

```text
arrival(E-prime) <= enqueue(E-prime) + W < t0(E) + W
```

Therefore, by the first-arrival deadline `t0(E) + W`, every earlier-SUID
`E-prime` covered by that premise has reached D1. A later arrival or
redelivery of `E` supplies no new ordering evidence: its event identity and
SUID are already known, and it does not establish the arrival of an earlier
SUID. With strict SUID order, complete source-universe discovery, and G44
settlement still required, first-arrival fencing is sound under this explicit
bound.

The cost is real: first-arrival fencing removes accidental queue-backlog
adaptivity from the current MAX/`LastArrivedAt` behavior. If `W` underestimates
lag for an allowed delivery path, exposure increases because the fence can
open earlier. The bound must therefore be a real contract precondition, not an
estimate inferred from the W150 substitute clocks. No concrete counterexample
where `W` is true and first-arrival admits while last-arrival excludes was
found in the retained receipts. Those receipts cannot establish that `W` is
true because their individual arrival rows are missing; that remains a G69
proof obligation, not a claim made by this PR.

### G69 controls and fallback

The G69 control plan is mandatory if this decision is implemented:

- Run a delayed-lower-SUID ordering test with two red mutants: one that skips
  the delayed lower-SUID row in favor of a later row, and one that advances
  the frontier before the delayed lower-SUID arrival is accounted for. Both
  mutants must go red.
- Exercise a late-lower-SUID detector that records the `(target, lower-SUID,
  observed-after-fence)` pair. The arm and production acceptance receipts must
  show zero detections; the detector result is not present in W145/W150 and is
  not claimed here.
- Roll back the first-arrival decision on any detector hit, frontier anomaly,
  or violation of the true-bound precondition.
- Under the WAKE-155 numbering, candidates two and three remain the fallback
  if the hazard disproves this decision: candidate two is the earlier-SUID
  closure certificate and candidate three is the conservative quiet/high-water
  certificate described in the comparison above. The arrival-generation row
  is observability/coalescing only. All are future design alternatives, not
  G68 implementation.

## G69 loose-thread handoff: post-Queue LastArrivedAt writers

The source trace identifies the writers without changing them. In
`packages/dcb-runtime/src/store/D1EventStore.ts:295`, both `fast` and `queue`
delivery call `recordDelivery(message, arrivedAt, deliverySource)`. The same
atomic batch at lines 543-555 upserts `dcb_event_ops.LastArrivedAt` with
`MAX(...)`; lines 572-592 upsert `serialized_dcb_event_arrivals.arrived_at`
with `MAX(...)`; line 663 commits the batch. The `fast` direct-doorbell path
is `DownstreamAdapter.ts:233-252` (and the Tag admission call at
`TagDurableObject.ts:3334`); the Queue path is
`DownstreamAdapter.ts:285-340`. `DeliveryCore.ts:313-324` records the durable
batch boundary after `recordDelivery` returns. The safe pass only reads the
resulting `event.lastArrivedAt` and computes the fence at
`MaterializedViewCatchUp.ts:216-229`; it is not a `LastArrivedAt` writer.

W150 contains ten target reservation events, obligation sequences 2 through
11. The retained durable-hop receipt has one fast and two Queue
`record-delivery-batch-committed` observations per event: 10 fast potential
writers and 20 post-Queue potential writers. The hop receipt also has two
Queue consumer invocations per event. These are batch-boundary counts; the
missing arrival export means they are not silently relabeled as 20 proven
`MAX` changes.

| obligation sequence | target SUID | Queue batch commit times | final selected LastArrivedAt | retained post-Queue effect / still-needed assessment |
| ---: | --- | --- | ---: | --- |
| 2 | `063924324988440000001041685361` | 1788728192234, 1788728194784 | 1788728214260 | Two Queue writers; no new event identity or unsafe view. Queue guarantee/retry path remains needed, but the exact MAX-changing attempt is unavailable. |
| 3 | `063924325002491000000522510130` | 1788728205977, 1788728207100 | 1788728225529 | Same: Queue guarantee/retry processing, no new event/unsafe state; MAX-changing attempt not identifiable. |
| 4 | `063924325015429000001832279219` | 1788728219453, 1788728221151 | 1788728226897 | Same; later Queue processing is visible, but no per-arrival `arrived_at` row is retained. |
| 5 | `063924325028310000001361936111` | 1788728231084, 1788728232190 | 1788728256877 | Same; Queue is the guarantee path, not new ordering evidence. |
| 6 | `063924325040941000000145805155` | 1788728243959, 1788728245564 | 1788728258702 | Same; no retained evidence that either replay carried a missing event. |
| 7 | `063924325053570000000144395544` | 1788728256901, 1788728260896 | 1788728269553 | Same; two Queue batches and no new unsafe state. |
| 8 | `063924325066798000000328411432` | 1788728271317, 1788728272849 | 1788728302505 | Same; later high-water is selected by the pass, but the writer attempt is not identifiable. |
| 9 | `063924325079863000000389715198` | 1788728282642, 1788728283825 | 1788728304474 | Same; Queue replay is observable, not a new event identity. |
| 10 | `063924325092487000001163035396` | 1788728295434, 1788728296775 | 1788728314889 | Same; Queue guarantee/retry need is retained, semantic novelty is not. |
| 11 | `063924325105572000001455364113` | 1788728308591, 1788728310207 | 1788728334252 | Same; no source receipt identifies which replay raised the high-water. |

Per target, the unsafe-writer receipt records one fast `applied`, one fast
`no-change`, and two Queue `duplicate-race` end outcomes across the two
independent unsafe views; the MV unsafe receipt records one `no-change`. This
supports the conclusion that the Queue deliveries did not create a missing
event or new unsafe view in this cohort. They remained operationally relevant
as the durable Queue guarantee/retry path. The retained rows do not preserve
the Queue ack/retry reason well enough to say that the second replay was
required operationally, and they do not prove which Queue attempt changed
`LastArrivedAt`; G69 should add that join rather than infer it.

## Boundaries and checks

This PR adds only this document. It does not implement a candidate, alter
G44/G62/G61/G65 semantics, change the SafeWindow, add tests, deploy, reset,
modify Cloudflare, or delete resources. No new cohort was run. Existing
unrelated dirty artifacts in the sender worktree were not staged or modified.

Applicable checks are documentation-format inspection and `git diff --check`;
runtime/deployed tests are not applicable to this documentation-only repair.
