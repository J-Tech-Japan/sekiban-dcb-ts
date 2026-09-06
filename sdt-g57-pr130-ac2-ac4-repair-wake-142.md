# SDT-G57-PR130-AC2-AC4-REPAIR-WAKE-142

## Checkpoint

- Repository: `J-Tech-Japan/sekiban-dcb-ts`
- PR: `#130`
- Branch: `claude/sdt-g57-deploy-free-w126`
- Reviewed starting head: `29bb960f623921f96b603bb1533afb3880bf7bf1`
- Source/test repair commit: `0d2da7d8176605c2f31f6c1d07f1492da73fab2a`
- Scope: F1/F2/F3 only; no deployment, Wrangler, Cloudflare, resource, review, merge, close, or unrelated cleanup.
- Existing unrelated worktree dirt was preserved and was not staged.

## Review findings and repairs

### F1 — AC2 response heads are per tag

`packages/dcb-client/src/executor.ts` now correlates returned written-event SUIDs with the candidate event tags (falling back to response-provided tags where available). It derives one head per claimed tag and chooses the greatest SUID only among events for that tag; it no longer returns a global `heads` maximum for every tag. The existing scalar `head` remains the global response head.

The new AC2 guard in `test/g57-executor.spec.ts` commits two events to `room:head-a` and `room:head-b`, supplies the intentionally global-looking response heads `[0002,0002]`, and verifies the executor result is `[0001,0002]` by tag. The pre-fix guard was red: it received `[0002,0002]` and expected `[0001,0002]`.

### F2 — supplied SnapshotReader is authoritative in snapshot-only mode

`snapshotReaderFrom` now consults a supplied reader's `exists` and `head` methods before the snapshot-only missing check. Snapshot arrays retain their existing precedence and uncovered array cells still fail closed. The AC3 guard supplies a reader whose existence/head methods return `true`/`suid-snapshot-reader`, makes the transport existence endpoint throw if used, and verifies the commit claim carries that exact head with zero transport existence reads. The pre-fix guard returned `executor.snapshot_missing` before consulting the supplied reader.

### F3 — cloud error bodies are credential-safe

Non-success `CommitHttpResult` values from `createSekibanCloudTransport` are sanitized to a bounded safe code and the generic message `SekibanCloud request failed`; 401/403 continue to become the typed `credential.rejected` error. Untrusted body fields, including `error`, `detail`, and partial data, do not enter the public result. The AC4 guard returns a synthetic HTTP 500 containing the credential secret and verifies both the raw cloud result and executor result contain no secret. The pre-fix guard observed the secret in the returned HTTP body.

No V1 body, public command shape, snapshot array semantics, credential header construction, or deployment configuration was changed.

## Red-before-green evidence

Command run after adding the three guards and before the product fixes:

```text
npm exec vitest -- run --config vitest.config.ts test/g57-executor.spec.ts
exit 1
Test Files 1 failed (1)
Tests 3 failed | 2 passed (5)
F1: expected room:head-a=0001, received 0002
F2: expected committed from supplied SnapshotReader, received invalid/snapshot_missing
F3: expected sanitized cloud failure, received error=fixture-secret-that-must-not-escape
```

After the fixes, the same focused file passed all 5 tests. The existing G57 path guard also remained green and its mutation probe remained red.

## Verification

| Command | Result |
| --- | --- |
| `npm run test:g57` | PASS; build, 5 executor tests, path guard green, mutation probe red |
| `npm run test:g15` | PASS; 2 files/11 tests and pagination self-test |
| `npm run test:boundaries` | PASS; G13/G14/G12 package-boundary fixture |
| `npm run test:g28:boundaries` with `npm_config_cache=/private/tmp/sdt-g57-w142-npm-cache` | PASS; source, negative-fixture, and package-manifest gates |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS with `--max-warnings=0` |
| `npm run test:store-contract` | PASS; G12/G18 store contract |
| `npm run test:d1` | PASS; 12 tests |
| `npm run test:mv` | PASS; 18 tests |
| `npm run test:consumer` | PASS; G13/G14/G18/G19 consumer fixtures |
| `git diff --check` | PASS before commit and on staged repair |

The full `npm test` aggregate was run and completed `88 passed, 1 skipped, 3 failed`. The failures were retained as environment/order evidence, not weakened or edited:

1. `test/g30-trace.spec.ts` expected the pre-existing literal schedule `180000` and observed `179000`.
2. `test/g43-tag-sql.spec.ts` AC6 did not observe the re-armed alarm in the parallel Worker pool; its output included the known `G43 scheduler crash`/`EnvironmentTeardownError` signatures.
3. `test/tag.spec.ts` G5 timed out at 5000 ms under the aggregate pool.

These are outside the changed dcb-client/test paths. The focused G57, boundary, typecheck, lint, and local-e2e contract lanes passed. No Wrangler or Cloudflare operation was run.

## Canonical PR repair transition

The PR preflight classified the update as actionable (`intent-pr-request-update` present). The canonical claim was applied before the repair push:

```text
intent-cli worker claim --repo J-Tech-Japan/sekiban-dcb-ts --kind pr --number 130 --github-only --write --format json
proceed: true
applied: true
add_labels: [intent-pr-update-in-progress]
```

The repair source/test commit above is pushed to the existing PR branch. The canonical `repair-pushed` completion result and final branch head are recorded in the required report after the evidence commit; no raw label mutation was used.
