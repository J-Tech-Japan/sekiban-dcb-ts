# SDT-G65-PR127-G43-FOUNDATION-REPAIR-WAKE-135

## Checkpoint

- Repository: `J-Tech-Japan/sekiban-dcb-ts`
- PR: [#127](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/127)
- Existing branch: `claude/sdt-g65-local-wake-w128` (no branch created)
- Starting/pinned CI head: `740bb53fd50840efff5c3fe8b50d581d98a86090`
- Narrow repair commit: `e3976a9967a4bf286122299d2ed9746c44ad67fb`
- Current pushed branch head after the evidence commit is reported by the final
  handoff; the source repair itself is exactly `e3976a9`.
- No Wrangler, Cloudflare, deployment, resource, secret, D1, Queue, or remote
  operation was performed.
- Existing dirty and untracked evidence was preserved and was never staged.

## Failure and diagnosis

The pinned CI failure was [ci-foundation job 101292836571 in run
33961035081](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/33961035081/job/101292836571).
The failing test was:

`test/g43-tag-sql.spec.ts` — `a due obligation inserted while delivery runs is retained and re-armed for the next handler` (the AC6 assertion at line 437).

The complete CI summary was 88 passed, 1 failed, 1 skipped test files and
753 passed, 1 failed, 1 skipped tests. The scan expected the newly inserted
`0ecb1824-ac84-78df-9698-d91b9abfdcfe` obligation (`insert-2`) but observed
the earlier pending `g43-attempt-insert-1` obligation
`11cb1824-b19d-78df-96b1-de1b9abfdffe`.

The source scheduler contract was not the cause. The fixture's nested public
`append` helper asserted only `Response.status`; it did not consume the
response body. In the parallel foundation worker pool, response headers were
observable while the nested handler/Durable Object turn and its durable SQL
commit were still settling. The outer alarm then resumed its source scan
before `insert-2` was visible, producing the stale pending row. This is a
test synchronization defect at the public-response boundary, not a G43
selection, no-gap, or re-arm policy defect.

## Repair

The fixture now stores the nested response, asserts status 201, and awaits
`nestedAppend.arrayBuffer()` before the outer alarm resumes its scan. This
waits for the response body/handler turn without changing production code,
the scheduler, SQL selection, retry timestamp, Queue, outbox, ordering, or
G65 policy. The AC6 assertion still requires the newly inserted obligation to
be scanned and re-armed; no assertion was deleted, loosened, or serialized.

## Red/green receipts

- Red-before-green: the pinned GitHub CI receipt above is the durable
  pre-change red receipt, with the exact expected/observed event identities
  and 88/1/1 file result.
- Focused green:

  `PATH=/Users/tomohisa/.nvm/versions/node/v24.18.0/bin:$PATH npx vitest run --config vitest.config.ts test/g43-tag-sql.spec.ts -t 'a due obligation inserted while delivery runs'`

  Exit 0; 1 passed, 13 skipped.
- Full G43 green:

  `PATH=/Users/tomohisa/.nvm/versions/node/v24.18.0/bin:$PATH npm run test:g43`

  Exit 0; 3 files and 20 tests passed. The five production fact mutants
  (`event`, `committedMembership`, `outbox_obligation`, `head`, and
  `commit_receipt`) were all red as required.
- CI forced-red reachability:

  `SDT_G43_FORCE_FAILURE=1 PATH=/Users/tomohisa/.nvm/versions/node/v24.18.0/bin:$PATH npm run test:g43:forced-red`

  Exit 1 at the intentional `SDT-G43 forced-red CI wiring proof` after the
  underlying G43 lane passed.

## Local CI-equivalent results

All commands below used Node 24.18.0. Expected-red rows are intentionally
nonzero and are not treated as green test results.

| Workflow area | Commands/results |
| --- | --- |
| Foundation | `npm run lint`, `npm run test:g37:evidence`, both G50 guard/check commands, `npm run test:g52`, `npm run typecheck`, `npm run test:g17`, and `npm run test:g17:rollout-order`: PASS. `npm test`: known local concurrency exception, 87 files passed, 2 failed, 1 skipped; 752 tests passed, 2 failed, 1 skipped. The failures were existing 5,000 ms timeouts in `test/commit.spec.ts` AC7 and `test/tag.spec.ts` G5; no timeout or gate was changed. |
| G21–G25/G53–G56 | `npm run test:g21` through `g25`, `g53`, `g54`, and `g56`: PASS. Their CI forced-red commands: expected nonzero injected failures. |
| G26/G27/G60/G65 | `npm run test:g26`, `g27`, `g26:topology`, `g60:required`, and `g65:required`: PASS. G26, G27, topology, and G65 forced-red commands: expected nonzero injected failures. |
| G28 | `npm run test:g28:compile-fail`: PASS. The initial package-boundary commands failed only because npm attempted protected `/Users/tomohisa/.npm/_logs`; rerunning the same gates with `NPM_CONFIG_CACHE=/private/tmp/g65-w135-npm-cache` passed all source, negative-fixture, and package-manifest checks. All G28 forced-red/boundary forced-red probes were expected nonzero. |
| G29 | Mapping, delivery, diagnostics, compatibility, domain-source, authoring-doc, sample, witness, and candidate commands: PASS. All corresponding forced-red probes: expected nonzero. |
| G30/G51 | `npm run test:g30` reached `all-production-config-mutants-red` but the unmodified trace mutation runner made no progress; it was stopped with SIGINT, exit 130. `SDT_G30_FORCE_FAILURE=1 npm run test:g30:forced-red` exited before injection because one unrelated trace test (`fails open without emitting a native span when callback attributes violate the manifest type`) observed one span instead of zero (1 failed, 102 passed). The same test remains outside this G43 change and was preserved. `npm run test:g30:candidate` and its forced-red probe, plus `npm run test:g51`: PASS/expected-red. The temporary G30 source mutation was restored and is not in the repair diff. |
| G38/G42/G43/G44/G58/G61/G62 | Each normal lane PASS; each listed forced-red probe returned the intended injected nonzero result. G43 normal was 3/3 files and 20/20 tests. G44 reported all production mutants red; G58, G61, and G62 reported their existing red receipts and green paths. |
| G41/G45/G46/G49 | Each normal lane PASS with all production mutation rows red; each forced-red probe returned the intended injected nonzero result. |
| Local contract/e2e portions | `npm run test:store-contract`, `test:d1`, `test:mv`, `test:boundaries`, `test:consumer`, `test:g16`, `test:g20`, `test:g20:gate`, `test:g20:candidate`, and `test:cosmos-wiring`: PASS. `npm run test:cosmos` and `test:g22:cosmos` were run with the three Cosmos credential variables explicitly unset and stopped at their documented missing-credential checks; no emulator or remote resource was started. |
| CI coverage | `node scripts/g40-ci-coverage-check.mjs`, `g40-ci-mutation-proof.mjs`, and `g40-verify-needs.mjs --self-test`: PASS. |

The workflow's `npm run build` is a Wrangler dry-run script, and
`e2e:g15:local`/`e2e:g16:local` launch Wrangler. They were not invoked because
this task explicitly forbids Wrangler/deployment activity. This is recorded
as a task boundary, not as a product or test repair.

## Scope and handoff

- `git diff --check` and the full PR-range check
  `git diff --check 4687efa5c49951d9966a3785be5fd7b2620c6e4f4...HEAD` passed
  before the repair commit; the working-tree check also passed.
- Only `test/g43-tag-sql.spec.ts` was staged for the source repair. Earlier
  W130–W134 evidence changes and untracked evidence remain unstaged.
- PR #127 remains open and on the existing branch. No self-review, merge, or
  deployment was performed. The canonical worker transition is issued after
  this report is committed and pushed.
