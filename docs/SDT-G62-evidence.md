# SDT-G62 local AC1–AC3 evidence

## AC2 soundness argument (written before implementation)

At the start of each reconciliation pass, the reconciler snapshots the source-partition set and each partition's upper-bound obligation sequence. It walks exactly those snapshots, enforcing the local sequence from 1 through that bound and joining every obligation to the exact global receipt. A partition registered after the snapshot is not in the pass's proof domain; therefore it is absent from that pass's cursor and will be scanned on the next pass. Its arrival cannot invalidate the completed proof for the start-of-pass set. Conversely, an existing in-scope partition whose page changes, has a missing or duplicate sequence, or is removed cannot satisfy the snapshot, page, and contiguity checks; the pass remains non-settled and no safe head may cross that gap. The frontier is therefore only the maximum SUID of receipts proven for the start-of-pass snapshots.

 W132 implementation and gate results are recorded in the task artifact:
`.g62-w132/sdt-g62-local-ac1-ac3-w132.md`.

## W139 deployed AC4–AC7 completion

W139 resumes the preserved W138 deployment after WAKE-96 classified the HTTP 403 body from /conformance/v1/read-health as the Worker's own conformance-handler response. A fresh mode-600 token was generated outside git at /private/tmp/sdt-g62-w139-conformance-token, referenced through G53_CONFORMANCE_TOKEN_FILE, and installed once as CONFORMANCE_TOKEN. The token value was never printed, persisted in an artifact, or committed.

### Exact source, existing resources, and deployment identity

- Branch: claude/sdt-g62-local-ac1-ac3-w132
- Rebased source/code checkpoint: 91687143076f2a1e5d36238bf5c0441d5011afe9
- Base after rebase: origin/main 0730ada95757c0d01b329d41f5b01e296dbf4f70
- Worker: sekiban-dcb-meeting-room-cloudflare-only
- Pipeline D1: f26d1299-82d9-4a64-8647-bc2ec86326ac
- MV D1: b416b212-4d09-413c-9b8d-7660e475772f
- Queue/DLQ: sekiban-dcb-meeting-room-cloudflare-outbox / sekiban-dcb-meeting-room-cloudflare-outbox-dlq

The initial W138 deployment was version 3635c594-a9ba-4d6b-9621-0443593ae66b, deployment f4c5dfc4-ea66-4ef6-b443-6b14acddd150, with 100% traffic and annotation SDT-G62 W138 exact 91687143076f2a1e5d36238bf5c0441d5011afe9. Secret installation published version c76918a2-93a8-4550-afd7-7881af7db370 (secret-triggered, 100%) without the exact source annotation. Per W139, one unchanged-head normal-config redeploy then published version ad4b72b3-c93c-445a-a512-d2def37f6d66, deployment 914b60c0-dfce-42f6-a0b2-5b48f5cdcac6, with 100% traffic and exact annotation:

SDT-G62 W139 exact 91687143076f2a1e5d36238bf5c0441d5011afe9

No resource was created and no migration, queue, outbox, global-D1 admission, G58, G60, G56, or G61 behavior was changed.

### AC4 fresh paced cohort

The one actual cohort ran with the cold first sample and the path-only G53_CONFORMANCE_TOKEN_FILE reference:

    G53_CONFORMANCE_TOKEN_FILE=/private/tmp/sdt-g62-w139-conformance-token node scripts/deploy/g58-safe-lane-e2e.mjs --base-url https://sekiban-dcb-meeting-room-cloudflare-only.ttakaoka.workers.dev --service-id sekiban-dcb-meeting-room-cloudflare-only --mode paced --paced-count 10 --pace-ms 10000 --poll-ms 2000 --continue-after-unsafe --report .artifacts/sdt-g62-w139-ac4-paced-cohort.json

Run 6aa8ff17-0b22-4b35-b763-ad3d2eb99de9 ran from 2026-09-04T04:03:43.267Z through 2026-09-04T04:06:35.187Z. All ten pacing intervals, including the setup-to-first-commit interval, were at least 10,000 ms; the minimum was 11,794 ms. The unchanged safe window was 20,000 ms and the unchanged safe acceptance bound was 180,000 ms.

Safe convergence: n=10, p50=77,624 ms, p95=114,766 ms, max=114,766 ms, 0 over 180,000 ms.

| # | reservation / SUID | commit received (UTC) | pace ms | first public visibility ms | unsafe disposition | strict >5,000 ms | safe reached (UTC) | commit-to-safe ms | MV safe head |
| ---: | --- | --- | ---: | ---: | --- | --- | --- | ---: | --- |
| 1 | g58-reservation-6aa8ff17-0b2-1 / 063924091440762000000482046285 | 04:04:01.345Z | 12,329 | 5,232 | pass | yes | 04:05:56.111Z | 114,766 | 063924091491148000000203472186 |
| 2 | g58-reservation-6aa8ff17-0b2-2 / 063924091452791000001009144541 | 04:04:13.349Z | 12,004 | 2,968 | pass | no | 04:05:56.111Z | 102,762 | 063924091491148000000203472186 |
| 3 | g58-reservation-6aa8ff17-0b2-3 / 063924091464903000000256695932 | 04:04:25.547Z | 12,198 | 89,858 (eventual) | miss | yes | 04:05:56.111Z | 90,564 | 063924091491148000000203472186 |
| 4 | g58-reservation-6aa8ff17-0b2-4 / 063924091477632000002082963033 | 04:04:38.487Z | 12,940 | 3,880 | pass | no | 04:05:56.111Z | 77,624 | 063924091491148000000203472186 |
| 5 | g58-reservation-6aa8ff17-0b2-5 / 063924091491148000000203472186 | 04:04:51.841Z | 13,354 | 5,272 | pass | yes | 04:05:56.111Z | 64,270 | 063924091491148000000203472186 |
| 6 | g58-reservation-6aa8ff17-0b2-6 / 063924091503500000001688264844 | 04:05:03.971Z | 12,130 | 3,094 | pass | no | 04:06:31.235Z | 87,264 | 063924091503500000001688264844 |
| 7 | g58-reservation-6aa8ff17-0b2-7 / 063924091515331000001399753513 | 04:05:15.852Z | 11,881 | 39,777 (eventual) | miss | yes | 04:06:33.708Z | 77,856 | 063924091551674000000134649594 |
| 8 | g58-reservation-6aa8ff17-0b2-8 / 063924091527162000000452286746 | 04:05:27.646Z | 11,794 | 3,267 | pass | no | 04:06:33.708Z | 66,062 | 063924091551674000000134649594 |
| 9 | g58-reservation-6aa8ff17-0b2-9 / 063924091539395000000230031794 | 04:05:39.988Z | 12,342 | 5,328 | pass | yes | 04:06:33.708Z | 53,720 | 063924091551674000000134649594 |
| 10 | g58-reservation-6aa8ff17-0b2-10 / 063924091551674000000134649594 | 04:05:52.165Z | 12,177 | 3,002 | pass | no | 04:06:33.708Z | 41,543 | 063924091551674000000134649594 |

Unsafe visibility is recorded only for SDT-G60. The harness disposition was 8 pass/2 miss with no censored rows; applying the strict actual first-public-visible time (using eventual visibility for the two misses) gives 5/10 over 5,000 ms. This is not a G62 pass/fail gate. Rows 1, 2, 3, and 6 exceeded the 80,000 ms safeWindowMs + 60 s diagnostic threshold; the persisted harness attribution for each was follow_stopping_at_unsafe_event with reason scheduled coverage advanced but the safe head remained below the target. No sample exceeded the 180-second safe bound.

### AC4 per-tick persisted coverage and safe heads

The receipt contains 383 historical coverage rows; the four rows below are the current run's persisted tick identities from the initial health observation through completion. reason and partitionTag were null on every current-run row. The first row is the baseline tick before the first reservation commit.

| tick identity | observedAt UTC | coverage kind / reason | partitionTag | proven frontier | Room MV safe head | Reservation MV safe head |
| --- | --- | --- | --- | --- | --- | --- |
| scheduled:1788494580497 | 04:03:00.497Z | SETTLED / null | null | 063924068819782000000708940540 | 063924068819782000000708940540 | 063924068819782000000708940540 |
| scheduled:1788494640568 | 04:04:00.568Z | SETTLED / null | null | 063924091428117000001182905325 | 063924091428117000001182905325 | 063924091428117000001182905325 |
| scheduled:1788494701989 | 04:05:01.989Z | SETTLED / null | null | 063924091491148000000203472186 | 063924091491148000000203472186 | 063924091491148000000203472186 |
| scheduled:1788494763795 | 04:06:03.795Z | SETTLED / null | null | 063924091551674000000134649594 | 063924091551674000000134649594 | 063924091551674000000134649594 |

For all four lifecycle groups, allRegisteredProjectorsObserved=true. The exact per-group attempt telemetry persisted by the health receipt was:

| tick | RoomProjector attempt / outcome | ReservationProjector attempt / outcome |
| --- | --- | --- |
| scheduled:1788494580497 | lastPollAt=1788494595662, invoked-but-no-work | lastPollAt=1788494595662, invoked-but-no-work |
| scheduled:1788494640568 | lastPollAt=1788494662790, advanced | lastPollAt=1788494662790, advanced |
| scheduled:1788494701989 | lastPollAt=1788494734783, advanced | lastPollAt=1788494734783, advanced |
| scheduled:1788494763795 | lastPollAt=1788494734783, advanced | lastPollAt=1788494734783, advanced |

The final health snapshot recorded both MV safe heads at the cohort final SUID 063924091551674000000134649594. The live projector heads remained at 063924091503500000001688264844 with lastPollAt=1788494734783; this is recorded-only because projector head advancement belongs to SDT-G61 and is not asserted by G62.

### AC5 and local gate preservation

The W132 AC1–AC3 implementation and red-capable receipts remain preserved. Post-rebase local verification passed without changing G44:

- npm run test:g41
- npm run test:g44 (8 G44 tests and four production mutants red)
- npm run test:g49
- npm run test:g51
- npm run test:g52
- npm run test:g53
- npm run test:g54
- npm run test:g55
- npm run test:g58
- npm run test:g62 (AC1/AC3 green, discard-whole-pass and sequence-gap mutants red)
- npm run typecheck
- npm run lint -- --max-warnings=0 (the package script already enforces --max-warnings=0)
- git diff --check

The current-run receipt independently records four coverage lifecycle groups and attempt telemetry for both registered projectors. No G61 projector-head convergence or G60 unsafe contract was used as a G62 gate.

### AC6 evidence and AC7 handoff

This document now contains the AC2-style deployed timing table, all current-run coverage/frontier/safe-head ticks, unsafe-only observations, and the W139 deployment identity. The raw immediately persisted cohort is .artifacts/sdt-g62-w139-ac4-paced-cohort.json; Wrangler operations and version/traffic proof are in .artifacts/sdt-g62-w139-operations.json, and the secret installation receipt is .artifacts/sdt-g62-w139-secret-put.json.

WAKE-115 credential hygiene was applied to remaining Wrangler verification: CLOUDFLARE_API_TOKEN=UNSET, CF_API_TOKEN=UNSET, CLOUDFLARE_API_KEY=UNSET, CF_API_KEY=UNSET, and WRANGLER_API_TOKEN=UNSET. G50_OBSERVABILITY_TOKEN_FILE=UNSET; no observability credential was used. The wrapper records the same five API fallback names as unset, and no secret value is present in any receipt.

The PR and canonical worker-completion result are recorded in the W139 task artifact after the GitHub handoff. G56 and G61 were not started.

## W141 cursor-aware downstream admission repair

W140 review [5109479654](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/119#pullrequestreview-5109479654) identified a proof-domain loss: `DownstreamAdapter.sourceAcknowledgementOptions` asked for service-level `coverage(serviceId, arrivedAt)` and could admit a delivery from a partition omitted by the successful start-of-pass cursor. W141 starts from exact PR head `44f98e22652c42db06b77a01f02f201293e506e4` on `claude/sdt-g62-local-ac1-ac3-w132` and changes only this admission path plus its real local oracles and guard evidence.

The reconciler now parses the persisted `sdt-g58-settled-frontier/v1` cursor and exposes `coverageForObligation(serviceId, tag, obligationSequence, nowMs)`. A `SETTLED` health status is returned to the downstream gate only when the cursor contains the exact service/tag snapshot whose upper-bound sequence covers that obligation. A healthy cursor that omits the tuple returns `BLOCK/UNSETTLED` with `obligation_not_in_settled_cursor:<tag>:<sequence>`. Existing `coverage`, G44 page/contiguity checks, start-partition-retention checks, frontier derivation, outbox, Queue, and global admission behavior are otherwise unchanged.

### Soundness and real local oracles

The proof domain is the immutable start-of-pass vector. Each successful cursor records the exact partition identity and upper-bound obligation sequence actually walked, plus the frontier derived from joined global receipts. A post-snapshot obligation B is outside that cursor even if the service health row is `HEALTHY`; its delivery therefore remains fail-closed until a later successful scan includes B's exact tuple. A later cursor containing B permits the delivery. This is a proof-domain check, not a materialized-view-head shortcut, and it preserves the G44 property that no safe head passes an unproven gap.

The AC1 oracle now performs real Tag Durable Object appends, real source-partition registration, real outbox acknowledgement handoff, and real D1 global-receipt recording. The exact current-main reproduction is preserved at `test/fixtures/g62-ac1-real-red-before-green.json`: three committed stream obligations were introduced during scans, and all three origin/main passes returned `UNKNOWN` / `BLOCK/UNSETTLED` with `source_partition_set_changed_during_scan`; the retained frontier was `062135596801000000061937829279`. The repaired oracle accepts the start snapshot while leaving the newly arrived partition for the next pass and advances through the committed SUIDs on later passes.

The AC2 integration oracle uses real committed A and B obligations. It proves A-only cursor admission, records B after that cursor, verifies B's global receipt exists but B's view is not applied while omitted, runs a later scan containing A and B, and verifies B then applies. Its red cursor-omission mutant replaces the exact obligation-aware call with the old service-level call and fails the B-block assertion. The preserved discard-whole-pass and start-partition-gap mutants remain red. Current W141 receipts are `test/fixtures/g62-w141-ac1-ac3-green.json` and `test/fixtures/g62-w141-mutants-red.json`; the latter records all three red rows with exit code 1 and expected reasons `source_partition_set_changed_during_scan`, `source_page_sequence_outside_snapshot`, and `obligation_not_in_settled_cursor`.

### W141 local verification

The focused command `./node_modules/.bin/vitest run --config vitest.config.ts --no-cache --maxWorkers=1 test/g62-global-completeness.spec.ts` passed all 3 tests. The full local protection commands passed without changing `test/g44-global-completeness.spec.ts`: `npm run test:g41`, `npm run test:g44`, `npm run test:g49`, `npm run test:g51`, `npm run test:g52`, `npm run test:g53`, `npm run test:g54`, `npm run test:g55`, `npm run test:g58`, `npm run test:g62`, `npm run typecheck`, `npm run lint -- --max-warnings=0`, and `git diff --check`. G41 emitted existing Durable Object teardown warnings while exiting 0; no gate was weakened or timeout changed. The four G58 generated receipt rewrites caused incidentally by running its guard were restored to the pinned head and are not part of W141.

The exact repaired commit `05d9d27cf77dda090da36bfb46e578a8e5841120` was pushed before deployment. No Cloudflare resource was created; W139 receipts remain historical evidence only.

### W141 existing-worker deployment and fresh cohort

The repaired code head `05d9d27cf77dda090da36bfb46e578a8e5841120` was deployed once to the existing `sekiban-dcb-meeting-room-cloudflare-only` Worker with `samples/meeting-room/wrangler.cloudflare-only.jsonc` and no `--keep-vars`. The deployment returned Worker version `d414765c-3303-42b5-8da2-b38889b4ecdc`, created `2026-09-04T06:00:30.343Z`, at 100% traffic. Its exact source annotation/message was:

`SDT-G62 W141 exact 05d9d27cf77dda090da36bfb46e578a8e5841120`

The existing bindings remained the production-shaped resources: pipeline D1 `f26d1299-82d9-4a64-8647-bc2ec86326ac`, MV D1 `b416b212-4d09-413c-9b8d-7660e475772f`, Queue `sekiban-dcb-meeting-room-cloudflare-outbox`, and DLQ `sekiban-dcb-meeting-room-cloudflare-outbox-dlq`. The deploy output showed the unchanged G32, G53/G55, SafeWindow, outbox/Queue, and projector bindings. WAKE-115 was applied to the Wrangler process: `CLOUDFLARE_API_TOKEN=UNSET`, `CF_API_TOKEN=UNSET`, `CLOUDFLARE_API_KEY=UNSET`, `CF_API_KEY=UNSET`, `WRANGLER_API_TOKEN=UNSET`; `G50_OBSERVABILITY_TOKEN_FILE=UNSET`. The conformance credential was referenced only through the existing path `/private/tmp/sdt-g62-w139-conformance-token`; its value is absent from this document and the raw receipt.

One fresh cold-first public paced cohort ran under run ID `3a90eb55-ef97-4de9-822f-bfdc8d70755a`, from `2026-09-04T06:01:11.299Z` through `2026-09-04T06:04:07.093Z`, with 10 reservations, `paceMs=10000`, and minimum observed pacing 11,660 ms. The W116 public instrument fully paged `GET /api/read/reservations` for each sample. The durable raw receipt is `.artifacts/sdt-g62-w141-ac4-paced-cohort.json` and was persisted incrementally by the harness.

Safe convergence used the unchanged 180,000 ms acceptance line and 20,000 ms SafeWindow: n=10, p50=75,281 ms, p95=114,811 ms, max=114,811 ms, and 0/10 over 180,000 ms. The 5,000 ms unsafe disposition is recorded only for SDT-G60: all 10 were misses at the strict bound, no rows were censored, and eventual first-public-visibility values are retained below.

| # | reservation ID / SUID | commit response ms | pace ms | unsafe disposition / eventual ms | safe ms | safe head |
| ---: | --- | ---: | ---: | --- | ---: | --- |
| 1 | g58-reservation-3a90eb55-ef9-1 / 063924098486039000000753418212 | 1,981 | 11,982 | miss / 112,944 | 114,811 | 063924098546071000001100363589 |
| 2 | g58-reservation-3a90eb55-ef9-2 / 063924098498185000001135073243 | 2,053 | 12,053 | miss / 101,053 | 102,758 | 063924098546071000001100363589 |
| 3 | g58-reservation-3a90eb55-ef9-3 / 063924098510221000000663480972 | 1,969 | 11,971 | miss / 89,236 | 90,787 | 063924098546071000001100363589 |
| 4 | g58-reservation-3a90eb55-ef9-4 / 063924098522319000001577686232 | 2,229 | 12,230 | miss / 77,141 | 78,557 | 063924098546071000001100363589 |
| 5 | g58-reservation-3a90eb55-ef9-5 / 063924098534313000000444420102 | 1,808 | 11,810 | miss / 65,508 | 66,747 | 063924098546071000001100363589 |
| 6 | g58-reservation-3a90eb55-ef9-6 / 063924098546071000001100363589 | 1,776 | 11,777 | miss / 53,922 | 54,970 | 063924098546071000001100363589 |
| 7 | g58-reservation-3a90eb55-ef9-7 / 063924098557973000000738342377 | 1,876 | 11,878 | miss / 86,085 | 86,941 | 063924098593396000000557418223 |
| 8 | g58-reservation-3a90eb55-ef9-8 / 063924098569629000000674102005 | 1,658 | 11,660 | miss / 74,556 | 75,281 | 063924098593396000000557418223 |
| 9 | g58-reservation-3a90eb55-ef9-9 / 063924098581534000001118550270 | 1,948 | 11,949 | miss / 62,806 | 63,332 | 063924098593396000000557418223 |
| 10 | g58-reservation-3a90eb55-ef9-10 / 063924098593396000000557418223 | 1,960 | 11,961 | miss / 51,040 | 51,371 | 063924098593396000000557418223 |

The current-run health response set contains 50 snapshots and the raw persisted coverage history contains 501 cumulative tick rows. The four new persisted scheduled ticks after the pre-cohort baseline were all `SETTLED`, with null `reason` and `partitionTag`; the table shows the exact frontier and the corresponding materialized safe heads recorded in the first health response observing each new frontier:

| persisted tick | frontier SUID | RoomProjector MV safe head | ReservationProjector MV safe head |
| --- | --- | --- | --- |
| `scheduled:1788501691054` | 063924098486039000000753418212 | 063924098474171000001652831636 | 063924091551674000000134649594 |
| `scheduled:1788501724859` | 063924098522319000001577686232 | 063924098474171000001652831636 | 063924098474171000001652831636 |
| `scheduled:1788501775628` | 063924098569629000000674102005 | 063924098546071000001100363589 | 063924098546071000001100363589 |
| `scheduled:1788501835226` | 063924098593396000000557418223 | 063924098546071000001100363589 | 063924098546071000001100363589 |

The final health response at `2026-09-04T06:04:05.269Z` was `SETTLED`, frontier/global head `063924098593396000000557418223`, and both RoomProjector and ReservationProjector materialized safe heads equaled that final cohort SUID. The raw receipt also records both live projector attempts and observed live heads; those fields were not used as a G62 gate because actual live head convergence remains SDT-G61.
