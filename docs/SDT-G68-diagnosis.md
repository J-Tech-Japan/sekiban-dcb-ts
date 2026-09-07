# SDT-G68: SafeWindow arrival-fence diagnosis

Closes #131

## Scope and conclusion

This is a documentation-only SDT-G68 diagnosis. No product behavior,
SafeWindow constant, frontier rule, test, deployment, reset, Cloudflare
resource, or protected worker was changed.

The retained W145/W150 receipts show that a later Queue delivery of an event
already seen by the G65 direct ring updates the durable arrival high-water and
restarts the SafeWindow fence. G67 remains fail-closed and eventually
effective: an early fence-expiry wake re-reads durable state, refuses to pass a
still-fresh strict-SUID event, and schedules or retains the applicable later
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
as `rung`, 10/10 direct applies as `applied`, and later Queue observations for
every sample. W145 supplied the earlier fence-expiry pass ledger, including
122 durable pass rows and target-SUID deadline observations. Its public
receipt did not retain a per-commit ring timestamp; that missing field is not
inferred from W145.

## W150 direct-ring and Queue observations

Times are epoch milliseconds from the deployed receipts. `LastArrivedAt` and
the eligibility deadline are selected by the actual applying pass; they are
not authored event timestamps or caller receipt times.

| # | target SUID | ring finished | Queue first | Queue last | LastArrivedAt | eligible at | applying trigger | arrival updates | safe ms |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | `063924324988440000001041685361` | 1788728188677 | 1788728191520 | 1788728194098 | 1788728214260 | 1788728234260 | delivery | 22 | 120646 |
| 2 | `063924325002491000000522510130` | 1788728202735 | 1788728205016 | 1788728206502 | 1788728225529 | 1788728245529 | delivery | 6 | 107132 |
| 3 | `063924325015429000001832279219` | 1788728215670 | 1788728218226 | 1788728220229 | 1788728226897 | 1788728246897 | delivery | 2 | 94055 |
| 4 | `063924325028310000001361936111` | 1788728228555 | 1788728230236 | 1788728231539 | 1788728256877 | 1788728276877 | delivery | 18 | 81342 |
| 5 | `063924325040941000000145805155` | 1788728241186 | 1788728242955 | 1788728244625 | 1788728258702 | 1788728278702 | delivery | 0 | 68758 |
| 6 | `063924325053570000000144395544` | 1788728253808 | 1788728256222 | 1788728260060 | 1788728269553 | 1788728289553 | delivery | 8 | 56172 |
| 7 | `063924325066798000000328411432` | 1788728267200 | 1788728270380 | 1788728271945 | 1788728302505 | 1788728322505 | delivery | 23 | 57551 |
| 8 | `063924325079863000000389715198` | 1788728280194 | 1788728281890 | 1788728283256 | 1788728304474 | 1788728328159 | delivery | 1 | 52957 |
| 9 | `063924325092487000001163035396` | 1788728292732 | 1788728294466 | 1788728296060 | 1788728314889 | 1788728338688 | delivery | 5 | 47812 |
| 10 | `063924325105572000001455364113` | 1788728305822 | 1788728307602 | 1788728309342 | 1788728334252 | 1788728354252 | fence-expiry | 5 | 61657 |

All ten W150 rows have `LastArrivedAt > Queue first`. The first-to-last Queue
invocation interval was 1,303–3,838 ms (nearest-rank p50 1,594 ms, p95
3,838 ms). The durable `LastArrivedAt - Queue first` interval was
8,671–32,125 ms (p50 20,513 ms, p95 32,125 ms). Ring-to-final-
`LastArrivedAt` was 11,227–35,305 ms (p50 22,794 ms, p95 35,305 ms). The
W150 safe metrics were n=10, p50=61,657 ms and p95=120,646 ms; scheduling
wait was p50=1,765 ms/p95=6,600 ms and pass latency was p50=1,186 ms/p95
=8,761 ms. These are retained context, not a new SDT-G68 acceptance cohort.

## W145 deadline movement

The W145 ledger joins retained `ReservationProjector` deferred-event rows to
the ten public target SUIDs. A dash means the raw ledger has no matching
deferred row; it does not mean that no delivery occurred.

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
20,000 ms. W150 is the stronger direct-ring-plus-later-Queue observation for
all ten samples.

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

## Candidate changes (none implemented)

The diagnosis permits at most these three candidate changes plus the
do-nothing option. None was selected or implemented.

1. **Do nothing / observability-only (lowest risk).** Keep the current
   fail-closed fence and publish arrival generations, deadlines, and alarm
   re-evaluations. This is sufficient when the goal is explanation rather than
   a latency change.
2. **Durable arrival-generation fence.** Add a monotonic per-event/per-service
   arrival generation and carry it with the alarm request. Increment only when
   the durable MAX changes; a stale request records `stale_fence`, reads the
   current deadline, and reschedules without advancing a checkpoint. Soundness
   is unchanged because the current `LastArrivedAt + SafeWindow` and strict
   SUID checks remain authoritative.
3. **Earlier-SUID closure certificate.** Permit a shorter first-arrival fence
   only after a durable certificate proves every in-scope obligation with SUID
   at or below the target is terminal and has no retry/DLQ path. A certificate
   that omits a partition or retry path cannot shorten the fence.
4. **Conservative quiet/high-water certificate.** Keep a durable Queue lag
   high-water and arrival generation. A shorter deadline is eligible only
   after that generation is quiet for the conservative unseen-earlier-SUID lag
   bound and G44 is settled; a new duplicate invalidates the generation and
   falls back to the current MAX fence. A timer alone is not proof.

## Boundaries and checks

This PR adds only this document. It does not implement a candidate, alter
G44/G62/G61/G65 semantics, change the SafeWindow, or add tests. The retained
W152 receipt remains the source for the hashes and tables above. Local checks
are documentation-format and `git diff --check`; no runtime or deployed test
is applicable to this documentation-only change. Existing unrelated dirty
artifacts in the sender worktree were not staged or modified.
