# SDT-G58 safe-proof W102

Status: **blocked** at the G58 safe/live-projector proof. No PR or worker
completion was requested or run in this checkpoint.

## Scope and deployed identity

The preserved branch started at `11c4523463fc0e83e3892883642f08d5e4028a85`.
The already deployed product was not redeployed: Cloudflare version
`2ec23a75-8365-484b-9c8f-1197d3499cec` (version 191), source annotation
`SDT-G58 W99 deployed proof a7da2589272842115fb7f8a0c0050f2c2e3494e9`, was
the target. There was no Wrangler operation, D1 reset, lag purge, or third
cohort. The W99 failed receipt remains unchanged.

The upstream 5,000 ms unsafe proof is delegated to SDT-G60. The unchanged
bound is still applied to every row: a late list visibility is never an
unsafe pass. W102 adds only the explicit `--continue-after-unsafe` paced
evidence mode; it records a 5,000 ms pass/miss and continues read-only
observation for G58 safe/live evidence. The conformance bearer was read from
the protected `G53_CONFORMANCE_TOKEN_FILE` path only; its value is absent from
all receipts. The Observability token was not needed or read.

## Fresh cohort

One non-stitched window ran against the deployed URL with one room and exactly
10 reservations, `paceMs=10,000` and `pollMs=250`:

- run ID: `acc68d23-6133-446d-9470-e54fb3c28284`
- UTC: `2026-09-03T09:37:48.552Z`–`09:40:59.730Z`
- actual inter-commit gaps: 11,724–12,626 ms
- raw report (accepted receipts/SUIDs, every health snapshot and list poll):
  `.artifacts/sdt-g58-w102-safe-proof-cohort.json`
- failure/last-health stderr: `.artifacts/sdt-g58-w102-safe-proof-cohort.log`

Every accepted reservation receipt and SUID was persisted before its first
unsafe poll. The row-level disposition and timing evidence is:

| row | SUID | unsafe at 5,000 ms | eventual first unsafe | safe commit→safe |
| ---: | --- | --- | --- | ---: |
| 1 | `063924025082417000002050260075` | **miss** | 5,353 ms | 114,733 ms |
| 2 | `063924025094541000000759003421` | pass, 2,195 ms | — | 102,657 ms |
| 3 | `063924025106891000001134410415` | **miss** | 89,866 ms | 90,366 ms |
| 4 | `063924025118818000001227710475` | pass, 3,931 ms | — | not reached |
| 5 | `063924025130835000001712017963` | pass, 1,923 ms | — | not reached |
| 6 | `063924025143589000001583316047` | pass, 2,585 ms | — | not reached |
| 7 | `063924025155336000001551455796` | pass, 3,265 ms | — | not reached |
| 8 | `063924025167387000000157375013` | pass, 2,812 ms | — | not reached |
| 9 | `063924025179334000000956814733` | pass, 2,289 ms | — | not reached |
| 10 | `063924025191103000001618685662` | **miss** | none before stop | not reached |

The 5,353 ms row-1 visibility and 89,866 ms row-3 visibility are eventual
observations only. Row 10 had no eventual visibility before the safe/live
deadline. No late value was reinterpreted as an unsafe pass.

## Health and G58-owned result

The raw report retains all 91 intervening health responses. Coverage was
19 `SETTLED`/null-reason snapshots and 72 `BLOCK/UNSETTLED` snapshots, all
with reason `source_partition_set_changed_during_scan`. `safeWindowMs` was
20,000 in every snapshot; `ceilingExceeded=false`; decayed lag ranged from
0 to 15,616 ms (maximum estimate 17,708 ms). The published 20 s/120 s bounds,
the 5 s unsafe constant, and all polling deadlines are unchanged.

Rows 1–3 reached ReservationProjector safe heads at 114,733, 102,657, and
90,366 ms. Partial nearest-rank safe values are p50 **102,657 ms** and p95
**114,733 ms** (n=3); full n=10 safe p50/p95 are undefined because rows 4–10
did not reach a safe head. All three observed safe values are below 180 s but
above `safeWindowMs + 60 s` (80,000 ms), and their intervals contain the
observed BLOCK gate, so the residual classification is `coverage_BLOCK`.

The runner stopped with this exact failure and printed the final snapshot:

```text
safe lane or live projections did not reach 063924025118818000001227710475 by safeWindowMs + 120000ms
```

At `09:40:59.722Z`, global and RoomProjector safe heads had reached row 10,
but ReservationProjector stopped at row 3 with six unsafe rows. Live
RoomProjector remained at `063923933985284000000088451532` and live
ReservationProjector at `063924022962293000001512609674`, both behind the
cohort. The failure occurred before projection-lag/tag-state queries, so no
live-projector or tag-state success is claimed. This is an in-scope G58
safe/live failure requiring a focused repair continuation. G15/G16 were not
started after the failed safe-proof window, avoiding extra requests after an
acceptance failure.

## Harness change and checks

Changed paths are only:

- `scripts/deploy/g58-safe-lane-e2e.mjs` — delegated unsafe disposition,
  eventual observation, durable health checkpoints, and last-health failure
  output; default strict mode is unchanged.
- `scripts/g58-cohort-evidence-guard.mjs` — red mutations for removing the
  delegated branch and for moving the unsafe pass before the 5,000 ms bound.
- `docs/SDT-G58-evidence.md` — this W102 evidence section.
- `.artifacts/sdt-g58-w102-safe-proof-cohort.json` and `.log` — the single
  fresh cohort receipt and exact failure output.

`npm run test:g58` passed before the final unsafe-order correction; the focused
guard self-test and witness self-test passed again after it:

```text
node scripts/g58-cohort-evidence-guard.mjs --self-test
node scripts/deploy/g58-safe-lane-e2e.mjs --self-test
```

After the final correction, `npm run typecheck` and `npm run lint` also passed.

No Tag outbox, Queue producer/consumer/configuration, global admission batch,
SDT-G53 naming, SDT-G55 read semantics, G44 correctness, SafeWindow bounds,
SDT-G56 state, or SDT-G60 publication state was changed. Because a required
G58 safe/live target was not reached, this checkpoint is **blocked**; no PR,
worker completion, or canonical completed handoff is appropriate.
