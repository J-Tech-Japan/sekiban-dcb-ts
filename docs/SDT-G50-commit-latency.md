# SDT-G50 post-G41 commit latency — client evidence and trace defect

## Scope and deployed identity

This is one fresh, warm, app-surface measurement window against the normal
configuration. The live deployment was verified through the pinned Wrangler
version and deployment listings before sampling; deployment `eb363aeb-2ed0-4efe-a115-6e584825d136`
routed 100% of traffic to the recorded version.

| Field | Observed value |
| --- | --- |
| Service | `sekiban-dcb-meeting-room-cloudflare-only` |
| Live version | `5610dd9d-2dfa-497b-99e9-9d6903deceab` (version 177) |
| Deployment message / source SHA | `SDT-G50 W56 2cfe5c5284caadc836b2b608820b1396dd8da67e` |
| Sample run ID | `sdtg50w57-20260901-2242` |
| App surface | `POST /api/commands/create-room` |
| Caller colo | PDX: 50 |
| Discarded warm-up | 1 accepted request, excluded from the statistics |
| Accepted sampled commits | 50 sequential HTTP 200 `kind=committed` requests |
| Failed / replacement requests | 0 / 0 |

The raw evidence is
[`.artifacts/sdt-g50-w57-commit-latency.json`](../.artifacts/sdt-g50-w57-commit-latency.json).
It contains the 50-request ledger, the discarded warm-up receipt, deployment
identity, and retained-query result. No token contents are present in it.

## AC1 — client sample

In this **warm PDX app-command window, after one accepted discarded warm-up,
50 sequential accepted commits measured nearest-rank client p50/p95 of
1,596/2,052 ms**. The nearest-rank positions are `ceil(50 × 0.50) = 25` and
`ceil(50 × 0.95) = 48` in ascending client-latency order.

| Statistic | Milliseconds |
| --- | ---: |
| Count | 50 |
| Client p50 | **1,596** |
| Client p95 | **2,052** |
| Mean (descriptive only) | 1,609.36 |
| Minimum / maximum | 1,129 / 2,316 |

## Per-hop breakdown BLOCKED by defect

The one retained-trace query attempted for this cohort used the exact window
`2026-09-01T22:43:10.290Z` through `2026-09-01T22:50:30.779Z`
(`1788302590290..1788303030779`). It returned:

| Retained-query observation | Count / value |
| --- | --- |
| Observed normalized traces | 0 |
| Schema-complete traces | 0 |
| Descriptive loss | 50 of 50 |
| Retained normalized traces | 0 |
| Retained observations | 0 |
| Observed span-name tally | `{}` — zero provider span names |
| Observed normalized-span tally | `{}` — zero normalized S-rows |
| Missing active rows | S00, S01, S02, S03, S06, S07, S08, S09, S10, S11, S12, S13, S14, S15, S16 |

There is deliberately no fabricated per-hop median table. The exporter expects
`sdt.row.id` (or its `rowId` fallback) on `sdt.commit/v1` attributes in order
to map native emitted spans to an authority S-row. In contrast, the G37
end-state sample captured on 2026-08-27 from version
`a5dcff48-9a9c-4b2c-a5fa-6a3391b8879b` had native `actor.handle` and
`tag.append.member` span names with `sdt.row.id` S-row attributes, yielding 50
observed and 46 schema-complete traces. W57's empty tally is therefore a
current-runtime native-span regression, not evidence that those operations take
zero time.

This defect is input to an R-1 follow-up that restores commit-path native spans
and their `sdt.row.id` attributes. It is not repaired or worked around in G50.

The historical G37 S04 JOURNAL admit and S05a–S05d transition rows also have no
current counterpart: G47's deployed structural evidence established zero
JOURNAL namespace calls on the normal commit path. They are omitted rather
than fabricated or reported as zero-duration current spans.

## AC3 — colo-honest historical comparison

| Window | Client result | Samples | Caller colo | Interpretation |
| --- | --- | ---: | --- | --- |
| G30 historical anchor | 2,564 ms | historic anchor | SJC | Historical reference only |
| G37 end state, 2026-08-27 | 960 / 1,510 ms p50 / p95 | 50 | SJC | Historical post-A5 reference |
| G50 W57 warm app-command window | 1,596 / 2,052 ms p50 / p95 | 50 | PDX | Current client observation |

The W57 and G37 windows use different caller colos (PDX versus SJC). Their
absolute p50/p95 differences (+636 / +542 ms) are informational only; this
document makes no percentage-improvement or regression claim across the two
placements. The G30 2,564 ms SJC record remains a historical anchor, not a
like-for-like W57 component comparison.

## AC4 — client-data-only residual ranking

Without native spans, the residual ranking is intentionally limited to the
largest observed client windows. Each row is pinned to its ordinal and CF-Ray
receipt in the raw ledger, all at PDX; none is attributed to an internal hop.

| Rank | Sample ordinal | Client latency (ms) | Pinned to |
| ---: | ---: | ---: | --- |
| 1 | 3 | 2,316 | W57 raw ledger receipt, PDX |
| 2 | 42 | 2,161 | W57 raw ledger receipt, PDX |
| 3 | 30 | 2,052 | W57 raw ledger receipt, PDX (nearest-rank p95) |
| 4 | 32 | 1,948 | W57 raw ledger receipt, PDX |
| 5 | 27 | 1,831 | W57 raw ledger receipt, PDX |

The next optimization decision is therefore blocked on R-1 span restoration,
not inferred from these client-only ranks.

## AC5 — findings and guard candidates

1. **Finding eight — observability config absent before this unit.** The normal
   configuration needed the earlier G50 observability block before a retained
   trace query could be attempted.
2. **Finding nine — dashboard-var dependency.** The W55 HTTP 503 stop showed
   that the normal deployment also required the four explicit G32 dashboard /
   cutover vars; W56 restored them as the sole config source of variables.
3. **Finding ten — current-runtime native-span regression.** With observability
   enabled and the accepting W56 deployment live, W57 still observed no
   exporter-mappable `sdt.row.id` spans for its 50 accepted commits.

Observability parity and config-var parity are future guard candidates. This
unit deliberately does **not** extend the G49 binding-parity guard.

## Verification

- The committed raw artifact recomputes its client nearest-rank p50/p95 from
  the 50 ledger rows and records exactly one discarded accepted warm-up.
- The sampler was locally exercised with a missing-row fixture: it emits the
  client artifact with `perHopStatus=blocked-by-defect` rather than fabricating
  a per-hop table.
- No source under `packages/**` or `samples/meeting-room/src/**` was changed
  by this unit.
