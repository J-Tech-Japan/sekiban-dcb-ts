# SDT-G36 evidence — commit correctness after G41

Status: folded post-G41 slice. Operator ruling O-G41-2 (2026-08-28) was
option B: fold G36 only after the fundamental design change. That change has
landed (two-scope ADR, G41 removed JOURNAL from the commit path, G45/G46).
This unit does **not** implement the pre-G41 Journal permit saga, S04–S14
control rows, alarm takeover, or the p1–p10 reset.

## Defects closed

| Defect | Before | Landed surface |
| --- | --- | --- |
| `tagWriteResults` absorbed a later append | `successResponse` read each tag `/head-facts` after append | Append response carries the write transaction's `{ version, updatedAt }`. `CommitWorker` stores that pair on the attempt and emits V1 `{ tag, version, writtenAt }` from it. Success path does not fetch `/head-facts` or `/state`. |
| Bootstrap `plan` could reach `PLANNED` while a commit could still write | Admit is released immediately, so `normalInFlight` is 0 before allocation. `finalize` is a read-only epoch check. | Bootstrap-owned `writePermits` acquired after admit/release and before allocation. `plan` rejects `bootstrap_write_permit_active` in the same storage transaction as the status check. |

The permit is only a bootstrap barrier. It is not commit-outcome authority.
Release happens only when every target tag is durably resolved: all-appended
success, a reservation/allocation failure whose cancel proved no-write
(`failedTags` empty), a finalize rejection before append whose cancel proved
no-write, or a partial outcome after fence install. Fence-install failure and
a cancel that does not prove no-write keep the permit. A crash-left permit
correctly blocks `plan`. There is no alarm recovery and no lease expiry.

Same `commandId` + same digest is idempotent. A different digest is
`409 bootstrap_permit_digest_mismatch`.

## Receipt replay

SQL `tag_commit_receipt.written_version` is `INTEGER NOT NULL` on a fresh
table. Existing stores gain the column with an idempotent
`ALTER TABLE ... ADD COLUMN` (nullable, so old rows stay `NULL`). Exact
duplicate replay returns the stored `committed_at` and `written_version`.
The lookup prefers the caller's epoch, then the receipt whose head is this
batch, then the sole receipt for that attempt, because exact-duplicate
replay is checked before the epoch gate. A missing receipt or a `NULL` `written_version` fails closed
(`duplicate_receipt_missing` / `duplicate_receipt_unknown`). The current head
is not substituted, and `Date.now` is not invented. The non-SQL append seam
stores the same pair on `TagRecord.writeReceipts`, keyed
`attemptId:epoch`.

Public `tagWriteResults` field names stay `{ tag, version, writtenAt }`.
S13/S14 remain trace observations. S14 does not fetch head facts.

## Out of scope (not in this diff)

- JOURNAL on the commit path, `sdt.commit/v2`, alarm takeover, RESOLVED_SAFE,
  epoch-scan, generation scaffold, p1–p10
- CF-CODE-1 WAIT discharge, Cloudflare placement, npm publish, SafeWindow / G67
- A new CI lane or G40 allowlist edit (`npm test` already runs this file)

## AC1 — append-owned version and duplicate replay

```
npx vitest run --config vitest.config.ts --maxWorkers=1 --no-file-parallelism test/g36-commit-correctness.spec.ts
```

Paste (2026-09-18):

```
 ✓ tag append returns the write transaction's own version+updatedAt and replays it on duplicate
 ✓ commit tagWriteResults report the first append's version and writtenAt despite a later concurrent append
 ✓ rejects a different digest for the same command permit and accepts the same digest
 ✓ bootstrap plan is rejected while a commit holds the write permit, and the commit still writes

 Test Files  1 passed (1)
      Tests  4 passed (4)
```

The first test appends version 1, appends a later event at version 2, then
replays the first body and requires the original `version` and `updatedAt`.

## AC2 — CommitWorker uses append results

`test/g45-head-facts.spec.ts` AC2 asserts the success seam receives
`writes.tagWriteFacts` and records no `/head-facts` paths. `test/g30-trace.spec.ts`
still expects S14 member identity from the completion path, with the append
stub returning `{ version, updatedAt }` so assembly does not re-read head facts.

Included in the focused run below.

## AC3 — permit window

Covered by the G36 plan-rejection test, the digest-mismatch test, and the
updated bootstrap oracles:

- `keeps normal allocation legal and holds the write permit before allocation`
- `revalidates a real admitted commit after bootstrap advances its epoch and leaves tags byte-empty`
  (plan during `beforeBootstrapFinalization` is `bootstrap_write_permit_active`;
  the commit still writes one tag event)
- `has both directions of the real CommitWorker/bootstrap race oracle`
  (bootstrap-first remains `bootstrap_command_rejected`)

## Focused regression paste

```
npx vitest run --config vitest.config.ts --maxWorkers=1 --no-file-parallelism \
  test/g36-commit-correctness.spec.ts test/bootstrap.spec.ts test/commit.spec.ts \
  test/g30-trace.spec.ts test/g45-head-facts.spec.ts test/g37-hop-reduction.spec.ts \
  test/g41-journal-removal.spec.ts test/g76-regression-matrix.spec.ts
```

Paste (2026-09-18, local, Postgres at `127.0.0.1:54329` down):

```
 ❯ test/bootstrap.spec.ts (12 tests | 3 failed)
     × uses the serving allocator lineage after READY so a real commit reaches the downstream store query
     × drives the real Queue entry point with BOOTSTRAP bound and retries a legal PLANNED service
     × drives the real projection-rebuild entry point with BOOTSTRAP bound and a legal PLANNED service
Error: Network connection lost.

 Test Files  1 failed | 7 passed (8)
      Tests  3 failed | 75 passed (78)
```

Those three failures are the existing store / queue / projection entry points.
They need the local Postgres binding. They are not G36 assertion failures.
The G36 permit and `tagWriteResults` tests in that run passed.

## AC4 — scope fence

- No JOURNAL reintroduced on the commit path.
- No `sdt.commit/v2`, alarm takeover, or p1–p10 cutover.
- PR closes the published G36 issue.
