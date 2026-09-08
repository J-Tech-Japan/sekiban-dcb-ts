# SDT-G69 PR136 W168 shrink repair

Status: completed scoped shrink repair; exact-head hosted CI is terminal green.

- Repository: `J-Tech-Japan/sekiban-dcb-ts`
- PR: #136; issue #133 remains open and referenced
- Starting PR head: `ca404bb77ee9b79713d40cdf358478adc1c5c566`
- Repair source head tested by hosted CI: `54b87fdeae438cb262d92880d34da36ca8fcf400`
- Scope: G69 shrink only. No deployment, production cohort, Wrangler,
  Cloudflare resource operation, G32 operation, fence/SafeWindow/retry/drain
  change, or G67 assertion/timeout change.

## Repair

1. Restored the pre-G69 D1 lag-estimate predicate that excludes a delivery when
   a higher SUID already exists for the service. The public high-lag fail-closed
   behavior is therefore retained. `test/read.spec.ts` was not changed and its
   expected HTTP 500 remains green.
2. Added an explicit `runOrderingDetector` catch-up option for isolated proof
   tests, but disabled it on every production safe-lane trigger. Queue /
   delivery, fence-expiry, coverage-retry, and cron kicks retain the existing
   SafeWindow/frontier catch-up and do not execute the detector query. The
   existing in-batch strict-order check remains fail-closed when a lower row is
   directly present in the fetched source batch.
3. Kept the W167 admission-attempt receipt strictly off the awaited delivery
   path. It remains best-effort, bounded-retention, and diagnostic-only; it
   does not provide allocation closure or alter Queue disposition.
4. Updated the G69 guard/test so removal of the restored lag exclusion is red,
   the isolated scheduled-maintenance detector proof cost is measured, and
   Queue-triggered detector cost is explicitly zero. The WAKE-166
   false-positive cases and the four existing G69 mutant checks remain active.
5. The first exact-head CI run exposed two source-shape compatibility issues:
   the existing G19 detector proof now explicitly opts into the scheduled
   detector, and the non-detector `d1-mv` follow branch preserves the exact
   retained-frontier call shape required by the unchanged G58 W105 guard.

## Measured local costs and gates

- Focused G69 generation/public-reader proof: 7/7 passed. The scheduled
  detector query measured `0–1 ms` (`detectorCalls=1` on the two-event
  scheduled follow-up); the Queue-triggered pass recorded `0 ms`.
- `npm run test:g69`: passed; four mutants red: omitted late-lower detector,
  removed higher-SUID lag exclusion, omitted append-only receipt, and awaited
  diagnostic receipt.
- `npm run test:g67`: passed unchanged: 11/11 behavior tests and 7/7 mutation
  probes red. The 5,000 ms guard, assertion and timeout were not changed.
- `npm run test:g44`: passed: contract plus 8 tests; 4/4 G44 production
  mutants red.
- `npm run test:g46`: passed: 4 files/31 tests; 9/9 G46 production mutants
  red. `test/read.spec.ts` is unchanged and passes its expected HTTP 500.
- `npm run test:g60:required`: passed; direct, Queue, durable-hop, unsafe-writer,
  and post-admission guards remained green with their existing red mutants.
- `npm run typecheck` and `npm run lint`: passed with the scoped option and
  scheduled-path changes.
- After the compatibility repair, `test/d1-mv.spec.ts` passed 14/14,
  `scripts/g58-reservation-safe-starvation-guard.mjs` passed its self-test and
  post-change guard, and `npm run test:g44` passed its contract, 8 tests, and
  four red production mutants.
- Exact run `34192281814` then failed the unchanged G67 AC3 5,000 ms guard in
  foundation job `101952616110` at `test/g67-safe-lane.spec.ts:731`; this is
  the measured detector unaffordability receipt required by WAKE-168. The
  detector is therefore removed from the production cron path too; its
  isolated false-positive/ordering tests remain explicit and the G67 timeout
  remains unchanged.
- `npm run typecheck`, `npm run lint`, and `git diff --check`: pass after the
  scoped edits.
- Local NOSENTRY SQLite alarm/Hyperdrive diagnostics are environment output;
  they did not fail the focused suites. No aggregate timeout or gate change was
  used.

## Retained hosted CI evidence under C-14

The prior exact-head run `34188299398` at `ca404bb` is preserved as the reason
for this shrink:

- G46 public fail-closed regression: [job 101940978295](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34188299398/job/101940978295), step `Run SDT-G46 bounded TagState cache/replay lane` failed.
- G44 G67 5,000 ms guard timeout: [job 101940978323](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34188299398/job/101940978323), step `Run SDT-G67 event-driven safe-lane kick lane` failed.
- G43 C-14 exception: [job 101940978202](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34188299398/job/101940978202). The supplied packet labels this the G43 C-14 exception; GitHub metadata currently labels the job `ci-foundation`, and its log was unavailable while the run was still in progress. The discrepancy is recorded, not relabeled.

## Acceptance boundaries

AC4/AC5 remain outstanding. This is a local shrink repair, not deployed
acceptance evidence. The first-arrival fence, SafeWindow, retries, drain,
allocator-closure claims, G44/G62 frontier semantics, G67 budgets, G60
mutants, protected resources, and issue #133 status remain unchanged.

## Handoff

The exact-head hosted run
[34193530512](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34193530512)
tested repair source head `54b87fdeae438cb262d92880d34da36ca8fcf400` and is
terminal `SUCCESS`: 20/20 jobs, including aggregate `verify` job
`101966143727`, are green. Relevant required jobs include foundation
`101956289524`, G44 `101956289645`, G46 `101956289740`, G43
`101956289635`, and both G30 jobs `101956289691` and `101956289702`.
The two G30 jobs reached terminal success after the known long runner interval;
no C-14 failure or product assertion remained on the exact head.

This receipt is updated in an evidence-only follow-up after exact CI; the
follow-up changes no source or tests and only pins the terminal result. No
review, merge, closeout, deployment, or canonical worker transition is
performed here.
