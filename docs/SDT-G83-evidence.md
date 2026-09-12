# SDT-G83 hosted budget evidence

This document records the SDT-G83 measurement-before-choice process. The
contract is the published issue #167; no budget is changed until the fresh
hosted observations below have been collected.

## AC1 predeclared hosted measurement plan

Declared before the first measurement rerun on the dedicated G83 branch:

- Target repository: `J-Tech-Japan/sekiban-dcb-ts`.
- Base: `origin/main` at `fc35a382bc67ac930776a5a6b52ae10699ce972d2`.
- Measurement source: the exact branch head used for the initial PR workflow;
  its final SHA is recorded with the receipts below.
- Workflow: `CI`; source job: `ci-foundation`, historical job identity
  `103509892567` from main run `34675690179` at the same source head.
- Collection plan: three fresh `gh run rerun --job` invocations for that one
  job, declared as runs M1, M2 and M3 before M1 starts. No whole workflow is
  dispatched and no unrelated job is rerun.
- Each receipt will retain workflow run ID, attempt, job ID, source SHA,
  `ci-foundation` npm-test phase total, and all five named test observations.
  A timed-out value remains **censored**, never a work-cost estimate. Each
  job is expected to cost about eight billable minutes.

The budget and work-basis decisions are intentionally pending until M1--M3
and the existing baseline receipts have been reconciled.

## Baseline and decisions

To be completed after the declared hosted collection and source/budget-origin
audit.
