# SDT-G70 PR145 rebase repair — W180

Status: W180 repair is pushed from the rebased PR branch; the final evidence
head must still receive terminal exact-head CI and rereview. No deployment,
Cloudflare mutation, npm operation, tag, credential change, G32 operation,
G64 operation, merge, or issue close was performed.

## Rebase and scope

- PR: #145, branch `claude/sdt-g70-allocator-closed-prefix-w176`.
- New main base: `82501b8c649b674a3c36db30122363fe2e9c1cca` (merged PR #147).
- Source repair checkpoint: `207515c` (`fix(g70): rebase closed-prefix safety repair`).
- W180 source/guard/docs repair: `9a463b35123e966394ec7d6a282343cd22d04cae`.
- Final evidence commit: `799c3a4065ce7bef8c66d69ace4676df692abba6` (this
  artifact's current committed evidence head).
- The prohibited `commit.test`/missing-service-header production special case
  is not present. The retained `commit.test` hostname checks are the existing
  fault-injection/attempt-id seam only; no G70 code uses them to bypass a
  production contract. `scripts/g70-allocator-closed-prefix-guard.mjs`
  remains present and supplementary to behavioral proofs.

## F1–F7 repair mapping

1. Tag fence confirmation is explicit. A cancellation is closure evidence only
   with a durable `fenceConfirmed`/idempotent fact; unknown cancellation stays
   unresolved. Delayed same-identity Tag evidence is recovered by the durable
   allocator alarm.
2. Allocation, resolution, and reconcile recovery are durable. Response
   `waitUntil` is not the sole recovery mechanism; the allocator alarm retries
   unresolved identity-bound work after an invocation disappears.
3. The reconcile cut validates current lineage, complete-through bounds,
   exhaustive identities, duplicate/conflict-free ordered SUIDs, and durable
   proof metadata. Invalid or incomplete cuts cannot certify the prefix.
4. Every safe advancement path requires the lineage-bound certificate with
   `authority: "allocator-transaction"` plus the existing G44/G62 settled
   coverage/frontier gates. Missing, stale, unreconciled, or mismatched proof
   fails closed; unsafe reads and Queue/drain behavior are unchanged.
5. The moving allocator index avoids full-history rewrite on the ordinary path.
   The focused cost proof records durable write/acquisition measurements for
   indexed histories of 1, 16, and 128 allocations; the exceptional reconcile
   cut remains bounded and is not a hot-path cost claim.
6. Public serialized CommitWorker coverage includes disjoint/multi-Tag,
   partial and lost-response/crash handoffs, expiry/abort, delayed writer,
   concurrent/restarted readers, and higher-before-lower SUID ordering. The
   source guard remains and all ten guard mutations are red, including the
   four required behavioral mutants: removed registration, premature
   participant resolution, expired/aborted writer acceptance, and allocated
   watermark substituted for closed prefix.
7. The G58 safe-poll guard now requires both `maximumSuid` and the validated
   certificate, with omission mutants red. The old hosted G69 ordering and G58
   source-literal failures are treated as real branch failures, not duration
   exceptions; the package dry-run collision was separate and was resolved by
   merged PR #147.

The foundation repair is general cancellation behavior: a missing Tag is
never synthesized merely because a commit lost the allocation-to-append
boundary. Existing Tags still return explicit durable fence evidence, and a
new source obligation remains unresolved until a real append or later recovery
fact. This is not conditioned on hostname, service header, event type, or test
environment.

## Local validation

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npx vitest run ... test/commit.spec.ts -t 'AC7: allocation and cancellation faults'` | pass; legacy 404/no-authoritative-write assertion unchanged |
| `npm run test:g70` | pass: 2 files, 16 tests; all 10 G70 guard mutations red |
| `npm run test:g44` | pass: 8 tests; all 4 production mutations red |
| `npm run test:g46` | pass: 4 files, 31 tests; all 9 tag-state mutation rows red |
| `npm run test:g62` | exit 0: green receipt plus 3 red self-test mutations |
| `npm run test:g67` | pass: 11 tests; all 7 budget mutations red |
| `npm run test:g69` | exit 0: ordering guard pass and 7 red mutations |
| `npm run test:g58` | focused Vitest/source checks pass; aggregate stops at legacy W97 same-tick runner (`spawnSync` status `null`, signal `null`, empty output) |
| `git diff --check origin/main...HEAD` | pass after W180 source/docs repair |
| `npm test` | not green in repository-wide parallel mode: existing G43 AC6 teardown/runner race, G43 measurement spread, and unrelated 5-second repair/tag timeouts; no assertion, timeout, retry wrapper, or fixture was changed |

The G69 mutation runner also reported two subprocesses exiting 143; its parent
guard classified those mutations red. This is runner behavior, not a skipped
mutation. Local Miniflare prints the existing Hyperdrive warning and occasional
overdue SQLite-alarm diagnostics. Generated `.artifacts` and fixture outputs
remain unrelated unstaged dirt and were not included.

## Hosted diagnosis and boundaries

The prior exact-head run `34304940836` was not green. These are the exact
receipts:

- `ci-foundation`: [job 102319563994](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34304940836/job/102319563994) failed the branch-caused legacy AC7 check (`expected 404`, received `200`) because the prior G70 path manufactured a missing-Tag tombstone. The W180 repair removes that create-on-cancel call; the new Tag remains unresolved and fail-closed, while an existing Tag can still provide explicit fence proof. The exact base foundation job [102312021120](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34302437259/job/102312021120) passed, and the focused base AC7 selection passed.
- `ci-g44`: [job 102319564176](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34304940836/job/102319564176) failed the in-scope G58 source guard literal because the G70 safe path propagates both `maximumSuid` and the closed-prefix certificate. The W180 `g58-reservation-safe-starvation` guard now checks that expanded call shape and has a certificate-omission mutation red; no G58 assertion was removed.
- `ci-g21-g25`: [job 102319563958](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34304940836/job/102319563958) failed the existing G54 empty-envelope timing equality (`PT0S` versus `PT0.001S`). The same timing-only failure is present on base [job 102312021101](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34302437259/job/102312021101); local G54 passes. It is retained as a C-14 environment/timing exception, not used to waive the branch-caused foundation or G58 failures.
- `ci-g64` and `dcb-domain-release-preflight` were the already-resolved package release-state collision after W177, not a G70 runtime failure. No package change is folded into this branch.
- `verify` is aggregate/downstream and is not an independent G70 failure. `ci-g69-ordering` did not fail on this run; local G69 is green.

The branch is rebased on merged PR #147 and contains no test-host special case.
The final evidence descendant must receive a new exact-head run and terminal
status. Any deterministic G69/G58/foundation failure remains a repair blocker;
only a matching documented baseline/environment result may be classified under
C-14. This artifact does not claim the PR is review-ready or that F1–F7 have
passed hosted CI.
