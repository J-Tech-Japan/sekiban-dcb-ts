# SDT-G65 PR #127 foundation repair — WAKE-137

## Result

- PR: `J-Tech-Japan/sekiban-dcb-ts#127`
- Starting PR/worktree head: `2a256645a961cd6049347339f760ec393adc2b44`
- Branch: `claude/sdt-g65-local-wake-w128`
- Scope: one narrow G8 projection-fixture identity isolation; no product,
  trace, CommitTraceVerifier, workflow, gate, deployment, or resource change.
- The final pushed checkpoint SHA is reported by the canonical worker/report
  transition after the commit; this document is part of that checkpoint.

## CI failure and diagnosis

The pinned failure was [ci-foundation job
101314955289](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/33969339608/job/101314955289)
in run `33969339608`, not the G43 5,000 ms failure. The exact failing test
was `SDT-G8 live projection > exposes behind-head projection lag without
advancing a projection` in `test/projection.spec.ts`. The job reported 88
passed, 1 failed, 1 skipped files and 756 passed, 1 failed, 1 skipped tests;
the assertion at line 337 expected `behindEvents=1` and the committed event's
SUID, but received `behindEvents=0` and `headSuid=""`.

The reproduced cause is a shared mutable PostgreSQL fixture namespace, not a
G65 production interaction. `test/read.spec.ts` and other suites bind the
fixed service id `local-test-runtime` to their own allocator lineage. The G8
projection fixture used that same service id while its delivery used
`test-projection-lineage`. `PostgresEventStore.recordDelivery` correctly
returns `lineage-mismatch` for that conflicting binding; the adapter records
the incident and acknowledges the non-stored result, so no `dcb_events` row
exists for the lag endpoint to report. The broader G65 file-wide run exposed
the order-dependent collision; the G8 test passes alone because the collision
is absent.

The durable reproduction is in
`.artifacts/sdt-g65-w137-g8-causal-receipt.md`. It records the disposable
Postgres setup, the deliberate `local-test-runtime|read-test-lineage`
prebind, the exact pre-fix command and exit 1 (`7 passed, 1 failed`), and the
same command after isolation and exit 0 (`8 passed, 0 failed`). The expected
G8 assertion was not changed.

## Narrow repair

`test/projection.spec.ts` now uses the private fixture service id
`projection-test-runtime`, and its existing lag request passes that same
service identity through the already-supported `serviceId` query parameter.
This isolates the G8 fixture's allocator binding without changing runtime
behavior, the projection lag contract, G44, G65 F1/F2, response bodies, or
any production source. No CommitTraceVerifier/trace change is retained or
staged. The pre-existing dirty evidence files remain untouched.

## Focused proof

| Proof | Result |
| --- | --- |
| Pre-fix disposable-Postgres reproduction | Red: exact G8 assertion failed from lineage collision |
| Post-fix `POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:55432/serialized_dcb npm exec -- vitest run --config vitest.config.ts test/projection.spec.ts --reporter=verbose` | Green: 8/8 tests |
| Projection + G65 behavior tests | Green: 2 files, 22/22 tests |
| G65 required guard and mutation receipt | Green; red mutants retained, including F1/F2 admission proofs |
| G44 | Green; all four production mutants red |

## CI-equivalent local lanes

Commands were run against the disposable local Postgres at port `55432` where
the lane requires `POSTGRES_URL`; no Wrangler or Cloudflare operation was
run.

- Foundation: `npm run lint`, `npm run test:g37:evidence`, both G50 guard
  commands, `npm run test:g52`, `npm run typecheck`, `npm run test:g17`, and
  `npm run test:g17:rollout-order` passed. The aggregate `npm test` was
  investigated and had only the local shared-runner failures: commit AC7 and
  Tag G5 5-second timeouts, two G43 alarm/re-arm races, and Vitest teardown
  errors (86 files/753 tests passed; 3 files/4 tests failed; 1 skipped). No
  projection failure remained. No timeout or expectation was changed.
- G21–G27 passed, including G26 topology, and their forced-red probes
  rejected as expected. G28 compile-fail, authoring/domain tests, all four
  boundary probes, and forced-red probes passed. The package boundary was
  rerun with a writable temporary npm cache and passed all source,
  negative-fixture, and package-manifest gates.
- G29 mapping, delivery, diagnostics, compatibility, domain-source,
  authoring-doc, sample, witness, and candidate lanes passed with their
  forced-red probes. G30 candidate passed.
- G31 passed (3 files, 33 tests), with candidate and forced-red probes
  passing. G32 bridge passed; full G32 passed (10 files, 50 tests), all
  mutation checks passed, and the pinned Sekiban source was
  `855feaa93564fef54defec76e9ccff969d4ee01a`. G32 candidate and forced-red
  probes passed.
- G38 preparation, G42, and G43 passed, including their mutation/forced-red
  evidence. G41, G44, G45, G46, G49, G51, G52, G53, G54, G55, G56, G58,
  G60, G61, G62, and G65 required lanes passed with their existing red
  receipts/mutation checks. G40 coverage and mutation proof passed.
- Local e2e lanes not requiring Wrangler passed: `test:d1` (12 tests),
  `test:mv` (18 tests), `test:boundaries`, `test:consumer`, and
  `test:store-contract` (also exercised in G32). `npm run test:g20` passed
  its local two-test lane; the candidate lane passed.
- The workflow's `npm run build` and G20 deployment gate were not run because
  they invoke Wrangler (`deploy --dry-run`) and this repair is explicitly
  deploy-free. G15 local Worker e2e was likewise not invoked. These are
  boundary exceptions, not failed product checks.
- `npm run lint`, `npm run typecheck`, and `git diff --check` passed after the
  final source restoration.

## Separate G30 local condition

The clean G30 verification reached its final
`"result":"all-production-config-mutants-red"` output. Its runner remained
alive after producing that complete result and was terminated only as the
identified completed background process (shell exit 130). An earlier
interrupted mutation attempt temporarily changed
`scripts/deploy/g30-b0-measure.mjs`; that exact line was restored, and final
`git diff` verified both that file and
`packages/dcb-runtime/src/trace/CommitTraceVerifier.ts` are clean. No G30
trace/production change is included in this checkpoint. This is recorded as a
local runner/environment exception only.

## Boundaries and evidence truth

- No Wrangler, Cloudflare, deployment, resource, PR merge, review-state, or
  host-metadata operation was performed.
- W136's incomplete/failed deployed evidence remains incomplete; this repair
  does not claim deployed G65 completion or alter its evidence.
- Existing G65 F1/F2 contracts and all unrelated dirty/untracked evidence are
  preserved and were not staged. Only `test/projection.spec.ts`, this report,
  and the causal receipt are intended for the checkpoint.
