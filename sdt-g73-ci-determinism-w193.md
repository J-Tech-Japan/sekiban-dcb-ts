# SDT-G73 CI determinism — W193 implementation report

Task: `SDT-G73-CI-DETERMINISM-W193`
Issue: [#149](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/149)
Branch: `claude/sdt-g73-ci-determinism-w193`
Base: `aca03b74d5677cffc42df105668235801f5a2580` (`origin/main`)

## Result

Implemented the test-only determinism and evidence slice on a dedicated main-
based branch. The detailed evidence is in
[docs/SDT-G73-evidence.md](docs/SDT-G73-evidence.md).

Changes are limited to:

- deterministic G43 AC6 fixture coordination with a same-DO durable-row
  barrier;
- explicit measured budgets for G67 AC3, commit AC7, both tag G5 cases, and
  the inherited repair checkpoint;
- semantic assertions for live driver-reported duration in G45 and G54;
- a driver-timing equality guard and a G43 finding-removal mutation runner;
- CI invocation of the timing guard and G43 lane invocation of the new mutant.

No production behavior, release/package version, credentials, test skip/retry,
or real guard was changed. The held-tag G69 503 baseline signature was
characterized and left unchanged as a separate G69 finding.

## Local evidence

- `npm run lint` — passed.
- `npm run typecheck` — passed.
- affected suite — 7 files, 65/65 tests passed after the G43 durable barrier.
- `npm run test:g43` — 20/20 focused tests passed; existing five production
  mutants red; new finding-removal mutant red.
- `npm run test:g73:guard` — 101 files, 2,053 equality assertions, zero
  violations; self-test passed.
- isolated G69 ordering — 8/8 passed; test file unchanged.
- repeat probes — 10/10 for every affected case; see detailed evidence.

The default-parallel local `npm test` was also run and recorded honestly as
red under host saturation; it was not used to weaken a guard or to claim a
green result. Terminal hosted CI is recorded in the final status below.

## PR and hosted CI

PR: [#156](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/156), open,
non-draft, against `main`, with `Closes #149`.
Head: `dc2d1c08d977183b54e3be353387f10132f3176b`.
Hosted checks: [CI run 34359651286](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34359651286)
completed successfully; all 21 jobs, including the terminal `verify` job,
passed. The [domain release preflight run 34359651297](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34359651297)
also passed.
