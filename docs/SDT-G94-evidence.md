# SDT-G94 — G67 AC3 hosted timeout calibration

Issue: [#196](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/196)
PR: [#197](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/197)
Measurement head: `8a1d20fa896ba0a57069107a10e0af03b73034fe`
**Selected permanent ceiling: 12_000 ms**

Machine-readable census: [`docs/evidence/SDT-G94-ac2-census.json`](evidence/SDT-G94-ac2-census.json)

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

### Procedure disclosure

Independent review B1–B6 required a **clean predeclared eight-execution census** on a fresh immutable head. The prior run `35142847147` on `c6e7d6a` (fourteen attempts, incompatible censuses, expired early logs) was **not** rehabilitated.

**Predeclaration:** exactly eight `ci-foundation` executions on measurement head `8a1d20f`; all outcomes retained; no outcome-based discard or rerun.

**Procedure:**

1. Measurement tip commit `8a1d20f` sets AC3 Vitest budget and G73/G80 `budgetMs` to **20_000 ms** (observational only).
2. PR push triggered workflow [35162060007](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35162060007) on that SHA.
3. For each sample: wait for `ci-foundation` to complete; extract AC3 `SDT-G79_HOSTED_TEST_TIMING` for the ten-paced-commits test from the job log; append to [`docs/evidence/SDT-G94-ac2-census.json`](evidence/SDT-G94-ac2-census.json) (copy retained under host scratch).
4. Next sample on the **same SHA**: `gh run rerun 35162060007 --job <ci-foundation-databaseId>` (job-level rerun only). No workflow cancels were required; every foundation conclusion (including attempts 5 and 7 where G80 failed on the 20 s measurement tip) was retained.
5. Deduplication by job database id; no receipt counted twice.

Immutable measurement head: `8a1d20fa896ba0a57069107a10e0af03b73034fe`
Workflow run: [35162060007](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35162060007) (PR #197, attempts 1–8, same SHA)

| # | Attempt | ci-foundation job | AC3 state | Duration (ms) | Censored | Foundation | Semantic |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | [105014928783](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35162060007/attempts/1) | passed | 2_951 | false | success | all assertions green |
| 2 | 2 | [105018618610](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35162060007/attempts/2) | passed | 3_003 | false | success | all assertions green |
| 3 | 3 | [105021261701](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35162060007/attempts/3) | passed | 2_460 | false | success | all assertions green |
| 4 | 4 | [105023188626](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35162060007/attempts/4) | passed | 3_357 | false | success | all assertions green |
| 5 | 5 | [105025898564](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35162060007/attempts/5) | passed | 4_312 | false | failure | AC3 green; G80 oracle mismatch at 20 s tip |
| 6 | 6 | [105027510289](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35162060007/attempts/6) | passed | 3_054 | false | success | all assertions green |
| 7 | 7 | [105030084680](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35162060007/attempts/7) | passed | 4_591 | false | failure | AC3 green; G80 oracle mismatch at 20 s tip |
| 8 | 8 | [105031534682](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35162060007/attempts/8) | passed | 3_193 | false | success | all assertions green |

**Census summary:** 8/8 healthy AC3 observations uncensored at 20_000 ms. Max uncensored duration **4_591 ms**. No semantic assertion failures. No 20 s censoring. Instrument and document agree (`docs/evidence/SDT-G94-ac2-census.json`).

## AC3 — selection rule

Allowed ceilings: {12_000, 15_000} ms.

```text
max_uncensored_healthy_ms = 4591
required_min_ceiling     = ceil(1.2 × 4591) = 5510

12_000 ms: 12000 ≥ 5510 ✓ ; max observation 4591 ≤ 0.8 × 12000 = 9600 ✓
15_000 ms: also satisfies both rules but is not the smallest allowed ceiling
```

**Selected permanent ceiling: 12_000 ms** (smallest allowed value satisfying both rules).

## AC4 — semantics unchanged

At 12_000 ms AC3 still performs ten paced commits with cron disabled; each uses real commit, tag outbox, Queue delivery, kick, MV catch-up, and public safe-reader paths. No product source, iteration count, assertion, or real-work path removed.

## AC5 — regression discrimination at 12 s

G73/G80 guard `budgetMs` set to **12_000** (replacing G90's literal 10_000 ms oracle). Timeout oracle message derived from `budgetMs`. Healthy AC3 and calibrated G69-path representative proof recorded on final head (see AC6).

## AC6 — exact-head verification

Final head: *(populated after permanent-ceiling commit push)*

| Check | Status | Detail |
| --- | --- | --- |
| `ci-foundation` | pending | AC3 at 12_000 ms budget |
| `foundation-g73` | pending | `healthy-green-g69-path-timeout-red`; `budgetMs` 12_000 |
| Mutant timeout | pending | Named `Test timed out in 12000ms.` on hosted foundation |

## Scope fence

- No product/runtime changes.
- No other test budgets changed.
- No retries, flaky annotations, or skip config added.
- 20_000 ms existed only on measurement commit `8a1d20f`; not retained as permanent ceiling.
