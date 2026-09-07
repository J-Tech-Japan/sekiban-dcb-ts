# SDT-G66 PR135 safe-predicate repair — W164

Status: completed. The one corrected production cohort passed the two G66
visibility bounds with sound terminal-state predicates. No G32 resource was
changed or cleaned up.

## Exact source and deployment

- Branch: `claude/sdt-g66-local-and-production-w160`
- Deployed source: `8042cfcbc7cd5ea207473e62d12aa478b2afc990`
- Deployed version: `f9b2b714-53e5-4b8c-bda9-6c4d35c6389e` (version 226)
- Deployment annotation: `SDT-G66 W164 safe-predicate repair 8042cfc`
- Final pushed head: `44bef7f0145e7bd7f21e646c7b4b3a5b4a07db20`
- Final-head changes after deployment are harness/guard receipt semantics only;
  the Worker runtime was not changed after the deployed source.

The version view proved the existing production configuration: self direct
doorbell enabled and proven, `DOWNSTREAM_DOORBELL` bound to
`sekiban-dcb-meeting-room-cloudflare-only` at `MeetingRoomDownstreamDoorbell`,
pipeline D1 `f26d1299-82d9-4a64-8647-bc2ec86326ac`, MV D1
`b416b212-4d09-413c-9b8d-7660e475772f`, and the existing outbox/DLQ. The C-0
reset used only those existing pipeline/MV operational tables and completed
105 stripped Wrangler invocations. The five recognized Wrangler credential
names were all `UNSET`; credentials were not printed or persisted, and
`--keep-vars` was not used. The protected conformance token was supplied only
by path `/private/tmp/sdt-g66-w160-conformance-token`.

Receipts:

- deployment/version: `.artifacts/sdt-g66-w164-deployed-version.json`
- reset: `.artifacts/sdt-g66-w164-production-c0-reset.json`
- lossless cohort: `.artifacts/sdt-g66-w164-production-corrected.json`
- corrected guard: `.artifacts/sdt-g66-w164-production-guard.json`

## Harness repair and guard

The previous harness waited for sample 9's `reserved` state even though sample
10 intentionally cancelled that same reservation. W164 separates the command
target from the safe predicate. Sample 9 retains its committed `reserved`
command target, while its safe predicate is the known terminal `cancelled`
state with mutation ordinal 10. A later-sample mutation guard turns red when
that terminal predicate is removed, left at `reserved`, or loses its exact
mutation reference. The six existing G60 red mutants remain unchanged.

The local tag-state guard also distinguishes DCB tag-write version from
projector applied-state version. It requires a positive applied projector
version, the positive committed tag-write version, and a tag-state last SUID
at or beyond the event SUID; it does not compare the two different version
domains. Its stale-tag-state mutant is red. The first post-cohort guard run
exposed the old comparison as a false negative; the same raw receipt passed
after this guard-only correction. No cohort was rerun.

## Corrected production cohort

Cold first, ten accepted commands, continuous writes, and 10,000 ms pacing
were used. Command-start spacing was 11,965–12,959 ms. The table reports
response duration and response-relative observed unsafe/safe visibility; all
times are observed clocks, not authored event timestamps.

| sample | command | safe predicate | response | unsafe | safe | admission |
| ---: | --- | --- | ---: | ---: | ---: | --- |
| 1 | create-room | created | 2,957 | 2,804 | 33,680 | admitted |
| 2 | reserve-room | reserved | 2,447 | 2,365 | 50,786 | unknown |
| 3 | reserve-room | reserved | 2,186 | 2,446 | 42,916 | unknown |
| 4 | reserve-room | reserved | 2,237 | 2,303 | 49,473 | unknown |
| 5 | reserve-room | reserved | 1,909 | 2,344 | 36,699 | unknown |
| 6 | reserve-room | reserved | 1,908 | 2,409 | 46,132 | unknown |
| 7 | reserve-room | reserved | 1,999 | 2,366 | 45,355 | unknown |
| 8 | reserve-room | reserved | 1,802 | 2,390 | 32,994 | unknown |
| 9 | reserve-room | cancelled by sample 10 | 2,036 | 2,336 | 55,942 | admitted |
| 10 | cancel-reservation | cancelled | 1,344 | 4,650 | 46,891 | admitted |

Aggregate: response p50/p95 `1,999/2,957 ms`; unsafe p50/p95
`2,366/4,650 ms`; safe p50/p95 `45,355/55,942 ms`. Accepted `10/10`, unsafe
within 5,000 ms `10/10`, safe within 180,000 ms `10/10`, with zero misses in
both lanes. Admission headers were 3 admitted and 7 unknown. The corrected
guard passed all eight acceptance booleans, including coverage/frontier,
tag-state/query, response-relative clocks and final query consistency.

The deployed runner's embedded `tagStateAndQueryReads=false` is retained in
the raw receipt as an historical runner output. It is the known false negative
from comparing projector version to shared-tag write version. The corrected
post-cohort guard is the authoritative guard result for this receipt and is
green without changing the raw receipt.

## Preserved phase-one attribution and outcome

W162/W163 remains preserved exactly: the prior source had 10/10 commits and
unsafe passes but only 9/10 reserved-state safe proofs because sample 10 later
cancelled the reservation; the phase-one checkpoint was fail-closed and its
G68 repeat-arrival/fence attribution remains historical. W164 does not rewrite
that receipt or use it as a pass.

Because this corrected cohort proves both bounds with a surviving terminal
predicate, AC2 is now evidenced for design/operator disposition. The PR
relationship is updated to `Closes #128` so merging PR135 can close the issue;
this task does not merge or close the PR directly. G32 resources remain
retained and untouched.

## Local gates

- `node scripts/deploy/g66-e2e.mjs --self-test`: PASS.
- `node scripts/g66-e2e-guard.mjs --self-test`: PASS; later-safe-predicate and
  stale-tag-state mutants red, plus all existing guard mutants red.
- `G66_GUARD_OUTPUT=.artifacts/sdt-g66-w164-production-guard.json node scripts/g66-e2e-guard.mjs --input .artifacts/sdt-g66-w164-production-corrected.json`: PASS.
- `npx vitest run --config vitest.config.ts test/g66-e2e.spec.ts --pool=threads --maxWorkers=1`: PASS, 7/7.
- `npm run typecheck`: PASS.
- targeted ESLint for the three changed harness/test files: PASS.
- `git diff --check`: PASS.

Vitest emitted the existing non-empty Hyperdrive local-connection-string
warning; it was environment-only and did not affect the result.
