# SDT-G66 evidence / PR handoff — W161

## Result

The existing W160 parent/self-ring production cohorts satisfy the issue's
public-surface acceptance bars. W161 adds the required read-only deployed
topology proof and publishes the evidence for review. No G32 resource was
modified.

## Exact source and receipts

- Branch: `claude/sdt-g66-local-and-production-w160`
- Evidence head: `fc25b6b6e01e6d4b76d80cdbfbb013c187779194`
- Candidate source: `134476a0c57187e697c4db55689b486b34bf2aed`
- Candidate Worker version: `16d0ee47-24ad-43d4-ad65-668a6933b5c0`
- Full topology receipt: `.artifacts/sdt-g66-w161-production-topology.json`
- Parent raw cohort: `.artifacts/sdt-g66-w160-production-baseline-final2.json`
- Candidate raw cohort: `.artifacts/sdt-g66-w160-production-candidate.json`

The parent cohort recorded response/unsafe/safe p50/p95 of
`1524/2028`, `412/523`, and `51156/54113` ms. The candidate recorded
`1725/2318`, `335/579`, and `48380/55239` ms. Both were cold-first, paced at
least ten seconds between accepted commands, 10/10 accepted, and had zero
unsafe-bound or safe-bound misses. The candidate retained read-through then
portable snapshot-only execution, tag/query reads, and delivery,
fence-expiry, cron and coverage-retry provenance.

## Deployed binding conclusion

The complete production D1 binding list is exactly:

| binding | database name | database ID |
|---|---|---|
| `D1` | `sekiban-dcb-meeting-room-cloudflare-pipeline` | `f26d1299-82d9-4a64-8647-bc2ec86326ac` |
| `D1_MV` | `sekiban-dcb-meeting-room-cloudflare-mv` | `b416b212-4d09-413c-9b8d-7660e475772f` |

No G32 D1 ID is bound. The account-only G32 comparison entries are
`c733dfb2-013a-4a5d-a72c-47931a63bac4` (MV) and
`eccf6048-7fc8-4412-a157-9fa180353f6d` (pipeline).

The complete Queue inventory, including every consumer, is retained in the
topology receipt and published in `docs/SDT-G66-evidence.md`. Production uses
its own `sekiban-dcb-meeting-room-cloudflare-outbox` with consumer
`worker:sekiban-dcb-meeting-room-cloudflare-only` and DLQ
`sekiban-dcb-meeting-room-cloudflare-outbox-dlq`; it does not use the G32
outbox for current production delivery. The old G32 outbox remains present
with zero producers and consumer
`worker:sekiban-dcb-meeting-room-cloudflare-only`. This is retained evidence,
not a cleanup authorization.

## Verification and boundaries

- `npm run test:g66`: PASS; focused e2e guard and Vitest tests, including
  red-capable censored-safe, paused-write and missing-coverage mutants.
- `npm run lint`: PASS.
- `git diff --check`: PASS.
- Earlier W160 `npm run typecheck` remains a documented pre-existing
  workspace/package exception; no G66 file was named. It is not relabeled
  green here.
- All five Wrangler credential names were unset for every read-only call;
  no `--keep-vars` was used.
- No G32 worker, D1 database, outbox, DLQ, old receiver, or production
  resource was created, deleted, detached, or rebound in W161.
- The PR will be non-draft and close issue #128 from this exact evidence
  head; its number and exact-head CI result are carried by the canonical
  W161 handoff after creation.

## W161 review-repair disposition

Review 5132886542 identified measurement/guard defects in the W160 witness;
it did not identify a G66 runtime defect. The repaired local harness now
captures the unsafe projection separately from the public room/list query,
requires affected-tag version/head evidence and reservation-list `readHead`,
uses response-completed-at-relative unsafe/safe clocks, and issues paced
commands without waiting for the preceding safe fence. The guard includes
red-capable pause-to-safe, missing-clock, bad-public-query, late-success,
failed-write, and missing-coverage mutants.

The retained W160 production receipts are preserved as historical topology and
smoke evidence only. They cannot prove the corrected AC1–AC4 contract because
the old runner serialized visibility waits, captured only one target tag after
convergence, and did not join each event to the public safe query/read-head
observations. No rerun, deployment, reset, cleanup, or G32 mutation was made
for this repair; a later authorized deployed cohort is required for corrected
acceptance publication.
