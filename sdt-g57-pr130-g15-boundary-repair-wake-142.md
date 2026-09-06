# SDT-G57-PR130-G15-BOUNDARY-REPAIR-WAKE-142

## Result

The hosted G15 failure was PR-caused by the G57 executor facade. It is repaired
and pushed at:

- Repository: `J-Tech-Japan/sekiban-dcb-ts`
- PR: `#130`
- Branch: `claude/sdt-g57-deploy-free-w126`
- Starting head: `22f8d3a60cb1f1fb888fffd67b96514787bae7ad`
- Pushed repair head: `53fb85534114fa6b7d89efab47676ac2811b2edd`
- Commit: `fix(g57): preserve malformed command rejection`
- No Wrangler, Cloudflare, deployment, resource, review, merge, or close
  operation was performed.

## Hosted failure and reproduction

The failing hosted job was
<https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34016849637/job/101442014869>.
Its G15 malformed `POST /api/commands/create-room` body (`{"name":"invalid"}`)
was expected to return HTTP 400 with `kind: invalid` and
`code: invalid_command_input`, but returned HTTP 502 with
`kind: transport` and `code: transport`.

The unmodified G15 suite at the pinned head passed its existing 10 tests, but it
did not exercise this public malformed-input route. The new public regression
guard was run against that pinned source before the repair:

```text
npm exec vitest run --config vitest.config.ts test/meeting-room.spec.ts --testNamePattern 'preserves the public invalid-command response'
exit 1
expected 400; received 502
```

The reproduction is the real `createMeetingRoomWorker` command route, not a
mocked executor result. The runtime fetcher is asserted not to be called for
malformed input.

## Diagnosis and repair

`createRoomCommand` input parsing throws the typed domain error
`COMMAND_INPUT_INVALID`. The new G57 `createSekibanExecutor` catch block only
recognized `DomainAuthoringError` through `instanceof`. The authored meeting
room command and the bundled client facade can contain separate copies of the
domain package, so the cross-package error failed that identity check and fell
through to the generic `{ kind: "transport" }` result. The Worker then correctly
serialized that result as HTTP 502, but the classification was wrong.

The repair in `packages/dcb-client/src/executor.ts` preserves the existing
`instanceof` path and also reads the stable string `code` across the package
boundary. `COMMAND_INPUT_INVALID` now returns
`{ kind: "invalid", code: "invalid_command_input" }`; the public Worker maps it
to HTTP 400. The existing `executor.snapshot_missing` fail-closed result is
preserved. No G15 assertion, timeout, scheduler expectation, CI wiring, or
acceptance criterion changed.

The focused guard in `test/meeting-room.spec.ts` is the exact public regression
for the hosted failure and is green after the repair.

## Verification

| Command | Result |
| --- | --- |
| `npm run build --workspace @sekiban/dcb-client && npm exec vitest run --config vitest.config.ts test/meeting-room.spec.ts --testNamePattern 'preserves the public invalid-command response'` | PASS; 1 selected test, 8 file tests |
| `npm run test:g15` | PASS; 2 files, 11 tests, G15 pagination self-test passed |
| `npm run test:g57` | PASS; 1 file, 5 tests; executor path guard passed and its mutation probe was red as required |
| `npm run test:boundaries` | PASS; SDT-G13/G14/G12 package-boundary fixture passed |
| `npm run test:g28:boundary:source` | PASS |
| `npm run test:g28:boundary:negative` | PASS |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS with `--max-warnings=0` |
| `git diff --check` | PASS |

`npm run test:g28:boundaries` was also run and stopped in the existing local
environment at its `npm pack` step because npm could not write
`/Users/tomohisa/.npm/_logs` (`EPERM`). This is an environment-only exception;
the source and negative G28 boundary gates passed, and no gate was weakened.

## Canonical PR transition receipts

The read-only repair summary recognized the pushed commit:

```text
intent-cli worker result-summary --kind pr-comment-fix --pr 130 --repo J-Tech-Japan/sekiban-dcb-ts --outcome repair-pushed --format json
status: completed
summary: Repair commit pushed to J-Tech-Japan/sekiban-dcb-ts#130.
```

The canonical claim was attempted before completion but made no mutation because
the PR was already `intent-pr-rereview-ready` and did not carry
`intent-pr-request-update`:

```text
intent-cli worker claim --repo J-Tech-Japan/sekiban-dcb-ts --kind pr --number 130 --github-only --write --format json
proceed: false
applied: false
errors:
  claim.missing.intent-pr-request-update: PR does not carry 'intent-pr-request-update'.
  claim.stale.already-rereview-ready: PR already carries 'intent-pr-rereview-ready'.
```

The canonical repair completion was then attempted after the push and likewise
made no mutation because no repair claim was active and the PR was already
rereview-ready:

```text
intent-cli worker complete --repo J-Tech-Japan/sekiban-dcb-ts --kind pr --number 130 --outcome repair-pushed --github-only --write --format json
proceed: false
applied: false
errors:
  complete.stale.not-claimed: PR does not carry 'intent-pr-update-in-progress'.
  complete.stale.already-completed: PR already carries 'intent-pr-rereview-ready'.
```

No manual label mutation was used. The source repair is pushed at the exact head
above; only the stale/already-completed PR transition state needs orchestration
reconciliation.
