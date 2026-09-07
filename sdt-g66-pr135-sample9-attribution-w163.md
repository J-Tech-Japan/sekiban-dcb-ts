# SDT-G66 PR135 sample-9 attribution — W163

## Scope

This is a documentation-only correction for review `5134613536`. It does not
rerun the cohort, change behavior, deploy, reset data, clean up resources, or
change the acceptance gate. The prior phase-one result remains fail-closed at
9/10 for the required safe target predicate.

Source checkpoint before this docs correction:
`853b0d0df0939f0cd6d53bb479c785b1409f8b16`.

## Exact retained sequence

Source receipt: `.artifacts/sdt-g66-w161-production-corrected.json`.

| sample | command and event | observed clocks and result |
|---:|---|---|
| 9 | `reserve-room`, reservation `g66-w161-production-corrected-w161-product-r08`; HTTP 200 committed; event `RoomReserved`; committed SUID and returned head `063924397376364000000490188162` | commit start/completion `1788800575342`/`1788800577387`, response `2045 ms`, admission `unknown`; unsafe first visible `1788800579620` (`2233 ms` response-relative), with the reservation visibly `reserved` |
| 10 | `cancel-reservation` for the same reservation; HTTP 200 committed; event `ReservationCancelled`; SUID/head `063924397388322000000430464790` | commit start/completion `1788800587728`/`1788800588924`, response `1196 ms`; unsafe first visible `1788800591177` (`2253 ms` response-relative); safe predicate passed at `1788800629308` (`40384 ms` response-relative) |

Sample 9's safe target was the reserved-state predicate for committed SUID
`063924397376364000000490188162`. Its fixed 180,000 ms bound expired at
`1788800757569`; `firstVisibleAtMs` and response-relative safe time are both
`null`. The final retained safe query had a settled/read head of
`063924397388322000000430464790` and `visible: false` for
`waitForSuid=063924397376364000000490188162`. That later head is the sample-10
cancel event, not proof that sample 9's reserved state became safe.

Thus the exact distinction is:

- sample 9 commit/head and unsafe reserved-state observation passed;
- the safe/read-head machinery did observe a later head, but the specific
  reserved-state predicate was censored before it could be proven;
- sample 10 then cancelled the same reservation and separately passed its
  cancelled-state safe predicate.

The raw safe object retains no successful sample-9 target observation. The
phase-one count therefore remains 9/10, fail-closed, even though this row is
not evidence of a permanently stalled read head.

## Corrected operator/evidence language

The retained G68 diagnosis remains the attribution for the delay: repeat
delivery arrivals can move `LastArrivedAt` and restart the SafeWindow/fence-
expiry deadline. The sample-10 cancellation is the additional semantic fact
that makes the original reserved-state predicate unprovable after the later
state transition. The two facts must not be collapsed into a claim that the
safe/read-head lane failed to advance, nor into a pass for the reserved-state
predicate.

Operator answer: the write, returned head, and unsafe lane passed for sample 9;
the exact reserved-state safe predicate did not complete before 180 seconds,
so the acceptance result remains fail-closed at 9/10. The later read head and
sample-10 cancelled-state proof are retained context, not a retrofit of
sample-9 success. AC2 remains outstanding; no rerun or behavior change is
claimed.

## Aggregate preservation

The unchanged cohort totals remain: 10/10 commits, 10/10 unsafe observations,
unsafe p50/p95 `2253/2727 ms`; 9/10 safe target predicates, with observed safe
p50/p95 `38259/61014 ms` over n=9 and one 180-second censor. The full raw
receipt and read-only topology receipt remain lossless and unchanged.
