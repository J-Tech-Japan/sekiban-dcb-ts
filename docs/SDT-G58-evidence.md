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

## W97 same-tick green repair — 2026-09-03

This focused repair continues W96 at starting checkpoint
`afd6041deb04c51b9bf15e005c619e0012bcdd64`. It did not deploy, send a new
request, rerun or stitch a cohort, change SafeWindow bounds, open a PR, or
complete the worker. The W95 cohort and W96 red receipt remain immutable.

### Repair and safety behavior

`packages/dcb-runtime/src/cloudflare.ts` now exposes a narrow
`beforeLiveProjectionPoll` scheduled hook. The runtime performs its one fresh
`GlobalCompletenessReconciler.reconcile()` first, invokes the hook, and only
then runs `pollLiveProjections()` for a FULL scan. The sample Worker uses that
hook to read the just-written coverage and run safe MV catch-up plus
unsafe-kick draining before the live-projection poll. The outer sample
scheduled handler now hands directly to this runtime path, so it no longer
performs a stale persisted-frontier pass before reconciliation.

For a FULL/SETTLED tick, the safe lane receives the newly proven frontier from
that same scan. For a non-FULL/BLOCK tick, `coverage()` returns the reconciler's
retained cursor (`lastSettledFrontierSuid`), so catch-up and drain remain fenced
to the last proven contiguous frontier; the BLOCK reason is recorded through
the existing safe-lane health row. No source event can cross an unproven gap,
and the existing `maximumSuid` and first-unsafe-event rules remain unchanged.
The D1-only test environment with no TAG authority retains its old local
unrestricted seam solely for existing unit fixtures; deployed primaries always
take the TAG-backed fresh-reconcile path.

The runtime calls the live-projection poll after the hook in the same scheduled
invocation. No second scanner or poll is started by the safe-lane hook, and the
existing serial projector behavior is unchanged.

### Red-to-green guard evidence

The W96 raw red receipt
`.artifacts/sdt-g58-w96-red-guard.json` remains checked in with
`status=red-baseline` and `exitCode=1`. Its witness test was changed only in
expectation/fixture wiring to assert the repaired behavior and now passes as
`W97 GREEN: applies a freshly scanned FULL frontier in the same scheduled
tick`. A second fixture asserts that a BLOCK decision uses only the last proven
frontier and retains its reason. The green run is preserved in
`.artifacts/sdt-g58-w97-green-guard.json` with:

```json
{"schema":"sdt-g58-w97-green-guard/v1","status":"green","exitCode":0,"baselineRedReceipt":{"report":".artifacts/sdt-g58-w96-red-guard.json","status":"red-baseline","exitCode":1}}
```

`npm run test:g58` now directly runs both safe-lane fixtures, the existing G58
source/mutation guards, the deployed-script self-tests, and the green
diagnosis guard. The static G58 contract additionally requires the fresh hook
to precede `pollLiveProjections` and checks the direct runtime handoff.

### Validation

- `npm run test:g58` — passed (2 files, 5 tests; all existing G58 guards and
  production omission mutation red proofs passed, green same-tick witness
  passed).
- `npm run test:g44` — passed unchanged (8 tests and all four G44 production
  mutation red proofs).
- `npm run test:g25` — passed (3 tests; deployed sample scheduled recovery
  remains intact, including its TAG-omitted fixture seam).
- `npm run test:g31` — passed (33 tests and wait-for contract).
- `npm run typecheck` — passed, including all workspace builds and root
  `tsc --noEmit`.
- `npm run lint` — passed with `--max-warnings=0`.
- `npm run diagnose:g58` — passed with the green witness and preserved W96
  baseline receipt.

No Wrangler command was run or needed. The <=5 s unsafe and <=180 s safe
contracts, published 20 s/120 s SafeWindow bounds, G44 correctness test, W95
raw cohort, and W96 red evidence are unchanged. The pushed repair checkpoint
is `4aa0deb4280baad7b51877a395ebe2972a1f5995` and is ready for orchestration
to dispatch the next bounded verification wake.

## W98 AC4 lag-estimate hygiene checkpoint — 2026-09-03

This is the local/code-only AC4 continuation from branch
`claude/sdt-g58-safe-lane-w93` at starting head
`2db0ad3ff2072959c750d5f71bcd0ff57d1d7fad`. It sent no application request,
performed no deployment, mutated no remote D1 state, reran no cohort, opened no
PR, and did not complete the worker. The W95 cohort and its evidence remain
unchanged.

### Lag decay and SafeWindow contract

The W95 health ledger already showed the retained estimate falling from about
10 seconds to `0 ms` while `safeWindowMs` stayed at `20,000 ms`. That behavior
does not justify a single-arrival cap, so no cap or other SafeWindow policy was
added. The implementation remains the existing linear current-estimate rule:
`max(0, estimateMs - (nowMs - observedAtMs))`. The published constants remain
byte-for-byte `PUBLISHED_SAFE_WINDOW_MS = 20_000` and
`MAX_PUBLISHED_SAFE_WINDOW_MS = 120_000`.

`test/g58-safe-lane.spec.ts` now exercises the service calculation and the
pure helper at a deterministic stale-estimate boundary. An `80,000 ms`
estimate is still `80,000 ms` at its observation time; at `79,999 ms` of idle
time it is `1 ms` and already clamps to the `20,000 ms` floor; at one full
`80,000 ms` decay interval `D1EventStore.currentLagBound` returns `0` and the
computed SafeWindow is exactly `20,000 ms`. This proves that after arrivals stop
the deployed service does not treat a stale estimate as current, without
changing the 20-second floor or 120-second ceiling.

### Red-capable mutation receipt

`scripts/g58-lag-hygiene-guard.mjs` runs the focused oracle green, mutates only
the `estimateMs - elapsed` term to a no-decay implementation, and requires the
same oracle to fail. It restores the source in a `finally` path and retains the
full child-process output in
`.artifacts/sdt-g58-w98-lag-red-guard.json`:

```json
{"schema":"sdt-g58-ac4-lag-hygiene/v1","status":"red-mutant","baseline":{"exitCode":0},"mutant":{"exitCode":1},"restored":true}
```

The mutant's assertion is the expected `1` ms stale value versus the received
`80,000` ms, so the guard is red-capable rather than merely checking that a
script ran. The normal `g58-safe-lane-guard.mjs` statically requires this guard,
the fixture anchor, and the purge plan; the W96 red receipt and W97 green
witness remain preserved.

### Prepared, unexecuted C-0 retired-row purge

The next authorized deployment continuation must first inventory lag-estimate
rows, then run this exact C-0/C-13-scoped remote operation against the normal
config's `D1` binding:

```sh
./node_modules/.bin/wrangler d1 execute D1 --remote --json --yes \
  --config samples/meeting-room/wrangler.cloudflare-only.jsonc \
  --command "DELETE FROM serialized_dcb_lag_estimates WHERE service_id <> 'sekiban-dcb-meeting-room-cloudflare-only'"
```

The SQL is checked in as
`scripts/deploy/g58-ac4-retired-lag-purge.sql`. Its predicate removes only
retired-service lag rows and retains the deployed service row
`sekiban-dcb-meeting-room-cloudflare-only`; the operation must not be run until
the next wake's identity inventory and reset authorization are recorded. W98
did not invoke Wrangler or execute this statement.

### Deterministic validation

- Focused decay oracle: `npm run build:packages && ./node_modules/.bin/vitest run --config vitest.config.ts --no-file-parallelism --maxWorkers=1 test/g58-safe-lane.spec.ts --testNamePattern 'decays a retired lag estimate'` — passed.
- `node scripts/g58-lag-hygiene-guard.mjs --self-test && node scripts/g58-lag-hygiene-guard.mjs` — passed; mutant exit `1`, receipt restored.
- `npm run test:g58` — passed (2 files, 5 tests, existing G58 production-omission and W97 same-tick guards intact).
- `npm run test:g44` — passed unchanged (8 tests and all four G44 production mutants red).
- `npm run typecheck` — passed.
- `npm run lint` — passed with `--max-warnings=0`.

No SafeWindow bound, G44 test, cohort, remote D1 row, SDT-G56 work item, or
deployment was changed in this checkpoint. The AC4 checkpoint is ready for the
next authorized deployment/purge and fresh verification continuation.

## W99 deployed proof — 2026-09-03 (blocked at unsafe visibility)

This was the one authorized normal-config deployment/proof wake from the W98
checkpoint. The pinned Wrangler `whoami` began at
`2026-09-03T08:58:53.3Z` and completed at `08:58:56.3Z` with OAuth success;
all API-token fallback variables were unset. No other Wrangler user or process
was used. The exact branch source was
`a7da2589272842115fb7f8a0c0050f2c2e3494e9`.

### Deployment identity and C-0 lag purge

The normal config was deployed once with the source annotation
`SDT-G58 W99 deployed proof a7da2589272842115fb7f8a0c0050f2c2e3494e9`:

- Cloudflare version: `2ec23a75-8365-484b-9c8f-1197d3499cec` (version 191).
- Deployment log: `.artifacts/sdt-g58-w99-deploy.log`.
- Pinned `versions list --json` identity: `.artifacts/sdt-g58-w99-versions.json`,
  where version 191 has that exact annotation and `triggered_by=version_upload`.

The pre-purge remote inventory (`.artifacts/sdt-g58-w99-lag-before.json`) found
exactly two lag rows:

| Service ID | estimate_ms | observed_at |
| --- | ---: | ---: |
| `sdt-g47-repair-wake32c-20260831` (retired) | 61,546,651 | 1,788,284,117,839 |
| `sekiban-dcb-meeting-room-cloudflare-only` (deployed) | 6,591 | 1,788,422,518,180 |

Under the authorized C-0/C-13 scope, the checked-in
`scripts/deploy/g58-ac4-retired-lag-purge.sql` was executed exactly once via
the pinned remote D1 `D1` binding. Its raw receipt is
`.artifacts/sdt-g58-w99-lag-purge.json`; Cloudflare reported `success=true`,
`rows_read=2`, `rows_written=1`, and `changes=2`. The post-purge inventory
(`.artifacts/sdt-g58-w99-lag-after.json`) contains only the deployed service
row with `estimate_ms=6591`; the retired row is absent. No D1_MV, queue, or
event rows were reset.

### Single fresh paced cohort and exact failure

The only application window was run ID
`97edc4cd-5910-410a-9de9-9f9cbc6fb969`, UTC
`09:02:04.058Z`–`09:02:48.358Z`, with one setup-room command and a requested
10-reservation sequence. It used `paceMs=10,000` and `pollMs=250`, retaining
the unchanged `unsafeBoundMs=5,000` and safe deadline
`safeWindowMs + 120,000 ms`. The conformance bearer was read only from the
protected token file; its value was not persisted. No Observability query was
needed, so the Observability token was not read.

The raw receipt is `.artifacts/sdt-g58-w99-paced-cohort.json` and the runner
log is `.artifacts/sdt-g58-w99-paced-cohort.log`. The setup room was accepted
at SUID `063924022926070000001564666749`. The first reservation was accepted
at `09:02:18.623Z` and became unsafe-visible at `09:02:24.015Z` after
`5,392 ms` (first fine poll at `5,116 ms`); this exceeds the unchanged 5 s
contract. The second was accepted at `09:02:30.658Z` and unsafe-visible after
`2,797 ms`. Its nearest-rank observed-only unsafe values are p50 `2,797 ms`
and p95 `5,392 ms`; a full-cohort percentile is intentionally undefined
because the window stopped before row 3 completed.

The third reservation request reached the runner's accepted-command path, but
the existing harness does not append its response to the report until unsafe
visibility succeeds. The runner stopped at the exact bounded stage with:

```
unsafe reservation g58-reservation-97edc4cd-591-3 was not visible within 5000ms
```

No SUID is fabricated for that incomplete report. At the row-3 health sample
(`09:02:43.222Z`), the observed gate was `BLOCK/UNSETTLED` with reason
`source_partition_set_changed_during_scan`, `decayedMs=6279`,
`safeWindowMs=20000`, global head
`063924022950280000000689507569`, ReservationProjector safe head still the
pre-cohort `063924019311336000000431147168`, and two unsafe rows. Earlier
samples were `SETTLED`/`reason=null`; the complete health snapshots and every
250 ms list observation are retained in the raw receipt.

Because the authoritative unsafe contract failed, no safe timings were
claimed, no live-projector/tag-state completion was asserted, and `e2e:g58`
was not followed by G15 or G16. There were no replacement requests, no
stitched cohort, and no SafeWindow bound change. This is a durable blocked
deployed-proof checkpoint for a focused follow-up to diagnose the row-3
unsafe-visibility/gate behavior; changing the published 20 s/120 s bounds is
not proposed.

## W100 unsafe-lane diagnosis and receipt checkpoint — 2026-09-03

Status: **blocked for a separate upstream delivery unit**. This wake did not
use Wrangler, deploy, reset remote data, send an application request, rerun
the W99 cohort, or change the G58 runtime. The committed W99 raw receipt and
its red outcome remain the baseline evidence.

The diagnosis/harness checkpoint is pushed on
`claude/sdt-g58-safe-lane-w93`; the canonical handoff records its exact head.

### Correlated W99 facts

The W99 run was `97edc4cd-5910-410a-9de9-9f9cbc6fb969` and used 250 ms list
polling with the unchanged 5,000 ms unsafe bound. Reservation 1 was accepted
at `09:02:18.623Z`; its first visible response was received at `09:02:24.015Z`
(`5,392 ms` from the command receipt; the first fine poll elapsed `5,116 ms`).
Reservation 2 was accepted at `09:02:30.658Z` and became visible at
`09:02:33.455Z` (`2,797 ms`). The nearest-rank values over those two completed
rows are p50 `2,797 ms` and p95 `5,392 ms`; the cohort stopped before a full
percentile could be claimed.

The third command reached the accepted-command path, then the bounded unsafe
wait failed without a visible row. The old W99 harness appended a reservation
only after unsafe success, so its response SUID was not in the raw report; no
SUID is inferred here. The exact failure remains:

```
unsafe reservation g58-reservation-97edc4cd-591-3 was not visible within 5000ms
```

The health snapshots line up with an upstream delivery gap:

| UTC health read | coverage | decayed lag / safe window | global head | MV safe head | interpretation |
| --- | --- | ---:|---|---|---|
| `09:02:18.898Z` | `SETTLED` / `null` | `0 / 20,000 ms` | setup-room SUID `063924022926070000001564666749` | pre-cohort `063924019311336000000431147168` | reservation 1 not yet in global D1 |
| `09:02:30.936Z` | `SETTLED` / `null` | `12,131 / 20,000 ms` | reservation 1 SUID `063924022938171000000990740165` | pre-cohort | reservation 2 not yet in global D1 |
| `09:02:43.222Z` | `BLOCK/UNSETTLED` / `source_partition_set_changed_during_scan` | `6,279 / 20,000 ms` | reservation 2 SUID `063924022950280000000689507569` | pre-cohort | reservation 3 is not in global D1 at this read |

Thus row 3 was absent from both the global head and the unsafe list, not merely
held behind a SafeWindow-fenced MV. The `lastPollAt` values remained at the
pre-cohort timestamp because live polling is correctly downstream of the
global completeness gate; this is a consequence, not evidence that the G58
hook caused the admission delay.

### Code-path diagnosis

The exact existing handoff is:

1. `TagDurableObject.appendSql` durably writes the Tag event, outbox
   obligation, and local receipt. `registerSourcePartition` runs after that
   append and before the response.
2. After the 201 response, `TagDurableObject.append` schedules
   `autoDrainAfterResponse` through `ctx.waitUntil(...)`; the command response
   does not await Queue-to-D1 delivery. `autoDrainOutbox` sends the complete
   row to `DOWNSTREAM_QUEUE`.
3. The Queue consumer calls `processDeliveryCore`, whose
   `D1EventStore.recordDelivery` batch is the code that creates `dcb_events`,
   global membership, receipt, arrival, and lag rows. A later read-back join
   must succeed before the source obligation is acknowledged.
4. Only after that global receipt can the G44 `beforeViews` gate and the MV
   handlers run. The G58 scheduled path (`stabilizeDownstream`, G44 reconcile,
   then the fresh-coverage hook and live poll) does not write `dcb_events` and
   cannot make an absent global row appear.

The row-3 global head stopping at row 2 is therefore direct evidence that the
unchanged asynchronous outbox/Queue/global-D1 handoff had not completed by the
5-second unsafe bound. There is no code or timestamp evidence that the G58
same-tick reconciliation, MV catch-up, live-projection poll, or D1 health reads
introduced execution contention: those stages occur after global admission and
operate on separate health/MV state. The observed BLOCK reason is the
reconciler's `assertSnapshotUniverseUnchanged` result: a source-partition set
changed between the scanner's start and end snapshots. It is a concurrent
expected scan symptom and correctly fences a frontier; it neither enqueues a
row nor delays Queue delivery. Inferring causation from that reason alone would
be incorrect.

The first sample's 5,392 ms and row 3's absent global row support the same
upstream queue/outbox delivery-latency classification. The available receipt
does not distinguish a platform Queue delay from an auto-drain/receiver
failure, and no replacement request or remote inspection was authorized in
this wake. The failure is outside G58 AC3 catch-up cadence and AC5
live-projection wiring, so this checkpoint is **blocked** for a separate held
outbox/Queue/global-D1 diagnosis unit. No outbox, Queue, D1, G44, or G58
product path was changed.

### Durable accepted-receipt harness repair

The old report-loss behavior is repaired locally in
`scripts/deploy/g58-safe-lane-e2e.mjs` without changing any deadline:

- setup-room receipt is checkpointed immediately after acceptance;
- each accepted reservation is pushed with its SUID and `unsafe: null`, then
  synchronously written before the health read or `waitForUnsafe` call;
- the health-updated checkpoint and successful unsafe observation are written
  again, while an unsafe failure leaves the accepted receipt in the report.

The report path is passed from `--report` to each checkpoint write. The focused
guard `scripts/g58-cohort-evidence-guard.mjs` writes
`.artifacts/sdt-g58-w100-cohort-evidence-guard.json`, verifies the preserved W99
failed receipt, and removes the immediate pre-poll write in its self-test; that
mutation is red. The guard artifact records schema
`sdt-g58-cohort-evidence/v1`, baseline W99 run ID, and the exact 5,000 ms
failure without any credential material. The existing W96 red receipt and W97
green same-tick witness remain untouched.

### Checks and scope boundary

- `npm run test:g58` — passed; existing G58/G44-boundary fixtures and mutation
  guards plus the new pre-unsafe checkpoint guard passed.
- `node scripts/g58-cohort-evidence-guard.mjs --self-test` and the guard —
  passed; removing the checkpoint is deterministically red.
- `node scripts/deploy/g58-safe-lane-e2e.mjs --self-test` — passed.
- SafeWindow constants remain 20,000 ms / 120,000 ms; unsafe bound remains
  5,000 ms; no polling deadline or queue/outbox semantics changed.
- No Wrangler, Cloudflare API, application request, replacement cohort, or
  SDT-G56 operation was performed.

## W102 delegated unsafe proof — 2026-09-03 (blocked at safe/live proof)

This continuation preserves the W99 deployed product and its failed unsafe
receipt. The deployed identity remains Cloudflare version
`2ec23a75-8365-484b-9c8f-1197d3499cec` (version 191), with source annotation
`SDT-G58 W99 deployed proof a7da2589272842115fb7f8a0c0050f2c2e3494e9`.
There was no deployment, Wrangler operation, D1 reset, lag purge, or
replacement cohort in W102. The upstream 5,000 ms unsafe proof is explicitly
delegated to SDT-G60; this unit retains the unchanged bound and records every
pass/miss without turning a later observation into an unsafe pass.

### Minimum delegated-proof harness change

`scripts/deploy/g58-safe-lane-e2e.mjs` now accepts the explicit
`--continue-after-unsafe` flag only with a paced run. The default path still
throws at `UNSAFE_BOUND_MS = 5,000`; the continuation records
`disposition=pass` only when visibility is observed at or before that bound,
and records `disposition=miss`, the bound timestamp, and any eventual first
visibility separately. The accepted command/SUID checkpoint remains written
before health or unsafe polling. During the G58 safe/projector loop, missed
rows are observed only for eventual evidence and are never reclassified. A
failure prints the final health snapshot and persists the report. The cohort
contract guard now has a red mutation for removing the delegated branch and a
red mutation for moving the unsafe-pass check ahead of the 5,000 ms bound.

### Fresh W102 cohort (one window, no stitching)

The only application window was run ID
`acc68d23-6133-446d-9470-e54fb3c28284`, UTC
`2026-09-03T09:37:48.552Z`–`09:40:59.730Z`, against the identity above. It
created one room and exactly ten reservations; each reservation was accepted
and its response/SUID was checkpointed before its first list poll. The actual
inter-commit gaps were 11,724–12,626 ms (required pace 10,000 ms). The raw
receipt and complete 91-health-snapshot sequence are
`.artifacts/sdt-g58-w102-safe-proof-cohort.json`; the failure/last-health
stderr is `.artifacts/sdt-g58-w102-safe-proof-cohort.log`.

| row | accepted (UTC) | SUID | unsafe disposition at 5,000 ms | eventual first unsafe | safe (commit→safe) |
| ---: | --- | --- | --- | --- | ---: |
| 1 | 09:38:02.926Z | `063924025082417000002050260075` | **miss** | 09:38:08.279Z (5,353 ms) | 114,733 ms |
| 2 | 09:38:15.002Z | `063924025094541000000759003421` | pass (2,195 ms) | — | 102,657 ms |
| 3 | 09:38:27.293Z | `063924025106891000001134410415` | **miss** | 09:39:57.159Z (89,866 ms) | 90,366 ms |
| 4 | 09:38:39.342Z | `063924025118818000001227710475` | pass (3,931 ms) | — | not reached |
| 5 | 09:38:51.968Z | `063924025130835000001712017963` | pass (1,923 ms) | — | not reached |
| 6 | 09:39:03.956Z | `063924025143589000001583316047` | pass (2,585 ms) | — | not reached |
| 7 | 09:39:15.794Z | `063924025155336000001551455796` | pass (3,265 ms) | — | not reached |
| 8 | 09:39:27.777Z | `063924025167387000000157375013` | pass (2,812 ms) | — | not reached |
| 9 | 09:39:39.835Z | `063924025179334000000956814733` | pass (2,289 ms) | — | not reached |
| 10 | 09:39:51.559Z | `063924025191103000001618685662` | **miss** | none before stop | not reached |

Rows 1, 3, and 10 are unsafe misses at the unchanged bound. Row 1's 5,353 ms
visibility is eventual-only; it is not an unsafe pass. Row 3's eventual
visibility at 89,866 ms is likewise observation-only. The raw receipt retains
all list observations, read heads, page counts, total counts, and CF-Rays.

### Health, safe-lane, and live-projection result

Every intervening health response is retained in the raw receipt with
coverage, reason, decayed lag, SafeWindow, MV heads, live heads, and global
head. There were 91 snapshots: 19 `SETTLED`/`reason=null` and 72
`BLOCK/UNSETTLED` with reason
`source_partition_set_changed_during_scan`. `safeWindowMs` was 20,000 in
every snapshot, `ceilingExceeded=false`, decayed lag ranged from 0 to 15,616
ms, and the largest current estimate was 17,708 ms. No 20 s/120 s bound or
polling deadline was changed.

Only rows 1–3 reached a ReservationProjector safe head. Their partial
nearest-rank safe values are p50 `102,657 ms` and p95 `114,733 ms` for n=3;
a full n=10 safe percentile is intentionally **undefined** because rows 4–10
did not reach a safe head. Each observed safe value is under the 180 s
contract, but each is slower than `safeWindowMs + 60 s = 80,000 ms`; the raw
intervals contain the `BLOCK/UNSETTLED` gate and are classified as
`coverage_BLOCK` residuals. The exact runner failure was:

```
safe lane or live projections did not reach 063924025118818000001227710475 by safeWindowMs + 120000ms
```

At the final snapshot (`09:40:59.722Z`), the global head and RoomProjector
safe head reached row 10, but ReservationProjector safe head stopped at row 3
(`063924025106891000001134410415`) with six unsafe rows. The live
RoomProjector head remained `063923933985284000000088451532` and the live
ReservationProjector head remained `063924022962293000001512609674`, both
behind the cohort. The safe/live failure occurred before projection-lag and
tag-state reads could be claimed, so no live-projector or cohort tag-state
success is asserted. This is a G58-owned blocked checkpoint for a focused
safe-lane/live-projection repair; no G15/G16 run was started after the failed
safe-proof window.

The first health snapshot was `09:37:49.090Z` (`SETTLED`, null reason,
`safeWindowMs=20,000`); the last health object is printed on the failure path
and retained in both the report and log. No evidence was stitched with W99,
and no additional application request was sent after this cohort failed.

### Checks and scope

- `npm run test:g58` — passed before the final unsafe-order correction; it
  covered the existing G44/G58 fixtures, production omission mutant, lag
  hygiene mutant, W100 receipt guard, and W97 witness.
- `node scripts/g58-cohort-evidence-guard.mjs --self-test` — passed after the
  correction, including red delegated-branch and red unsafe-order mutations.
- `node scripts/deploy/g58-safe-lane-e2e.mjs --self-test` — passed after the
  correction.
- `npm run typecheck` and `npm run lint` — passed after the correction.
- The W99 5,000 ms failed receipt remains unchanged; the W102 report's row-1
  late visibility is explicitly corrected to an unsafe miss/eventual-only
  observation.
- No Tag outbox, Queue producer/consumer/configuration, global admission
  batch, SDT-G53 naming, SDT-G55 semantics, SafeWindow bounds, G44 test, or
  SDT-G56/G60 publication state was changed.

## W103 safe/live starvation diagnosis — 2026-09-03 (red guard checkpoint)

W103 is a read-only diagnosis continuation of the committed W102 receipt. No
Wrangler operation, deployment, D1 mutation, application request, replacement
cohort, PR, or worker completion was performed. The W102 receipt remains the
only cohort evidence and is not stitched with any other window:
`.artifacts/sdt-g58-w102-safe-proof-cohort.json` (run
`acc68d23-6133-446d-9470-e54fb3c28284`). The derived guard receipt is
`.artifacts/sdt-g58-w103-red-guard.json`.

### Scheduled ticks, not HTTP samples

The raw receipt has 91 HTTP health samples but only four distinct scheduled
coverage `observedAt` values. The following table reports the first and last
state in each coverage group; all heads and row counts are retained in the
JSON guard receipt.

| coverage observedAt (UTC) | HTTP samples | coverage | Room safe head / unsafe rows | Reservation safe head / unsafe rows | live Room head / lastPollAt | live Reservation head / lastPollAt |
| --- | ---: | --- | --- | --- | --- | --- |
| 1788428250004 / 09:37:30.004Z | 5 | SETTLED / null | old / 0 → old / 1 | old / 0 → old / 3 | old / 1788426228497 | old / 1788426228497 |
| 1788428310641 / 09:38:30.641Z | 5 | SETTLED / null | row 2 / 1 → row 2 / 1 | row 2 / 4 → row 2 / 8 | old / 1788426228497 | old / 1788426228497 |
| 1788428377716 / 09:39:37.716Z | 72 | BLOCK/UNSETTLED / `source_partition_set_changed_during_scan` | row 2 / 1 → row 3 / 0 | row 2 / 9 → row 3 / 6 | old / 1788426228497 | old / 1788426228497 |
| 1788428437283 / 09:40:37.283Z | 9 | SETTLED / null | row 3 / 0 → row 10 / 0 | row 3 / 6 → row 3 / 6 | old / 1788426228497 | old / 1788426228497 |

Thus the 72 repeated BLOCK reads are one scheduled decision, not 72 cron
ticks. `safeWindowMs` stayed 20,000 ms; the largest raw estimate was 17,708
ms and the maximum decayed value was 15,616 ms. The final global head and
RoomProjector safe head are row 10
(`063924025191103000001618685662`). ReservationProjector is row 3
(`063924025106891000001134410415`) with six unsafe rows. Both reported live
heads remain behind the cohort and their `lastPollAt` never advances from
`1788426228497`.

### Diagnosis

The primary G58 AC5 cause is in the runtime scheduler. In
`packages/dcb-runtime/src/cloudflare.ts`, `scheduled()` invokes the sample's
`beforeLiveProjectionPoll` hook, then executes
`if (scan.kind !== "FULL") return;`. Consequently, the BLOCK tick performs the
fenced retained-frontier safe work but never calls `pollLiveProjections`; a
long BLOCK group can therefore starve every live projector. The focused green
repair seam is to run that poll after the retained-frontier pass on BLOCK while
preserving the G44 no-gap fence and the last proven frontier.

The MV divergence is per-view, not a global-head gap. The sample's
`catchUpMeetingRoomMaterializedViews` and `drainMeetingRoomUnsafeKicks` each
iterate materializers serially in RoomProjector → ReservationProjector order.
Queue delivery invokes the two view branches independently/concurrently. In
the receipt, Room has no remaining unsafe rows and can follow the settled
frontier to row 10; Reservation retains six unsafe rows and its safe follow
stops at row 3 at the first unsafe barrier. This proves the per-view starvation
shape while remaining honest about the lower-level CAS/lease winner: the
read-only health surface contains no exception field that would identify one.
`MaterializedViewCatchUpRuntime`'s first-unsafe return is preserved, so no
view can cross an unproven gap.

Even if a poll runs for some tag states, `ProjectionRuntime.pollRegistered`
walks every tag and registered projector serially, while the sample health
surface aggregates each projector's head and `lastPollAt` by the minimum across
its tag states. One stale state therefore keeps the reported live head/poll
behind; the W102 values are consistent with that minimum and with the BLOCK
early return. This is an aggregation/polling observability effect in addition
to the proven scheduler starvation, not evidence that the global source head
was unsafe.

The 5,289 ms late unsafe observation remains a miss against the unchanged
5,000 ms contract (eventual-only visibility, not a pass). W103 sends no new
sample and does not reclassify it or assign the upstream outbox/Queue/global
admission path to G58; that path remains held by SDT-G60.

### Red-capable guard and validation

`scripts/g58-safe-live-starvation-guard.mjs` parses the W102 receipt, derives
the four coverage groups and all per-view progress/heads/poll times, and checks
the source seams above. Its deterministic self-test proves red behavior for:

- removing the runtime BLOCK early return (the BLOCK model must then call the
  live poll);
- removing serial per-materializer catch-up or the first-unsafe SafeWindow
  barrier; and
- reversing minimum-across-tags head aggregation.

The normal guard intentionally records `status: "red-baseline"` because the
current runtime still skips the live poll on BLOCK. The existing W96 red
receipt, W97 same-tick green witness, G44 correctness test, SafeWindow
20,000/120,000 ms bounds, and 5,000 ms unsafe constant remain untouched.

Checks run:

- `node scripts/g58-safe-live-starvation-guard.mjs --self-test` — passed;
  runtime, serial-MV, first-unsafe, and minimum-aggregation mutants were
  rejected.
- `node scripts/g58-safe-live-starvation-guard.mjs` — passed as a recorded
  red-baseline diagnosis (`.artifacts/sdt-g58-w103-red-guard.json`).
- The W103 diagnosis guard and its red receipt remain preserved as historical
  evidence. W104's successor guard is wired into `npm run test:g58`; no
  product/runtime source, Queue/outbox/global admission path, G44 test, or
  published bound changed in the diagnosis unit.

This checkpoint is **completed** for the in-scope G58 AC5 diagnosis and
red-capable guard. A subsequent focused green-repair wake must address the
BLOCK live-poll seam and then re-verify safe/live behavior; W103 does not apply
that fix or recollect a cohort.

## W104 BLOCK live-projection green repair — 2026-09-03

W104 is a local, no-deploy continuation from the W103 checkpoint at
`5641a09066f7d4318da1d48e3187b37dafab7fd1`. It sends no application request,
starts no cohort, changes no D1 state, and does not open a PR or complete the
worker. The W103 red receipt
`.artifacts/sdt-g58-w103-red-guard.json` remains byte-preserved and records the
pre-fix `scan.kind !== "FULL"` early return. The new green receipt is
`.artifacts/sdt-g58-w104-green-guard.json`.

### Repair boundary and ordering

The Cloudflare-only scheduled entry point now executes the established order:

```
stabilizeDownstream → fresh G44 reconcile → beforeLiveProjectionPoll
  (sample retained-frontier safe catch-up/drain) → pollLiveProjections
```

The previous return after the hook was the W103 starvation defect. Every scan
outcome now reaches `pollLiveProjections`. A `FULL` scan passes
`maximumSuid=undefined`, retaining the established unbounded poll behavior. A
`BLOCK`/`UNSETTLED`, `UNKNOWN`, or `FAILED` scan passes only the frontier
returned by the hook from the persisted last proven FULL cursor; with no such
cursor it passes `maximumSuid=null`. `null` keeps the poll observable but makes
`ProjectionRuntime` advance zero source events. A source event above the
retained SUID is stopped before the SafeWindow check, so no unproven frontier
can be applied. The sample now returns its persisted `coverage.frontierSuid`
to the runtime after the retained-frontier hook completes.

The same optional fence is propagated through single-tag and all-tag polling.
Projection polling remains serial over tags and registered projectors, and
the minimum-across-tags health aggregation is untouched. The first-unsafe
SafeWindow barrier, 20,000 ms floor, 120,000 ms ceiling, 5,000 ms unsafe
constant, G44 source-partition fence, W97 same-tick ordering, and upstream
outbox/Queue/global-admission paths held by SDT-G60 are unchanged.

### Deterministic red/green proof

`test/g58-safe-lane-diagnosis.spec.ts` retains the W97 FULL and BLOCK safe-lane
order witnesses and adds a runtime `ProjectionRuntime` fixture. It proves that
a BLOCK poll applies only the retained SUID, a null frontier applies nothing,
and a FULL poll continues to apply the next event. It also proves the pure
scanner-to-fence mapping: FULL → `undefined`, BLOCK with a retained frontier →
that SUID, and BLOCK without one → `null`.

`scripts/g58-block-live-green-guard.mjs` checks the production source order,
the returned-frontier seam, all propagation points, and the retained frontier
fence. Its self-test is red-capable for three focused mutations: restoring the
W103 early return, replacing the scheduler fence with `undefined`, and
removing the `ProjectionRuntime` high-water check. The self-test also checks
the BLOCK/null/FULL plans and confirms the W103 red receipt remains a
pre-fix (`status=red-baseline`, `livePollCalled=false`) record. The normal
guard writes `.artifacts/sdt-g58-w104-green-guard.json` with `status=green`.

### Validation and scope

- `npm run test:g58` — passed, including the existing G44/G58 fixtures,
  production omission and lag-hygiene mutations, W100 evidence guard, the
  W97 witness, and W104's red-capable green guard (which also verifies the
  preserved W103 receipt).
- `npm run test:g44` — passed; the existing `test/g44-global-completeness.spec.ts`
  remains byte-unmodified and the production G44 mutation runner remains
  green with all four forced-red cases.
- `npm run typecheck` — passed.
- `npm run lint` — passed after the focused test/guard cleanup.

No SafeWindow bound, timeout, gate, G44 correctness fixture, deployment,
cohort, Wrangler operation, token, D1 reset, SDT-G56 state, or SDT-G60-owned
path changed. This W104 checkpoint is **completed** for the focused G58 AC5
BLOCK live-poll repair and is ready for a later deployed proof continuation.
