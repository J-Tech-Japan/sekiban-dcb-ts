# SDT-G58 diagnose + red guard checkpoint (W96)

Status: **completed checkpoint** (diagnosis and red-capable guard only). This
wake sent no application requests, ran no cohort, deployed nothing, opened no
PR, and did not complete the worker.

## Identity and evidence boundary

- Branch: `claude/sdt-g58-safe-lane-w93`.
- Starting checkpoint: `9b21259917a52da602c50781ccde0067193e3cbd`.
- W95 run: `5588d9cc-b508-41f4-a332-f6464721e747`.
- Raw source: `.artifacts/sdt-g58-ac2-cohort-checkpoint-w95.json`.
- Deployment and cohort identity are unchanged from W95; no Wrangler command
  was needed in this diagnosis wake.

## W95 facts reproduced from raw receipt

- 42 health snapshots all reported `coverage.kind=SETTLED`,
  `coverage.reason=null`, and `lag.safeWindowMs=20000`.
- Scheduled observations were 07:58:35.669Z, 07:59:35.261Z, 08:00:47.143Z,
  and 08:02:51.116Z UTC. The ReservationProjector safe head advanced only
  through row 4 (`063924019239189000001227397085`) and remained there at the
  final 08:02:51.116Z observation; six older eligible cohort rows remained
  unsafe.
- Global head reached row 10, but RoomProjector and ReservationProjector live
  heads remained pre-cohort in the terminal health response. The exact W95
  failure was:

  ```text
  safe lane or live projections did not reach 063924019251513000000760677805 by safeWindowMs + 120000ms
  ```

## Diagnosis

The exact in-scope defect is **scheduled execution ordering**. The sample
Worker reads the prior persisted coverage frontier, invokes safe MV catch-up
and unsafe-kick draining with that frontier, and only then invokes generic
runtime scheduled work. The generic runtime performs the fresh G44 scan and
then live-projection polling. Thus the fresh FULL frontier is not applied to
the safe lane until a later tick. `MaterializedViewCatchUpRuntime.follow()` is
correctly conservative: it honors the maximum-SUID fence and stops at the
first event still inside SafeWindow, so this is not a gap-skipping or follow
ordering defect. Live polling is downstream/deferred; its serial all-tag loop
and minimum-across-tags health projection also prevent the terminal minimum
head from proving a distinct poll corruption.

The relevant code is preserved at:

- `samples/meeting-room/src/worker.cloudflare-only.ts:76-101` — persisted
  coverage, catch-up/drain, then generic work;
- `packages/dcb-runtime/src/cloudflare.ts:343-353` — fresh reconcile, then
  `pollLiveProjections` only after FULL;
- `packages/dcb-runtime/src/mv/MaterializedViewCatchUp.ts:186-207` —
  first-unsafe-event and `maximumSuid` fences;
- `packages/dcb-runtime/src/projection/ProjectionRuntime.ts:229-240` —
  serial tag/projector polling;
- `samples/meeting-room/src/d1-mv.ts:375-389` — minimum checkpoint/poll
  aggregation in the health surface.

## Red-capable guard

Added `test/g58-safe-lane-diagnosis.spec.ts`, an intentional baseline-red
same-tick frontier witness. It records the stale-frontier → catch-up/drain →
fresh-scan order and requires the safe head to reach the newly scanned FULL
frontier in that same tick. On the starting baseline it failed with:

```text
Expected: "062135596800000001014284255396"
Received: "062135596800000000425462603235"
```

Added `scripts/g58-safe-lane-diagnosis-guard.mjs`, which runs that fixture,
requires a non-zero baseline exit, and preserves complete output in
`.artifacts/sdt-g58-w96-red-guard.json`. The observed guard result was:

```json
{"guard":"g58-w96-same-tick-frontier","status":"red-baseline","report":".artifacts/sdt-g58-w96-red-guard.json","exitCode":1}
```

The package `test:g58` lane now runs the diagnosis guard self-test, while the
expected-red witness remains separately runnable via `npm run diagnose:g58`.
The existing G44 test and all existing G58 guards are unchanged.

## Unsafe-observation classification

W95 row 1 was not visible at commit+2,347 ms and was first observed visible at
commit+5,289 ms. The polling loop elapsed 4,974 ms with approximately
two-second sampling, so the actual visibility transition lies between those
observations; 5,289 ms is an upper-bound observation, not a measured crossing
time. This is **indeterminate at the existing sampling/harness resolution**,
not evidence sufficient to call a product violation. The <=5,000 ms limit is
retained unchanged; row 10 remains exactly 5,000 ms and no timing was imputed.

## Changed paths and boundary

- `test/g58-safe-lane-diagnosis.spec.ts`
- `scripts/g58-safe-lane-diagnosis-guard.mjs`
- `package.json` (diagnosis lane and G58 self-test wiring)
- `.artifacts/sdt-g58-w96-red-guard.json`
- `docs/SDT-G58-evidence.md`
- `.g58-w93/sdt-g58-diagnose-red-guard-w96.md`

No product source, SafeWindow bound, timeout, gate, G44 test, cohort data,
deployment, SDT-G56 issue, PR, or worker lifecycle state was changed.
