# SDT-G94 — G67 AC3 hosted timeout calibration

Issue: [#196](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/196)
PR: [#197](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/197)
Measurement SHA: `c6e7d6a11e118142a79839b03253f2fd243ed5d0`
**Selected permanent ceiling: 12_000 ms**

## AC1 — baseline (fixed window through G93)

Evidence cutoff: 2026-09-16 16:04 UTC. Window: first G90 PR run `35076720269` through last completed G93 PR run `35119284935`.

**13 completed workflow records, 24 executed AC3 attempts.**

### Main pushes (3 attempts)

| Run | Attempt | AC3 outcome | Duration (ms) | Notes |
| --- | --- | --- | --- | --- |
| [35093945798](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35093945798) | 1 | over-budget fail | 10_411 | Broad slow run; unrelated tests also over 5 s |
| [35112861741](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35112861741) | 1 | **pass** | 5_066 | Later G80 `CALIBRATION_INCONCLUSIVE` (not AC3 failure) |
| [35117025761](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35117025761) | 1 | over-budget fail | 10_011 | Isolated G67 AC3 timeout |

Main over-budget rate: **2/3 (66.7%)**.

### Pull requests (21 attempts across 10 workflow records)

| Run | Attempt | AC3 outcome | Duration (ms) |
| --- | --- | --- | --- |
| [35105938197](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35105938197) | 1 | over-budget fail | 10_010 |
| [35105938197](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35105938197) | 2 | pass | 3_125 |
| [35109714437](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35109714437) | 1 | over-budget fail | 10_004 |
| *(other 18 PR attempts)* | 1 each | pass | ~2_900–8_472 |

PR over-budget (attempt-weighted): **2/21 (9.5%)**. PR first-attempt only: **2/10 (20%)**.

**Attribution notes:** G91 main AC3 passed; G80 calibration failed separately. G92 PR head `b5524c8` and merge push `6d67e16` were **not** the same SHA. Exact-SHA variance: G91 run `35105938197` failed at 10_010 ms then passed at 3_125 ms on rerun.

## AC2 — eight-run measurement census (20 s observational ceiling)

Immutable measurement head: `c6e7d6a11e118142a79839b03253f2fd243ed5d0`
Workflow run: [35142847147](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35142847147) (PR #197, attempts 1–8, same SHA)

| # | Attempt | ci-foundation job | AC3 state | Duration (ms) | Censored | Semantic |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | [104951388951](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35142847147/attempts/1) | passed | 2_864 | false | all assertions green |
| 2 | 2 | [104955265186](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35142847147/attempts/2) | passed | 3_480 | false | all assertions green |
| 3 | 3 | [104960517831](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35142847147/attempts/3) | passed | 2_957 | false | all assertions green |
| 4 | 4 | [104965849107](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35142847147/attempts/4) | passed | 3_507 | false | all assertions green |
| 5 | 5 | [104971038144](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35142847147/attempts/5) | passed | 2_953 | false | all assertions green |
| 6 | 6 | [104975004583](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35142847147/attempts/6) | passed | 3_282 | false | all assertions green |
| 7 | 7 | [104978911239](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35142847147/attempts/7) | passed | 7_872 | false | all assertions green |
| 8 | 8 | [104983730180](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35142847147/attempts/8) | passed | 9_460 | false | all assertions green |

**Census summary:** 8/8 healthy AC3 observations uncensored at 20_000 ms. Max uncensored duration **9_460 ms**. No semantic assertion failures. No 20 s censoring. Attempts 6–8 had workflow-level verify/cancellation noise from concurrent reruns; AC3 receipts retained from `SDT-G79_HOSTED_TEST_TIMING` on the measurement SHA.

## AC3 — selection rule

Allowed ceilings: {12_000, 15_000} ms.

```text
max_uncensored_healthy_ms = 9460
required_min_ceiling     = ceil(1.2 × 9460) = 11352

12_000 ms: 12000 ≥ 11352 ✓ ; max observation 9460 ≤ 0.8 × 12000 = 9600 ✓
15_000 ms: also satisfies both rules but is not the smallest allowed ceiling
```

**Selected permanent ceiling: 12_000 ms** (smallest allowed value satisfying both rules).

## AC4 — semantics unchanged

At 12_000 ms AC3 still performs ten paced commits with cron disabled; each uses real commit, tag outbox, Queue delivery, kick, MV catch-up, and public safe-reader paths. No product source, iteration count, assertion, or real-work path removed.

## AC5 — regression discrimination at 12 s

G73/G80 guard `budgetMs` set to **12_000** (replacing G90's literal 10_000 ms oracle). Timeout oracle message derived from `budgetMs`. Healthy AC3 and calibrated G69-path representative proof recorded on final head (see AC6).

## AC6 — exact-head verification

Final head: *(filled after final CI run)*

| Check | Status |
| --- | --- |
| `ci-foundation` | pending |
| `foundation-g73` (`healthy-green-g69-path-timeout-red`) | pending |
| lint / typecheck / timing validation | pending |

## Scope fence

- No product/runtime changes.
- No other test budgets changed.
- No retries, flaky annotations, or skip config added.
- 20_000 ms existed only on measurement commit `c6e7d6a`; not retained as permanent ceiling.
