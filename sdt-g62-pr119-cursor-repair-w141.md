# SDT-G62 PR119 cursor repair — W141

Task: `SDT-G62-PR119-CURSOR-REPAIR-W141`
PR: [J-Tech-Japan/sekiban-dcb-ts#119](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/119)
Issue: [#116](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/116)
Starting branch/head: `claude/sdt-g62-local-ac1-ac3-w132` / `44f98e22652c42db06b77a01f02f201293e506e4`

## Review finding and bounded repair

W140 review [5109479654](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/119#pullrequestreview-5109479654) found that `DownstreamAdapter.sourceAcknowledgementOptions` used service-level `coverage(serviceId, arrivedAt)` and did not prove that the delivered `(serviceId, tag, obligationSequence)` belonged to the successful snapshot cursor. The repair adds `GlobalCompletenessReconciler.coverageForObligation(...)`, which parses the persisted `sdt-g58-settled-frontier/v1` cursor and returns `BLOCK/UNSETTLED` unless the exact tag snapshot upper bound includes the delivery's local obligation sequence. The existing service-level health API remains unchanged for health consumers; the downstream view gate now consumes the precise obligation-aware proof.

No G44 test, 5,000 ms contract, SafeWindow, outbox, Queue, global-D1 admission, ordering, fence, G53/G55/G58/G60/G61 surface, or Cloudflare resource was changed.

## Soundness argument

The proof domain is the immutable source-partition vector captured at the start of a reconciliation pass. The pass walks every captured partition from local sequence 1 through its captured upper bound, checks the exact source page bounds and contiguity, and joins each obligation to its exact global receipt before persisting the cursor and derived frontier. A partition or obligation arriving after that snapshot is outside the cursor and remains unproven until a later pass includes its exact `(serviceId, tag, obligationSequence)`. Therefore a service-level `HEALTHY` bit cannot admit B after an A-only pass. Conversely, a gap, changed page bound, or removed start partition prevents the cursor from settling, so no safe head can cross an unproven in-scope gap. The frontier is never taken from a materialized-view head.

## Local red/green evidence

The AC1 guard's exact `origin/main` pre-fix receipt is `test/fixtures/g62-ac1-real-red-before-green.json`, schema `sdt-g62-w141-ac1-real-red-receipt/v1`, status `red-before-green`, and exit code 1. It uses real Tag commits, source registry rows, outbox acknowledgement handoffs, and D1 global receipts. The three committed stream SUIDs are:

- `062135596802001000000000000001`
- `062135596802002000000000000002`
- `062135596802003000000000000003`

The retained baseline frontier is `062135596801000000061937829279`. Each of the three origin/main passes recorded `UNKNOWN` / `BLOCK/UNSETTLED`, reason `source_partition_set_changed_during_scan`, and that same retained frontier. This is the preserved red-before-green reproduction of the old discard-the-whole-pass behavior against real obligations.

The repaired green receipt is `test/fixtures/g62-w141-ac1-ac3-green.json` (3 focused tests passed). The AC2 integration sequence is real A-only proof → committed/registered B with a persisted global receipt → B blocked before view application because B is absent from the cursor → later scan including B → B applied. The mutant receipt `test/fixtures/g62-w141-mutants-red.json` records exit code 1 for all required mutations:

| mutant | expected red reason |
| --- | --- |
| restore discard-the-whole-pass | `source_partition_set_changed_during_scan` |
| remove start-partition contiguity check | `source_page_sequence_outside_snapshot` |
| omit delivery cursor-membership check | `obligation_not_in_settled_cursor` |

The historical W132 fixture `test/fixtures/g62-ac3-green.json` and `test/fixtures/g62-ac3-mutants-red.json` were restored unchanged. The unchanged G44 suite remains green.

## Local gates

Focused command:

```text
./node_modules/.bin/vitest run --config vitest.config.ts --no-cache --maxWorkers=1 test/g62-global-completeness.spec.ts
```

Result: 3/3 tests passed.

The following all exited 0 without weakened assertions or inflated timeouts:

```text
npm run test:g41
npm run test:g44
npm run test:g49
npm run test:g51
npm run test:g52
npm run test:g53
npm run test:g54
npm run test:g55
npm run test:g58
npm run test:g62
npm run typecheck
npm run lint -- --max-warnings=0
git diff --check
```

`test:g44` reported 8/8 tests and four production mutants red. `test:g62` reported the three focused green oracles and all three required mutants red. G41 printed existing Durable Object teardown warnings while still exiting 0; they are not W141 failures. Running G58 rewrote four generated receipts incidentally; those files were restored and are not staged.

## Deployment and fresh proof

The repair commit `05d9d27cf77dda090da36bfb46e578a8e5841120` was pushed before the one authorized deployment. The exact source was deployed once to the existing Worker `sekiban-dcb-meeting-room-cloudflare-only` with `samples/meeting-room/wrangler.cloudflare-only.jsonc`; no `--keep-vars` and no resource creation were used. Wrangler returned version `d414765c-3303-42b5-8da2-b38889b4ecdc`, deployment timestamp `2026-09-04T06:00:30.343Z`, and 100% traffic. The source annotation/message was:

`SDT-G62 W141 exact 05d9d27cf77dda090da36bfb46e578a8e5841120`

The verified existing bindings were pipeline D1 `f26d1299-82d9-4a64-8647-bc2ec86326ac`, MV D1 `b416b212-4d09-413c-9b8d-7660e475772f`, Queue `sekiban-dcb-meeting-room-cloudflare-outbox`, and DLQ `sekiban-dcb-meeting-room-cloudflare-outbox-dlq`. WAKE-115 process hygiene reported `CLOUDFLARE_API_TOKEN=UNSET`, `CF_API_TOKEN=UNSET`, `CLOUDFLARE_API_KEY=UNSET`, `CF_API_KEY=UNSET`, `WRANGLER_API_TOKEN=UNSET`, and `G50_OBSERVABILITY_TOKEN_FILE=UNSET`. The conformance credential was supplied only by the existing path `/private/tmp/sdt-g62-w139-conformance-token`; its value is not in this artifact or the raw receipt.

One fresh cold-first public paced cohort completed under run ID `3a90eb55-ef97-4de9-822f-bfdc8d70755a` from `2026-09-04T06:01:11.299Z` through `2026-09-04T06:04:07.093Z`. It used 10 reservations, `paceMs=10000`, the fully paged W116 `/api/read/reservations` instrument, and a minimum observed pacing interval of 11,660 ms. The raw receipt was persisted incrementally at `.artifacts/sdt-g62-w141-ac4-paced-cohort.json`.

Safe convergence passed the unchanged 180,000 ms bound with `safeWindowMs=20000`: n=10, p50=75,281 ms, p95=114,811 ms, max=114,811 ms, and 0/10 over 180,000 ms. Unsafe visibility remains SDT-G60 evidence only: strict 5,000 ms disposition was 10 misses, 0 passes, and 0 censored rows. Eventual public-visibility values are included per sample.

| # | reservation ID / SUID | commit response ms | pace ms | eventual unsafe ms | safe ms |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | g58-reservation-3a90eb55-ef9-1 / 063924098486039000000753418212 | 1,981 | 11,982 | 112,944 | 114,811 |
| 2 | g58-reservation-3a90eb55-ef9-2 / 063924098498185000001135073243 | 2,053 | 12,053 | 101,053 | 102,758 |
| 3 | g58-reservation-3a90eb55-ef9-3 / 063924098510221000000663480972 | 1,969 | 11,971 | 89,236 | 90,787 |
| 4 | g58-reservation-3a90eb55-ef9-4 / 063924098522319000001577686232 | 2,229 | 12,230 | 77,141 | 78,557 |
| 5 | g58-reservation-3a90eb55-ef9-5 / 063924098534313000000444420102 | 1,808 | 11,810 | 65,508 | 66,747 |
| 6 | g58-reservation-3a90eb55-ef9-6 / 063924098546071000001100363589 | 1,776 | 11,777 | 53,922 | 54,970 |
| 7 | g58-reservation-3a90eb55-ef9-7 / 063924098557973000000738342377 | 1,876 | 11,878 | 86,085 | 86,941 |
| 8 | g58-reservation-3a90eb55-ef9-8 / 063924098569629000000674102005 | 1,658 | 11,660 | 74,556 | 75,281 |
| 9 | g58-reservation-3a90eb55-ef9-9 / 063924098581534000001118550270 | 1,948 | 11,949 | 62,806 | 63,332 |
| 10 | g58-reservation-3a90eb55-ef9-10 / 063924098593396000000557418223 | 1,960 | 11,961 | 51,040 | 51,371 |

The raw receipt contains 50 health snapshots and 501 cumulative persisted coverage-history rows. The new cohort's persisted ticks were all `SETTLED`, with null reason and partitionTag:

| persisted tick | frontier SUID | RoomProjector MV safe head | ReservationProjector MV safe head |
| --- | --- | --- | --- |
| `scheduled:1788501691054` | 063924098486039000000753418212 | 063924098474171000001652831636 | 063924091551674000000134649594 |
| `scheduled:1788501724859` | 063924098522319000001577686232 | 063924098474171000001652831636 | 063924098474171000001652831636 |
| `scheduled:1788501775628` | 063924098569629000000674102005 | 063924098546071000001100363589 | 063924098546071000001100363589 |
| `scheduled:1788501835226` | 063924098593396000000557418223 | 063924098546071000001100363589 | 063924098546071000001100363589 |

The final health response at `2026-09-04T06:04:05.269Z` was `SETTLED`, with global/frontier SUID `063924098593396000000557418223`; both RoomProjector and ReservationProjector materialized safe heads equaled that final cohort SUID. The raw receipt records live projector telemetry as observation-only; live head convergence and committed tag-state convergence remain SDT-G61 and were not used as a G62 gate.

## Scope and preserved evidence

The W139 deployed cohort and its token-path evidence remain preserved and are not reused as W141 proof. No new Cloudflare resource is authorized. Wrangler invocations, if reached, will strip `CLOUDFLARE_API_TOKEN`, `CF_API_TOKEN`, `CLOUDFLARE_API_KEY`, `CF_API_KEY`, and `WRANGLER_API_TOKEN`; credential reporting will contain names/set-state only and tokens will be referenced by path only. G56, G60, and G61 remain outside this continuation.
