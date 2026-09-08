# SDT-G69 PR136 W168 shrink repair

Status: local repair complete; exact-head hosted CI and terminal C-14
classification are required before rereview.

- Repository: `J-Tech-Japan/sekiban-dcb-ts`
- PR: #136; issue #133 remains open and referenced
- Starting PR head: `ca404bb77ee9b79713d40cdf358478adc1c5c566`
- Scope: G69 shrink only. No deployment, production cohort, Wrangler,
  Cloudflare resource operation, G32 operation, fence/SafeWindow/retry/drain
  change, or G67 assertion/timeout change.

## Repair

1. Restored the pre-G69 D1 lag-estimate predicate that excludes a delivery when
   a higher SUID already exists for the service. The public high-lag fail-closed
   behavior is therefore retained. `test/read.spec.ts` was not changed and its
   expected HTTP 500 remains green.
2. Added an explicit `runOrderingDetector` catch-up option. Only the scheduled
   `cron` maintenance pass enables the bounded late-lower detector. Queue /
   delivery, fence-expiry, and coverage-retry kicks retain the existing
   SafeWindow/frontier catch-up and do not execute the detector query. The
   existing in-batch strict-order check remains fail-closed when a lower row is
   directly present in the fetched source batch.
3. Kept the W167 admission-attempt receipt strictly off the awaited delivery
   path. It remains best-effort, bounded-retention, and diagnostic-only; it
   does not provide allocation closure or alter Queue disposition.
4. Updated the G69 guard/test so removal of the restored lag exclusion is red,
   scheduled detector cost is measured, and Queue-triggered detector cost is
   explicitly zero. The WAKE-166 false-positive cases and the four existing
   G69 mutant checks remain active.

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

The final pushed repair head and exact-head CI run/job terminal result will be
filled into this receipt after the scoped commit/push and C-14 polling. The
canonical worker/report transitions are separate from this artifact; no review,
merge, or closeout action is performed here.
