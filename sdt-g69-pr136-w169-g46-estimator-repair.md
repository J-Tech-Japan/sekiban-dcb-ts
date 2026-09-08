# SDT-G69 PR136 W169 G46 estimator repair

Status: **blocked at the hosted-CI checkpoint**. The scoped repair is pushed at
`29d48b790af6f6834132b3a5d527d14185daf5ad`. The repaired G46 contract lane is
green, but the exact-head `ci-g46` job has not reached a terminal state because
its forced-red reachability step is still running; the exact-head run also has
the known G30/G32 runner steps still in progress.

## Scope and invariants

- Repository: `J-Tech-Japan/sekiban-dcb-ts`
- PR: [#136](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/136)
- Branch: `claude/sdt-g69-local-ordering-proof-w164`
- PR base: `3f6df6433c6e6cc7e16ea26f0fc8ac32e39f5809`
- Starting evidence head: `20a036afa6ac73dae62806bfdc1fff0cfb740f82`
- Repair source/test head: `29d48b790af6f6834132b3a5d527d14185daf5ad`
- Issue #133 remains open; AC4/AC5 remain outstanding.

No deployment, Wrangler, Cloudflare/resource, fence, SafeWindow, retry, drain,
G67 assertion/timeout, or SDT-G46 test change was made. `test/read.spec.ts`
remains byte-for-byte unchanged from the PR base. The W169 unconditional
default-path pre-apply `ORDER_VIOLATION` guard remains intact. The optional
late-lower query remains proof-only/off production paths.

## Hosted G46 failure and diagnosis

The prior exact-head failure was
[ci-g46 job 101991535429](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34204752791/job/101991535429)
in run `34204752791`. Its unchanged `test/read.spec.ts` high-lag guard failed
with:

```text
test/read.spec.ts (7 tests | 1 failed)
fails closed with Section 6 JSON when a current lag estimate exceeds 120 seconds
AssertionError: expected 200 to be 500
Expected -500, Received +200
test/read.spec.ts:125 and test/read.spec.ts:370
Test Files 1 failed | 3 passed (4)
```

The exact repository comparison does not show a remaining G69 lag-estimator
semantic delta in `D1EventStore`: the current source and PR base both exclude
higher-SUID prior rows and both update the incoming clock with
`observed_at = excluded.observed_at`. That restoration was already present in
the W169 source commit `1c974fee541932f00d2ceaf1cc7e870d8eb6edcb`; this
checkpoint adds a guard so it cannot regress.

The hosted 200/500 result is not reproduced locally. The test has only a
1,000 ms margin above its 120,000 ms threshold, while the public read creates
and initializes another Postgres store before observing the estimate. The
available hosted log does not expose a public-boundary estimator snapshot, so
this remains a bounded timing-sensitive hypothesis, not a claim that G69
caused a product semantic change. No test expectation was changed.

## Scoped repair

1. `test/g69-ordering.spec.ts` now exercises the production `D1EventStore`
   record-delivery path with a newer-SUID sample whose incoming observed clock
   moves backwards. It asserts the unchanged PR-base result: the estimate
   remains `5000`, while `observed_at` is the incoming `1000`.
2. `scripts/g69-ordering-guard.mjs` now includes the red-capable
   `restore-monotonic-lag-observed-at` mutant, replacing the restored
   `excluded.observed_at` with `MAX(previous, excluded)`. The guard fails under
   that mutant, proving reintroduction of the residual D1 semantic change is
   detected.
3. No D1 product code, public-read test, G46 test, fixture, timeout, or
   acceptance contract was changed in this repair.

## Local evidence

- `npm exec vitest run --config vitest.g69.config.ts --maxWorkers=1 --no-file-parallelism test/g69-ordering.spec.ts` — **8/8 passed**.
- `npm exec vitest run --config vitest.g69.config.ts --maxWorkers=1 --no-file-parallelism test/g69-ordering.spec.ts --testNamePattern 'lag estimate'` — **8/8 passed**.
- Direct red proof with the temporary `MAX(previous, excluded)` estimator mutation — **failed as required** at `test/g69-ordering.spec.ts:544`: expected `observed_at=1000`, received `5000`; the mutation was restored immediately.
- `node scripts/g69-ordering-guard.mjs --self-test` — **passed**; all six mutation anchors are unique.
- `node scripts/g69-ordering-guard.mjs` / `npm run test:g69` — **passed**; all six mutants exited nonzero/red, including `restore-monotonic-lag-observed-at`, `omit-unconditional-batch-order-guard`, `omit-late-lower-suid-detector`, `restore-higher-suid-lag-exclusion`, `omit-append-only-admission-receipt`, and `await-diagnostic-receipt-on-core-path`.
- `npm exec vitest run --config vitest.config.ts --maxWorkers=1 test/read.spec.ts` — **7/7 passed** locally; the unchanged high-lag assertion remains HTTP 500 locally.
- `npm run test:g46` — build, contract/self-test, and the four-file Vitest phase **31/31 passed**; the existing `g46-tagstate-mutation-runner.mjs` then produced no further output and was terminated with Ctrl-C, exit 130. This is recorded as an environment/runner exception, not as a green aggregate result.
- `git diff --check 3f6df6433c6e6cc7e16ea26f0fc8ac32e39f5809...HEAD` and the scoped worktree diff check — **clean** before the repair commit.

Pre-existing dirty and untracked evidence was preserved and was not staged.
The guard-generated `.artifacts/sdt-g69-ordering-red-green.json` and all other
unrelated dirt remain outside this checkpoint.

## Exact-head hosted CI

Pushing `29d48b7` triggered run
[34206921666](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34206921666).
At the evidence cutoff the following relevant jobs were terminal success:

- `ci-foundation` — [job 101998464482](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34206921666/job/101998464482)
- `ci-local-e2e` — [job 101998464537](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34206921666/job/101998464537)
- `ci-g26-g27` — [job 101998464638](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34206921666/job/101998464638)
- `ci-g43` — [job 101998464641](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34206921666/job/101998464641)
- `ci-g28` — [job 101998464699](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34206921666/job/101998464699)
- `ci-g41` — [job 101998464723](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34206921666/job/101998464723)
- `ci-g45` — [job 101998464791](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34206921666/job/101998464791)
- `ci-g42` — [job 101998464851](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34206921666/job/101998464851)
- `ci-g38` — [job 101998464970](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34206921666/job/101998464970)
- `ci-coverage` — [job 101998465199](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34206921666/job/101998465199)
- `cosmos-emulator` — [job 101998465333](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34206921666/job/101998465333)

The repaired `ci-g46` job is [101998464985](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34206921666/job/101998464985).
Its main `Run SDT-G46 bounded TagState cache/replay lane` is green; the job
remains `in_progress` at `Prove SDT-G46 forced-red CI reachability`, so there
is no terminal G46 conclusion to report. `ci-g30-core` [job
101998464591](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34206921666/job/101998464591),
`ci-g30-forced-red` [job
101998464561](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34206921666/job/101998464561),
`ci-g32-parity` [job
101998464907](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34206921666/job/101998464907),
`ci-g44` [job
101998464649](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34206921666/job/101998464649),
and `ci-g21-g25` [job
101998464685](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34206921666/job/101998464685)
were also still in progress at the cutoff. The run is therefore **blocked**
pending terminal hosted classification; no hosted failure has been attributed
to this scoped guard/test repair.
