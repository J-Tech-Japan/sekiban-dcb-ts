# SDT-G40 CI throughput evidence

## Before measurement

The accepted baseline is the most recent full green `main` CI run before this
change: [run 33111555614](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/33111555614),
for commit `7d4caabd6a1f21d5bf7be72ec509f8e4a1f62d35`.

| Measure | Actions record |
| --- | --- |
| Run start | 2026-08-27T20:04:47Z |
| Run completion | 2026-08-27T21:50:06Z |
| End-to-end wall-clock | 1:45:19 (6,319 seconds) |
| Serial `verify` job | 1:45:15 |
| Parallel `cosmos-emulator` job | 2:05 |
| Dominant serial segment | SDT-G30 core lane plus its forced-red proof: 1:10:04 total, including 34:44 for the forced-red proof |

The pre-change run is a GitHub Actions record, not a reconstructed local
measurement. Its serial job is the reason the change partitions independent
lanes rather than altering their commands.

## Coverage-equivalence gate

`docs/evidence/SDT-G40-ci-step-inventory-baseline.json` is generated from
`origin/main:.github/workflows/ci.yml` and `origin/main:package.json` with:

```sh
node scripts/g40-ci-step-inventory.mjs --ref origin/main \
  --write docs/evidence/SDT-G40-ci-step-inventory-baseline.json
```

It records 89 workflow `run:` blocks and 174 recursively expanded command
entries. The PR-lane checker re-derives the current set from the working
`ci.yml` plus `package.json`:

```sh
node scripts/g40-ci-coverage-check.mjs
```

Local result before opening the PR: baseline 174 entries, current 179 entries,
zero missing entries, five allowed additions. The additions are only the G40
inventory checker, its mutation proof, the aggregate-needs checker (including
its self-test), and the cache-miss pinned Sekiban checkout command. No existing
check or forced-red probe is an allowed addition/removal trade.

The mutation proof is an executable forced-red check, not a prose assertion:

```sh
node scripts/g40-ci-mutation-proof.mjs
```

It replaces the real PR-lane `npm run test:g37:evidence` leaf in a temporary
valid workflow, invokes the checker with that temporary workflow, and observed
checker exit status **1**. The outer proof exits zero only after observing that
rejection. This remains in the PR CI lane.

## Required-context continuity

The aggregate job remains named `verify`. It has `needs` on every split job
(including `cosmos-emulator` and the inventory job), runs with `always()`, and
executes `scripts/g40-verify-needs.mjs`. That checker accepts only
`result == "success"`; a `failure` or `skipped` need makes the required
`verify` context red. Its independent self-test exercises success, failure,
and skipped results in the PR lane.

No branch-protection or ruleset setting is changed by this PR.

## Parallelization and cache design

The former serial `verify` work is partitioned into independent foundation,
G28, G21–25, G26–27, G29, G31, G32 parity, G30 core, G30 forced-red, G38, and
local-E2E jobs; the existing Cosmos emulator job stays a required parallel lane.
The separate G30 jobs are necessary because the baseline shows the core and its
forced-red proof each consume about 35 minutes but have no dependency. Each Node job has
the existing content-addressed npm cache plus a content-keyed `node_modules`
cache (`runner OS`, Node 24, `package-lock.json`, and `package.json`). Cache
misses run `npm ci`; no test command is conditional or skipped.

The G32 lane additionally caches the pinned Sekiban source checkout using the
parity runner/project content hash, and the NuGet/parity build graph using the
complete `tools/sekiban-parity/**` content hash. The runner still verifies the
pinned commit at execution time, so cache reuse cannot substitute a stale
source graph.

## After measurement

To be completed after the PR head has a full green GitHub Actions run. The
record will name the run id, head SHA, start/completion timestamps, wall-clock,
and the longest remaining split job. If the result exceeds 45 minutes, this
document will retain the complete result and name that dominant lane without
weakening coverage.
