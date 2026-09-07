# SDT-G66 PR135 review repair — W161

## Scope

- PR: `J-Tech-Japan/sekiban-dcb-ts#135`
- Review: `5132886542`
- Starting head: `0a66dcf092604a6ed4551aa9de7d80a650591892`
- Branch: `claude/sdt-g66-local-and-production-w160`
- Repair boundary: G66 runner, guard, focused test, and evidence wording only.
- Cloudflare/Wrangler/deployment/reset/cleanup: not used. G32 worker, D1s,
  outbox and DLQ remain untouched.

## Review findings repaired

1. The runner now distinguishes the unsafe tag-state projection from the
   public room/list query. Safe completion requires the MV safe head plus the
   public query target/state; reservation-list `readHead` is captured and
   required, and every affected committed tag is read with expected version
   and SUID versus the observed committed version/head. The scalar room query
   wire's lack of a read-head field is retained explicitly rather than
   invented.
2. Accepted commands are checkpointed before visibility polling. Unsafe and
   safe polling runs asynchronously while later commands continue at the
   configured ten-second pace; only necessary portable-snapshot acquisition
   can gate executor input. The receipt records request start, response
   completion, response duration, and response-completed-at-relative unsafe and
   safe clocks. A late observation is censored, not relabeled as a pass.
3. The guard now rejects missing/late visibility clocks, incomplete public
   query evidence, stale/incomplete tag evidence, and missing per-tick
   coverage. It requires continuous paced overlap so a pause-to-safe runner
   cannot pass.
4. Red-capable self-tests cover censored safe visibility, pause-to-safe,
   missing unsafe clocks, bad public reads, late-success timestamps, rejected
   writes, and missing coverage. Existing G60 guards were not modified.

The retained W160 production receipts remain historical topology/smoke
evidence. They cannot be upgraded to corrected AC1–AC4 proof because their
runner serialized visibility before the next command, captured only one target
tag after convergence, and did not join each event to public safe query/read-
head evidence. No new cohort or deployment was run.

## Local checks

Passing focused checks:

- `npm run lint`
- `npm run typecheck`
- `npm run test:g66`
- `node scripts/deploy/g66-e2e.mjs --self-test`
- `node scripts/g66-e2e-guard.mjs --self-test`
- `npx vitest run test/g66-e2e.spec.ts --pool=threads --maxWorkers=1`
- `npm run test:g60:required`
- `npm run test:g61`

The repository `npm run check` reached the full `npm test` aggregate and
stopped with the known parallel-runner/5-second-bound exceptions: `commit.spec`
AC7 timeout; G43 AC6 `waitForConfiguredAlarm` null at line 446; G67 AC3
timeout; `repair.spec` bounded-scan timeout; and `tag.spec` G5 timeout. The
aggregate result was 88 files/776 tests passed, 5 failed, 1 skipped. No G66
assertion failed. The initial G28 boundary invocation additionally hit an
environment-only npm log-directory write failure; the same lane passed with
`npm_config_cache=/private/tmp/sdt-g66-w161-npm-cache`.

G62, G65 mutation, and G67 mutation subprocess lanes were attempted and hit
the same environment-only package-layout exception: the runner invokes
`node_modules/vitest/vitest.mjs`, absent from this seat, while the supported
Vitest CLI and focused tests pass. These are recorded exceptions, not green
claims; no test, timeout, or gate was weakened.

## Handoff

The scoped repair is ready to push from the existing PR branch. Exact final
source head and hosted CI state are reported after the push. Canonical worker
repair-pushed completion and the canonical task report are the final lifecycle
actions; no review, merge, cleanup, or deployment action is included.
