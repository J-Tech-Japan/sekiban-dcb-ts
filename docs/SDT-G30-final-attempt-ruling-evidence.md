# SDT-G30 final-attempt ruling evidence

Status: **operator-terminated partial closure; not B0 acceptance evidence.**

On 2026-08-27 the operator directed that the active third attempt be the
last live B0 attempt. This document records the three results without
weakening the AC5 floor, tail rule, 10-minute deadline, or `UNKNOWN`
classification. No fourth attempt was made.

The amended-2 authority mirrored by this candidate is
`A=2763c99aacef5e46a4716268a0690e555920c814`,
`S=160b4be0b3752c36425597ed9bc46002a1671cff`, and
`bundleDigest=sha256:31f28838c2255b8d45268fea81d3433bb64296098b01bb9857ba973bc3b54391`.
The final live candidate was
`13c3e31a84922db0e3da8254086106ce90d95470`; its CI run `33077155272`
was green before the runs.

## Fail-closed result

Each attempt reached independent 100-request A(off) and B(on) client
windows. A-prime was intentionally not started by the runbook after a B
trace gate failure. The primary was then explicitly restored to the A-prime
off configuration. Provider read-back confirms recovery version
`2a51fbd6-515b-476e-b3f5-d6830457a857` (version 151) at 100 percent, with
the recovery deployment annotation naming the final-attempt tail failure.

| Attempt | B cohort | Terminal gate result | Terminal observation |
| --- | ---: | --- | --- |
| 1 | 100 accepted | `export-deadline` | 85/100 schema-complete; 15 `UNKNOWN`; ranks 1–5 complete. The 85th visible cohort arrived after the fixed deadline (deadline `16:06:17.066Z`, capture `16:06:31.191Z`). |
| 2 | 100 accepted | `tail-coverage` | 89/100 schema-complete; 11 `UNKNOWN`; rank 1 was incomplete (terminal capture `16:45:58.849Z`, before deadline `16:46:07.015Z`). |
| 3 (final) | 100 accepted | `tail-coverage` | 81/100 schema-complete; 19 `UNKNOWN`; rank 3 was `schema-incomplete` because `S05a` was absent (terminal capture `17:25:44.596Z`, before deadline `17:25:55.741Z`). |

The terminal per-request failure artifact is kept locally at
`.artifacts/g30-b0-13c3e31a8492-trace-export-failure.json`; it is deliberately
not copied to published evidence because it retains request identities. The
run script uses a candidate-keyed failure filename, so the first two terminal
artifacts were superseded by the later attempts. Their aggregate values above
were captured at their respective terminal points; this retention limitation
is recorded rather than concealed.

For the final attempt, the terminal 19 `UNKNOWN` requests contained four
`root-absent` and fifteen `schema-incomplete` identities. The terminal
missing-row distribution was led by `S05a` (12); the remaining observed
missing counts were `S01`/`S02`/`S06`/`S07`/`S10`/`S14` (6 each),
`S03`/`S04`/`S05d`/`S09`/`S11`/`S12` (5 each), and
`S00`/`S05b`/`S05c`/`S08`/`S13`/`S15` (4 each). This remains an ingestion
observation, not a permission to infer an absent span.

## Final-attempt per-hop attribution

The following is a **post-deadline, read-only descriptive re-query** of the
final B ledger at `2026-08-27T17:30:34.145Z`. It is explicitly not used to
retroactively pass AC5: it found 80 schema-complete joined traces, 16
schema-incomplete traces, and four root-absent traces. The final tail still
included an incomplete rank-3 request.

The immutable 100-client B ledger had p50/p95/p99/max response latency of
2,564/3,888/5,939/6,406 ms. The joined cohort had 28–31 emitted spans per
trace (p50 31, p95 31); its root colo distribution was `SJC: 80`. These are
joined-cohort conditional descriptive estimates only, with no whole-cohort
performance conclusion.

| Row | Joined spans | p50 duration (ms) | p95 duration (ms) |
| --- | ---: | ---: | ---: |
| S00 | 80 | 2,418 | 3,815 |
| S01 | 80 | 0 | 0 |
| S02 | 80 | 52 | 65 |
| S03 | 80 | 52 | 67 |
| S04 | 80 | 398 | 585 |
| S05a | 80 | 32 | 42 |
| S05b | 80 | 31 | 52 |
| S05c | 80 | 32 | 46 |
| S05d | 80 | 33 | 42 |
| S06 | 80 | 391 | 677 |
| S07 | 80 | 391 | 676 |
| S08 | 80 | 68 | 131 |
| S09 | 80 | 18 | 37 |
| S10 | 80 | 19 | 31 |
| S11 | 80 | 853 | 1,151 |
| S12 | 80 | 852 | 1,151 |
| S13 | 80 | 384 | 691 |
| S14 | 80 | 170 | 367 |
| S15 | 80 | 0 | 0 |
| S16 (fan-out members) | 944 | 0 | 16 |

This evidence is the input for a separately scoped topology/placement and
hop-reduction decision. It does not modify protocol semantics, the sealed
trace manifest, or the frozen amended-2 AC5 thresholds.
