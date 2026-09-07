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
- Every command records the request start, response completion, response
  duration, and `x-sdt-global-admission` header. Every sample records unsafe
  projection visibility and the default public query's safe visibility from
  the response-completed-at clock, per-tick coverage/frontier health, every
  affected tag-state read with its committed version, and query/read-head
  evidence. The scalar room-query wire has no read-head field; that absence is
  recorded explicitly while the reservation-list read-head is required.
- Visibility polling is asynchronous with respect to paced command issuance.
  A later command may be sent while an earlier command is still waiting for
  unsafe or safe visibility. Source snapshot acquisition remains a necessary
  executor input, but safe convergence is never used as a pacing barrier.
- Missing or late observations are explicitly `censored`; the guard never
  converts a censored sample into a pass. The pause-to-safe, missing-clock,
  public-query, late-success, failed-write, and missing-coverage mutants are
  red-capable and exercised by `test/g66-e2e.spec.ts` and
  `scripts/g66-e2e-guard.mjs --self-test`.

## Historical deployment evidence — W160 production window

The W160 receipts below are retained losslessly and remain useful for the
deployed configuration, admission headers, and broad latency context. They are
not current AC1–AC4 proof after review 5132886542: the old runner serialized
each visibility wait before issuing the next command, checked only the unsafe
projection and MV safe head, read one target tag after convergence, and did not
record the complete affected-tag/default-query/read-head joins. The old tables
therefore must not be described as a continuous-write cohort or as proof of
the corrected guard.

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
each saved one post-convergence target tag-state read and room/reservations
query reads. In this historical runner, `response` is command duration and
`unsafe`/`safe` are response-completed-at-relative visibility intervals; the
receipts do not establish send-to-visibility clocks or continuous issuance.

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

The W160 production before/after witness passed the then-existing
public-surface smoke bars on both normal and self-ring configurations. It did
not prove the corrected AC1–AC4 measurement contract described above. The
candidate sample remains usable historical evidence; a later authorized
cohort is required before claiming the corrected continuous-write, public
safe-query, complete-tag-join, and mutant-resistant acceptance. The self-ring
configuration is deployed on the production sample, while the explicitly
unsafe old-G32 cleanup is blocked by the consumer-topology contradiction above
and was not performed.

## W161 review repair — corrected measurement contract

Review 5132886542 found four measurement/guard defects, not a product-runtime
defect. The local repair addresses them without changing G66 runtime behavior
or any G32 resource:

1. The runner now separates the unsafe/tag-state projection from the public
   room/list query. Each pass records the query body, list `readHead` when the
   wire supplies it, target identity/state, and every affected tag's expected
   version/SUID versus its observed committed version/head. A safe MV head by
   itself is no longer accepted as public safe visibility.
2. The runner checkpoints an accepted command before starting asynchronous
   visibility polling. The next command is paced from the command clock and is
   not delayed by the preceding safe fence. The receipt and guard require both
   ten-second pacing and at least one later command issued before its
   predecessor's safe observation; an intentionally pause-to-safe mutant is
   red.
3. Unsafe and safe summaries are explicitly response-completed-at-relative
   clocks, with request start, response completion, and duration retained
   separately. A late successful read is censored/rejected by the bound guard;
   no send-to-visibility claim is made. Admission-attempt duration percentile
   is not reconstructed from the old receipts and remains missing until the
   next authorized run records it directly.
4. The guard no longer trusts a disposition label, non-empty tag array, or
   HTTP 200 alone. Missing visibility clocks, bad public-query bodies, stale
   tag versions, late-success timestamps, rejected writes, missing coverage,
   and pause-to-safe sequencing all have red-capable checks.

The retained W160 receipts cannot be upgraded to this contract: they lack
continuous-write overlap and the complete per-event public-query/tag joins.
No cohort was rerun in W161; deployment and Cloudflare state were untouched.
The next deployed continuation must use the corrected harness and publish a
new receipt before reclassifying AC1–AC4.

### W161 local gate record

Focused repair checks passed: `npm run lint`, `npm run typecheck`,
`npm run test:g66`, `node scripts/deploy/g66-e2e.mjs --self-test`,
`node scripts/g66-e2e-guard.mjs --self-test`, and the four focused
`test/g66-e2e.spec.ts` tests. The focused G60 required lane and G61 retained
frontier lane also passed with their existing red mutants green-protected.

The repository aggregate `npm run check` reached `npm test` and stopped with
five existing parallel-runner/5-second-bound exceptions: `test/commit.spec.ts`
AC7 timeout, `test/g43-tag-sql.spec.ts` AC6 `waitForConfiguredAlarm` null at
line 446, `test/g67-safe-lane.spec.ts` AC3 timeout, `test/repair.spec.ts`
bounded-scan timeout, and `test/tag.spec.ts` G5 timeout. The aggregate had 88
files/776 tests passed, 5 failed, and 1 skipped. No G66 assertion failed.
The isolated G28 boundary lane passes with a temporary npm cache; the first
uncached attempt was an environment-only npm-log write failure under
`/Users/tomohisa/.npm/_logs`.

The directly affected G62, G65 mutation, and G67 mutation lanes also hit the
seat's existing package-layout exception: their subprocesses invoke
`node_modules/vitest/vitest.mjs`, which is absent, while the supported `vitest`
CLI and focused tests run successfully. Exact signatures were retained in the
W161 repair receipt; no timeout, assertion, gate, or resource was changed.

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

## W161 final review repair — corrected public MV witness

Review `5133812363` identified four evidence/guard escapes in the W160
witness. The repair is limited to the G66 runner, its guard, the focused test,
and this evidence record; it does not change the G66 runtime path or any G32
resource.

- Unsafe reservation visibility is now polled from the public
  `/api/read/reservations` surface. The room/projection observation remains a
  separately labelled projection diagnostic; it is not substituted for the
  public reservation result.
- Safe acceptance requires the public reservation body to contain exactly one
  target/status and a `readHead` at least as large as the committed SUID. The
  safe MV head is retained as supporting evidence, never as the sole proof.
- Each affected tag is joined to its expected committed version/SUID and the
  observed tag-state result. The final public state is compared with the exact
  committed room/reservation set and duplicate count.
- Observed absolute clocks are used to derive response-completed-at-relative
  visibility durations. The guard pins the unchanged 5,000 ms unsafe and
  180,000 ms safe bounds and rejects missing, late, false, stale, or synthetic
  observations.
- The accepted command is checkpointed before asynchronous visibility polling,
  so later commands continue at the configured ten-second pace. Red-capable
  tests cover censored safe reads, a fully chronological pause-to-safe mutant,
  bad public reads, stale read heads, absolute-clock/bound escapes, failed
  writes, missing coverage, and duplicate final state.

Local source/guard checks passed before this checkpoint:
`node --check scripts/deploy/g66-e2e.mjs`,
`node --check scripts/g66-e2e-guard.mjs`, both script self-tests,
`npx vitest run --config vitest.config.ts test/g66-e2e.spec.ts
--pool=threads --maxWorkers=1`, `npm run lint -- --quiet`, and
`npm run typecheck`. The broader aggregate and package-layout exceptions remain
the documented W161 environment exceptions above; they are not called green.

The W160 deployed receipts remain historical and are not relabelled as proof
of this corrected contract. A fresh corrected deployed cohort is required
before AC1–AC4 can be reclassified. The required deployment, if run, must
retain the existing production Worker/D1/Queue configuration and the G32
worker, databases, outbox and DLQ unchanged.

## W161 final repair deployed attempt — C-0 storage-timeout blocker

The exact W161 repair source `b840c189cd1dd5cbe31400fc606b691c0293d9e9` was
deployed to the existing production sample with the unchanged self-mode
configuration. Version `566dd5dd-4d9d-4125-be6d-750722d0c210` carried the exact
message `SDT-G66 W161 exact b840c189 final public MV repair` at 100% traffic.
The deployed version view confirmed `DIRECT_DOORBELL=true`, self receiver mode
and proof, and `DOWNSTREAM_DOORBELL` bound to
`sekiban-dcb-meeting-room-cloudflare-only#MeetingRoomDownstreamDoorbell`. It
also confirmed the existing production D1 IDs
`f26d1299-82d9-4a64-8647-bc2ec86326ac` and
`b416b212-4d09-413c-9b8d-7660e475772f`, plus the existing production outbox
consumer and DLQ.

The required C-0 reset receipt is
`.artifacts/sdt-g66-w161-production-c0-reset.json`. Every child Wrangler
process stripped `CLOUDFLARE_API_TOKEN`, `CF_API_TOKEN`,
`CLOUDFLARE_API_KEY`, `CF_API_KEY`, and `WRANGLER_API_TOKEN`; no secret value
was printed or persisted and no `--keep-vars` was used. The reset completed
all pipeline counts/deletes, then stopped on the first MV delete
`mv_active_generations` with Cloudflare D1 storage timeout code `7429`.
There was no authorization failure, no classifier, and no state-changing retry.
Because the pipeline was partially reset but MV rows were not reset, the
sample was not clean and no corrected W161 cohort was started. AC1–AC4 remain
blocked; no W161 response/unsafe/safe metrics are claimed. G32 worker/D1/
outbox/DLQ resources were retained and untouched.
