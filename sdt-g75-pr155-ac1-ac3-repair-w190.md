# SDT-G75 PR #155 AC1–AC3 repair — W190

Task: `SDT-G75-PR155-AC1-AC3-REPAIR-W190`

PR: [#155](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/155)

Starting exact head: `985d10e0c4f8d4606f4eb4a979a16c00d3c378c2`

Review repaired: [5153250295](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/155#pullrequestreview-5153250295)

## F1 — direct unmarked compatibility

`ProjectionRuntime.catchUp` now reads certificate and safe-context options only
when `requireClosedPrefixCertificate === true`. Direct unmarked calls therefore
ignore absent, null, irrelevant, and malformed certificate fields. The
positional `pollRegistered` API explicitly normalizes its unmarked branch to
the ordinary `maximumSuid` option, while marked calls retain the complete safe
options. No unmarked caller can acquire `ordering_certificate_unavailable`
from these fields.

## F2 — actual consumer binding

`validatedClosedPrefixSuid` now receives the actual `catchUp`/`pollRegistered`
`serviceId` and requires both the certificate identity and any supplied
`expectedServiceId` to match it. `safeViewCoverage.serviceId` is checked by the
same actual-consumer boundary. Direct safe probes with a service-B
certificate/expected context against service A fail before any service-A
checkpoint can be written.

## F3 — independent G44/G62 coverage context

Marked safe advancement now requires `SafeViewCoverageContext` with
`authority: "g44-g62"` and `startOfPass: "PROVEN"`. Missing or malformed
context fails with `ordering_coverage_unavailable`; a proven
`BLOCK/UNSETTLED` null frontier remains non-advancing. Explicit proven `FULL`
is the only context that permits an unbounded `maximumSuid`. `SETTLED` and
`BLOCK/UNSETTLED` frontiers are enforced independently of the existing G44
`maximumSuid` gate and the certificate closed-prefix gate. No G44/G62 scanner,
allocator, migration, recovery, or commit-outcome implementation was added.

## Scoped regressions and mutant proof

`test/g75-certificate-scope.spec.ts` now has 10 focused tests covering:

- direct unmarked `catchUp` and `pollRegistered` absent/null/malformed inputs;
- ordinary scheduled/diagnostic-style polling;
- missing certificate and foreign actual-consumer identity/context;
- missing coverage, null unsettled coverage, and explicit proven FULL;
- separate G44 `maximumSuid`, G44/G62 coverage-frontier, and certificate caps.

The existing product mutants remain unchanged and both are red:

| Mutant | Result |
| --- | --- |
| `omit-g44-settled-frontier` | `behavioral-product-mutant-red` |
| `omit-closed-prefix-certificate-gate` | `behavioral-product-mutant-red` |

`docs/SDT-G70A-evidence.md` was corrected to match direct-call behavior and to
describe the G44/G62 coverage/start-of-pass context separately from the
certificate cap. It includes the complete call-site classification and local
verification boundary.

## Local verification

| Check | Result |
| --- | --- |
| `npm run test:g75:certificate-scope` | Pass: runtime build, 10/10 focused tests, static guard, both product mutants red |
| `npm run typecheck --workspace @sekiban/dcb-runtime` | Pass |
| Changed-file ESLint (`--max-warnings=0`) | Pass |
| `git diff --check` | Pass |
| Direct affected G58 Vitest set | Pass: 5 files/15 tests |
| G44/G62 focused Vitest set | Pass: 2 files/11 tests |
| G44 contract check | Pass |
| Relevant G58 guards | Pass |

The aggregate `npm run test:g58` command was not claimed green: its unchanged
`build:packages` prelude stops on existing dcb-client/sample export drift
before running tests. The G62 guard self-test passed, but its normal oracle
resolves a missing worktree-local Vitest path and could not start. No bypass,
test relaxation, timeout change, or unrelated repair was made.

## Hosted verification

The repair was pushed to the existing non-draft PR #155 branch from the
required exact starting head. Hosted CI run
[`34344552925`](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34344552925)
completed successfully at exact head
`3d4d2669186baada80f4af032ce658a18dcb6c1`; all 21 jobs passed, including
`ci-g30-core`, `ci-g30-forced-red`, and the G75 lane in `ci-g44`. The separate
release preflight run
[`34344552824`](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34344552824)
also completed successfully at the same head. No publish, tag, deployment, or
credential operation is part of this task.

## Scope

Only the accepted PR #155 G75 F1–F3 findings are repaired. SDT-G76/G77
allocator, migration, recovery, and commit-outcome work is not started.
