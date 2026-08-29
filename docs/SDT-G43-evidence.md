# SDT-G43 evidence

## Development-stage boundary

This is an in-place change to the ordinary Tag Durable Object and meeting-room sample. It creates no Worker, namespace, provider read-back, rollback or migration protocol.

Pre-G43 `TAG_KEY` application records are deliberately not migrated. Under the C-0 development ruling, delete and recreate a test record if it must be used; there is no operational data to preserve.

## AC1–AC4

[`TagSqlSchema.ts`](../packages/dcb-runtime/src/tag/TagSqlSchema.ts) contains literal SQLite DDL for identity, reservation, epoch/tombstone, events, head, committed membership, outbox obligation and commit receipt, with primary keys, uniqueness, foreign keys and indexes. `tag_event.event_json` stores the complete current `TagEvent`, including payload and metadata.

[`g43-surface-check.mjs`](../scripts/g43-surface-check.mjs) proves this is the normal Tag DO, has no `wrangler.g43*` Worker, adds no scanner HTTP route, does not read full history in append, and does not contaminate G38 receiver/tombstone components. Its public-route, history-read, receiver-contamination, and missing-schema mutations are red.

Append rechecks reservation token and head, then writes event, head, committed membership, outbox obligation and commit receipt in one local transaction. [`g43-commit-mutation-runner.mjs`](../scripts/g43-commit-mutation-runner.mjs) removes each actual production write, rebuilds, and verifies the matching SQLite-fact oracle turns red. The transaction-fault test rolls all five facts back. Rejected reserve leaves no partial state; cancel keeps committed event/membership/obligation, adds a tombstone, and rejects a delayed same-attempt/epoch operation. First-write relabeling is rejected.

## AC5–AC6

`tag_outbox_obligation` contains monotone sequence, status, next retry, canonical bytes, digest, declared tags and local membership. `g43ScanSourceObligations()` is a DO-internal source-table RPC: it does not call Queue, doorbell, pending delivery, detector or runner count. The typed finding `tag_outbox_obligation_unacknowledged` is produced for no-delivery and always-throw delivery. Local sink acknowledgement is the only acknowledgement here; it is not a global receipt.

An explicit Queue drain is an immediate handoff/retry attempt and may request pending obligations regardless of `next_attempt_at`; ordinary alarm selection remains governed by that durable retry deadline. This preserves the existing direct-drain seam without weakening the single-alarm scheduler.

The sole scheduler recomputes the one DO alarm as the minimum of reservation expiry and pending retry. Fixtures cover before/after/equal due times, insertion while delivery runs, crash before/after re-arm, 33 items with a 32-row selection budget, and poison alongside sibling/reservation work. The backlog fixture proves exact source selection before delivery and then source identity-set progress after re-arm.

## AC7

The exact issue-owned JSON is committed as [`g43-digest-spec.json`](../contracts/g43-digest-spec.json) and [`g43-measurement-spec.json`](../contracts/g43-measurement-spec.json). The v2 digest uses SHA-256, domain/presence/BE32 framing, raw payload bytes, and UTF-8-byte sorted/deduplicated individually length-prefixed tags.

[`g43-digest-contract-check.mjs`](../scripts/g43-digest-contract-check.mjs) independently implements the contract and verifies all seven committed lowercase-hex vectors: ASCII, non-ASCII, supplementary-plane, unit-separator, two-vs-one tag collision, invalid UTF-8 payload, and absent/empty optional lineage. Runtime fixtures prove tag reordering/duplicates canonicalize, an extra tag and changed payload conflict, unknown fields reject, and different identities persist separately.

## AC8

The structural fixture consumes the measurement spec's five histories, six operations, four metrics, three repetitions and median. It instruments the real SQL store, exhausts every reached cursor, and sums final counters. The required complete grid is 120 rows including informational rebuild rows.

| bounded operation | rowsRead | rowsWritten | request bytes | response bytes |
| --- | ---: | ---: | ---: | ---: |
| reserve | 7 | 6 | 190 | 292 |
| commit | 12 | 18 | 426 | 83 |
| cancel | 8 | 5 | 104 | 53 |

Those values are unchanged at histories 1/10/100/1000/5000. `readAfter` returns/reads 1, 10, 50, 50, 50 rows; incremental ten-event catch-up reads ten at every history; rebuild reads its full history and is informational. The exact range plan is `SEARCH tag_event USING INDEX tag_event_suid_idx (suid>?)`, no scan, with returned count/set equality. No wall-clock decision or asymptotic constant-time claim is made. Intermediate spike, negative-endpoint spike, single inflated point, over-bound read, missing informational row, and scan-plan mutations are red.

## AC9–AC10

This PR does not prove global D1 delivery or receipts, destination reconciliation, detector health, read/view-frontier gating, import round-trip, TagState split, or JOURNAL removal.

All nine NO-GO conditions are PASS: five-fact mutation/rollback, source-only enumeration, replay versus typed digest conflict, cancel preservation, no whole-history append, full obligation envelope, single-alarm coexistence, poison/backlog progress, and immutable identity. If any was false the table/source mutation fixtures would fail closed.

## Verification

```sh
npm run test:g43
npm run typecheck
node scripts/g40-ci-coverage-check.mjs
node scripts/g40-verify-needs.mjs --self-test
git diff --check
```
