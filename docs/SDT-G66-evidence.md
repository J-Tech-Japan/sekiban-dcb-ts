# SDT-G66 evidence

This document is the durable evidence record for issue #128. The G66 witness
uses one public, browser-equivalent session and does not alter product
behavior. Raw cohort receipts are retained under `.artifacts/` and are written
after every accepted command before visibility polling.

## Contract and guard

- `e2e:g66` sends one cold-first room/create and reservation/cancel session with
  at least ten accepted commands and at least 10 seconds between command
  responses.
- The first command for each tag is read-through; subsequent commands use a
  portable snapshot. Tag-state and public query responses are saved per
  command.
- Every command records the observed response and `x-sdt-global-admission`
  header. Every sample records unsafe and safe first visibility, per-tick
  coverage/frontier health, and tag-state/query reads.
- Missing or late observations are explicitly `censored`; the guard never
  converts a censored sample into a pass. The paused-write, missing-lane, and
  missing-coverage mutants are red-capable and exercised by
  `test/g66-e2e.spec.ts` and `scripts/g66-e2e-guard.mjs --self-test`.

## Deployment evidence — W160 production window

The window used the same existing production Worker and D1 pair. The
pre-change deployment was the true parent `774f76def8fcf37edf4bd651187bd3a9230efa61`
with the normal configuration, version
`b436a7bd-a698-4e34-8446-57a489c90847`, and deployment
`a0e9d778-b0b1-4532-a5ab-c6a435a8aabc`. The candidate was the exact pushed
G66 head `134476a0c57187e697c4db55689b486b34bf2aed`, version
`16d0ee47-24ad-43d4-ad65-668a6933b5c0`, deployment
`f66411cd-eaa1-4f44-833a-87554cc9d5ea`.

Every Wrangler child process removed
`CLOUDFLARE_API_TOKEN`, `CF_API_TOKEN`, `CLOUDFLARE_API_KEY`, `CF_API_KEY`,
and `WRANGLER_API_TOKEN`; all five were recorded `UNSET`. No `--keep-vars`
was used. The conformance bearer was read only from the private
`/private/tmp/sdt-g66-w160-conformance-token` path; its value is absent from
all receipts and documents.

The baseline version view proved the normal state: `DIRECT_DOORBELL=false`,
`DIRECT_DOORBELL_RECEIVER_MODE=separate`, no `DOWNSTREAM_DOORBELL` service
binding, pipeline D1 `f26d1299-82d9-4a64-8647-bc2ec86326ac`, MV D1
`b416b212-4d09-413c-9b8d-7660e475772f`, and the production outbox Queue.
The candidate version view proved `DIRECT_DOORBELL=true`,
`DIRECT_DOORBELL_RECEIVER_MODE=self`,
`DIRECT_DOORBELL_SELF_BINDING_PROOF=true`,
`DIRECT_DOORBELL_DEGRADATION=queued-degraded`,
`DIRECT_DOORBELL_MAX_INVOCATIONS=32`, and
`DOWNSTREAM_DOORBELL.service=sekiban-dcb-meeting-room-cloudflare-only` with
entrypoint `MeetingRoomDownstreamDoorbell`. It retained the same D1 pair,
outbox Queue and DLQ. Queue inspection after deployment showed one producer
and one consumer, both `worker:sekiban-dcb-meeting-room-cloudflare-only`, on
`sekiban-dcb-meeting-room-cloudflare-outbox`; the production DLQ had zero
producers and zero consumers.

Both cohorts were cold-first, sequential, ten accepted public commands,
with at least 10,000 ms between command responses. Each used read-through for
the first command on a tag and portable snapshot-only for subsequent commands;
each saved tag-state and room/reservations query reads. `response`, `unsafe`,
and `safe` are observed send-to-first-response/visibility intervals in ms.

| phase | receipt | response p50/p95 | unsafe p50/p95 | safe p50/p95 | over 5 s / 180 s | admission |
|---|---|---:|---:|---:|---:|---|
| parent normal | `.artifacts/sdt-g66-w160-production-baseline-final2.json` | 1,524 / 2,028 | 412 / 523 | 51,156 / 54,113 | 0 / 0 | admitted 8, unknown 2 |
| self-ring candidate | `.artifacts/sdt-g66-w160-production-candidate.json` | 1,725 / 2,318 | 335 / 579 | 48,380 / 55,239 | 0 / 0 | admitted 10 |

The candidate deltas are response p50 `+201 ms`, response p95 `+290 ms`,
unsafe p50 `-77 ms`, unsafe p95 `+56 ms`, safe p50 `-2,776 ms`, and safe p95
`+1,126 ms`. All ten rows in both cohorts were accepted and remained within
the unchanged 5,000 ms unsafe and 180,000 ms safe bounds. The final public
room/query and tag-state reads were HTTP 200 and consistent. The candidate
health receipt observed 203 per-poll health rows and 72 distinct safe-pass
IDs, with trigger labels delivery, fence-expiry, cron, and coverage-retry;
the parent observed 211 per-poll rows and 86 distinct pass IDs with the same
labels. These are provenance observations, not a claim that every pass ID
was independently required for every sample; repeated rows are retained in
the raw receipt and the compact health rows retain the latest pass tail plus
history counts.

### Parent per-command table

| # | command | executor | admission | response | unsafe | safe |
|---:|---|---|---|---:|---:|---:|
| 1 | create-room | read-through | admitted | 1,756 | 70 | 33,872 |
| 2 | reserve-room | read-through | admitted | 2,028 | 88 | 54,113 |
| 3 | reserve-room | snapshot-only | unknown | 1,664 | 433 | 51,318 |
| 4 | reserve-room | snapshot-only | admitted | 1,470 | 497 | 46,950 |
| 5 | reserve-room | snapshot-only | admitted | 1,534 | 460 | 51,156 |
| 6 | reserve-room | snapshot-only | admitted | 1,506 | 523 | 49,808 |
| 7 | reserve-room | snapshot-only | admitted | 1,572 | 330 | 53,365 |
| 8 | reserve-room | snapshot-only | admitted | 1,524 | 444 | 53,743 |
| 9 | reserve-room | snapshot-only | admitted | 1,461 | 412 | 53,619 |
| 10 | cancel-reservation | snapshot-only | unknown | 1,240 | 112 | 48,897 |

### Candidate per-command table

| # | command | executor | admission | response | unsafe | safe |
|---:|---|---|---|---:|---:|---:|
| 1 | create-room | read-through | admitted | 2,318 | 130 | 31,536 |
| 2 | reserve-room | read-through | admitted | 2,080 | 68 | 45,372 |
| 3 | reserve-room | snapshot-only | admitted | 1,488 | 384 | 41,047 |
| 4 | reserve-room | snapshot-only | admitted | 1,807 | 373 | 48,380 |
| 5 | reserve-room | snapshot-only | admitted | 1,725 | 556 | 51,148 |
| 6 | reserve-room | snapshot-only | admitted | 2,013 | 463 | 50,526 |
| 7 | reserve-room | snapshot-only | admitted | 1,904 | 579 | 51,049 |
| 8 | reserve-room | snapshot-only | admitted | 1,699 | 335 | 53,340 |
| 9 | reserve-room | snapshot-only | admitted | 1,573 | 326 | 55,239 |
| 10 | cancel-reservation | snapshot-only | admitted | 1,300 | 126 | 37,368 |

### C-0 and cleanup receipts

The production operational reset used only explicit `DELETE FROM` statements
against the existing pipeline/MV operational tables, with pre/post per-table
counts; it did not drop schema, apply migrations, change DO namespaces, or
touch Queue configuration. The successful receipts are
`.artifacts/sdt-g66-w160-production-c0-reset-retry.json`,
`.artifacts/sdt-g66-w160-production-c0-reset-retry2.json`,
`.artifacts/sdt-g66-w160-production-c0-reset-retry3.json`, and
`.artifacts/sdt-g66-w160-production-c0-reset-post-baseline.json` (105
invocations, exit code 0, post-counts zero for the reset operational rows).
The first count attempt is retained at
`.artifacts/sdt-g66-w160-production-c0-reset.json`; it stopped before writes
because one compound SQLite `UNION ALL` exceeded the term limit (code 7500),
and the helper was narrowed to one count query per table.

The authorized old-G32 deletion did not run. Immediately before cleanup,
read-only queue resolution showed
`sekiban-dcb-meeting-room-g32-9043d626fe1149cb-outbox` has zero producers but
one consumer, `worker:sekiban-dcb-meeting-room-cloudflare-only`; its DLQ has
zero producers and consumers. The candidate version has no old-doorbell
service binding, but the “no other worker consumes its outbox” safety
condition is false because the protected production worker consumes it.
Therefore no detach or delete was attempted, and the old G32 worker, D1s and
queues remain untouched.

## Result

The W160 production before/after witness passed the G66 public-surface
acceptance bars on both normal and self-ring configurations. The candidate
sample is usable after the cohort. The self-ring configuration is deployed
on the production sample, while the explicitly unsafe old-G32 cleanup is
blocked by the consumer-topology contradiction above and was not performed.

## W161 read-only topology publication

W161 deliberately performs no G32 mutation. The complete read-only topology
receipt is `.artifacts/sdt-g66-w161-production-topology.json`.

The candidate version view for
`16d0ee47-24ad-43d4-ad65-668a6933b5c0` (source annotation
`SDT-G66 W160 self-ring candidate exact
134476a0c57187e697c4db55689b486b34bf2aed`) reported the full production D1
binding list:

| binding | database name | database ID |
|---|---|---|
| `D1` | `sekiban-dcb-meeting-room-cloudflare-pipeline` | `f26d1299-82d9-4a64-8647-bc2ec86326ac` |
| `D1_MV` | `sekiban-dcb-meeting-room-cloudflare-mv` | `b416b212-4d09-413c-9b8d-7660e475772f` |

The account inventory also contained, for comparison, G32 D1s
`sekiban-dcb-meeting-room-g32-9043d626fe1149cb-mv`
(`c733dfb2-013a-4a5d-a72c-47931a63bac4`) and
`sekiban-dcb-meeting-room-g32-9043d626fe1149cb-pipeline`
(`eccf6048-7fc8-4412-a157-9fa180353f6d`). Neither G32 ID is bound to the
production worker.

The production version has one Queue producer binding
`DOWNSTREAM_QUEUE` to `sekiban-dcb-meeting-room-cloudflare-outbox` and one
consumer for that same queue, with DLQ
`sekiban-dcb-meeting-room-cloudflare-outbox-dlq`. The complete account Queue
inventory and exact consumers is:

| queue | ID | producers | consumers |
|---|---|---|---|
| `sekiban-dcb-g60-w129-a-outbox` | `372a4b8b67714238835dc4aeaf67712f` | `worker:sekiban-dcb-g60-w129-a` | `worker:sekiban-dcb-g60-w129-a` |
| `sekiban-dcb-g60-w129-a-outbox-dlq` | `b8550fde79824aef88d9ed8ed674fe80` | none | none |
| `sekiban-dcb-g60-w129-b-outbox` | `f010a2882ebc48d6a8b8d0859ccbb92c` | `worker:sekiban-dcb-g60-w129-b` | `worker:sekiban-dcb-g60-w129-b` |
| `sekiban-dcb-g60-w129-b-outbox-dlq` | `eb412c9ea2c847758ec6a91df7416432` | none | none |
| `sekiban-dcb-g60-w155-c-outbox` | `1c45193743cb4adabeac4d071ec96ca6` | `worker:sekiban-dcb-g60-w155-c` | `worker:sekiban-dcb-g60-w155-c` |
| `sekiban-dcb-g60-w155-c-outbox-dlq` | `a1a3667566f140b4a25d42daf1dc8358` | none | none |
| `sekiban-dcb-meeting-room-cloudflare-outbox` | `e8c48f826758437ca4df10f61a9145ad` | `worker:sekiban-dcb-meeting-room-cloudflare-only` | `worker:sekiban-dcb-meeting-room-cloudflare-only` |
| `sekiban-dcb-meeting-room-cloudflare-outbox-dlq` | `495f566c63c64b1a9d7d49d275801438` | none | none |
| `sekiban-dcb-meeting-room-g32-9043d626fe1149cb-outbox` | `a8f591e7053743e79e2e9ade49e52ba4` | none | `worker:sekiban-dcb-meeting-room-cloudflare-only` |
| `sekiban-dcb-meeting-room-g32-9043d626fe1149cb-outbox-dlq` | `6e67ddcde0dd48faac784548ad3e185d` | none | none |

Therefore production uses its own outbox, not the G32 outbox, for current
production delivery. The old G32 outbox remains separately consumed by the
protected production worker, which is why W160 did not detach or delete it.
W161 treats that cleanup as intentionally deferred configuration work; no G32
worker, D1, Queue, DLQ, or old receiver was modified.
