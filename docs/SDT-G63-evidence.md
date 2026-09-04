# SDT-G63 evidence — G52 clock ownership

Task: `SDT-G63-ISSUE117-W135`
Issue: [J-Tech-Japan/sekiban-dcb-ts#117](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/117)
Branch: `claude/sdt-g63-issue117-w135`
Base: `origin/main` = `a41839ff8ba117244d55ffcf2ecffd4d3b8df051`

This is a local, test-only repair. No Wrangler, Cloudflare endpoint,
deployment, remote resource, or Cloudflare credential was used. The host
execution-unit claim for `SDT-G63` was supplied as owned for implementation;
the child issue claim was acquired before editing with the canonical
GitHub-only worker command. Its exact JSON receipt is
`.artifacts/sdt-g63-w135-child-issue-claim.json`.

## AC1 — reproduction before change

The exact target is:

```text
File: test/g52-resume-query.spec.ts
Title: SDT-G52 resume-only retained-log state > accepts a Worker-only snapshot root while retaining the Worker-row completeness gate
```

From the exact `origin/main` baseline, the complete package lane was run as:

```text
npm run test:g52
```

The clean worktree receipt records the full command expansion and environment
in `.artifacts/sdt-g63-w135-ac1-filewide-before.txt`. It exited `1` with
`1 failed | 17 passed` across four files and 18 tests. The target failed at
`resumeExactRayQuery` with:

```text
Error: g52-resume-query:paced state has no valid persisted cohort window
```

The complete isolated pass is in
`.artifacts/sdt-g63-w135-ac1-isolated-before.txt`; it ran the target alone,
passed `1` test, skipped the other two by the explicit name filter, and exited
`0`.

The cause is the two pre-change test-local assignments to the process-global
`Date.now`: the paced test in `test/g52-resume-query.spec.ts` and the
snapshot-breakdown test in `test/g52-commit-breakdown.spec.ts`. The later
Worker-only target did not supply a clock. Its capture path therefore used the
global clock for the warm-up and request timestamps. When the earlier async
clock owner overlapped the target-last schedule, the no-op target sleep and
immediate fixture responses could collapse the persisted window so
`cohortWindow.to <= cohortWindow.from`; the local resume helper then failed
closed. Isolated execution avoids the overlap and passes.

## AC2 — injected clock

The existing `createPacedResumeState` and `resumeExactRayQuery` APIs already
accepted `now`, but the shared `capturePacedCohort` →
`captureG50AppCommitLatency` request path did not. The minimum seam was added
there:

- `captureG50AppCommitLatency` accepts an optional `now` and passes it to its
  internal request timestamp boundaries.
- `capturePacedCohort` accepts and forwards the optional clock and uses it for
  `nextQueryAtMs`.
- The declarations expose the optional callback.
- When omitted, the helpers use a dynamic `Date.now()` fallback, preserving
  the existing default behavior for live callers.

Both G52 tests now use private closures over their local `clock` values and
pass that function explicitly. No production package, wire shape, timeout,
or CI configuration changed. The G52 test files also contain an `afterEach`
identity guard asserting that the platform `Date.now` function was not
replaced.

## AC3 — red before green and mutant

The pre-change red receipt is the AC1 file-wide receipt above. The final-source
global-override mutant receipt is
`.artifacts/sdt-g63-w135-ac3-final-global-override-mutant-red.txt`. It changed
the injected handoff to `now: Date.now = readNow`, intentionally reinstated a
process-global override, and exited `1`: the G52 identity guard reported
`G52 tests must not replace process-global Date.now` for all three resume-file
tests (`3 failed | 2 passed`). The mutant was reverted immediately through
`apply_patch`; the final source has no `Date.now =` assignment in either G52
test.

## AC4 — order independence

The complete receipt is
`.artifacts/sdt-g63-w135-ac4-order-evidence.txt`. All commands used the normal
parallel-capable Vitest defaults; none used `--no-file-parallelism`,
`--maxWorkers`, `--sequence.concurrent`, a timeout change, a skip, or a split.

| Run | Result |
| --- | --- |
| Target first, `--sequence.shuffle.tests --sequence.seed=3` | `3/3` pass |
| Target last, `--sequence.shuffle.tests --sequence.seed=1` | `3/3` pass |
| Target alone with exact title filter | `1` pass, `2` skipped by filter |
| Package file-wide `npm run test:g52` | `18/18` pass, including existing G52 guard commands |
| Reversed file selection | `18/18` pass |
| Randomized files and tests, `--sequence.shuffle --sequence.seed=117` | `18/18` pass |

## AC5 — unchanged scope and gates

The only implementation seam is in the G50/G52 deployment sampler helpers;
the behavior remains unchanged when no clock is supplied. The test changes
are limited to removing the global clock assignments, passing local clocks,
and adding the identity guard. No `package.json`, workflow, product package,
outbox/Queue path, Cloudflare configuration, or unrelated source changed.

The complete gate output is in `.artifacts/sdt-g63-w135-gates.txt`; every
command exited `0`:

| Gate | Result |
| --- | --- |
| `npm run test:g41` | PASS |
| `npm run test:g44` | PASS |
| `npm run test:g49` | PASS |
| `npm run test:g51` | PASS |
| `npm run test:g52` | PASS; 18 tests and existing snapshot guard |
| `npm run test:g53` | PASS; 10 tests and existing mutation checks |
| `npm run test:g54` | PASS; 18 tests and unchanged fixture/SHA protections |
| `npm run test:g55` | PASS; 12 tests |
| `npm run test:g58` | PASS; 14 tests and existing guards |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `git diff --check` | PASS |

## AC6/AC7 process evidence

The child issue claim receipt records `applied: true`, `proceed: true`, and
the added `intent-issue-in-progress` label before the branch edit. The branch
was created from fetched `origin/main` at the exact base above. The evidence
files and this document are intended to be included in the ready PR with
`Closes #117`; the final PR number, commit head, and worker completion JSON
are reported in the W135 handoff after push.

This unit remains local-only. No later unit was started.
