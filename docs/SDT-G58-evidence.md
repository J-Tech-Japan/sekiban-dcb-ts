# SDT-G58 evidence

## W94 AC1/AC5 checkpoint — 2026-09-03

This is deliberately a checkpoint, not the AC2 measurement result. No new app
command, paced cohort, G15/G16 run, or `poll=1` projection request was sent in
this window. AC2, AC4's retired-lag-row purge, AC6, and any further AC3 work
remain for the next authorized continuation.

### Deployed identity and migration receipt

- Branch source: `98b4534980e9886f7c7127ce99fae0bb0e01a7af`.
- Normal-config Worker version: `07c3d85f-9bdf-4cf4-b342-6493ef32ef20`
  (version 190), annotated `SDT-G58 AC1 AC5 checkpoint` with that source SHA.
- Pinned Wrangler OAuth `whoami` succeeded. `CONFORMANCE_TOKEN` was confirmed
  by name only, freshly provisioned through the protected
  `G53_CONFORMANCE_TOKEN_FILE` procedure, and never written to an artifact.
  `G50_OBSERVABILITY_TOKEN_FILE` was referenced only as
  `/Users/tomohisa/.config/sekiban-dcb/observability-token`; no Observability
  query was needed for this read-side checkpoint.
- Initial normal migration apply exposed an empty Wrangler `d1_migrations`
  ledger even though the deployed database already had the nine G32/G44
  required tables and `dcb_events.EventDigest`. After that read-only schema
  verification, only the two matching ledger entries
  `0001_dcb_events.sql` and `0002_g44_global_completeness.sql` were restored;
  no application rows were reset or deleted. Normal Wrangler migration then
  applied `0003_g58_safe_lane_health.sql` successfully.

### AC1: authenticated, read-only health surface

`GET /conformance/v1/read-health` returned HTTP 200 through the bearer-only
conformance lane. The completed raw receipt is
`.artifacts/sdt-g58-w94-ac1-ac5-readproof-repaired.json`.

| Surface | Deployed value |
| --- | --- |
| Coverage | `SETTLED`, `reason=null`, `partitionTag=null`, scheduled `observedAt=1788421776610` |
| Lag | retained raw estimate `651320 ms`, decayed `0 ms`, safe window `20000 ms`, ceiling not exceeded |
| Room MV | generation 0; safe head `063924008135922000000562824059`; unsafe rows 0; receipts 34 |
| Reservation MV | generation 0; safe head `063924008135922000000562824059`; unsafe rows 0; receipts 144 |
| Global head | `063924008135922000000562824059` |

The endpoint is a read-only operator diagnostic: its values come from active
MV generations, unsafe tables, the persisted scheduled coverage row,
`serialized_dcb_lag_estimates`, `serialized_dcb_projection_checkpoints`, and
`dcb_events`; it adds no public V1 query policy.

### AC5: deployed live-projection wiring and proof

The Worker now relays the existing internal projection-lag operation only
through the authenticated conformance lane. Both registered projector health
rows were at the global head:

| Projector | Health head | `lastPollAt` |
| --- | --- | ---: |
| RoomProjector | `063924008135922000000562824059` | 1788411907785 |
| ReservationProjector | `063924008135922000000562824059` | 1788411907785 |

The read-only witness also checked a persisted room tag and reservation tag.
For each, `/internal/projection/lag` reported a checkpoint at the global head
with `behindEvents=0`, and tag-state returned the exact per-tag committed head
and version. The room tag's own head is intentionally earlier than the global
head; the repaired witness compares tag-state to its authoritative tagged D1
head rather than falsely requiring every tag state to equal the global head.

The first two raw read-only artifacts preserve that guard defect and bounded
failure. The repaired artifact records the passing rule, and its self-test goes
red when a tag state is behind its own expected tag head. The G58 source guard
also goes red if scheduled `pollLiveProjections` wiring is removed.

### Local guard evidence

- `npm run typecheck` — passed.
- `npm run test:g58` — passed: health fixture, BLOCK-frontier production
  mutation, scheduled-poll source guard, paced/single e2e self-test, and
  read-proof own-tag-head mismatch self-test.
- `npm run test:g44` — passed unchanged, including all four production
  mutations; its correctness property remains intact.

### Explicit checkpoint boundary

No AC2 sample exists yet, so no p50/p95, <=180 s latency claim, or slow-sample
attribution is asserted here. The next authorized continuation must use one
fresh coherent paced cohort and treat any safe result above 180 seconds as an
in-scope SDT-G58 defect.
