# SDT-G65-PR127-AC1-CARVEOUT-LOCAL-WAKE-133

Status: completed local repair checkpoint; the deployed AC5 evidence remains a
later continuation.

## Checkpoint and boundaries

- Repository: `J-Tech-Japan/sekiban-dcb-ts`
- Branch: `claude/sdt-g65-local-wake-w128`
- Starting PR head: `468515bb6783be358eeb5ff5e79b2e8596569748`
- PR: `#127`
- Cloudflare/Wrangler/deployment/resource operations: none
- The exact pushed repair head is emitted by the final canonical worker/report
  transport after this artifact is committed and pushed.
- Existing unrelated dirty evidence was preserved and was not staged. The
  required mutation runner also refreshed the existing
  `.artifacts/sdt-g65-w131-idempotence-mutant.json`; that incidental receipt
  drift remains unstaged rather than replacing the prior evidence.

## Binding AC1 text

The following text is carried verbatim as the authoritative contract:

> AC1 (synchronous admission attempt, response never gated): after the durable Tag append and the SDT-G60 direct doorbell, and before returning the commit response, attempt global D1 admission through the same recordDelivery path the queue consumer uses, under a bounded time budget (a documented constant, on the order of a few hundred milliseconds, chosen so the commit root stays near the SDT-G52 baseline). If the attempt succeeds, the event is admitted before the response; if it fails, times out or throws, the response is returned unchanged and nothing else changes - the outbox obligation is already durable and the queue delivery admits the event later. A timeout is an UNKNOWN outcome, not a failure: the same immutable event, SUID and obligation identity is retried by the queue path, and conflicting payloads under the same identity are rejected. The response distinguishes committed from globally admitted (a documented field or header; the commit semantics are unchanged). A counting fake D1 proves the response is returned with identical commit status whether the attempt succeeded, failed, timed out or hung, with only the admitted indicator differing. CARVE-OUT, ruled 2026-09-05 for frontier soundness (the source-universe question): the ONE derived write that may gate a response is the registration of a brand-new source partition, and only for the FIRST commit on that tag. The completeness reconciler can only walk partitions it knows, so a committed event in a partition the completeness domain has never heard of would let the frontier certify past it and the safe view would silently miss it. Therefore: before the first durable append on a tag, the Tag Durable Object registers the partition under a bounded budget; if that registration fails or times out, that first commit is REFUSED with a typed, retryable error (for example 503 partition_registration_unavailable, never 504 unknown_outcome), no event is written, and the caller retries. Every later commit on a registered tag treats registration as a no-op that is never awaited and never gates the response. So the contract reads: the response never depends on D1 for an existing partition; the first write of a new partition requires its registration to be durably known, bounded and typed. Tests: a brand-new tag with a hanging registration is refused within the budget with no event written; a registered tags commit succeeds with D1 entirely unavailable and reports not-admitted; registration on an already-registered tag is idempotent and not awaited.

## Implementation

`TagDurableObject.append` now performs the source-universe carve-out only on a
real SQLite-backed first append:

1. `ensureSourcePartitionBeforeFirstAppend` checks the durable local
   `tag_source_partition_registration` marker.
2. If the marker is not registered, the G44 global source registry is probed
   and the partition is inserted with sequence `0` under the existing 300 ms
   `G65_DERIVED_WRITE_BUDGET_MS` budget. A missing binding, schema failure,
   thrown write, or timeout becomes HTTP 503,
   `partition_registration_unavailable`, with `retryable: true`.
3. The local Tag append is not entered after that failure, so the refused
   attempt writes no `tag_event`, outbox obligation, or commit receipt.
4. After successful registration the local marker is durable. The append then
   writes the event/outbox/receipt in the existing SQLite transaction. The
   post-append source watermark is scheduled through `waitUntil` only; it does
   not gate the response and does not downgrade an already-registered marker
   during a D1 outage. Queue/`recordDelivery` remains the durable sequence and
   recovery path.

The direct doorbell, bounded global-admission attempt, Queue ordering/retry/DLQ
path, V1 body, admission header, G44 fence, G62 behavior, and 5,000 ms contract
were not weakened or changed. The existing G60 guards remain unchanged.
`docs/write-path.md` now specifies the carve-out and the later AC5 plan for
both a first-tag registration outage and an already-registered D1 outage.

## Red/green evidence

Guard receipts are retained under `.artifacts/`:

| Receipt | SHA-256 | Result |
| --- | --- | --- |
| `sdt-g65-w133-pre-change-red.json` | `d2c2c2a79ceb1021d7fb3997c63f7775750270cbdb4f2e425a38c43a2f177938` | pre-change source guard exited 1 with expected red |
| `sdt-g65-w133-self-test-green.json` | `3d80479c3d0e84e8829f8a6524025ea4914dfd8c249919fd8f8213e9d1089ad9` | self-test green; omission, unbounded-doorbell, D1-gating, durability-order, and direct-omission mutants red |
| `sdt-g65-w133-post-change-green.json` | `573d8537202e711ee293becb706c994cee1014b7fe96f4e6fb98f556c8de89f1` | post-change green with the same red mutant set |

The production idempotence-removal mutant remains a real runtime oracle: its
pre-change mutated test is red because the conflicting identity is accepted,
and the unmutated test is green. The required carve-out tests are in
`test/g65-admission.spec.ts`:

- missing runtime D1 on a new tag -> typed 503 and zero events/receipts;
- hanging registration -> bounded typed 503 and zero events;
- failed registration INSERT -> typed 503 and zero events;
- registered tag with D1 unavailable -> 201 and
  `x-sdt-global-admission: not-admitted`;
- already-registered tag with a never-resolving D1 -> 201 without awaiting
  registration again.

## Local gate results

- `npx vitest run --config vitest.config.ts test/g65-admission.spec.ts`: 1
  file, 10/10 passed.
- `npm run test:g65 --silent`: passed; G65 guard green and production
  idempotence mutant red-before-green/green-after.
- `npm run test:g44 --silent`: 8/8 G44 tests passed; all four production G44
  mutants red.
- `npm run test:g60:required --silent`: all listed G60 focused suites and
  unchanged direct/queue/unsafe-writer/post-admission/durable-hop guards passed;
  all six G60 mutants remained red as expected.
- `npm run typecheck --silent`: passed.
- `npm run lint --silent`: passed.
- `git diff --check`: passed on the local repair diff. The full PR-range check
  is repeated as `git diff --check 4687efa5c49951d9966a3785be5fd7b2620c6e4f...HEAD`
  after the push.

No deployed proof is claimed here. The next authorized continuation must run the
same-arm AC5 cohort with the two D1-unavailable cases described above; this
checkpoint does not deploy, remeasure, create resources, or close/merge PR #127.
