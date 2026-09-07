# SDT-G66 local and production prep — W160

Status at local-prep checkpoint: harness ready; production window pending.

## Claim and source

- Issue: `J-Tech-Japan/sekiban-dcb-ts#128`.
- Canonical issue claim: `intent-cli worker claim --repo J-Tech-Japan/sekiban-dcb-ts --kind issue --number 128 --github-only --write --format json` — applied successfully with `intent-issue-in-progress`; no raw label mutation.
- Host execution-unit claim was supplied as already held by orchestration and was not changed.
- Branch: `claude/sdt-g66-local-and-production-w160`.
- Base: `origin/main` at `774f76d docs: diagnose G68 SafeWindow arrival fence (#134)`.

## Local harness

Added:

- `scripts/deploy/g66-e2e.mjs` — one cold-first, paced public session: create-room, eight reserve-room commands, and cancel-reservation; first use of each tag is read-through and later commands use portable snapshots. It persists accepted command receipts before polling and retains observed response/admission, unsafe, safe, per-tick coverage/frontier, tag-state, and query reads.
- `scripts/g66-e2e-guard.mjs` — receipt shape and acceptance guard. Missing clocks, failed/paused writes, missing coverage history/frontier data, and censored bounds fail closed. Its self-test flips censored-safe, paused-write, and missing-coverage mutants red.
- `test/g66-e2e.spec.ts` — focused guard tests.
- `docs/SDT-G66-evidence.md` and `docs/end-to-end.md` — contract/evidence skeletons; deployed rows are to be filled only from retained production receipts.
- `package.json` scripts `e2e:g66` and `test:g66`.

## Local results

| command | result |
|---|---|
| `node scripts/deploy/g66-e2e.mjs --self-test` | PASS |
| `node scripts/g66-e2e-guard.mjs --self-test` | PASS; censored-safe, paused-write and missing-coverage mutants red |
| `npm run test:g66` | PASS; 1 file / 3 tests |
| `npm run lint` | PASS |
| `git diff --check` | PASS |
| `npm run typecheck` | BLOCKED by the pre-existing workspace package build/type surface before G66 code is reached: `@sekiban/dcb-client` reports `SnapshotReader.head`/`head` shape errors and the sample reports missing existing G60/G65 exports and catch-up fields. No G66 file is named in the failure. This is retained as an environment/base-lane exception, not called green. |
| `node scripts/g67-safe-lane-guard.mjs --self-test` | PASS; the guard's own anchor self-test ran. |
| `node scripts/g67-safe-lane-guard.mjs --pre-fix` / green replay | BLOCKED as an environment-only exception: the existing mutation runner hard-codes the current worktree's `node_modules/vitest/vitest.mjs`, but this fresh worktree intentionally has no installed `node_modules/vitest`; the runner therefore cannot execute its green oracle. Its generated fixture mutation was reverted and no G67 file is part of this checkpoint. |

No Wrangler or Cloudflare operation has been performed in this local half.

## Production window plan

The single later window will capture the existing production deployment before
self-ring enablement, deploy the same worker with self mode and a self
`DOWNSTREAM_DOORBELL` binding, and capture the matched cohort. It will not
claim success for any unsafe/safe censored row. The authorized G32 removal will
occur only after read-only target and consumer proofs, in the exact requested
order; protected W155-C, G32 cutover resources, production data outside the
C-0 sample, and the old doorbell's unrelated resources will not be touched.
