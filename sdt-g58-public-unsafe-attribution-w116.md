# SDT-G58 public unsafe attribution — W116

Task: SDT-G58-PUBLIC-UNSAFE-ATTRIBUTION-W116
Issue: #112
Status: **completed; attribution inconclusive from the bounded public data**
Branch: claude/sdt-g58-safe-lane-w93
Config: samples/meeting-room/wrangler.cloudflare-only.jsonc
Wrangler: 4.125.0

## Result

The exact-main public arm was slow: 8/10 samples were over or missing the
unchanged 5,000 ms bound, with five censored at the 120,000 ms observation
ceiling. Because A was slow, the conditionally authorized C-0/C-13 clean-main
datum was run once. It removed the accumulated D1 source and projection
volume, but C still had 5/10 samples over 5,000 ms (no missing samples).

The bounded result therefore does **not** establish either that G58's D1
health/poll writes caused the contention or that accumulated operational volume
alone caused it. The clean run reduced censoring but was not a fast clean run.
Attribution is **inconclusive**; final unsafe proof remains delegated to
drafted, unpublished SDT-G60.

No B repeat was scientifically necessary: the durable W115 B receipt already
contains the requested ten-sample G58 comparison, and C supplied the only
authorized third cohort. No fourth cohort was run.

## Scope and public instrument

This continuation made no product, test, configuration, issue, PR, or repair
change. It did not repeat the prior OAuth preflight. All Wrangler calls used
one OAuth user with API-token fallback variables unset, path-only credentials,
the normal config, and no --keep-vars. No Wrangler code 10000 or OAuth/auth
failure occurred.

A and C used only the public surface common to the exact main and G58 heads:

1. POST /api/commands/create-room with the G15 body
   {"roomId":"...","name":"SDT-G15"}.
2. Ten POST /api/commands/reserve-room commands with the G15 body
   {"roomId":"...","reservationId":"...","userId":"g15"}.
3. After every successful reservation commit, GET
   /api/read/reservations?pageNumber=N&pageSize=1000&newestFirst=true until
   that reservation ID appeared.

The first sample was cold. Reservation commits were at least 10,000 ms apart.
Every list observation fetched all pages declared by the response; the plan
also grew if a later response declared more pages. A's snapshots declared one
page. C's later snapshots declared two pages, and both were fetched, so list
pagination was not treated as a miss. Each raw commit and list observation was
persisted immediately to the raw receipt. A and C did not call
/conformance/v1/read-health, use a conformance token, call a private
read endpoint, or warm the frontend.

The unchanged unsafe bound was 5,000 ms. A/C missing samples are censored at
the 120,000 ms observation ceiling and counted over-or-missing. Percentiles for
A and B are nearest-rank values over observed samples only; censored full-arm
percentiles are not claimed. C had no censored samples, so its p50/p95 also
describe all ten samples.

## Exact deployed identities and pre-run counts

| Arm | Exact source | Deployment | 100% version | Source annotation | dcb_events | mv_unsafe_receipts | mv_rows |
| --- | --- | --- | --- | --- | ---: | ---: | ---: |
| A — main public | 65a19688d743700d10cab4ba0d3940485b37aab6 | 6061b245-e3a3-4423-a1bd-632d78eee118 | a3c80a08-3590-4d8d-a665-28695edc4e20 | SDT-G58 W116 A public main 65a19688d743700d10cab4ba0d3940485b37aab6 | 5,377 | 213 | 418 |
| B — G58, reused W115 | 8d889cfe2e550930a14a7c30c33d80b4b0759344 | f45237bf-37c2-4f73-ba0e-209652187c0d | 660fb952-57bf-4e7a-957e-1e929a31d6af | SDT-G58 W115 B G58 8d889cfe2e550930a14a7c30c33d80b4b0759344 | 5,366 | 208 | 407 |
| C — clean main public | 65a19688d743700d10cab4ba0d3940485b37aab6 | 6678ed0f-943c-4098-a862-ec5264eff1d7 | c89fe440-9c12-4a42-b76c-9e9473ea4639 | SDT-G58 W116 C clean main public 65a19688d743700d10cab4ba0d3940485b37aab6 | 0 | 0 | 0 |

A's pre-traffic counts are preserved in
[.artifacts/sdt-g58-w116-main-precounts.json](.artifacts/sdt-g58-w116-main-precounts.json).
B's reused counts are preserved in
[.artifacts/sdt-g58-w115-g58-precounts.json](.artifacts/sdt-g58-w115-g58-precounts.json).
C's counts were captured at 2026-09-03T16:33:06.3Z (pipeline) and
2026-09-03T16:33:13.3Z (MV), immediately before its setup command, in
[.artifacts/sdt-g58-w116-clean-main-precounts.json](.artifacts/sdt-g58-w116-clean-main-precounts.json).
All three count reads were remote read-only queries with zero rows written.

## Conditional C-0/C-13 reset

A's 8/10 over-or-missing result authorized the clean datum. The reset was run
once, after the A cohort and before the C redeploy. It targeted all application
operational rows in the two configured D1 databases, including the accumulated
retired-service source rows. It preserved _cf_KV, d1_migrations, schemas,
worker code, and configuration. It did not invoke or edit Queue, outbox, or the
external/global-admission code path. The serialized completeness/allocator rows
inside these D1 databases were included because leaving them would retain the
volume being tested; this data reset is recorded explicitly rather than being
presented as a product repair.

The exact remote SQL was:

    -- pipeline D1
    DELETE FROM serialized_dcb_global_receipts;
    DELETE FROM serialized_dcb_global_memberships;
    DELETE FROM serialized_dcb_event_arrivals;
    DELETE FROM dcb_event_ops;
    DELETE FROM dcb_events;
    DELETE FROM serialized_dcb_allocator_bindings;
    DELETE FROM serialized_dcb_completeness_findings;
    DELETE FROM serialized_dcb_completeness_scanner_health;
    DELETE FROM serialized_dcb_delivery_incidents;
    DELETE FROM serialized_dcb_inconsistency_findings;
    DELETE FROM serialized_dcb_lag_estimates;
    DELETE FROM serialized_dcb_live_poll_health;
    DELETE FROM serialized_dcb_pending_arrivals;
    DELETE FROM serialized_dcb_projection_checkpoints;
    DELETE FROM serialized_dcb_safe_lane_health;
    DELETE FROM serialized_dcb_source_partitions;
    DELETE FROM serialized_dcb_wait_target_incidents;

    -- MV D1
    DELETE FROM mv_active_generations;
    DELETE FROM mv_checkpoint_ahead_findings;
    DELETE FROM mv_index_entries;
    DELETE FROM mv_rows;
    DELETE FROM mv_unsafe_index_entries;
    DELETE FROM mv_unsafe_rows;
    DELETE FROM mv_wait_receipts;
    DELETE FROM mv_wait_target_poison;
    DELETE FROM mv_unsafe_arrivals;
    DELETE FROM mv_unsafe_kicks;
    DELETE FROM mv_unsafe_markers;
    DELETE FROM mv_unsafe_receipts;
    DELETE FROM mv_unsafe_failure_findings;
    DELETE FROM mv_atomic_guards;
    DELETE FROM mv_instances;

The complete command receipts are in
[.artifacts/sdt-g58-w116-clean-main-reset.json](.artifacts/sdt-g58-w116-clean-main-reset.json).
Key before/after counts were:

| Table | Before reset | Immediately after reset |
| --- | ---: | ---: |
| pipeline dcb_events | 5,388 | 0 |
| MV mv_unsafe_receipts | 219 | 0 |
| MV mv_rows | 429 | 0 |

The before-reset pipeline volume included 4,938 rows for retired service
sdt-g47-repair-wake32c-20260831 and 442 for the normal service. Immediately
after the reset, the running deployment reconstructed 31 completeness findings
and one scanner-health row from retained Durable Object state, and reconstructed
2 empty MV active-generation/instance records. Source events and projection
rows remained zero. This incidental generated drift is recorded in the reset
receipt and was not silently described as an all-table zero.

## Cohort comparison

| Arm | Run | n | observed | censored/missing | observed p50 (ms) | observed p95 (ms) | over-or-missing 5,000 ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A — main public | 16760031-7516-4cfa-b159-111d0193d527 | 10 | 5 | 5 at 120,000 ms | 5,698 | 21,854 | 8/10 |
| B — G58 reused W115 | e038aee6-3053-4f29-a1d5-b3b229d1ab79 | 10 | 4 | 6 harness misses | 3,132 | 7,438 | 8/10 |
| C — clean main public | 7bd6a53e-dcdc-44ae-8195-a6c885c68241 | 10 | 10 | 0 | 4,911 | 7,839 | 5/10 |

B is the preserved W115 G58 health/poll receipt, so its six miss samples are
censored by that receipt's unsafe harness decision rather than silently
reclassified as A/C-style 120-second list misses. The W115 report defines the
same requested commit-to-first-visibility over-5,000-ms count, and the raw B
receipt is unchanged.

### A — main public per-sample values

Setup room: g15-room-1676003175164cfa, SUID
063924048637332000001277563359. All reservation commits returned HTTP 200.
obs is the number of complete all-page list scans retained for that sample.

| # | Reservation | Commit SUID | Commit ms | Spacing ms | First visible epoch / commit→visible ms | Disposition | Over 5,000 | obs |
| ---: | --- | --- | ---: | ---: | --- | --- | --- | ---: |
| 1 | g15-reservation-1676003175164cfa-1 | 063924048651268000001344697783 | 3,860 | 13,861 | 1788451855231 / 2,731 | within | no | 2 |
| 2 | g15-reservation-1676003175164cfa-2 | 063924048665408000000017964345 | 4,168 | 14,168 | — / —; missing after 121,204 ms | missing | yes | 80 |
| 3 | g15-reservation-1676003175164cfa-3 | 063924048790343000000430914524 | 4,015 | 125,223 | 1788452013745 / 21,854 | over | yes | 15 |
| 4 | g15-reservation-1676003175164cfa-4 | 063924048816346000000774722646 | 3,894 | 25,753 | 1788452025089 / 7,445 | over | yes | 5 |
| 5 | g15-reservation-1676003175164cfa-5 | 063924048830230000000235198165 | 3,610 | 13,612 | 1788452036954 / 5,698 | over | yes | 4 |
| 6 | g15-reservation-1676003175164cfa-6 | 063924048844451000001013209121 | 4,085 | 14,087 | 1788452048536 / 3,193 | within | no | 4 |
| 7 | g15-reservation-1676003175164cfa-7 | 063924048858147000001359739491 | 4,940 | 14,942 | — / —; missing after 120,528 ms | missing | yes | 77 |
| 8 | g15-reservation-1676003175164cfa-8 | 063924048983244000001078165047 | 3,784 | 124,320 | — / —; missing after 120,455 ms | missing | yes | 77 |
| 9 | g15-reservation-1676003175164cfa-9 | 063924049107840000001972870540 | 4,838 | 125,304 | — / —; missing after 120,141 ms | missing | yes | 79 |
| 10 | g15-reservation-1676003175164cfa-10 | 063924049232587000000681246002 | 3,971 | 124,124 | — / —; missing after 120,282 ms | missing | yes | 81 |

### B — reused G58 W115 per-sample values

B used the preserved W115 run and raw receipt without rewriting it. Its
harness disposition is shown verbatim. The six misses have no first-visibility
value; the raw receipt records their five-second decision-bound timestamps.

| # | Reservation | Commit SUID | Commit response ms | Spacing ms | First visible epoch / commit→visible ms | Harness disposition | Over 5,000 |
| ---: | --- | --- | ---: | ---: | --- | --- | --- |
| 1 | g58-reservation-e038aee6-305-1 | 063924047188111000000120870582 | 4,178 | 14,178 | 1788450392218 / 3,125 | pass | no |
| 2 | g58-reservation-e038aee6-305-2 | 063924047201985000001191970427 | 3,917 | 13,918 | 1788450410449 / 7,438 | pass | yes |
| 3 | g58-reservation-e038aee6-305-3 | 063924047215687000001432855132 | 4,287 | 14,289 | 1788450420432 / 3,132 | pass | no |
| 4 | g58-reservation-e038aee6-305-4 | 063924047229987000000478411011 | 3,678 | 13,680 | 1788450437213 / 6,233 | pass | yes |
| 5 | g58-reservation-e038aee6-305-5 | 063924047243484000000123629886 | 4,022 | 14,025 | — / —; harness miss | miss | yes |
| 6 | g58-reservation-e038aee6-305-6 | 063924047257426000001476844191 | 5,533 | 15,533 | — / —; harness miss | miss | yes |
| 7 | g58-reservation-e038aee6-305-7 | 063924047272880000000560394951 | 3,766 | 13,766 | — / —; harness miss | miss | yes |
| 8 | g58-reservation-e038aee6-305-8 | 063924047286677000001602897605 | 3,797 | 13,798 | — / —; harness miss | miss | yes |
| 9 | g58-reservation-e038aee6-305-9 | 063924047300719000000656602468 | 10,452 | 20,453 | — / —; harness miss | miss | yes |
| 10 | g58-reservation-e038aee6-305-10 | 063924047321183000001665199681 | 5,031 | 15,032 | — / —; harness miss | miss | yes |

### C — clean main public per-sample values

Setup room: g15-room-7bd6a53edcdc44ae, SUID
063924050148814000001311352323. All reservation commits returned HTTP 200;
all ten IDs became present in the fully paged public list.

| # | Reservation | Commit SUID | Commit ms | Spacing ms | First visible epoch / commit→visible ms | Disposition | Over 5,000 | obs |
| ---: | --- | --- | ---: | ---: | --- | --- | --- | ---: |
| 1 | g15-reservation-7bd6a53edcdc44ae-1 | 063924050161893000001050985788 | 3,147 | 13,149 | 1788453366890 / 4,243 | within | no | 5 |
| 2 | g15-reservation-7bd6a53edcdc44ae-2 | 063924050176655000001016110720 | 5,073 | 15,073 | 1788453381523 / 3,803 | within | no | 2 |
| 3 | g15-reservation-7bd6a53edcdc44ae-3 | 063924050191373000001991141912 | 4,717 | 14,719 | 1788453399814 / 7,375 | over | yes | 3 |
| 4 | g15-reservation-7bd6a53edcdc44ae-4 | 063924050204363000000882649249 | 2,943 | 12,945 | 1788453410231 / 4,847 | within | no | 2 |
| 5 | g15-reservation-7bd6a53edcdc44ae-5 | 063924050218693000000007025473 | 4,946 | 14,947 | 1788453428170 / 7,839 | over | yes | 3 |
| 6 | g15-reservation-7bd6a53edcdc44ae-6 | 063924050233028000000601035031 | 4,233 | 14,234 | 1788453439705 / 5,140 | over | yes | 2 |
| 7 | g15-reservation-7bd6a53edcdc44ae-7 | 063924050247422000001022177849 | 3,637 | 13,638 | 1788453452824 / 4,621 | within | no | 3 |
| 8 | g15-reservation-7bd6a53edcdc44ae-8 | 063924050262339000001806481506 | 5,307 | 15,308 | 1788453468422 / 4,911 | within | no | 2 |
| 9 | g15-reservation-7bd6a53edcdc44ae-9 | 063924050276274000000936676801 | 3,826 | 13,828 | 1788453485030 / 7,691 | over | yes | 3 |
| 10 | g15-reservation-7bd6a53edcdc44ae-10 | 063924050289760000000088044272 | 3,449 | 13,451 | 1788453495797 / 5,007 | over | yes | 2 |

## Evidence files and preservation

- A raw public receipt: [.artifacts/sdt-g58-w116-main-public-cohort.json](.artifacts/sdt-g58-w116-main-public-cohort.json), run 16760031-7516-4cfa-b159-111d0193d527.
- Reused B raw receipt: [.artifacts/sdt-g58-w115-g58-cohort.json](.artifacts/sdt-g58-w115-g58-cohort.json), run e038aee6-3053-4f29-a1d5-b3b229d1ab79; it remains unchanged.
- C raw public receipt: [.artifacts/sdt-g58-w116-clean-main-public-cohort.json](.artifacts/sdt-g58-w116-clean-main-public-cohort.json), run 7bd6a53e-dcdc-44ae-8195-a6c885c68241.
- C reset receipt and before/after inventories: [.artifacts/sdt-g58-w116-clean-main-reset.json](.artifacts/sdt-g58-w116-clean-main-reset.json) and [.artifacts/sdt-g58-w116-clean-main-precounts.json](.artifacts/sdt-g58-w116-clean-main-precounts.json).
- A pre-count receipt: [.artifacts/sdt-g58-w116-main-precounts.json](.artifacts/sdt-g58-w116-main-precounts.json).

Existing W112/W114/W115 evidence and G58 head 8d889cfe2e550930a14a7c30c33d80b4b0759344 were preserved. Generated receipt drift is not hidden: the W115 B raw document retains its harness-level status: failed while its four observed and six censored sample facts are reported from the unchanged raw values; the C raw document conservatively leaves its generic full-cohort-percentile field as “censored; not claimed” even though all ten C samples were visible, so this report states the valid all-ten p50/p95 separately. No product source, test/config source, 5,000 ms constant, SafeWindow bounds, outbox/Queue/global admission path, issue, PR, worker state, G56, or G60 draft state was changed.
