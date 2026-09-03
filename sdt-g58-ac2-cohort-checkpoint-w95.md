# SDT-G58 AC2 cohort checkpoint (W95)

Status: **blocked** at the bounded safe-lane/live-projection gate. This is one
fresh cohort and no replacement requests were sent.

## Identity and boundary

- Branch: `claude/sdt-g58-safe-lane-w93`.
- Checkpoint before measurement: `344e08277b82d85f03bc7fcf6d1bfb2f03e19a3f`.
- Active normal-config deployment: Cloudflare version
  `07c3d85f-9bdf-4cf4-b342-6493ef32ef20` (version 190), source annotation
  `98b4534980e9886f7c7127ce99fae0bb0e01a7af`; no redeploy.
- Pinned OAuth `whoami` passed. The corrected read-only `versions list --json`
  confirmed the active version/source. No auth/API-token fallback was used.
- No SafeWindow bound, product behavior, AC3, or AC4 change was made. The
  protected conformance token was used only in memory from the private G53
  token-file path; the Observability token was referenced only by its approved
  `G50_OBSERVABILITY_TOKEN_FILE` path.

## One paced cohort

Run ID `5588d9cc-b508-41f4-a332-f6464721e747`, UTC
`2026-09-03T07:59:48.215Z`–`2026-09-03T08:03:12.431Z`. The sampler accepted one
setup room at 07:59:51.163Z, then exactly ten reservation commits. Their
minimum inter-commit spacing was 11,762 ms (required: 10,000 ms). The complete
raw ledger, including every unsafe observation and all 42 health snapshots, is
[`sdt-g58-ac2-cohort-checkpoint-w95.json`](.artifacts/sdt-g58-ac2-cohort-checkpoint-w95.json).

| # | SUID | Commit UTC | Pace ms | Unsafe UTC / ms | Safe UTC / ms | Classification |
| ---: | --- | --- | ---: | --- | --- | --- |
| 1 | `063924019202929000002071469094` | 08:00:03.380 | 12,217 | 08:00:08.669 / **5,289** | 08:01:57.128 / **113,748** | `follow_stopping_at_unsafe_event`, >80 s |
| 2 | `063924019214889000000198562541` | 08:00:15.268 | 11,888 | 08:00:19.999 / 4,731 | 08:01:57.128 / **101,860** | `follow_stopping_at_unsafe_event`, >80 s |
| 3 | `063924019226780000000577907676` | 08:00:27.285 | 12,017 | 08:00:29.967 / 2,682 | 08:01:57.128 / **89,843** | `follow_stopping_at_unsafe_event`, >80 s |
| 4 | `063924019239189000001227397085` | 08:00:39.869 | 12,584 | 08:00:42.546 / 2,677 | 08:01:57.128 / 77,259 | within >80 s gate |
| 5 | `063924019251513000000760677805` | 08:00:52.121 | 12,252 | 08:00:54.742 / 2,621 | **—** (deadline 08:03:12.121) | first overdue safe row |
| 6 | `063924019263517000001710065922` | 08:01:03.986 | 11,865 | 08:01:08.894 / 4,908 | **—** | safe head stopped below target |
| 7 | `063924019275350000000552576636` | 08:01:15.825 | 11,839 | 08:01:19.553 / 3,728 | **—** | safe head stopped below target |
| 8 | `063924019287500000001855581609` | 08:01:28.101 | 12,276 | 08:01:31.060 / 2,959 | **—** | safe head stopped below target |
| 9 | `063924019299552000000108062308` | 08:01:40.005 | 11,904 | 08:01:42.596 / 2,591 | **—** | safe head stopped below target |
| 10 | `063924019311336000000431147168` | 08:01:51.767 | 11,762 | 08:01:56.767 / **5,000** | **—** | safe head stopped below target |

Unsafe nearest-rank (`n=10`) is p50 **2,959 ms**, p95 **5,289 ms**; row 1
violates the 5-second unsafe limit, while row 10 is exactly at it. Only four
safe timings exist, so the full-cohort safe percentile is undefined. The
observed partial (`n=4/10`) nearest-rank values are p50 **89,843 ms** and p95
**113,748 ms**. With `safeWindowMs=20,000`, the `safeWindowMs+60s` threshold is
80,000 ms: rows 1–3 are classified by the observed `SETTLED`/no-block gate as
`follow_stopping_at_unsafe_event`; rows 5–10 have no safe timestamp and are
reported as bounded safe-lane failures, never imputed.

## Scheduled health and AC5 disposition

The raw receipt retains all 42 snapshots. Every snapshot has
`coverage.kind=SETTLED`, `coverage.reason=null`, and `lag.safeWindowMs=20000`.
Distinct scheduled coverage observations were:

| `coverage.observedAt` UTC | Snapshot indices | Decayed lag observed | Reservation safe head / unsafe rows |
| --- | --- | --- | --- |
| 07:58:35.669Z | 0–1 | 0 → 0 ms | pre-cohort `063924008135922000000562824059` / 0 |
| 07:59:35.261Z | 2–6 | 10,860 → 0 ms | pre-cohort head / 1 → 5 |
| 08:00:47.143Z | 7–40 | 10,165 → 0 ms (intermediate values retained raw) | advanced only to row 4 / 6 remain |
| 08:02:51.116Z | 41 | 0 ms | row-4 head `063924019239189000001227397085` / 6 |

At the terminal health snapshot, global head was the cohort last SUID
`063924019311336000000431147168`; RoomProjector was at
`063924007158786000002138376468` and ReservationProjector at
`063924008135922000000562824059`. Therefore all-live-projectors-at-target and
cohort tag-state committed-version proof were not reached; no AC5 pass is
claimed.

The exact bounded failure was:

```
safe lane or live projections did not reach 063924019251513000000760677805 by safeWindowMs + 120000ms
```

It occurred at `2026-09-03T08:03:12.431Z`, when row 5 first exceeded its
140,000 ms safe deadline. This checkpoint is pushed as **blocked** for a
focused safe-lane/unsafe-bound diagnosis. No further requests, deployment,
SafeWindow change, AC3/AC4 continuation, PR, or worker completion was started.
