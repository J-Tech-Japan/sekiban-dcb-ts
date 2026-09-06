# SDT-G65-PR127-REREPAIR-WAKE-131

Status: blocked for rereview pending the source-universe design ruling below.

Branch: `claude/sdt-g65-local-wake-w128`
Reviewed/request-update start: `d6b89c7f55171e1dd4233c4e8c043b6e3992b969`
Issue/PR: J-Tech-Japan/sekiban-dcb-ts#126 / PR #127
Deployment: none. Wrangler, Cloudflare, resource, migration, secret, and PR
deployment operations were not used in this checkpoint. The final pushed
repair head is the exact hash reported by the canonical worker/report
transport after this local checkpoint is pushed.

## Intent and PR workflow

The installed `intent-cli` first-call sequence was run before editing:

1. `intent-cli task fix-pr-comments --repo J-Tech-Japan/sekiban-dcb-ts --pr 127 --workdir /Users/tomohisa/dev/GitHub/SekibanDcbTsImplementation/.g65-w128 --format markdown`
2. `intent-cli worker pr-comment-preflight --repo J-Tech-Japan/sekiban-dcb-ts --pr 127 --workdir /Users/tomohisa/dev/GitHub/SekibanDcbTsImplementation/.g65-w128 --format json`
3. `intent-cli worker claim --kind pr --repo J-Tech-Japan/sekiban-dcb-ts --number 127 --write --format json`

Preflight classified the PR as `request-update-pending`; the worker claim
added the intent PR-update label. No raw label or GitHub API mutation was used.
The result-summary and worker completion commands are run only after the
narrow repair commit is pushed.

## Approved findings

### F1: durable source discoverability and the remaining design boundary

The W155-C evidence config restores `DIRECT_DOORBELL=true`; this is a local
configuration/evidence correction only and was not deployed. The G44 zero-
delivery and DLQ tests no longer seed `serialized_dcb_source_partitions` with
`registerSnapshot`; the ordinary production append path must make the row
discoverable.

The Tag path now writes a durable local
`tag_source_partition_registration` obligation in the same SQLite transaction
as the event/outbox record. Its alarm retries the source-registration D1 write
after the three bounded post-commit attempts, independently of Queue delivery
and admission. The real test
`retries source discoverability from durable Tag state after registration
exhaustion without delivery` injects a registration crash, verifies the public
commit remains 201, observes pending retry state, restores D1, runs the alarm,
verifies source registration, and scans the undelivered event as `BLOCK`.
This is unseeded production behavior and the G44 suite remains 8/8 green.

The requested stronger test cannot honestly be claimed yet. The independent
`GlobalCompletenessReconciler` enumerates only
`serialized_dcb_source_partitions` in global D1. If a brand-new committed
partition has no row there while an unrelated partition advances, the scanner
cannot observe the missing partition and therefore cannot prove that the
frontier did not cross its gap. The Tag-local durable obligation cannot be
read by that independent scanner. This is a cross-store source-universe design
dependency, not a safe-fence weakening: no code here substitutes a materialized
view head or claims absence is fail-closed. A design ruling is required before
the requested no-gap acceptance proof can be added; the checkpoint is blocked
on that specific dependency.

### F2: genuine production idempotence mutant

`test:g65` now invokes `scripts/g65-admission-mutation-runner.mjs`. The runner
mutates the real `D1EventStore` production source once by removing stored
identity rejection and changing the exact event conflict from `DO NOTHING` to
an overwrite, then runs the real direct-first/Queue-first duplicate,
replay, and conflict oracle. The unmutated oracle passed and the mutant
failed on the conflicting replay (`stored` was observed where
`D1IdentityConflictError` was required), exit code 1 for the mutant as
expected. The receipt is
`.artifacts/sdt-g65-w131-idempotence-mutant.json`. The six existing G60
mutants were not edited and remained red-capable/green in
`npm run test:g60:required`.

### F3: observed clocks

`.artifacts/analyze-g65-w128.mjs` now uses correlated admission-ledger
`Date.now()` observations and the completion observation after
`D1EventStore.recordDelivery` returns. It labels the origin explicitly and
excludes authored `dcb_events.Timestamp`, D1 `received_at`, and caller
`received_at` from visibility timing. No new deployed before/after
distribution is claimed in this local-only task.

### F4 and accepted boundaries

The header-only admission indication and byte-identical valid V1 JSON body
contract remain unchanged. Existing G21–G25 red probes, bounded non-gating
registration behavior, sample header forwarding, and corrected AC4
ordering/boundary remain intact. No G58/G60/G61 safe-window, Queue, fence,
5,000 ms, or V1 behavior was changed.

## Receipt hygiene

The six expanded W129 Wrangler/ledger logs had terminal-column whitespace that
made the requested full-range `git diff --check` fail. Their bytes were not
edited: each was gzip-compressed with `gzip -n -c`, verified losslessly, and
the expanded tracked copies were removed. Decompress with
`gzip -dc <artifact>.log.gz > <artifact>.log` (or pipe to `cmp`).

| compressed receipt | SHA-256 |
| --- | --- |
| `.artifacts/sdt-g65-w129-deploy-d1-unavailable.log.gz` | `2e8109c1ef2b8cc8850d083a200a31ba865c982280b88ce1fbabe3ccb0b2ae9f` |
| `.artifacts/sdt-g65-w129-deploy-normal.log.gz` | `10559268824643cc4d530355f6a834ff1ec555a42ba0d7ee11db91cd00bc6ee8` |
| `.artifacts/sdt-g65-w129-deploy-restore-normal.log.gz` | `338691d93d61595ea4267d68c1f5d80c0803578459cd9cf47ff5faf1d9039f52` |
| `.artifacts/sdt-g65-w129-ledger-query.log.gz` | `28d7bf4ec34cd5f6616be8a28d85f8c4b5b2d50c4456168feaaf2bdde816b82a` |
| `.artifacts/sdt-g65-w129-migrations-apply.log.gz` | `c82217cf8d05da4aac74259df6a01a09dd0d1f93ed9614da7734b74340eac622` |
| `.artifacts/sdt-g65-w129-migrations-list.log.gz` | `0660836cf76216945a86d26716dae9ca6acdc516984184e4d635f37e9cce57c9` |

## Verification

- `npm run test:g65 --silent`: 9/9 behavior tests; guard self-test and
  post-change guard green; static omission, unbounded, response-gated,
  durability-order, and direct-omission mutants red; production
  idempotence-removal mutant red.
- `npm run test:g44 --silent`: contract guard, self-test, 8/8 tests, and all
  four production G44 mutation probes green/red as expected.
- `npm run test:g60:required --silent`: 3/3 focused files, 14/14 tests,
  direct-doorbell/Queue/durable-hop/unsafe-writer/post-admission guards green;
  all six G60 mutant receipts red as expected.
- `npm run typecheck --silent`: passed.
- `npm run lint --silent`: passed.
- `git diff --check`: passed after the lossless receipt conversion. The exact
  requested range check is repeated after the repair commit as part of the
  final push verification:
  `git diff --check 4687efa5c49951d9966a3785be5fd7b2620c6e4f...HEAD`.

The repair is pushed as one narrow local checkpoint. Because F1's missing
partition/unrelated-advancement proof needs the source-universe ruling, this
task stops before deployment, rereview-ready claims, merge, and issue
completion.
