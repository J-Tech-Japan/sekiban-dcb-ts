# SDT-G67 amended AC4/AC5 production proof and cleanup — W146

Status: **blocked**

Task: `SDT-G67-AMENDED-AC4-PRODUCTION-CLEANUP-WAKE-146`

Branch: `claude/sdt-g67-local-wake-w142`

Evidence parent before this report commit: `6467be1615562d31df29de900ed48773e0a36a71`
Candidate source measured in production: `d596192f3b0ddb0ab6b70d10ed8b8c04cd5489ae`

This checkpoint reconciles the retained W145 arm receipts, completes one
production C-0 proof on the existing sample Worker, and records the exact
cleanup blocker. No W155-C resource was touched. No product source, PR, or
acceptance bound was changed.

## Authority and credential hygiene

Every Wrangler call in this window was executed through the receipt wrapper
that removes `CLOUDFLARE_API_TOKEN`, `CF_API_TOKEN`, `CLOUDFLARE_API_KEY`,
`CF_API_KEY`, and `WRANGLER_API_TOKEN`. Each receipt records all five names as
`UNSET` and `noKeepVars: true`. The conformance token was supplied only by a
private file path; its value is not present in this report or any receipt.

The first production cohort attempt received the application’s own HTTP 403
(`Conformance authentication required`) and created zero reservations. A
read-only `wrangler secret list` succeeded; a fresh path-only conformance token
was installed, and the Worker was redeployed unchanged at the exact candidate
source. The final deployed version was `11c907ff-dde3-44c3-928e-550303d47aac`,
100% active, with annotation
`SDT-G67 W146 production candidate exact d596192f3b0ddb0ab6b70d10ed8b8c04cd5489ae
after conformance secret`. The normal production configuration had the
expected pipeline/MV bindings and Queue/DLQ bindings. This was an application
auth receipt, not a Cloudflare API authorization failure.

## Retained W145 reconciliation

The W145 parent/candidate receipts were sufficient to derive the amended
attribution columns, so the arm cohort was not rerun. The retained cohorts
were cold-first, paced, and `n=10` each:

| cohort | response p50/p95 (ms) | unsafe p50/p95 (ms) | safe p50/p95 (ms) | safe <180 s |
|---|---:|---:|---:|---:|
| parent `91c36df5434895cccbbe03beeb5d7f8b5639857f` | 2979 / 4359 | 2947 / 3206 | 71304 / 123906 | 10/10 |
| candidate `d596192f3b0ddb0ab6b70d10ed8b8c04cd5489ae` | 2829 / 3535 | 2878 / 3062 | 69065 / 120301 | 10/10 |

The candidate retained ledger has 56 fence stops and 9 completed
fence-expiry passes with `SafeWindow=20000 ms`. Its derived residual scheduling
wait p95 was 936 ms; the pass-latency p95 was 27598 ms. The amended AC4
pass-latency <=5000 ms condition therefore was not proven by W145. These rows
are retained as evidence, not reinterpreted as a pass.

## Production deployment and C-0 reset

The production normal config remained the existing sample Worker
`sekiban-dcb-meeting-room-cloudflare-only`, pipeline D1
`f26d1299-82d9-4a64-8647-bc2ec86326ac`, MV D1
`b416b212-4d09-413c-9b8d-7660e475772f`, Queue
`sekiban-dcb-meeting-room-cloudflare-outbox`, and DLQ
`sekiban-dcb-meeting-room-cloudflare-outbox-dlq`. Pipeline migrations 0008
through 0014 were applied; the C-0 reset used explicit count/delete/count
operations over the operational tables and did not drop schema or alter
queues. The reset receipt finished at `2026-09-06T15:22:37.057Z`.

The valid production cohort was run with the cold first sample and 10-second
pacing:

- run ID: `7b5cdd0f-ed47-46a2-8f7c-b2d04e9aff20`
- started: `2026-09-06T15:26:01.565Z`
- finished: `2026-09-06T15:29:05.432Z`
- reservations: `10/10`, all eventually visible and uncensored
- all `safeWindowAtCommit`: `20000 ms`
- final lag estimate: `14421 ms`
- normal config `DIRECT_DOORBELL=false`; the ring ledger consequently has
  zero rows and the cohort uses Queue delivery for the durable path

The strict five-second unsafe observations all missed the 5000 ms observation
bound, but all ten eventual unsafe reads and all ten safe reads completed. The
amended production gates are not all satisfied: scheduling-wait p95 passed,
while pass-latency p95 was 16983 ms (>5000 ms). This is a blocked production
result; no repair or second cohort was attempted.

### Per-commit observed attribution

`Queue arrival` is the maximum, across the event’s room and reservation
obligations, of `consumer-invocation-started - queue-send-returned` from the
seven-hop ledger. `Fence wait` is `stop_deadline_at - command-receipt` for the
selected completed pass row. `Scheduling wait` is
`started_at - scheduled_at`; `pass` is `completed_at - started_at`. The
selected row is the last completed row for the exact delivery SUID, preferring
a completed fence-expiry row. The raw ledger remains the authoritative
batch-level record; this join is not asserted to be the sole causal public-read
path. Ring arrival is `N/A` for every row because the deployed normal config
has direct doorbell disabled and the ring ledger is empty.

| # | exact SUID | response | unsafe eventual | safe | ring arrival | Queue arrival | fence wait | scheduling wait | pass | trigger | stop reason |
|---:|---|---:|---:|---:|---|---:|---:|---:|---:|---|---|
| 1 | `063924305177989000001699136368` | 1944 | 115342 | 116916 | N/A | 9028 | 41655 | 203 | 9939 | fence-expiry | safe_window_fence |
| 2 | `063924305189942000001445738364` | 1929 | 103481 | 104975 | N/A | 10548 | 54995 | 219 | 11713 | fence-expiry | safe_window_fence |
| 3 | `063924305202088000000186107726` | 2172 | 91401 | 92801 | N/A | 15044 | 60760 | 230 | 13617 | fence-expiry | safe_window_fence |
| 4 | `063924305214231000001842017430` | 2000 | 79493 | 80735 | N/A | 16868 | 48694 | 270 | 4982 | delivery | safe_window_fence |
| 5 | `063924305226385000001467339264` | 2092 | 67331 | 76684 | N/A | 22375 | 60230 | 257 | 15760 | fence-expiry | safe_window_fence |
| 6 | `063924305238640000001842031745` | 2388 | 55070 | 66724 | N/A | 15452 | 59003 | 216 | 15086 | fence-expiry | safe_window_fence |
| 7 | `063924305251043000001307772868` | 2059 | 42968 | 59204 | N/A | 11860 | 57528 | 213 | 16983 | fence-expiry | safe_window_fence |
| 8 | `063924305263164000001063677243` | 2152 | 30920 | 80210 | N/A | 22514 | 62698 | 1608 | 3312 | delivery | safe_window_fence |
| 9 | `063924305275242000000197541936` | 2022 | 19008 | 68186 | N/A | 12205 | 33351 | 119 | 4825 | delivery | safe_window_fence |
| 10 | `063924305287381000001223743116` | 2284 | 9535 | 55900 | N/A | 6998 | 38388 | 1032 | 5365 | delivery | safe_window_fence |

All values are milliseconds from observed clocks. `unsafe eventual` is shown
because the strict 5000 ms read was missed in all 10 rows; the valid cohort
receipt records the strict miss separately. Safe first visibility was under
180 seconds for all 10 rows.

### Production distributions and gate result

| measure | n | p50 (ms) | p95 (ms) | result |
|---|---:|---:|---:|---|
| command response | 10 | 2059 | 2388 | measured |
| Queue arrival (max obligation) | 10 | 12205 | 22514 | measured |
| fence wait | 10 | 54995 | 62698 | measured |
| scheduling wait | 10 | 219 | 1608 | **pass** (`<=5000`) |
| pass latency | 10 | 9939 | 16983 | **miss** (`>5000`) |
| catch-up body | 10 | 3259 | 5312 | measured |
| safe first visibility | 10 | 76684 | 116916 | measured; 10/10 `<180000` |
| unsafe eventual visibility | 10 | 55070 | 115342 | strict 5000 ms bound missed 10/10 |

The seven-hop production ledger has 126 rows: 21 outbox obligations, 21 tag
append commits, 21 Queue sends, 21 consumer starts, 21 record-delivery commits,
11 command receipts (setup plus the 10 cohort commits), and 10 eventual
unsafe-read rows. The post-admission
ledger has 252 rows across global receipt, source acknowledgement, completeness,
detector, and unsafe-view boundaries. The safe-pass ledger has 320 rows in the
final receipt: 300 delivery-trigger rows, 10 fence-expiry rows, 10 cron rows,
with 63 completed, 256 coalesced, and 1 running at snapshot time. Its stop
reasons include 55 `safe_window_fence` rows and 8 `advanced_or_caught_up` rows.
The safe history begins with the expected BLOCK/UNSETTLED partition-set change
and ends SETTLED at final cohort SUID
`063924305287381000001223743116`.

## Authorized cleanup and exact blocker

After the cohort, read-only target resolution confirmed:

| target | resolved identity |
|---|---|
| Worker | `sekiban-dcb-g60-w131-c`; latest deployment listing contained the expected worker service |
| pipeline D1 | `sekiban-dcb-g60-w131-c-pipeline` / `b03270df-9698-4a9e-94c6-c2c5726f106d` |
| MV D1 | `sekiban-dcb-g60-w131-c-mv` / `616dd377-42f3-49f7-b373-a1a07cedf2b3` |
| outbox Queue | `sekiban-dcb-g60-w131-c-outbox` / `1bd200864a804e78bd83da26a343deb4` |
| DLQ | `sekiban-dcb-g60-w131-c-outbox-dlq` / `607750c269894fa3b29e019a2db23908` |

The first authorized cleanup command was exactly the Worker deletion in the
specified order:

`wrangler delete sekiban-dcb-g60-w131-c --force`

It failed with Cloudflare API code **10064**:

`Cannot delete this Worker as it is a consumer for a Queue. Remove it from the Queue's consumers first, then retry.`

The preceding read-only Queue inventory confirmed that the W131-C outbox has
one consumer and the DLQ has zero. No consumer-detach mutation is authorized
by this task, and deleting the Queue before the Worker would violate the
required cleanup order. Therefore cleanup stopped at this exact blocker; the
two D1s and two Queues were not deleted, and no retry or alternate deletion
path was attempted. The W131-C resources remain explicitly recorded for
operator follow-up.

## Raw receipts and reproducibility

All W146 raw receipts remain on disk under
`.artifacts/sdt-g67-amended-ac4-production-cleanup-wake-146-*`, including
preflight/version/binding, migration, reset, deploy/redeploy, secret,
cohort, seven-hop, post-admission, safe-pass/history, lag, target-resolution,
and cleanup-attempt receipts. The valid cohort receipt is
`.artifacts/sdt-g67-amended-ac4-production-cleanup-wake-146-production-cohort-valid.json`;
the exact failed first attempt is retained separately as
`.artifacts/sdt-g67-amended-ac4-production-cleanup-wake-146-production-cohort.json`.
W145 raw arm receipts remain untouched under
`.artifacts/sdt-g67-fence-expiry-arm-wake-145-*`, and its committed report is
`sdt-g67-fence-expiry-arm-wake-145.md`.

Applicable local evidence/diff inspection was clean for this report. No
source/test change was made in W146. Final status is **blocked** by the
production pass-latency gate and the explicit Cloudflare Worker cleanup
dependency (10064), not by an unverified inference.
