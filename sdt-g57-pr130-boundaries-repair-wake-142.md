# SDT-G57-PR130-BOUNDARIES-REPAIR-WAKE-142

## Scope and diagnosis

- Repository: `J-Tech-Japan/sekiban-dcb-ts`
- PR: `#130`
- Branch: `claude/sdt-g57-deploy-free-w126`
- Exact starting head: `013003993437d9a6b704c5458467767508a446b3`
- Change class: local package/integration boundary repair only.
- No Wrangler, Cloudflare, deployment, resource, review, merge, close, release, or label operation was performed.

The exact failing CI gate was reproduced before the repair with:

```text
npm run test:boundaries
```

It failed in `scripts/g13-boundary-check.mjs:28` with:

```text
AssertionError [ERR_ASSERTION]: client may depend only on core
  [ '@sekiban/dcb-core', '@sekiban/dcb-domain' ]
```

The failure was PR-caused. G57's new `packages/dcb-client/src/executor.ts` imports the domain executor/runtime types, and commit `cfe731d` placed `@sekiban/dcb-domain` in the dcb-client runtime `dependencies`. The unchanged boundary oracle intentionally requires the published client runtime dependency set to contain only `@sekiban/dcb-core`.

## Repair

`@sekiban/dcb-domain` is now a dcb-client `devDependency`, with the matching workspace entry in `package-lock.json`. It remains available to the package build/typecheck, while the published/runtime dependency boundary remains core-only. No source, test assertion, timeout, scheduler expectation, CI wiring, acceptance criterion, wire shape, or G57 executor behavior was changed.

The repaired exact gate passes:

```text
npm run test:boundaries
SDT-G13/G14/G12 package-boundary fixture passed: core is platform independent, runtime registration stays private, Cosmos is opt-in, and sample consumes public entrypoints
```

## Focused results

| Command | Result |
| --- | --- |
| `npm run test:boundaries` | PASS after repair |
| `npm run test:g57` | PASS; 5 tests, path guard green and mutation red |
| `npm run test:g65` | PASS; 17 tests, guards green and mutants red |
| `npm run test:g15` | PASS; 10 tests |
| `npm run test:g16` | PASS; 6 tests |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `git diff --check` | PASS |

## CI-equivalent local lane results

The package/boundary repair was checked against the workflow's relevant local commands. All expected-red probes below were run as probes and failed at their deliberate forced assertion; none was treated as a green pass.

Passing or expected-red-green lanes:

- Foundation support: `npm run lint`, `npm run test:g37:evidence`, G50 guard/check, `npm run test:g52`, `npm run typecheck`, `npm run test:g17`, and `npm run test:g17:rollout-order` passed.
- G28 normal/negative/source lanes, with the compile-fail probe red as expected; G21, G22, G23, G24, G25, G53, G54, and G56 passed with their forced-red probes red as expected.
- G26, G27, G26 topology, G29 mapping/delivery/diagnostics/compatibility/domain-source/authoring-doc/sample/witness, and G31 passed; their forced-red probes were red as expected.
- G30 candidate check passed and its forced-red probe was red as expected. The normal `npm run test:g30` reached the type/import checks, 103 passing G30 tests, trace/B0/manifest checks, and configuration mutation checks, then stopped producing output at `node scripts/g30-trace-mutation-runner.mjs`. It was terminated with Ctrl-C after the bounded wait. This is the documented pre-existing local G30 trace-mutation runner stall; no G30 source or gate was changed.
- `npm run test:g51` passed its focused 4-test selection and native-span/ingestion/probe/sample guards.
- `npm run test:g32` passed the 10-file/50-test suite, production/admission/tag mutation oracles, forward recorder oracle, DDL and store-contract checks. Its final parity runner could not build the C# helper because the sandbox denies writes to the user NuGet cache (`/Users/tomohisa/.nuget/packages/...` and `/Users/tomohisa/.local/share/NuGet/http-cache/...`, `Operation not permitted`). This is an environment-only exception after the G32 checks themselves passed.
- G38, G42, G43, G44, G45, G46, G49, G58, G61, and G62 passed; their required forced-red probes were red as expected. G43's scheduler crash messages were fixture diagnostics while the 20 tests and five production mutants passed. G44 had one first-run local alarm scheduling race in AC7; the exact test passed in isolation and the complete rerun passed all 8 tests plus all four production mutants red.
- G41 passed its 8 tests and all three production mutants red.
- `node scripts/g40-ci-coverage-check.mjs`, `node scripts/g40-ci-mutation-proof.mjs`, and `node scripts/g40-verify-needs.mjs --self-test` passed.
- Local-e2e non-Wrangler checks `npm run test:store-contract`, `npm run test:d1` (12 tests), `npm run test:mv` (18 tests), `npm run test:boundaries`, and `npm run test:consumer` passed.

The following failures/exceptions were retained rather than weakened:

1. The foundation aggregate `npm test` had four local parallel Miniflare/workerd race/teardown failures (AC7 allocation/cancellation, G5 exact-key fences, repair fact re-query, and bounded scan checkpoint). Each exact failing test was rerun in isolation and passed; the output contained the known `G43 scheduler crash`, `EnvironmentTeardownError`, `Closing rpc while "resolve" was pending`, and `Tag Durable Object identity changed` runner signatures. This is an environment/concurrency exception, not a failure in the dcb-client boundary repair.
2. `npm run test:g28:boundaries` and `npm run test:g28:boundary:package` remain blocked by the local npm 10 environment: `npm pack` cannot write its default `/Users/tomohisa/.npm/_logs` path (`Operation not permitted`). The source, negative, compile-fail, and normal G28 checks passed; no gate was changed.
3. The workflow's `npm run build`, `e2e:g15:local`, and `e2e:g16:local` steps were not invoked because this task explicitly forbids Wrangler/Cloudflare operations; those scripts invoke Wrangler/local deployment. This is a declared scope exception, not a claimed pass.

The package fix itself has no failing focused test. Existing generated evidence/fixture dirt from the local lanes was preserved and excluded from the repair commit.

## Checkpoint

## Canonical worker transition

`intent-cli worker result-summary --kind pr-comment-fix --pr 130 --repo J-Tech-Japan/sekiban-dcb-ts --outcome repair-pushed --format json` recognized the repair commit. The canonical claim and completion attempts were intentionally made through intent-cli and both refused without mutation because the PR currently has only `intent-target` and does not carry `intent-pr-request-update` / `intent-pr-update-in-progress`:

```text
claim.missing.intent-pr-request-update: PR does not carry 'intent-pr-request-update'.
complete.stale.not-claimed: PR does not carry 'intent-pr-update-in-progress'.
```

No manual label operation was used. The source repair is pushed at the checkpoint reported by the canonical handoff; only the host/PR label-state reconciliation remains blocked.

Only `packages/dcb-client/package.json`, its workspace entry in `package-lock.json`, and this evidence artifact are in scope for the pushed repair checkpoint. The exact post-push commit SHA is reported by the canonical completion message; verify it with `git rev-parse HEAD` on `claude/sdt-g57-deploy-free-w126`. PR review/merge state is unchanged.
