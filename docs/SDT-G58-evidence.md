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

## W95 AC2 cohort checkpoint — 2026-09-03 (blocked)

This wake ran the one authorized fresh paced cohort against the already
deployed normal-config Worker. It did not change a SafeWindow bound, deploy a
new version, send a replacement cohort, or begin AC3/AC4 work. The raw receipt
is `.artifacts/sdt-g58-ac2-cohort-checkpoint-w95.json` and contains the complete
request and health ledger.

### Identity and command boundary

- Branch before this checkpoint: `claude/sdt-g58-safe-lane-w93` at
  `344e08277b82d85f03bc7fcf6d1bfb2f03e19a3f`.
- Active deployment: version
  `07c3d85f-9bdf-4cf4-b342-6493ef32ef20` (version 190), annotated with source
  `98b4534980e9886f7c7127ce99fae0bb0e01a7af`. No redeploy occurred.
- Pinned Wrangler OAuth `whoami` succeeded. The first `versions list` attempt
  used the unsupported `--format` flag; the corrected pinned command used
  `--json` and confirmed the identity above. This was a local CLI syntax error,
  not an authentication or Cloudflare API failure.
- The conformance bearer was read only from the protected G53 token file in
  memory. `G50_OBSERVABILITY_TOKEN_FILE` was supplied only as the authorized
  filesystem path; no token value was printed, logged, or persisted.
- Run ID: `5588d9cc-b508-41f4-a332-f6464721e747`; UTC window
  `2026-09-03T07:59:48.215Z`–`2026-09-03T08:03:12.431Z`.
- The sampler sent one setup-room commit followed by exactly 10 reservation
  commits. Every reservation was paced at least 10,000 ms after the previous
  commit; the observed minimum was 11,762 ms. No request was sent after the
  bounded failure.

### AC2 per-commit ledger

The setup room was accepted at `2026-09-03T07:59:51.163Z` with SUID
`063924019190293000000618290808` (CF-Ray `a3533799384b7d9d-LAX`). The ten
reservation rows below are the complete paced cohort. `—` means the safe head
never reached that SUID before the first overdue deadline; it is not a zero or
an imputed timing.

| # | SUID | Commit (UTC) | Pace (ms) | Unsafe (UTC / ms) | Safe (UTC / ms) | Gate classification |
| ---: | --- | --- | ---: | --- | --- | --- |
| 1 | `063924019202929000002071469094` | 08:00:03.380 | 12,217 | 08:00:08.669 / **5,289** | 08:01:57.128 / **113,748** | `follow_stopping_at_unsafe_event`; >80,000 ms |
| 2 | `063924019214889000000198562541` | 08:00:15.268 | 11,888 | 08:00:19.999 / 4,731 | 08:01:57.128 / **101,860** | `follow_stopping_at_unsafe_event`; >80,000 ms |
| 3 | `063924019226780000000577907676` | 08:00:27.285 | 12,017 | 08:00:29.967 / 2,682 | 08:01:57.128 / **89,843** | `follow_stopping_at_unsafe_event`; >80,000 ms |
| 4 | `063924019239189000001227397085` | 08:00:39.869 | 12,584 | 08:00:42.546 / 2,677 | 08:01:57.128 / 77,259 | within `safeWindowMs + 60s` |
| 5 | `063924019251513000000760677805` | 08:00:52.121 | 12,252 | 08:00:54.742 / 2,621 | **—** (deadline 08:03:12.121) | first safe-lane deadline failure |
| 6 | `063924019263517000001710065922` | 08:01:03.986 | 11,865 | 08:01:08.894 / 4,908 | **—** | safe head stopped below target |
| 7 | `063924019275350000000552576636` | 08:01:15.825 | 11,839 | 08:01:19.553 / 3,728 | **—** | safe head stopped below target |
| 8 | `063924019287500000001855581609` | 08:01:28.101 | 12,276 | 08:01:31.060 / 2,959 | **—** | safe head stopped below target |
| 9 | `063924019299552000000108062308` | 08:01:40.005 | 11,904 | 08:01:42.596 / 2,591 | **—** | safe head stopped below target |
| 10 | `063924019311336000000431147168` | 08:01:51.767 | 11,762 | 08:01:56.767 / **5,000** | **—** | safe head stopped below target |

The unsafe nearest-rank sample is `n=10`, p50 **2,959 ms**, p95 **5,289
ms**. Sample 1 is over the authoritative 5,000 ms unsafe limit; sample 10 is
exactly at the limit. Safe timing is only observed for `n=4/10`, so a full
cohort p50/p95 is intentionally undefined. The observed partial nearest-rank
values are p50 **89,843 ms** and p95 **113,748 ms**; they are not presented as
an AC2 pass. The `safeWindowMs` at each commit was 20,000 ms, making the
classification threshold 80,000 ms. Samples 1–3 exceeded it with only
`SETTLED` coverage and a progressing-but-insufficient safe head, hence
`follow_stopping_at_unsafe_event`. Samples 5–10 have no safe timestamp and
remain failed/unresolved at the bounded deadline; no timing was fabricated.

### Intervening scheduled health snapshots

The raw `healthSnapshots` array has 42 entries; every entry records
`coverage.kind`, `coverage.reason`, `coverage.observedAt`, `lag.decayedMs`, and
`lag.safeWindowMs`. The table groups only identical scheduled coverage tick
IDs to make the cron sequence readable; snapshot index ranges show that no
poll snapshot was dropped. Every observed coverage kind was `SETTLED`, every
reason was `null`, and every safe-window value was 20,000 ms.

| Scheduled tick (`coverage.observedAt`, UTC) | Raw snapshots | First health response (UTC) | Decayed lag observed (ms) | `safeWindowMs` | Reservation safe head at tick / unsafe rows |
| --- | --- | --- | --- | ---: | --- |
| 1788422315669 / 07:58:35.669Z | 0–1 | 07:59:48.603Z | 0 → 0 | 20,000 | pre-cohort `063924008135922000000562824059` / 0 |
| 1788422375261 / 07:59:35.261Z | 2–6 | 08:00:15.510Z | 10,860 → 0 | 20,000 | pre-cohort `063924008135922000000562824059` / 1 → 5 |
| 1788422447143 / 08:00:47.143Z | 7–40 | 08:01:16.147Z | 10,165 → 0 (with intermediate bounded reads) | 20,000 | advanced to reservation 4 `063924019239189000001227397085`; 6 remain unsafe |
| 1788422571116 / 08:02:51.116Z | 41 | 08:03:12.431Z | 0 | 20,000 | `063924019239189000001227397085` / 6 |

At the terminal snapshot the global head was the cohort last SUID
`063924019311336000000431147168`, but the RoomProjector head was the older
`063924007158786000002138376468` and the ReservationProjector head was the
pre-cohort `063924008135922000000562824059`. Thus the required post-cohort
AC5 condition (all registered live-projector heads and cohort tag states at
the last SUID within the bound) was not reached and no tag-state success was
asserted.

### Exact failure and disposition

The sampler stopped at `2026-09-03T08:03:12.431Z` with:

```
safe lane or live projections did not reach 063924019251513000000760677805 by safeWindowMs + 120000ms
```

The first overdue row was reservation 5 (deadline
`2026-09-03T08:03:12.121Z`). Coverage remained `SETTLED`, `decayedMs=0`, and
`safeWindowMs=20000`; the ReservationProjector retained six unsafe rows and
the safe head stopped at reservation 4. This is a blocked AC2/AC5 checkpoint,
not a reason to raise the SafeWindow, average away missing samples, or stitch
another window. A later focused continuation must diagnose the safe-lane gate
and the unsafe-bound sample; this wake made no product or timeout change.

## W96 diagnosis and red guard — 2026-09-03

This is a diagnosis-only checkpoint on top of the W95 receipt. It sent no
requests, performed no deployment, changed no SafeWindow bound, and did not
open a PR or complete the worker. The W95 raw receipt remains the sole source
for this diagnosis: `.artifacts/sdt-g58-ac2-cohort-checkpoint-w95.json`.

### Exact failure diagnosis

W95 recorded `coverage.kind=SETTLED`, `coverage.reason=null`, and
`safeWindowMs=20000` for all 42 health snapshots. The scheduled coverage ticks
were 07:58:35.669Z, 07:59:35.261Z, 08:00:47.143Z, and 08:02:51.116Z. At the
08:00:47.143Z observation the ReservationProjector safe head had advanced only
through cohort row 4 (`063924019239189000001227397085`), leaving rows 5–10
unsafe. At 08:02:51.116Z it was still row 4 with six unsafe rows, even though
the global head had reached row 10. Both reported live-projector heads were
pre-cohort at the terminal observation.

The exact product cause is scheduled execution ordering, not a broken
`follow` algorithm:

1. `samples/meeting-room/src/worker.cloudflare-only.ts:76-101` calls
   `globalCoverage()` and passes that persisted frontier to
   `catchUp(frontierSuid)` and `drainUnsafeKicks(frontierSuid)` before invoking
   `runGenericScheduledWork()`.
2. The production generic schedule in
   `packages/dcb-runtime/src/cloudflare.ts:343-353` then performs the fresh
   `GlobalCompletenessReconciler.reconcile()` and, only for a FULL result,
   calls `pollLiveProjections()`. Therefore the fresh scanner frontier is not
   fed back into the safe MV pass during that same cron invocation. The next
   tick is the first opportunity to consume it; W95's bounded deadline expired
   before that happened.
3. `packages/dcb-runtime/src/mv/MaterializedViewCatchUp.ts:186-207` correctly
   stops at the first SafeWindow-unsafe event and honors `maximumSuid`; it did
   not skip a gap or cross an unproven frontier. The observed row-4 stop is
   exactly what the stale persisted frontier plus the first-unsafe-event rule
   predicts.

Live polling was not independently proven corrupt. It is downstream of the
fresh scanner in the same generic schedule, and
`ProjectionRuntime.pollRegistered()` (`packages/dcb-runtime/src/projection/ProjectionRuntime.ts:229-240`)
processes every tag/projector serially. The health reader also reports the
minimum checkpoint and poll time across all tags
(`samples/meeting-room/src/d1-mv.ts:375-389`), so a pre-cohort minimum is not a
cohort-specific proof that every poll failed. The terminal pre-cohort live
heads mean AC5 was not reached, but the actionable G58 defect demonstrated by
the receipt is the scanner-to-safe-lane scheduling gap; a future repair must
make a newly proven FULL frontier available to safe catch-up in the same tick
while retaining the existing gap fence.

### Red-capable guard (preserved before a green repair)

`test/g58-safe-lane-diagnosis.spec.ts` is an intentionally failing witness on
this baseline. It simulates the W95 sequence: a persisted stale frontier is
consumed, generic scheduled work discovers a fresh FULL frontier afterward,
and no second safe pass occurs. The final assertion requires the safe head to
reach the fresh frontier, so the current baseline fails with the exact
received/expected SUIDs. Existing `test/g44-global-completeness.spec.ts` is
untouched, and the existing G58 frontier/gap guards remain in place.

`scripts/g58-safe-lane-diagnosis-guard.mjs` runs that fixture with the pinned
local Vitest, requires the baseline to remain red, and writes the complete
stdout/stderr and exit status to
`.artifacts/sdt-g58-w96-red-guard.json`. The package lane now includes the
guard's self-test; `npm run diagnose:g58` produced:

```json
{"guard":"g58-w96-same-tick-frontier","status":"red-baseline","report":".artifacts/sdt-g58-w96-red-guard.json","exitCode":1}
```

The future focused green repair must make this witness pass and then replace
the expected-red checkpoint deliberately; no product fix is included here.

### Unsafe 5-second observation classification

Row 1's raw observations were not visible at commit+2,347 ms and visible at
commit+5,289 ms; the `waitForUnsafe` loop elapsed 4,974 ms and polls roughly
every two seconds. This brackets the transition between two observations but
does not establish that the product crossed the authoritative 5,000 ms limit;
the 5,289 ms value is a first-visible upper bound. Row 10 is exactly 5,000 ms.
Accordingly this single row is classified **indeterminate at the existing
sampling resolution**, not as a proven product defect. The <=5 s contract is
unchanged, no timeout or acceptance limit was weakened, and no value was
imputed.

### Checkpoint boundary

W96 pushes only the diagnosis fixture, red-output artifact, package wiring,
and this evidence section. No deployment, cohort rerun, green product change,
SafeWindow change, G44 modification, SDT-G56 work, PR, or worker completion was
performed. The next authorized wake can implement and validate the focused
same-tick frontier repair against this preserved red witness.
