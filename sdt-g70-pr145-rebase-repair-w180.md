# SDT-G70 PR145 rebase repair — W180

Status: local F1–F7 repair checkpoint pushed from the rebased PR branch; hosted
exact-head CI and rereview remain required. No deployment, Cloudflare mutation,
npm operation, tag, credential change, G32 operation, G64 operation, merge, or
issue close was performed.

## Rebase and scope

- PR: #145, branch `claude/sdt-g70-allocator-closed-prefix-w176`.
- New main base: `82501b8c649b674a3c36db30122363fe2e9c1cca` (merged PR #147).
- Source repair checkpoint: `207515c` (`fix(g70): rebase closed-prefix safety repair`).
- The final evidence commit is a descendant of that source checkpoint; the
  pushed SHA is reported with this artifact.
- The prohibited `commit.test`/missing-service-header production special case
  is not present. The retained `commit.test` hostname checks are the existing
  fault-injection/attempt-id test seam only; no G70 code uses them to bypass a
  production contract. `scripts/g70-allocator-closed-prefix-guard.mjs` remains
  present and is supplementary to behavioral proofs.

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

## Local validation

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npm run test:g70` | pass: 2 files, 16 tests; all 10 G70 guard mutations red |
| `npm run test:g44` | pass: 8 tests; all 4 production mutations red |
| `npm run test:g46` | pass: 4 files, 31 tests; all 9 tag-state mutations red |
| `npm run test:g62` | exit 0: green receipt plus 3 red self-test mutations |
| `npm run test:g67` | pass: 11 tests; all 7 budget mutations red |
| `npm run test:g69` | exit 0: focused ordering proof and 7 red mutations; two mutation subprocesses terminated exit 143 under the bounded runner and were classified red by the parent guard |
| `npm run test:g58` | focused Vitest/source checks passed, but aggregate is not green: legacy W97 same-tick runner ended with `spawnSync` status `null`, signal `null`, empty output after reporting `same-tick frontier witness remains red (exit null)` |
| `git diff --check` | pass before checkpoint commit |

The G58 W97 result is an environment/runner exception and is not being called
green or waived as a G70 acceptance result. Generated `.artifacts` and fixture
outputs from these runs remain unrelated unstaged work and were not included.

## Hosted handoff

The branch is rebased on merged PR #147 and contains no test-host special case.
After the evidence descendant is pushed, exact-head CI must reach a terminal
state. Any deterministic G69/G58 failure remains a repair blocker; only a
matching documented baseline/environment result may be classified under C-14.
This checkpoint is therefore ready for hosted verification, not a claim that
the PR is review-ready or that F1–F7 have passed hosted CI.
