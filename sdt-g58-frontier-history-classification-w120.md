# SDT-G58 frontier-history classification — W120

Task: `SDT-G58-FRONTIER-HISTORY-CLASSIFICATION-W120`  
Issue: `J-Tech-Japan/sekiban-dcb-ts#112`  
Status: completed under `HOST-LOOP-WAKE-104`, Outcome A  
Branch: `claude/sdt-g58-safe-lane-w93`

## Decision

The final fresh W120 classification cohort is Outcome A. The persisted
scheduled-tick history contains two BLOCK/UNSETTLED rows during the cohort;
both rows carry the same non-empty proven completeness frontier
`063924053488305000000669856102`. Both RoomProjector and ReservationProjector
MV safe heads remained exactly at that frontier on every recorded observation.
There is therefore no persisted frontier advance with a stale MV head, so
WAKE-103 Outcome B is not present.

This is a persisted-value classification. The new history table was created by
the W120 migration, so the first history row in this deployment window is a
BLOCK row rather than a pre-window SETTLED row. The two recorded BLOCK rows are
nevertheless sufficient to show that the retained proven frontier stayed put;
the MV head is used only for the separate stale-head comparison, never as the
frontier source.

## W119 red-before-green evidence

Before the history change, the preserved W119 guard was run at the pushed W119
checkpoint and returned:

```text
{"guard":"g58-w119-frontier-attribution","status":"red-baseline","report":".artifacts/sdt-g58-w119-safe-convergence-diagnosis-guard.json","blockTicks":3,"missingFrontierGroups":3}
```

The W119 red receipt is preserved at
`.artifacts/sdt-g58-w119-safe-convergence-diagnosis-guard.json`. The W120
red-before-green receipt is
`.artifacts/sdt-g58-w120-frontier-history-red-before-green.json`. The extended
guard is `scripts/g58-frontier-history-guard.mjs`; its self-test proves equal
frontier/head Outcome A, advanced-frontier/stale-head Outcome B, a missing
frontier red result, and a safe-head-over-frontier red result.

The implementation adds `serialized_dcb_safe_lane_history`, with immutable
`(service_id, tick_id)` identity and a unique `(service_id, observed_at)` tick
constraint. `tick_id` is the deterministic `scheduled:<observedAt>` value.
History insertion uses `ON CONFLICT ... DO NOTHING` and verifies the stored row
before updating the separate current-health row. An absent proven frontier is
persisted as an empty database value and exposed as `frontierSuid: null`; it is
never replaced by an MV head. The existing G44 maximum-SUID fence and
no-frontier hold are unchanged.

## Exact deployed identity

The source commit deployed was the pushed W120 implementation checkpoint
`9637e1f6c4e2b4b4c604763239abc4d214249118` on the branch above. The normal
`samples/meeting-room/wrangler.cloudflare-only.jsonc` config SHA-256 is
`f0c55e4676ad2f9f3adb2f2a7f42045f2827d4d99aff80a85cdaa955be54e345`.

The additive D1 migration `0005_g58_safe_lane_history.sql` was applied once to
D1 `f26d1299-82d9-4a64-8647-bc2ec86326ac`. Exactly one Worker deployment was
made with Wrangler `4.125.0`, no `--keep-vars`, and API-token environment
credentials unset. Wrangler read-back and `deployments list` both reported:

| field | value |
|---|---|
| Worker | `sekiban-dcb-meeting-room-cloudflare-only` |
| URL | `https://sekiban-dcb-meeting-room-cloudflare-only.ttakaoka.workers.dev` |
| version | `29fa773f-bceb-40f1-bd06-53f6b887f2da` |
| created | `2026-09-03T18:21:02.460Z` |
| deployment | 100% |
| message/source annotation | `SDT-G58 W120 frontier history 9637e1f` |
| Wrangler source metadata | `Unknown (version_upload)` |

The sanitized identity receipt is
`.artifacts/sdt-g58-w120-deploy-identity.json`. The conformance bearer was
read only from the protected path `.artifacts/.sdt-g58-w108-conformance-token`;
its value was not printed or persisted. The one local `--yes` argument
attempt was rejected by Wrangler before contacting Cloudflare; the corrected
interactive migration command then succeeded. No Cloudflare code 10000 or
OAuth/authentication failure occurred.

## Final classification cohort

Raw receipt: `.artifacts/sdt-g58-w120-final-classification-cohort.json`  
Guard receipt: `.artifacts/sdt-g58-w120-frontier-history-guard.json`  
Run ID: `f0c9a000-5931-4a61-8bfe-c5b9c29fbe99`  
Run interval: `2026-09-03T18:21:45.095Z` — `2026-09-03T18:25:07.525Z`  
Setup room: `g58-room-f0c9a000-593`, SUID
`063924056509826000001819228841`  
Reservation count: `n=10`  
Commit spacing: `12561, 13466, 12620, 13750, 14155, 12260, 12159, 12568,
12562, 12625 ms`; minimum `12159 ms` (required `>=10000 ms`).  
First reservation deadline: `2026-09-03T18:25:03.271Z`  
Final cohort SUID/global head:
`063924056638460000000983947577`  
Safe result: `n=0`, p50 `N/A`, p95 `N/A`; the receipt failed only because the
first reservation did not reach the unchanged 180,000 ms paced safe line. No
second cohort was run.

### Persisted coverage history and MV heads

These are the exact rows exposed by `read-health.coverageHistory`; the safe
heads are the final values recorded for each tick, and the raw receipt retains
all safe-head observations for that row.

| tick ID | observedAt UTC | kind | reason | partitionTag | proven frontier SUID | Room MV safe head | Reservation MV safe head | head observations | projector attempt/outcome |
|---|---|---|---|---|---|---|---|---:|---|
| `scheduled:1788459748077` | `2026-09-03T18:22:28.077Z` | `BLOCK/UNSETTLED` | `source_partition_set_changed_during_scan` | `reservation:g58-reservation-9b8befe9-144-1` | `063924053488305000000669856102` | `063924053488305000000669856102` | `063924053488305000000669856102` | 19 | Room/Reservation attempted `1788459783423`, both `advanced` |
| `scheduled:1788459809755` | `2026-09-03T18:23:29.755Z` | `BLOCK/UNSETTLED` | `source_partition_set_changed_during_scan` | `reservation:g58-reservation-9b8befe9-144-1` | `063924053488305000000669856102` | `063924053488305000000669856102` | `063924053488305000000669856102` | 8 | Room/Reservation attempted `1788459850262`, both `advanced` |

Every recorded BLOCK row has a frontier, the values are equal, and both MV
safe heads are equal to that frontier. The exact guard result was:

```text
{"guard":"g58-frontier-history","status":"pass","report":".artifacts/sdt-g58-w120-frontier-history-guard.json","outcome":"A_FRONTIER_STAYED_PUT","classificationError":null}
```

The latest health snapshot at the safe deadline was received at epoch
`1788459907523` (`2026-09-03T18:25:07.523Z`). It still reported
`BLOCK/UNSETTLED`, the same reason and frontier, `decayedMs=0`,
`safeWindowMs=20000`, Room and Reservation MV safe heads at
`063924053488305000000669856102`, and both live projector rows with
`lastPollAt=1788459850262` and outcome `advanced`. Live projector-head and
committed tag-state convergence remains SDT-G61 evidence and is not asserted
here.

### Complete cohort table

`unsafe-visible` is the first raw public visibility time. The runner's
pass/miss label is retained, but the actual commit-to-first-visible value is
the authoritative unsafe observation for the unchanged 5,000 ms evidence
column. A missing value is censored at the single cohort's final safe-line
deadline.

| # | reservation ID | commit UTC | SUID | spacing ms | runner unsafe label | unsafe-visible UTC | raw commit-to-unsafe ms | over/missing 5000 ms | commit-to-safe ms |
|---:|---|---|---|---:|---|---|---:|---|---|
| 1 | `g58-reservation-f0c9a000-593-1` | `18:22:03.271Z` | `063924056522344000001601439360` | 12561 | pass | `18:22:09.107Z` | 5836 | over | censored |
| 2 | `g58-reservation-f0c9a000-593-2` | `18:22:16.737Z` | `063924056536034000001117718433` | 13466 | pass | `18:22:19.565Z` | 2828 | within | censored |
| 3 | `g58-reservation-f0c9a000-593-3` | `18:22:29.357Z` | `063924056548419000001556449942` | 12620 | pass | `18:22:35.283Z` | 5926 | over | censored |
| 4 | `g58-reservation-f0c9a000-593-4` | `18:22:43.107Z` | `063924056562124000000664397736` | 13750 | pass | `18:22:45.827Z` | 2720 | within | censored |
| 5 | `g58-reservation-f0c9a000-593-5` | `18:22:57.262Z` | `063924056576285000001492127972` | 14155 | miss | censored | — | missing | censored |
| 6 | `g58-reservation-f0c9a000-593-6` | `18:23:09.522Z` | `063924056588671000001740209859` | 12260 | miss | censored | — | missing | censored |
| 7 | `g58-reservation-f0c9a000-593-7` | `18:23:21.681Z` | `063924056601018000001094214700` | 12159 | miss | censored | — | missing | censored |
| 8 | `g58-reservation-f0c9a000-593-8` | `18:23:34.249Z` | `063924056613208000000677996215` | 12568 | miss | censored | — | missing | censored |
| 9 | `g58-reservation-f0c9a000-593-9` | `18:23:46.811Z` | `063924056625856000000049826690` | 12562 | miss | censored | — | missing | censored |
| 10 | `g58-reservation-f0c9a000-593-10` | `18:23:59.436Z` | `063924056638460000000983947577` | 12625 | miss | censored | — | missing | censored |

Unsafe evidence only: actual observed unsafe values were `2720, 2828, 5836,
5926 ms`, observed-only p50 `2828 ms`, observed-only p95 `5926 ms`, and six
samples were censored. The honest unchanged-bound count is `8/10` over or
missing 5,000 ms (two actual over values plus six missing values). This does
not fail G58 and remains delegated to SDT-G60; the 5,000 ms constant was not
changed.

The W120 safe sample is censored, but WAKE-104 accepts the non-starved safe
evidence already recorded in the preserved W118 AC6 receipt (`95,629 ms`) and
the earlier W95 measurement (`42,492 ms`) against the unchanged 180,000 ms
line. The W120 table is the final starvation classification cohort, not a
repair target.

## Acceptance evidence carried into completion

- AC1: current health remains bearer-only and read-only; it now exposes the
  current coverage frontier plus append-only `coverageHistory` fields
  `{tickId, kind, reason, partitionTag, frontierSuid, observedAt}`.
- AC3: retained-frontier BLOCK catch-up and the same-tick FULL frontier order
  remain in force. W120 adds history persistence/guarding only; no completeness
  fence or frontier substitution was changed.
- AC4: the W118 C-0 retired-lag purge receipt remains preserved and unchanged.
- AC5: W111/W118 per-projector scheduled attempt/outcome observability remains
  green. The W120 rows show both registered projectors attempted on both
  persisted ticks. Projector-head/tag-state convergence remains G61.
- AC6: the preserved amended AC6 e2e remains green with the isolated
  `95,629 ms` safe sample and attempt telemetry; it does not assert unsafe
  visibility or G61 head convergence.
- AC7: no Tag outbox, Queue producer/consumer/configuration, or global-D1
  admission path was modified.

## Local gates

All gates ran against the history-enabled source without weakening, deleting,
or inflating a gate:

| command | result |
|---|---|
| `npm run test:g15` | pass; 2 files, 9 tests, pagination self-test |
| `npm run test:g16` | pass; 2 files, 6 tests, UI contract |
| `npm run test:g41` | pass; 8 tests and production mutation red |
| `npm run test:g44` | pass; 8 tests and all four production mutations red |
| `npm run test:g49` | pass; binding/migration parity and omission mutants red |
| `npm run test:g51` | pass; 4 selected tests and regression/probe guards |
| `npm run test:g52` | pass; 18 tests and omission mutants red |
| `npm run test:g53` | pass; 10 tests and scope mutants red |
| `npm run test:g54` | pass; 18 tests and known-divergence mutants red |
| `npm run test:g55` | pass; 12 tests and read-visibility mutants red |
| `npm run test:g58` | pass; 5 files, 14 tests, preserved guards, and W120 red-capable history guard |
| `npm run typecheck` | pass |
| `npm run lint` | pass with zero warnings |

The G58 guard run generated incidental timestamp/Vitest-output drift in the
older tracked W97/W98 receipts; those two files were restored exactly to their
checkpoint contents and are not part of this evidence. G41 also printed local
Workerd environment-teardown warnings after its passing test; its exit status
and mutation gate were green.

## Branch, PR, and worker transition

The implementation checkpoint was pushed before deployment at
`9637e1f6c4e2b4b4c604763239abc4d214249118`. The final evidence commit and PR
head are recorded here after the evidence/report commit is pushed. The PR is
against `main` for issue #112; no G60/#113 or G61/#114 dispatch was performed,
and G56 remains held.

The canonical issue-to-PR worker transition is run only after the PR is open,
using `intent-cli worker result-summary` followed by
`intent-cli worker complete --kind issue --number 112 --repo
J-Tech-Japan/sekiban-dcb-ts --github-only --outcome pr-created --pr <PR_NUMBER>
--write --format json`. Its exact result is added to this section before the
canonical W120 report notification.

## Scope boundaries

G58 does not claim the unsafe 5,000 ms proof (G60), actual projector-head or
committed tag-state convergence (G61), or final unsafe-path diagnosis. The
SafeWindow floor `20,000 ms`, ceiling `120,000 ms`, and paced safe acceptance
line `180,000 ms` are unchanged. G60 and G61 remain queued and undispatched;
G56 remains held.
