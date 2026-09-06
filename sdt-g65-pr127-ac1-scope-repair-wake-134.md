# SDT-G65-PR127-AC1-SCOPE-REPAIR-WAKE-134

## Checkpoint

- Repository: `J-Tech-Japan/sekiban-dcb-ts`
- PR: `#127`
- Branch: `claude/sdt-g65-local-wake-w128`
- Failed starting head: `a9a3d9bd05cf383da32ffd95a19dc9f6fc7e5a0a`
- Local repair commit: `a3b3483` (`fix: narrow G65 source-universe admission gate`)
- Cloudflare/Wrangler: not used; no deployment, resource, secret, D1, Queue, or remote operation was performed.
- Preserved dirty evidence: all pre-existing modified and untracked evidence was left unstaged and untouched.

This checkpoint is local-only. It does not claim deployed AC5/AC6 evidence.

## Diagnosis and repair

The failed head unconditionally entered `ensureSourcePartitionBeforeFirstAppend`
for SQL-backed compositions with a service id. A missing D1 binding, or a D1
binding whose schema did not contain the G44 global array (`dcb_events.EventDigest`),
was then treated as a failed source-partition registration. Generic foundation,
G21/G25, G28/G29/G30/G32, G43/G46 and local-e2e compositions consequently
received typed 503/504 or rejected outcomes although they had no configured G44
completeness store. This is benign-condition misclassification, not a
configured-store registration timeout or a cold fake budget race.

The repair is deliberately narrow:

1. No D1 binding returns the pre-G65 local-append path immediately.
2. A D1 binding with no `dcb_events` table or no `EventDigest` column is
   classified as an explicitly unconfigured completeness store and also uses
   the pre-G65 local-append path. It does not enter the first-write refusal
   contract.
3. Only a successful G44 schema probe enters the bounded source-partition
   INSERT. A configured INSERT failure, throw, or hang still returns typed,
   retryable HTTP 503 `partition_registration_unavailable` and writes no local
   event, obligation, or receipt. The `G65_DERIVED_WRITE_BUDGET_MS = 300`
   budget is unchanged.
4. After an accepted append, an unconfigured composition may record the local
   `tag_source_partition_registration` row as scheduler bookkeeping. This is
   not a D1 registration, is not awaited before the response, and cannot
   authorize the G44 safe frontier. It restores the pre-G65 scheduler behavior
   without broadening the gate.
5. Configured existing partitions remain non-gating and preserve the unchanged
   not-admitted/header and Queue fallback semantics.

The G44 completeness fence and safe-lane behavior are unchanged. No 5,000 ms,
Queue, outbox, reservation/fence, response-envelope, or G62 behavior was
weakened.

## Red/green evidence

- Pre-change guard receipt: `.artifacts/sdt-g65-w134-pre-change-red.json`.
  It is a durable expected-red receipt pinned to source revision
  `68454969e6b9c15bb22e5e57bfd388167477dbfb`.
- Green/mutant receipt: `.artifacts/sdt-g65-w134-green-and-mutants.json`.
  It records green post-change wiring at source revision
  `a9a3d9bd05cf383da32ffd95a19dc9f6fc7e5a0a` and expected-red results for
  omitted admission, unbounded doorbell, response-gated-on-D1, reordered
  durability, production idempotence removal, and omitted direct attempt.
- `npm run test:g65` ran 11/11 behavior tests, the guard self-test and
  post-change guard, and the production idempotence-removal mutation runner;
  all passed, with the mutation's pre-green oracle intentionally red.
- The configured hanging fixture now proves that the G44 schema probe succeeds
  and the source-partition INSERT hangs; it returns typed 503 with zero local
  event/receipt rows. The no-D1 and no-G44-schema fixtures prove 201 with one
  event/receipt. The existing registered-tag unavailable-D1 and idempotence
  cases remain green.

The G43 mutation runner was also repaired only at its stale call-site anchor:
the production helper now has the required `tag` argument. `npm run test:g43`
ran its 20 tests and all five production fact mutants red.

The G32 explicit legacy-fixture inventory now includes the newly added
`test/g65-admission.spec.ts`; this is an inventory correction, not a relaxed
allow-list. The full G32 lane and its forced-red probe pass with the writable
local NuGet cache described below.

## Local CI-equivalent results

The commands below are the workflow-equivalent scripts actually run. A
`PASS_EXPECTED_RED` result means the workflow intentionally injected a forced
failure and correctly observed nonzero exit. Repeated `build:packages` steps
inside these npm scripts passed unless a row says otherwise.

| Lane/commands | Result |
| --- | --- |
| `npm run lint`; `npm run typecheck`; `npm run test:g37:evidence`; G50 guard and sample self-test; `npm run test:g52`; `npm run test:g17`; `npm run test:g17:rollout-order` | PASS |
| `npm run test:g21`/`g22`/`g23`/`g24`/`g25`; `g54`; `g56`; `g53` | PASS |
| Forced-red probes for G21–G25, G53, G54, G56 | PASS_EXPECTED_RED |
| `npm run test:g26`; `g27`; `g26:topology`; `g60:required`; `g65:required` | PASS |
| G26/G27/topology/G65 forced-red probes | PASS_EXPECTED_RED |
| G29 mapping, delivery, diagnostics, compatibility, domain-source, authoring-doc, sample, witness, candidate | PASS |
| G29 mapping/delivery/diagnostics/compatibility/domain-source/authoring-doc/sample/witness/candidate forced-red probes | PASS_EXPECTED_RED |
| `npm run test:g31`; `g31:candidate`; their forced-red probes | PASS / PASS_EXPECTED_RED |
| `npm run test:g32:bridge`; `npm run test:g32:candidate`; candidate forced-red | PASS / PASS_EXPECTED_RED |
| `npm run test:g32` and `SDT_G32_FORCE_FAILURE=1 npm run test:g32:forced-red` with `NUGET_PACKAGES=/private/tmp/g65-w134-nuget-packages NUGET_HTTP_CACHE_PATH=/private/tmp/g65-w134-nuget-http-cache` | PASS / PASS_EXPECTED_RED |
| `npm run test:g30` | BLOCKED LOCALLY: the unmodified `g30-trace-mutation-runner.mjs` made no progress after the preceding config-mutant output in both Node 23 and CI-matching Node 24 runs. It was stopped with SIGINT; no G30 source mutation remained. The isolated emitted-row oracle passed after restoration. |
| `npm run test:g51`; `npm run test:g38:prep`; `g42`; `g43`; `g44`; `g58`; `g62`; `g61`; `g45`; `g46`; `g49`; `g41` | PASS |
| Forced-red probes for G38, G42, G43, G44, G58, G62, G61, G45, G46, G49, G41 | PASS_EXPECTED_RED |
| `npm run test:store-contract`; `test:d1`; `test:mv`; `test:boundaries`; `test:consumer`; `test:g16`; `test:cosmos-wiring`; `test:g20`; `test:g20:gate`; `test:g20:candidate` | PASS |
| G20 candidate forced-red probes for G22/G26/G27/G28; G29/G31/G32 candidate probes | PASS_EXPECTED_RED where injected; PASS otherwise |
| `NPM_CONFIG_CACHE=/private/tmp/g65-w134-npm-cache npm run test:g28:boundaries`; same `test:g28:boundary:package` | PASS. The default local cache attempt failed only because `/Users/tomohisa/.npm/_logs` is sandbox-protected. |
| `npm run test:cosmos`; `npm run test:g22:cosmos` | ENVIRONMENT UNAVAILABLE: both fail before test execution because no Cosmos emulator credentials are present. Exact errors require `COSMOS_ENDPOINT`, `COSMOS_KEY`, `COSMOS_DATABASE` or the real bootstrap equivalents. No emulator/resource was started. |
| `git diff --check 4687efa5c49951d9966a3785be5fd7b2620c6e4f4...HEAD`; `git diff --check` | PASS |

The exact aggregate `npm test` was also run under Node 24.18.0, the CI
version. Its final result was nonzero from the known unrelated local timing
surface: `test/commit.spec.ts` AC7 and `test/tag.spec.ts` G5 hit their existing
5,000 ms test timeout, and one `test/g43-measurement.spec.ts` run observed a
non-deterministic spread of 33 against its 2-point allowance. The same commit
AC7 and G5 tests pass alone with one worker, and the complete `npm run test:g43`
lane passes. No timeout, gate, or test was changed.

The workflow's `npm run build` and `e2e:g15:local`/`e2e:g16:local` steps were
not invoked because they execute Wrangler/deployment paths, prohibited by this
task. No Wrangler invocation occurred.

## Scope and handoff

The full PR-range diff check is clean. All prior W133/W134 evidence and dirty
files remain unstaged. This checkpoint does not deploy, create resources,
modify Cloudflare state, or claim AC5/AC6. PR #127 remains the existing PR;
the pushed repair head and canonical worker transition are reported separately
by the final handoff.
