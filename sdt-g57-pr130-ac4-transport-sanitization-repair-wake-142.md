# SDT-G57-PR130-AC4-TRANSPORT-SANITIZATION-REPAIR-WAKE-142

## Checkpoint

- Repository: `J-Tech-Japan/sekiban-dcb-ts`
- PR: `#130`
- Branch: `claude/sdt-g57-deploy-free-w126`
- Reviewed starting head: `f29b13ebea6e39e07023656b95f41665b2560df1`
- Scope: AC4 cloud-transport/public-boundary sanitization only; no deployment,
  Wrangler, Cloudflare, resource, review, merge, or lifecycle-label operation.
- The pre-existing unrelated worktree dirt was preserved and was not staged.

## Diagnosis and repair

Review `5124772828` identified the remaining AC4 leak in the cloud transport's
non-success `CommitHttpResult` path. The earlier repair replaced the upstream
`body.error` and discarded extra body fields, but it passed the upstream
`body.code` and `headers` through unchanged. The synthetic-secret probes could
therefore expose Cloud-originated credential material in the serialized code or
header map even though the message was generic.

`packages/dcb-client/src/executor.ts` now applies the following boundary:

1. HTTP 401/403 keeps the existing typed `credential.rejected` error and status.
2. Every other non-2xx result gets the fixed message
   `SekibanCloud request failed` and an empty header map.
3. A syntactically valid upstream error code is retained only when it does not
   contain either configured cloud credential identity (`CredentialId` or
   `CredentialSecret`); otherwise it becomes `transport`.
4. Untrusted body fields (`error`, `detail`, partial data, and all other fields)
   never enter the public result. Successful responses are unchanged.

This preserves meaningful non-secret classifications such as
`consistency_conflict`, while the body, serialized code, and headers cannot
reflect either configured credential value. V1 bodies, request credential
headers, status codes, retry behavior, F1 per-tag heads, F2 SnapshotReader
semantics, AC5 deployed evidence, and G15 classification were not changed.

## Regression guard

`test/g57-executor.spec.ts` now uses a synthetic credential sentinel in all
three response components: body `code`, body `error/detail`, and an upstream
credential header. The public cloud transport result must have code
`transport`, the generic message, and `{}` headers, with no sentinel in its
serialization. A second synthetic response proves a non-secret
`consistency_conflict` classification survives while its secret-bearing body
and header do not. The executor result is also checked for sentinel absence;
401/403 remains the typed `credential.rejected` path.

The review receipt is the pre-fix red evidence: at the reviewed head the
synthetic code/header values were returned through the public result. The new
assertions are red-capable against the old pass-through implementation and are
green at this checkpoint. No gate, fixture, timeout, or acceptance criterion
was weakened.

## Verification

| Command | Result |
| --- | --- |
| `npm run test:g57` | PASS; package build, 5 executor tests, path guard green, mutation probe red |
| `npm run test:g15` | PASS; 2 files/11 tests and pagination self-test |
| `npm run test:g16` | PASS; 2 files/6 tests and UI contract check |
| `npm run test:g21 && npm run test:g22 && npm run test:g23 && npm run test:g24 && npm run test:g25` | PASS; all five local lanes and their tests |
| `npm run test:g26` | PASS; 4 files/32 tests |
| `npm run test:g27` | PASS; 1 file/6 tests |
| `npm run test:g49` | PASS; binding parity and mutation receipts red as expected |
| `npm run test:g52` | PASS; 4 files/18 tests and omission mutants red |
| `npm run test:g53` | PASS; 1 file/10 tests and scope mutation guards |
| `npm run test:g54` | PASS; 3 files/18 tests and accepted-positive/omission mutants red |
| `npm run test:g55` | PASS; 4 files/12 tests and read-visibility mutation guards |
| `npm run test:g65` | PASS; 2 files/17 tests and admission/ring-apply/idempotence guards |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS with `--max-warnings=0` |
| `npm run test:boundaries` | PASS; G13/G14/G12 boundary fixture |
| `npm run test:g28:boundary:source` | PASS |
| `npm run test:g28:boundary:negative` | PASS |
| `npm run test:g28:boundaries` / `npm run test:g28:boundary:package` | Environment exception: the unchanged `npm pack --dry-run --json --workspace @sekiban/dcb-domain` exits 1 under local Node `v23.10.0`/npm `10.9.2`; first npm could not write `/Users/tomohisa/.npm/_logs`, and a rerun with `NPM_CONFIG_LOGS_DIR=/private/tmp/sdt-g57-npm-logs` still exited 1. No source or package-boundary files were changed. |
| `npm run test:store-contract` | PASS; G12/G18 store contract |
| `npm run test:d1` | PASS; 1 file/12 tests |
| `npm run test:mv` | PASS; 2 files/18 tests |
| `npm run test:consumer` | PASS; G13/G14/G18/G19 consumer fixtures |
| `npm test` | Known aggregate exceptions only: 86 files passed, 1 skipped, 5 files failed; 760 tests passed, 1 skipped, 6 failed. Failures were the pre-existing G30 `179000` vs `180000` schedule assertion, G43 AC6 alarm/re-arm race, G6 repair teardown/timeouts, commit AC7 timeout, and Tag G5 timeout. They do not exercise the changed dcb-client cloud-result path and no gate was weakened. |
| `git diff --check` | PASS before staging |

The local runner reported the normal Hyperdrive binding notice during Vitest;
no Wrangler or Cloudflare command was run.

## Handoff

Only the following task files are eligible for the repair commit:

- `packages/dcb-client/src/executor.ts`
- `test/g57-executor.spec.ts`
- this artifact

The existing unrelated dirty artifacts and `packages/dcb-runtime/src/trace/CommitTrace.ts`
were deliberately left unstaged. The exact pushed repair head and canonical
`repair-pushed` transition are recorded after the commit.
