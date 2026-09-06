# SDT-G65 PR #127 — W136 public refusal deployed repair

Task: `SDT-G65-PR127-PUBLIC-REFUSAL-DEPLOYED-REPAIR-WAKE-136`
Issue: `J-Tech-Japan/sekiban-dcb-ts#126`
PR: `https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/127`
Branch: `claude/sdt-g65-local-wake-w128`
Repair/evidence head: `a8bb1bd493591081c24a52239c1b0e2dce2c42e1`
Pushed evidence checkpoint: `af88baaee009a44c86fddf8271eb58bb72b851b8`
Disposition: **blocked before rereview/completion**

The local F1 public CommitWorker contract is green: configured first-partition
registration failure and hang serialize as bounded HTTP 503
`partition_registration_unavailable` with `retryable: true` and zero
authoritative event rows; the mixed public envelope preserves the existing
partition write and returns the typed `partial_write` result for the refused
new partition. `npm run test:g65` passed all 14 focused tests.

The required deployed W136 proof is not a pass. The pre-change cohort
completed ten accepted samples but missed the unsafe and safe bounds. The
post-change cohort stopped at six accepted samples because sample 7 returned
application HTTP 504 `unknown_outcome`; one of the four observed post unsafe
reads was over 5,000 ms and two more were censored at that bound. The C-0
absent-D1 deployed check correctly showed unconfigured-store behavior, not the
configured-store first-partition 503 required by AC1: the brand-new partition
committed with `not-admitted`. No claim of AC5 completion or PR rereview
readiness is made.

## Evidence classification

W128 measurements are historical and superseded. W130 was a failed/superseded
cohort line. W131-W134 are local checkpoints only. They are not substituted
for W136 deployed measurements, and superseded W128 admission figures are not
current evidence.

## Deployed identities and hygiene

Only existing W155-C was used: Worker `sekiban-dcb-g60-w155-c`, pipeline D1
`ac751211-fde8-4587-9d56-1e9fd8051bc3`, MV D1
`2b60dbcf-0912-4bb2-93aa-77c26cd260e1`, Queue
`sekiban-dcb-g60-w155-c-outbox`, and DLQ
`sekiban-dcb-g60-w155-c-outbox-dlq`. No resource was created/deleted and no
migration was run. Every Wrangler receipt records the five recognized
credential variables as `UNSET`, with all five stripped and no `--keep-vars`.
Conformance was path-only; the initial 403 was the Worker’s own handler, so a
fresh private secret was installed and exact source redeployed. No secret
value is present.

Pre source `96482c288127ee082751d3beebcd36708f9d9561` was verified at 100%
with `DIRECT_DOORBELL=true` in version
`f1837521-395b-40d2-a39f-947687139064`, deployment
`dd1bef66-2d5d-45c2-bb0e-3ef1ae48f8ee`.

Post source `a8bb1bd493591081c24a52239c1b0e2dce2c42e1` was verified at 100%
with `DIRECT_DOORBELL=true` and expected bindings in version
`1f4a0966-81b4-42fc-8489-49c2ec7b854e`, deployment
`2ae6ea08-df5e-4a45-890e-608bbb3c4e10`.

The C-0 absent-D1 variant was version
`2967f040-e1d4-46d2-8f66-636f68ca391b`; normal D1 was restored at 100% in
version `7c2a8b6e-1866-4f70-b611-0c892abf45b3`, deployment
`2e8f0e2d-743e-4d91-8cf3-5ae2e498dc72`, exact `a8bb1bd`,
`DIRECT_DOORBELL=true`.

## Cohort results (observed clocks)

Both cohorts used cold-first public create-room/reserve-room, at least ten
seconds between reservation responses, and fully paged list reads. Authored
`dcb_events.Timestamp` and caller `received_at` were not used for timing.

| Metric | Pre-change n=10 | Post-change n=6 accepted |
| --- | ---: | ---: |
| response p50 / p95 | 2,344 / 3,259 ms | 2,246 / 2,396 ms |
| unsafe p50 / p95 | 35,896 / 119,427 ms | 4,800 / 5,301 ms (4 observed) |
| strict over 5,000 ms | 10/10 | 1/4 observed; 2/6 censored |
| safe final head | 145,229 / 207,599 ms; 7/10 <=180 s | not established |
| admission header | unknown 10/10 | unknown 6/6 |

Post reservation 7 returned HTTP 504 `unknown_outcome`, attempts 1, after
2,359 ms; the harness stopped. Per-sample and per-hop tables are in
`docs/SDT-G65-evidence.md` and `.artifacts/sdt-g65-w136-analysis.json`.

Pre per-sample unsafe/safe ms: `119427/207599, 5001/195268,
95439/182923, 83359/170126, 71670/157792, 60054/145229, 5573/132881,
35896/120285, 5532/108024, 11205/94763`.

Post accepted per-sample unsafe ms: `4919, 4612, 5301, 4800, censored,
censored`; safe was not established. Queue-send to consumer p50/p95 was
`4419/7634 ms` pre and `3567/5169 ms` post. Direct inline Room/Reservation
writer p50/p95 was `75/159` and `65/105 ms` pre, `57/110` and `63/76 ms`
post. No valid global completion/read distribution exists because
`global_completion_observed_at` was null for all sampled admission attempts.

## C-0 result

An existing registered reservation tag returned HTTP 200 `not-admitted` while
D1 was absent and, after restoration, reached public `{status: cancelled,
version: 2}` after 84 observations; the D1 read contains its global receipt.
A brand-new tag `room:g65-w136-new-first-da855b66-4b9` returned HTTP 200
`not-admitted`, not typed 503. D1 contains event
`01a071bb-6f65-795d-984a-02c4fba48363`, SUID
`063924211304954000001191258191`, and one global receipt. This is the narrow
unconfigured-store behavior; configured deployed refusal remains missing.

## Receipts, gates, and next boundary

The large raw cohort/ledger receipts are committed as lossless gzip artifacts;
expanded copies are ignored. Each was verified with `gzip -dc <file>.gz |
cmp -s - <file>`. SHA-256 pairs and decompression command are recorded in
`docs/SDT-G65-evidence.md`.

Passed before deployment: `npm run test:g65`, `npm run test:g44`,
`npm run test:g53`, `npm run test:g55`, `npm run test:g58`,
`npm run test:g60:required`, `npm run test:g62`, `npm run test:g61`,
`npm run test:g41`, `npm run test:g26`, `npm run typecheck`, `npm run lint`,
and `git diff --check`; existing G60 mutants remained red. No gate was
weakened. The next decision must provide a real configured-store failure/hang
deployment and resolve the incomplete/over-bound post cohort before rereview.
