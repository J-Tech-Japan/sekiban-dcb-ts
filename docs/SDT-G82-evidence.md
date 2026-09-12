# SDT-G82 hosted budget evidence

## Predeclared AC1 measurement plan

Declared before the first fresh hosted measurement on 2026-09-11:

* Target exact head: `102d65f545292634cc43022ad4ebb3e0f2adc877`.
* Target workflow run: `34548851696` (CI), whose `ci-foundation` job is the
  one-job target for this measurement; no other job is to be rerun.
* Fresh sample: three sequential job-level reruns of `ci-foundation` only,
  retaining every resulting run attempt and URL. The first rerun is sample 1,
  followed by sample 2 and sample 3 only after the preceding attempt reaches a
  terminal state.
* Each sample will report both SDT-G79 timing invocations for
  `test/g71-composition.spec.ts` (the `npm test` invocation and the explicit
  `test:g71` invocation), the job's `npm-test` phase total, terminal result,
  exact head, job identity, and an estimated cost of about 8 billable minutes.
* No whole workflow dispatch, unrelated job rerun, release preflight, or
  measurement replacement is permitted by this plan.

The historical baseline records named by issue #166 will remain alongside the
fresh samples; no receipt will be overwritten or relabelled.

## AC1 collected measurements

The declared plan above was executed exactly as written. All three samples
are job-level reruns of `ci-foundation` only, at exact head
`102d65f545292634cc43022ad4ebb3e0f2adc877`; no whole workflow was dispatched
and no unrelated job was rerun. Each job was approximately 8 billable minutes
under the hosted accounting budget. Every sample is retained:

| Sample | Workflow / attempt | ci-foundation job | Job receipt | `npm test` phase | Named composition in `npm test` | `test:g71` phase | Named composition in `test:g71` | Result |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| 1 | [34548851696 attempt 3](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34548851696/attempts/3) | [103476567532](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34548851696/job/103476567532) | 6m38s | 147,936 ms | 897 ms | 7,051 ms | 874 ms | success |
| 2 | [34548851696 attempt 4](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34548851696/attempts/4) | [103477682638](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34548851696/job/103477682638) | 6m18s | 122,492 ms | 864 ms | 5,672 ms | 795 ms | success |
| 3 | [34548851696 attempt 5](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34548851696/attempts/5) | [103478658269](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34548851696/job/103478658269) | 6m04s | 140,168 ms | 2,274 ms | 6,213 ms | 1,188 ms | success |

The named rows are the SDT-G79 reporter's per-test `durationMs`; the phase
values are its run-summary `durationMs` for the corresponding invocation.
The three fresh jobs ran through the unchanged foundation sequence, including
the G71 proof and G73 guard, and each ended with normal process success.

The issue's historical baseline is retained separately: PR #161 at
`037eb9ff` (run `34516970598`) measured 990 ms / 1,049 ms; PR #161 at
`7c9d5787` (run `34544744250`) measured 937 ms / 894 ms; and main
`102d65f5` (run `34548851696` attempt 1, `ci-foundation` job
`103107269918`) measured 1,408 ms in `npm test` and then 5,887 ms in the
explicit G71 invocation, where the inherited 5,000 ms timeout failed. These
historical records are not replaced by the fresh reruns.

Across the 12 named observations, the median is 963.5 ms, the fresh maximum
is 2,274 ms, and the historical maximum is 5,887 ms. The fresh `npm-test`
phase totals (122,492–147,936 ms) also identify the runner-wide context; the
historical failure occurred during a 71.5-second npm-test phase versus about
42 seconds on the comparison run. The data shows the known inherited-default
boundary on a slow runner, not a changed composition assertion or a new
product defect.

## AC2 budget decision and basis

This unit chooses the permitted written per-test option, not cheaper work.
`test/g71-composition.spec.ts` now uses `}, 10_000);` for the named
composition test only. The 10,000 ms budget leaves 4,113 ms above the
historical worst named duration of 5,887 ms (about 1.70x the worst observed
work) and 7,726 ms above the fresh maximum of 2,274 ms. It leaves roughly
10.4x the 963.5 ms median. No global Vitest timeout, CLI timeout, or other
test budget changed.

The reporter's `workBasis()` entry for `g71-composition` is:

> two real SELF.fetch commits, scoped Tag deliveries through the sample worker.queue, SafeWindow hold and logical-clock release, safe and unsafe reads through the executor and sample route

This describes the genuine work that costs time on a hosted runner. The
budget is not justified by the default or by a lucky green run; it is the
smallest issue-authorized candidate that covers the retained slow-run receipt
while preserving the named proof.

## AC3 and AC4 scope preservation

The composition body remains byte-for-byte unchanged apart from its explicit
per-test timeout. It still performs real commits A and B, Queue delivery,
SafeWindow hold/release, safe page 1 and empty safe page 2 observations,
unsafe page observations, and released convergence to SUID_B. Both G71
composition mutants continue to target the named assertion rather than a
timeout; the six other G71 mutants and `test/g67-safe-lane.spec.ts` are
outside this diff. No lane was removed or reordered, and no retry, skip,
flaky marker, product behavior, or global timeout changed.
