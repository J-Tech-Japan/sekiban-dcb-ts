# SDT-G66 local and production prep — W160

Status: production witness completed with an explicit cleanup blocker. The
before/after cohorts passed the G66 public-surface bounds; the separately
authorized old-G32 cleanup was not run because its required consumer-topology
safety condition was false.

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

## Production window result

All Wrangler child processes removed and recorded these five names as
`UNSET`: `CLOUDFLARE_API_TOKEN`, `CF_API_TOKEN`, `CLOUDFLARE_API_KEY`,
`CF_API_KEY`, and `WRANGLER_API_TOKEN`. No call used `--keep-vars`. The
conformance value was generated once into the private path
`/private/tmp/sdt-g66-w160-conformance-token` and was supplied only through
`G53_CONFORMANCE_TOKEN_FILE`/`--token-file`; it is not present in this
artifact or any receipt. Existing private token paths returned the application
403 `{"error":"Conformance authentication required","code":"unauthorized"}`.
The packet's self-provisioning rule authorized one fresh secret put. The
`wrangler secret list` result named only `CONFORMANCE_TOKEN`,
`G32_CUTOVER_FENCE_TOKEN`, and `G32_FREEZE_TOKEN`; the put succeeded and
published version `4fadfcb8-077c-446c-b271-6040d8744713`. Because that secret
version had only the generic `workers/triggered_by: secret` annotation, the
unchanged source was redeployed before sampling.

The issue claim was completed before the window with:

```text
intent-cli worker claim --repo J-Tech-Japan/sekiban-dcb-ts --kind issue --number 128 --github-only --write --format json
```

The branch is `claude/sdt-g66-local-and-production-w160`, based on
`origin/main` `774f76def8fcf37edf4bd651187bd3a9230efa61`. The production
candidate source is `134476a0c57187e697c4db55689b486b34bf2aed`.

The C-0 helper used only explicit operational-table `DELETE` statements on
the existing production pipeline/MV pair. The first count-only receipt
`.artifacts/sdt-g66-w160-production-c0-reset.json` exited 1 before writes with
SQLite code 7500 (`too many terms in compound SELECT`). The helper was changed
to one count query per table; each of
`.artifacts/sdt-g66-w160-production-c0-reset-retry.json`,
`.artifacts/sdt-g66-w160-production-c0-reset-retry2.json`,
`.artifacts/sdt-g66-w160-production-c0-reset-retry3.json`, and
`.artifacts/sdt-g66-w160-production-c0-reset-post-baseline.json` records 105
invocations, exit 0, and zero post-counts for the reset operational rows.
No schema, migration, DO namespace, or Queue configuration was changed.

The normal parent deployment used the exact source
`774f76def8fcf37edf4bd651187bd3a9230efa61`, produced version
`b436a7bd-a698-4e34-8446-57a489c90847`, deployment
`a0e9d778-b0b1-4532-a5ab-c6a435a8aabc`, and annotation
`SDT-G66 W160 baseline parent 774f76def8fcf37edf4bd651187bd3a9230efa61 normal config after conformance secret`.
The self-ring candidate deployment produced version
`16d0ee47-24ad-43d4-ad65-668a6933b5c0`, deployment
`f66411cd-eaa1-4f44-833a-87554cc9d5ea`, and annotation
`SDT-G66 W160 self-ring candidate exact 134476a0c57187e697c4db55689b486b34bf2aed`.
Both had 100% traffic. The candidate version view proved
`DIRECT_DOORBELL=true`, `DIRECT_DOORBELL_RECEIVER_MODE=self`,
`DIRECT_DOORBELL_SELF_BINDING_PROOF=true`,
`DIRECT_DOORBELL_DEGRADATION=queued-degraded`,
`DIRECT_DOORBELL_MAX_INVOCATIONS=32`, and a real
`DOWNSTREAM_DOORBELL` service binding to
`sekiban-dcb-meeting-room-cloudflare-only` with entrypoint
`MeetingRoomDownstreamDoorbell`. The existing production pipeline/MV D1 pair,
outbox and DLQ remained in place.

The exact parent cohort command was:

```text
G53_CONFORMANCE_TOKEN_FILE=/private/tmp/sdt-g66-w160-conformance-token node scripts/deploy/g66-e2e.mjs --base-url https://sekiban-dcb-meeting-room-cloudflare-only.ttakaoka.workers.dev --token-file /private/tmp/sdt-g66-w160-conformance-token --phase baseline --run-id sdtg66w160c5aaaa --source-commit 774f76def8fcf37edf4bd651187bd3a9230efa61 --version-id b436a7bd-a698-4e34-8446-57a489c90847 --samples 10 --pace-ms 10000 --poll-ms 2000 --report .artifacts/sdt-g66-w160-production-baseline-final2.json
```

It exited 0: response p50/p95 `1524/2028 ms`, unsafe `412/523 ms`, safe
`51156/54113 ms`, 10/10 accepted, 0 unsafe-bound misses, 0 safe-bound misses,
and admissions `8 admitted / 2 unknown`.

The exact candidate cohort command was:

```text
G53_CONFORMANCE_TOKEN_FILE=/private/tmp/sdt-g66-w160-conformance-token node scripts/deploy/g66-e2e.mjs --base-url https://sekiban-dcb-meeting-room-cloudflare-only.ttakaoka.workers.dev --token-file /private/tmp/sdt-g66-w160-conformance-token --phase candidate --run-id sdtg66w160d6aaaa --source-commit 134476a0c57187e697c4db55689b486b34bf2aed --version-id 16d0ee47-24ad-43d4-ad65-668a6933b5c0 --samples 10 --pace-ms 10000 --poll-ms 2000 --report .artifacts/sdt-g66-w160-production-candidate.json
```

It exited 0: response p50/p95 `1725/2318 ms`, unsafe `335/579 ms`, safe
`48380/55239 ms`, 10/10 accepted, 0 unsafe-bound misses, 0 safe-bound misses,
and admissions `10 admitted`. Both receipts include read-through followed by
portable snapshot-only commands, tag/query reads, and per-poll coverage and
safe-pass observations. The candidate observed 203 health rows and 72 pass
IDs; parent observed 211 rows and 86 pass IDs. Both observed delivery,
fence-expiry, cron, and coverage-retry trigger labels. The guard receipts
`.artifacts/sdt-g66-w160-baseline-guard.json` and
`.artifacts/sdt-g66-w160-candidate-guard.json` exited 0 with all acceptance
booleans true.

The final read-only cleanup resolution found the old G32 outbox
`sekiban-dcb-meeting-room-g32-9043d626fe1149cb-outbox` with zero producers but
one consumer: `worker:sekiban-dcb-meeting-room-cloudflare-only`. Its DLQ had
zero producers and consumers. Since the protected production worker still
consumes the old outbox, the required “no other worker consumes its outbox”
condition is false. No detach or destructive call was attempted; the old
worker, D1s, queues, W155-C and production resources remain untouched.

The successful raw receipts and reset receipts are retained under
`.artifacts/`. The earlier failed/expanded receipts are also preserved but
are intentionally not staged because they contain large repeated health
arrays. The production witness itself passed the G66 public-surface bounds;
this task remains blocked only on the explicit cleanup safety contradiction.
