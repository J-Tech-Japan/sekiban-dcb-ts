# SDT-G62 conformance resume W139

Task: SDT-G62-CONFORMANCE-RESUME-W139

Status: completed.

## Source and deployment

- Branch: claude/sdt-g62-local-ac1-ac3-w132
- Rebased W132 code checkpoint: 91687143076f2a1e5d36238bf5c0441d5011afe9
- Rebase base: origin/main 0730ada95757c0d01b329d41f5b01e296dbf4f70
- Existing Worker: sekiban-dcb-meeting-room-cloudflare-only
- Existing D1s: pipeline f26d1299-82d9-4a64-8647-bc2ec86326ac; MV b416b212-4d09-413c-9b8d-7660e475772f
- Existing Queue/DLQ: sekiban-dcb-meeting-room-cloudflare-outbox / sekiban-dcb-meeting-room-cloudflare-outbox-dlq
- No resource creation, migration, queue, outbox, global-D1 admission, G58, G60, G56, or G61 change.

W139 first listed the existing secret names. A fresh token was generated outside git at /private/tmp/sdt-g62-w139-conformance-token with mode 600, referenced through G53_CONFORMANCE_TOKEN_FILE, and installed once with CONFORMANCE_TOKEN. The value was never printed or committed. Secret publication created version c76918a2-93a8-4550-afd7-7881af7db370 without the exact source annotation. One unchanged-head normal-config redeploy then produced version ad4b72b3-c93c-445a-a512-d2def37f6d66, deployment 914b60c0-dfce-42f6-a0b2-5b48f5cdcac6, 100% traffic, and annotation:

SDT-G62 W139 exact 91687143076f2a1e5d36238bf5c0441d5011afe9

The earlier W138 deployment was version 3635c594-a9ba-4d6b-9621-0443593ae66b, deployment f4c5dfc4-ea66-4ef6-b443-6b14acddd150, and remains preserved. Raw version/traffic and command receipts are in .artifacts/sdt-g62-w139-operations.json and the secret result is in .artifacts/sdt-g62-w139-secret-put.json.

## AC4 deployed cohort

The one actual cohort was run cold-first with 10 reservations paced at least 10 seconds after the preceding commit response:

G53_CONFORMANCE_TOKEN_FILE=/private/tmp/sdt-g62-w139-conformance-token node scripts/deploy/g58-safe-lane-e2e.mjs --base-url https://sekiban-dcb-meeting-room-cloudflare-only.ttakaoka.workers.dev --service-id sekiban-dcb-meeting-room-cloudflare-only --mode paced --paced-count 10 --pace-ms 10000 --poll-ms 2000 --continue-after-unsafe --report .artifacts/sdt-g62-w139-ac4-paced-cohort.json

Run ID: 6aa8ff17-0b22-4b35-b763-ad3d2eb99de9; started 2026-09-04T04:03:43.267Z; finished 2026-09-04T04:06:35.187Z. Pace intervals were all at least 10,000 ms; minimum 11,794 ms. SafeWindow was 20,000 ms and the acceptance bound was 180,000 ms.

Safe result: n=10, p50=77,624 ms, p95=114,766 ms, maximum=114,766 ms, 0/10 over 180,000 ms.

| # | reservation / SUID | commit UTC | pace ms | first public visibility ms | unsafe disposition | strict >5,000 | safe UTC | commit-to-safe ms | MV safe head |
| ---: | --- | --- | ---: | ---: | --- | --- | --- | ---: | --- |
| 1 | g58-reservation-6aa8ff17-0b2-1 / 063924091440762000000482046285 | 04:04:01.345Z | 12,329 | 5,232 | pass | yes | 04:05:56.111Z | 114,766 | 063924091491148000000203472186 |
| 2 | g58-reservation-6aa8ff17-0b2-2 / 063924091452791000001009144541 | 04:04:13.349Z | 12,004 | 2,968 | pass | no | 04:05:56.111Z | 102,762 | 063924091491148000000203472186 |
| 3 | g58-reservation-6aa8ff17-0b2-3 / 063924091464903000000256695932 | 04:04:25.547Z | 12,198 | 89,858 eventual | miss | yes | 04:05:56.111Z | 90,564 | 063924091491148000000203472186 |
| 4 | g58-reservation-6aa8ff17-0b2-4 / 063924091477632000002082963033 | 04:04:38.487Z | 12,940 | 3,880 | pass | no | 04:05:56.111Z | 77,624 | 063924091491148000000203472186 |
| 5 | g58-reservation-6aa8ff17-0b2-5 / 063924091491148000000203472186 | 04:04:51.841Z | 13,354 | 5,272 | pass | yes | 04:05:56.111Z | 64,270 | 063924091491148000000203472186 |
| 6 | g58-reservation-6aa8ff17-0b2-6 / 063924091503500000001688264844 | 04:05:03.971Z | 12,130 | 3,094 | pass | no | 04:06:31.235Z | 87,264 | 063924091503500000001688264844 |
| 7 | g58-reservation-6aa8ff17-0b2-7 / 063924091515331000001399753513 | 04:05:15.852Z | 11,881 | 39,777 eventual | miss | yes | 04:06:33.708Z | 77,856 | 063924091551674000000134649594 |
| 8 | g58-reservation-6aa8ff17-0b2-8 / 063924091527162000000452286746 | 04:05:27.646Z | 11,794 | 3,267 | pass | no | 04:06:33.708Z | 66,062 | 063924091551674000000134649594 |
| 9 | g58-reservation-6aa8ff17-0b2-9 / 063924091539395000000230031794 | 04:05:39.988Z | 12,342 | 5,328 | pass | yes | 04:06:33.708Z | 53,720 | 063924091551674000000134649594 |
| 10 | g58-reservation-6aa8ff17-0b2-10 / 063924091551674000000134649594 | 04:05:52.165Z | 12,177 | 3,002 | pass | no | 04:06:33.708Z | 41,543 | 063924091551674000000134649594 |

Unsafe is evidence-only for SDT-G60. The harness recorded 8 pass/2 miss and 0 censored; strict actual first-public visibility, using eventual visibility for the misses, is 5/10 over 5,000 ms. Rows 1, 2, 3, and 6 were over safeWindowMs + 60 seconds (80,000 ms), each with persisted attribution follow_stopping_at_unsafe_event: scheduled coverage advanced but the safe head remained below the target. None exceeded the 180-second safe bound.

## AC4 persisted coverage/tick evidence

The raw receipt has 383 historical coverage rows and four current-run tick rows:

| tick identity | observedAt UTC | kind | reason | partitionTag | proven frontier | Room MV safe head | Reservation MV safe head |
| --- | --- | --- | --- | --- | --- | --- | --- |
| scheduled:1788494580497 | 04:03:00.497Z | SETTLED | null | null | 063924068819782000000708940540 | 063924068819782000000708940540 | 063924068819782000000708940540 |
| scheduled:1788494640568 | 04:04:00.568Z | SETTLED | null | null | 063924091428117000001182905325 | 063924091428117000001182905325 | 063924091428117000001182905325 |
| scheduled:1788494701989 | 04:05:01.989Z | SETTLED | null | null | 063924091491148000000203472186 | 063924091491148000000203472186 | 063924091491148000000203472186 |
| scheduled:1788494763795 | 04:06:03.795Z | SETTLED | null | null | 063924091551674000000134649594 | 063924091551674000000134649594 | 063924091551674000000134649594 |

All four lifecycle groups reported allRegisteredProjectorsObserved=true. Per-group attempt telemetry:

| tick | RoomProjector | ReservationProjector |
| --- | --- | --- |
| scheduled:1788494580497 | lastPollAt 1788494595662, invoked-but-no-work | lastPollAt 1788494595662, invoked-but-no-work |
| scheduled:1788494640568 | lastPollAt 1788494662790, advanced | lastPollAt 1788494662790, advanced |
| scheduled:1788494701989 | lastPollAt 1788494734783, advanced | lastPollAt 1788494734783, advanced |
| scheduled:1788494763795 | lastPollAt 1788494734783, advanced | lastPollAt 1788494734783, advanced |

The final health snapshot had both MV safe heads at final cohort SUID 063924091551674000000134649594. Live heads remained 063924091503500000001688264844 with lastPollAt 1788494734783; this is recorded only because projector head advancement belongs to SDT-G61.

## Gates and handoff

Post-rebase local gates all passed before deployment: npm run test:g41, test:g44, test:g49, test:g51, test:g52, test:g53, test:g54, test:g55, test:g58, test:g62, npm run typecheck, npm run lint, and git diff --check. G44 was unchanged and green; W132 AC1/AC3 green and red-mutant receipts remain preserved. Generated G58/G62 receipt drift from reruns was restored to the committed W132 versions.

WAKE-115 credential hygiene: CLOUDFLARE_API_TOKEN=UNSET, CF_API_TOKEN=UNSET, CLOUDFLARE_API_KEY=UNSET, CF_API_KEY=UNSET, and WRANGLER_API_TOKEN=UNSET. G50_OBSERVABILITY_TOKEN_FILE=UNSET and no observability credential was used. No secret value is present in any evidence file.

PR and CI: pending the GitHub handoff; the exact final PR head, PR number, CI state, and canonical worker transition will be appended here after push and PR creation. G56 and G61 were not started.
