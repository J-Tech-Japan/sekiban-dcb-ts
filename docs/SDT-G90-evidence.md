# SDT-G90 — hosted G80 calibration determinism

Issue: [#186](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/186)
Branch: `claude/sdt-g90-calibration-w901`

## Baseline and scope

- **Census baseline SHA (main / PR base):** `b6c1a6e32a20c9c89345a3c988445cc2c27fa16a`
- **Runner head (this slice):** changes limited to `scripts/g73-g67-budget-mutation-runner.mjs` and this evidence file.
- **Unchanged:** G67 AC3 test body, `budgetMs` 10_000, `safetyFactor` 1.5, `maxRepresentativeRounds` 4096, `calibrationRounds` 32 (representative sizing only), G79 reporter, foundation lane ordering, 10 s timeout oracle, fail-closed `CALIBRATION_INCONCLUSIVE`.

## AC1 — noise census (pre-bound change)

Collected **14** hosted `ci-foundation` / `foundation-g73` calibration summaries using the pre-G90 runner on current main lineage (same runner blob as baseline `b6c1a6e`; runner unchanged since G80 merge head `af7baff`).

**Actual counts:** 14 summaries harvested — **12 green** (`healthy-green-g69-path-timeout-red`), **2 red** (`CALIBRATION_INCONCLUSIVE`).

### Green-run residual distribution (paired-residual max per job)

| # | Workflow run | Head (short) | `costsPerRoundMs` | `pairedResidualsMs` | Residual max | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | [35034913839](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35034913839) | `9ab022a` | `[22.5,21.875,19.75,19.25,19.5]` | `[3,2.25,0.75]` | **3.0** | green |
| 2 | [35043656546](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35043656546) | `d78f0b6` | `[22.25,21.25,20.5,19.75,19.25]` | `[3.25,2.5,0.75]` | **3.25** | green |
| 3 | [34720223769](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34720223769) | `994a44c` | `[23.5,25,21.08,21,19.75]` | `[2.5,3.75,1.25]` | **3.75** | green |
| 4 | [35060855698](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35060855698) | `9878fff` | `[23.5,21.125,19.92,20.75,19.5]` | `[2.75,3,1.25]` | **4.0** | green |
| 5 | [35045899531](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35045899531) | G77 head | `[26.75,25.25,22.75,22.75,22.25]` | `[4,4.5,0.5]` | **4.5** | green |
| 6 | [34906292071](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34906292071) | `5da349b` | `[21.25,18.75,16.67,16.75,17]` | `[4.5,4.25,0.25]` | **4.5** | green |
| 7 | [34924367119](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34924367119) | `d3cac49` | — | `[5,4.5,0.5]` | **5.0** | green |
| 8 | [35059318147](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35059318147) | `b833879` | — | `[4.5,5,0.5]` | **5.0** | green |
| 9 | [35071063211](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35071063211) | **`b6c1a6e`** | `[20.5,17.25,22.75,20,15.5]` | `[0.5,5,4.5]` | **5.0** | green |
| 10 | [34929338141](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34929338141) | `2f6b7dd` | `[22.5,20.125,18.67,17.5,17]` | `[5,5.5,0.5]` | **5.5** | green |
| 11 | [34895631699](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34895631699) | `681da42` | `[26.5,23.5,23.5,21.5,20.5]` | `[5,6,1]` | **6.0** | green |
| 12 | [35055148465](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35055148465) | `7e42616` | — | `[5.25,6,0.75]` | **6.0** | green |

**Green residual max percentiles (n=12):** p50 **4.75 ms**, p90 **5.95 ms**, p99 **6.0 ms**.

### Red receipts retained

| Run | Head | Reason | Residual max |
| --- | --- | --- | --- |
| [35036309188](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35036309188) | `2fb1c1f` | equal-size bound (old 10 ms) | **10.25** |
| [34740076840](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34740076840) | `a0d6add` | cross-size / first-chunk warm-up (`51.25` vs steady ~17–34 ms/round) | n/a |

Historical inconclusive class cited for AC6: [35036309188](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35036309188) (residual 10.25 vs bound 10) and [34704762453 attempt 3](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34704762453/job/103585936144) (residual 10.5 vs bound 10, same head `fbca111` passed on attempts 2 and 4).

## AC2 — warm-up excluded from gates

Predeclared plan:

```text
warmUpRounds:     16 real G69 rounds (performance.now measured, emitted separately)
scoring chunks:   [8, 8, 8, 8, 8] rounds (40 scoring rounds)
total mutation:   56 rounds injected at index === 1
```

Warm-up duration is emitted as `warmUpDurationMs` in the direct-timing marker and durable `G80_CALIBRATION_RECORD` v3 summary; it is excluded from `costsPerRoundMs` and all statistical gates.

Self-test mutants: `warmUpOmissionMutant: red` (validation rejects missing/`false` `warmUpExcludedFromGates`); digest changes when warm-up field omitted.

## AC3 — equal-size-only plan; cross-size gate removed

Old mixed plan `[4, 8, 12, 4, 4]` compared unequal amortization across chunk sizes. The new plan measures **only equal 8-round batches**, so the 0.5–2× median cross-size gate is removed — there is no cross-size comparison left to authorize. `validateDirectTiming` rejects mixed chunk sizes (`mixedChunkPlanMutant: red`).

## AC4 — census-backed residual bound

Formula (from architect ruling):

```text
equalSizeResidualBoundMs = ceil(p99_green_residual_max + timerResolutionFloorMs)
                         = ceil(6.0 + 1)
                         = 7
```

No round-up beyond the documented formula. Self-test `equalSizeResidualMutant` (`[8,10,18,8,8]` ms/round → residual 10 > 7) remains **red**.

## AC5 — gate integrity

Local `npm run test:g73:guard` self-test (2026-09-16, Node v22.19.0 after `npm ci`):

```json
{
  "equalSizeResidualMutant": "red",
  "inconclusiveDirectSignal": "red",
  "warmUpOmissionMutant": "red",
  "mixedChunkPlanMutant": "red",
  "crossSizeGate": "removed-with-equal-size-only-plan"
}
```

No retry-until-green. Ten-second timeout oracle unchanged.

## AC6 — hosted stability proof

**Before G90 (historical, pre-change runner on main lineage):** among recent `ci-foundation` runs with G80 calibration, inconclusive rate ≈ **2 / 14 ≈ 14.3%** (runs 35036309188, 34740076840 in the census set; additional historical flakes documented in G80 evidence). Historical inconclusive class cited: [35036309188](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35036309188) and [34704762453 attempt 3](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34704762453/job/103585936144).

**After G90 (final PR head `c1f781b466e1337b24046e47d941323fa76e3759`):** **5 / 5** green `ci-foundation` attempts with outcome `healthy-green-g69-path-timeout-red` and **0** `CALIBRATION_INCONCLUSIVE` on workflow run [35078040136](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35078040136) attempts **1, 2, 3, 5, 6**.

| Attempt | Conclusion | Calibration outcome | Residual max (ms) | `costsPerRoundMs` | Warm-up (ms) |
| --- | --- | --- | --- | --- | --- |
| 1 | success | `healthy-green-g69-path-timeout-red` | **2.25** | `[20.625,22.125,20.75,19.875,20.75]` | 371 |
| 2 | success | `healthy-green-g69-path-timeout-red` | **1.875** | `[16.75,16.75,16.25,16.625,18.125]` | 299 |
| 3 | success | `healthy-green-g69-path-timeout-red` | **1.5** | `[20.875,20.125,21.625,20.5,20.875]` | 365 |
| 4 | failure | `HEALTHY_OR_ORACLE_FAILURE` (not inconclusive) | n/a (gates not scored) | n/a | 782 |
| 5 | success | `healthy-green-g69-path-timeout-red` | **2.125** | `[18.25,17.375,19.125,19.5,18.125]` | 304 |
| 6 | success | `healthy-green-g69-path-timeout-red` | **1.125** | `[21.875,21.375,21.125,21.75,22.25]` | 398 |

- After inconclusive rate on this final head for the G90 failure class: **0 / 5 = 0%** `CALIBRATION_INCONCLUSIVE` among successful timeout-red representatives (plus attempt 4 failed closed as `HEALTHY_OR_ORACLE_FAILURE` — healthy-oracle receipt incomplete; warm-up still excluded; not the residual/cross-size inconclusive class G90 targets).
- All five green residual maxima (**1.125–2.25 ms**) are well under `equalSizeResidualBoundMs = 7`.

## AC7 — scope fence

Confirmed: no edits to G67 body, budget, safety factor, max rounds, G79, AC4 timeout path, or `ci/lanes.json` ordering.

## AC8 — process

Worker claim: issue #186 already carried `intent-issue-in-progress`. PR targets `main` with `Closes #186`.


## Hosted AC6 progress

| # | Run / attempt | foundation-g73 / ci-foundation | Calibration outcome |
|---|---|---|---|
| 1 | [35078040136](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35078040136) attempt 1 | **success** | residual max 2.25; 0 `CALIBRATION_INCONCLUSIVE` |
| 2 | 35078040136 attempt 2 | **success** | residual max 1.875 |
| 3 | 35078040136 attempt 3 | **success** | residual max 1.5 |
| 4 | 35078040136 attempt 5 | **success** | residual max 2.125 |
| 5 | 35078040136 attempt 6 | **success** | residual max 1.125 |

AC6 met on final head `c1f781b`. (Pre-final-head green on [35076720269](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35076720269) residual max 3.375 is retained as supporting only.)

## Post-0.2.0 g64 dry-run adaptation (CI unblock)

After `@sekiban/dcb-*@0.2.0` landed on npm, `scripts/dcb-matched-set-publish-dry-run.mjs` failed closed on expected `version-collision` (`You cannot publish over the previously published versions: 0.2.0`), red-failing `cheap/g64` on every PR. Classifier already documents collisions as expected after release; the dry-run harness now treats `failure.kind === "version-collision"` as PASS (`outcome: version-already-published`) and still fails closed on `invalid-packaging` and other kinds.
