# SDT-G67 AC4 deployed rehearsal — W142

Task: `SDT-G67-AC4-REREHEARSAL-WAKE-142`  
Issue: `J-Tech-Japan/sekiban-dcb-ts#129`  
Branch: `claude/sdt-g67-local-wake-w142`  
Candidate source: `6d691275dd763bb8fb8fad1c6d2a49bd18d45d00`  
Status: **BLOCKED at the isolated W155-C arm gate**

## Decision

The true pre-G67 parent `868f2fc63bb02fb2c127e750c1d22516cc0fcff6` and the
repaired candidate `6d691275dd763bb8fb8fad1c6d2a49bd18d45d00` each completed a
fresh cold-first paced cohort of 10 accepted reservations. The candidate met
the response and unsafe relative gates and all 10 safe reads were below 180 s,
but candidate safe p95 was **117,444 ms**, above the AC4 arm target of **60,000
ms**. The arm therefore failed AC4. No production reset, deployment, or cohort
was attempted. The earlier `f5b2212` deployment and the earlier `540aab1`
receipt were not reused as baseline evidence.

## Exact sources, arm and configuration

- Parent/base: `868f2fc63bb02fb2c127e750c1d22516cc0fcff6`.
- Candidate: `6d691275dd763bb8fb8fad1c6d2a49bd18d45d00` (the requested short
  head `6d69127`).
- Worker: `sekiban-dcb-g60-w155-c`.
- Base URL: `https://sekiban-dcb-g60-w155-c.ttakaoka.workers.dev`.
- Pipeline D1: `sekiban-dcb-g60-w155-c-pipeline`,
  `ac751211-fde8-4587-9d56-1e9fd8051bc3`.
- MV D1: `sekiban-dcb-g60-w155-c-mv`,
  `2b60dbcf-0912-4bb2-93aa-77c26cd260e1`.
- Queue: `sekiban-dcb-g60-w155-c-outbox`.
- DLQ: `sekiban-dcb-g60-w155-c-outbox-dlq`.
- Both deployed version views proved `DIRECT_DOORBELL=true`,
  `DIRECT_DOORBELL_RECEIVER_MODE=self`,
  `DIRECT_DOORBELL_SELF_BINDING_PROOF=true`,
  `DIRECT_DOORBELL_DEGRADATION=queued-degraded`,
  `DIRECT_DOORBELL_MAX_INVOCATIONS=32`, and
  `DOWNSTREAM_DOORBELL=sekiban-dcb-g60-w155-c#MeetingRoomDownstreamDoorbell`.
- The existing Queue consumer readback proved script
  `sekiban-dcb-g60-w155-c`, DLQ `sekiban-dcb-g60-w155-c-outbox-dlq`, batch
  size 10, max retries 3, and max wait 1000 ms.
- No Cloudflare resource was created or deleted. Only the existing W155-C
  Worker and its existing D1 pair were used.

The parent was deployed from a detached local worktree checked out at the
exact parent SHA. The parent version was
`c8354d46-53d6-4d33-95f8-371328793178`; its deployment message carried the
exact parent SHA and its version view proved the bindings above. The candidate
version was `cf3aa08a-50bc-4c43-ad95-ea1a44f15f6b`; its deployment message and
version view carried the exact candidate SHA and the same bindings. The
candidate deployment was 100% active in the deployment readback.

The candidate-only migration `0011_g67_safe_lane_passes.sql` was applied to
the existing pipeline D1 successfully. A subsequent `d1 migrations list` with
the candidate config returned `No migrations to apply`, confirming the local
migration set, including 0011, is applied. The parent preflight had no
0011 table: the attempted cleanup of
`serialized_dcb_safe_lane_passes` returned SQLite code 7500 `no such table`
and made no change. This is why the parent has cron/coverage evidence but no
event-driven pass ledger; that failed no-op receipt is retained.

All five Wrangler credential names were unset for every Wrangler command:

```text
CLOUDFLARE_API_TOKEN=UNSET
CF_API_TOKEN=UNSET
CLOUDFLARE_API_KEY=UNSET
CF_API_KEY=UNSET
WRANGLER_API_TOKEN=UNSET
```

The conformance credential was read only from the protected path
`/private/tmp/sdt-g65-wake141-token.pdPTFB/conformance-token`; its value was
never printed, logged, or committed. No authorization error occurred.

## Cohort protocol and gate results

Each cohort used the same self-mode arm, cold first sample, 10 accepted
reservations, and at least 10,000 ms from the preceding commit response before
the next commit. The harness wrote the report checkpoint after setup, each
accepted commit, and each visibility observation.

| arm | source | run ID | response p50/p95 ms | unsafe p50/p95 ms | unsafe >5,000 ms | safe p50/p95 ms | safe <180,000 ms |
|---|---|---|---:|---:|---:|---:|---:|
| parent | `868f2fc` | `5365c30a-195f-46a1-98e2-f9c8a194b72b` | 2,746 / 3,105 | 2,867 / 3,103 | 0/10 | 77,828 / 123,321 | 10/10 |
| candidate | `6d691275` | `ef40d7f2-67b1-4967-972d-cc838d5e0ab1` | 2,658 / 2,952 | 2,892 / 3,095 | 0/10 | 68,725 / 117,444 | 10/10 |

Gate arithmetic:

- Response p95: `2,952 - 3,105 = -153 ms`; candidate is within parent p95
  plus 150 ms.
- Unsafe p95: `3,095 - 3,103 = -8 ms`; candidate is within parent p95 plus
  150 ms and all 10 observations are within the unchanged 5,000 ms bound.
- Safe p95: `117,444 ms > 60,000 ms`; **AC4 arm gate fails**.
- Safe deadline: 10/10 candidate observations are below 180,000 ms, but this
  does not waive the stricter AC4 p95 gate.
- Because the arm gate failed, the conditional production C-0 reset/deploy/
  cohort was correctly **not run**.

### Complete parent sample table

`unsafeMs` is command response to first unsafe visibility; every row is an
unsafe pass. `safeMs` is command response to the first safe head observed by
the harness.

| # | reservation | SUID | response ms | unsafe ms | safe ms | observed safe head |
|---:|---|---|---:|---:|---:|---|
| 1 | `g58-reservation-5365c30a-195-1` | `063924292989245000001437597435` | 3105 | 2821 | 123321 | `063924292989245000001437597435` |
| 2 | `g58-reservation-5365c30a-195-2` | `063924293002298000000022646066` | 3094 | 2799 | 112269 | `063924293015476000000733795861` |
| 3 | `g58-reservation-5365c30a-195-3` | `063924293015476000000733795861` | 2802 | 3103 | 99465 | `063924293015476000000733795861` |
| 4 | `g58-reservation-5365c30a-195-4` | `063924293028218000000346353957` | 3061 | 2986 | 88764 | `063924293054024000001573048412` |
| 5 | `g58-reservation-5365c30a-195-5` | `063924293041204000001253721906` | 2785 | 2977 | 75977 | `063924293054024000001573048412` |
| 6 | `g58-reservation-5365c30a-195-6` | `063924293054024000001573048412` | 2629 | 2779 | 63347 | `063924293054024000001573048412` |
| 7 | `g58-reservation-5365c30a-195-7` | `063924293066538000001216039408` | 2442 | 2919 | 53215 | `063924293066538000001216039408` |
| 8 | `g58-reservation-5365c30a-195-8` | `063924293079210000001833844603` | 2746 | 2867 | 90422 | `063924293091915000002029229553` |
| 9 | `g58-reservation-5365c30a-195-9` | `063924293091915000002029229553` | 2593 | 2910 | 77828 | `063924293091915000002029229553` |
| 10 | `g58-reservation-5365c30a-195-10` | `063924293104577000000092702268` | 2670 | 2769 | 67449 | `063924293104577000000092702268` |

### Complete candidate sample table

| # | reservation | SUID | response ms | unsafe ms | safe ms | observed safe head |
|---:|---|---|---:|---:|---:|---|
| 1 | `g58-reservation-ef40d7f2-67b-1` | `063924293292327000002095420341` | 2952 | 2891 | 117444 | `063924293343290000000885164331` |
| 2 | `g58-reservation-ef40d7f2-67b-2` | `063924293304955000001630459683` | 2779 | 2988 | 104663 | `063924293343290000000885164331` |
| 3 | `g58-reservation-ef40d7f2-67b-3` | `063924293317650000000684049012` | 2459 | 2721 | 92203 | `063924293343290000000885164331` |
| 4 | `g58-reservation-ef40d7f2-67b-4` | `063924293330694000001138651377` | 2666 | 2904 | 79080 | `063924293343290000000885164331` |
| 5 | `g58-reservation-ef40d7f2-67b-5` | `063924293343290000000885164331` | 2610 | 2892 | 66469 | `063924293343290000000885164331` |
| 6 | `g58-reservation-ef40d7f2-67b-6` | `063924293355851000002084943799` | 2465 | 2918 | 56479 | `063924293355851000002084943799` |
| 7 | `g58-reservation-ef40d7f2-67b-7` | `063924293368470000001695611628` | 2769 | 2959 | 61313 | `063924293368470000001695611628` |
| 8 | `g58-reservation-ef40d7f2-67b-8` | `063924293381244000000680646493` | 2685 | 3095 | 53591 | `063924293381244000000680646493` |
| 9 | `g58-reservation-ef40d7f2-67b-9` | `063924293393959000001628408632` | 2658 | 2672 | 78801 | `063924293393959000001628408632` |
| 10 | `g58-reservation-ef40d7f2-67b-10` | `063924293406371000000872576668` | 2382 | 2682 | 68725 | `063924293406371000000872576668` |

## Durable trigger and frontier evidence

The parent source predates the G67 kick and its clean D1 schema has no pass
ledger. Its cohort health history records four scheduled coverage observations:

| observed UTC | kind | proven frontier | projector observation |
|---|---|---|---|
| 2026-09-06T12:02:45.815Z | SETTLED | empty | both `never-invoked` at the first snapshot |
| 2026-09-06T12:03:45.773Z | SETTLED | `063924293015476000000733795861` | both `advanced` |
| 2026-09-06T12:04:46.546Z | SETTLED | `063924293079210000001833844603` | both `advanced` |
| 2026-09-06T12:05:46.893Z | SETTLED | `063924293104577000000092702268` | both `advanced` |

The candidate D1 query returned 154 append-only pass rows: 150 `kick`, four
`cron`; statuses were 140 `coalesced`, 10 completed kicks, three completed
cron passes, and one failed cron pass. The failed cron row was
`cron:1788696466906:552995d5-9842-4132-90d9-09338ac7a7ac`, observed at
`2026-09-06T12:07:46.906Z`, and recorded
`CHECKPOINT_AHEAD: materialized-view checkpoint is ahead of the source store;
rebuild and promote a generation`. It occurred after candidate deployment and
before the first candidate commit. The three completed cron rows were at
12:08:54.367Z, 12:10:02.892Z, and 12:11:03.279Z. The ten completed kick rows
were at 12:08:06.290Z, 12:08:13.334Z, 12:08:19.064Z, 12:08:48.151Z,
12:09:26.209Z, 12:09:45.670Z, 12:09:57.657Z, 12:10:12.014Z,
12:10:22.463Z, and 12:10:23.247Z. Their exact start/end times, coverage
frontiers, status, and error fields are in
`.artifacts/sdt-g67-w142-rerehearsal-candidate-safe-passes.txt`.

The persisted candidate coverage history was:

| tick ID | observed UTC | kind | frontier |
|---|---|---|---|
| `scheduled:1788696465928` | 2026-09-06T12:07:45.928Z | SETTLED | empty |
| `scheduled:1788696527004` | 2026-09-06T12:08:47.004Z | SETTLED | `063924293317650000000684049012` |
| `scheduled:1788696589671` | 2026-09-06T12:09:49.671Z | SETTLED | `063924293381244000000680646493` |
| `scheduled:1788696650600` | 2026-09-06T12:10:50.600Z | SETTLED | `063924293406371000000872576668` |

The pass schema exposed `safe_heads_before_json` and `safe_heads_after_json`,
but every returned row had both fields `null`. The cohort health snapshots do
contain the observed materialized safe heads shown in the sample tables; they
are not substituted for the missing durable before/after fields. The pass
schema also has no event ID, SUID, or obligation identity, so the durable
ledger cannot establish an exact one-to-one pass-to-commit mapping. The raw
cohort rows preserve the exact commit/SUID/timing identities, and the raw
ledger preserves the exact trigger/timestamp/frontier values. This is a
measurement limitation, not an inferred trigger attribution.

## Raw receipts

All new receipts were written under `.artifacts/` in this worktree:

- `sdt-g67-w142-rerehearsal-whoami.txt`
- `sdt-g67-w142-rerehearsal-parent-deploy.txt`
- `sdt-g67-w142-rerehearsal-parent-version-view.txt`
- `sdt-g67-w142-rerehearsal-parent-deployments.txt`
- `sdt-g67-w142-rerehearsal-parent-queue-consumer.txt`
- `sdt-g67-w142-rerehearsal-parent-d1-migrations.txt`
- `sdt-g67-w142-rerehearsal-parent-reset-pipeline.txt`
- `sdt-g67-w142-rerehearsal-parent-reset-mv.txt`
- `sdt-g67-w142-rerehearsal-parent-reset-pass-ledger.txt`
- `sdt-g67-w142-rerehearsal-parent-cohort.log`
- `sdt-g67-w142-rerehearsal-parent-cohort.json`
- `sdt-g67-w142-rerehearsal-candidate-migration-0011.txt`
- `sdt-g67-w142-rerehearsal-candidate-reset-pipeline.txt`
- `sdt-g67-w142-rerehearsal-candidate-reset-mv.txt`
- `sdt-g67-w142-rerehearsal-candidate-reset-passes.txt`
- `sdt-g67-w142-rerehearsal-candidate-deploy.txt`
- `sdt-g67-w142-rerehearsal-candidate-version-view.txt`
- `sdt-g67-w142-rerehearsal-candidate-deployments.txt`
- `sdt-g67-w142-rerehearsal-candidate-queue-consumer.txt`
- `sdt-g67-w142-rerehearsal-candidate-d1-migrations.txt`
- `sdt-g67-w142-rerehearsal-candidate-cohort.log`
- `sdt-g67-w142-rerehearsal-candidate-cohort.json`
- `sdt-g67-w142-rerehearsal-candidate-safe-passes.txt`
- `sdt-g67-w142-rerehearsal-candidate-safe-history.txt`
- `sdt-g67-w142-rerehearsal-candidate-safe-health.txt`

The prior `f5b2212` and `540aab1` receipts remain preserved and are excluded
from all tables and gate calculations in this report. No PR, review, merge, or
production action was performed. The arm remains at the candidate deployment;
the next decision requires an in-scope AC4 repair or ruling before another
deployed cohort.
