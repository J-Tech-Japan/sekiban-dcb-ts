# SDT-G57 evidence

This document records the deploy-free checkpoint plus the bounded deployed
AC5/AC6 attempt for issue #123. The deployed comparison was blocked by a
repeatable public HTTP 504 before the snapshot-only arm could start; it is not
represented as a passing G50 result. G59 and G64 are not part of this unit.

## Identity and boundaries

- Issue: `sekiban-dcb-ts#123`
- Branch: `claude/sdt-g57-deploy-free-w126`
- Deploy-free predecessor: `5c80bbfcce9e59a39224420cb633edbe9574a3ba`
- Deployed source: `fbeb4df01cbd804b7d1d8f90703cdab1d744a06c`
- Existing throwaway arm only: Worker `sekiban-dcb-g60-w155-c`, URL
  `https://sekiban-dcb-g60-w155-c.ttakaoka.workers.dev`.
- Deployed version: `63f57044-8e42-4820-a100-3325dc2848b2`, deployment
  `6fea8072-c0be-4e34-848e-369337155952`, 100% traffic. The active version
  annotation is `SDT-G57 W126 exact fbeb4df01cbd804b7d1d8f90703cdab1d744a06c
  existing W155-C arm`.
- Existing bindings: pipeline D1 `ac751211-fde8-4587-9d56-1e9fd8051bc3`, MV
  D1 `2b60dbcf-0912-4bb2-93aa-77c26cd260e1`, queue
  `sekiban-dcb-g60-w155-c-outbox`, and DLQ
  `sekiban-dcb-g60-w155-c-outbox-dlq`.
- No Cloudflare resource was created or recreated.
- No migration was applied. Only existing-arm D1 operational deletes, clean
  count reads, an existing-Worker deployment, and version/deployment reads
  were run. Receipts are under `.artifacts/sdt-g57-w126-*`.
- Every Wrangler invocation used the five-variable stripped environment
  (`CLOUDFLARE_API_TOKEN`, `CF_API_TOKEN`, `CLOUDFLARE_API_KEY`, `CF_API_KEY`,
  `WRANGLER_API_TOKEN`: all `UNSET`), omitted `--keep-vars`, and used only the
  existing arm's config/resources. The G50 observability credential was passed
  only by path `/Users/tomohisa/.config/sekiban-dcb/observability-token`.

The first pre-reset counts were pipeline `dcb_events=11`, hop measurements
`126`, hop submeasurements `226`, unsafe-writer boundaries `44`, and live-poll
rows `2`; MV counts were `mv_rows=11`, `mv_unsafe_receipts=11`,
`mv_unsafe_rows=0`, `mv_unsafe_kicks=2`, and `mv_unsafe_arrivals=2`. The reset
receipt pair and post-reset count receipts prove the targeted operational rows
were zero before the first measurement. The recovery reset pair was also
successful and targeted only W155-C.

## AC1–AC4 and local AC7

The deploy-free checkpoint is preserved in
[`sdt-g57-deploy-free-w126.md`](../sdt-g57-deploy-free-w126.md). It records the
C-12 red fixture, the green facade suite, exact V1 byte identity, zero-read
snapshot-only behavior, assert-empty/omitted claim mapping, typed cloud
credential rejection, and the unchanged G41/G49/G51/G52/G54/G56 boundaries.

## AC5 sample migration

The meeting-room server route parses the executor envelope and calls
`createSekibanExecutor` over the in-process transport. The browser retains
portable JSON snapshots by projector/tag. A known RoomProjector or
ReservationProjector snapshot selects `snapshot-only`; an uncovered claim
uses the default `read-through` path. Reservation list/query read heads and
commit result heads are retained as portable snapshot heads. The public V1
wire and response protocol remain unchanged.

## G50 comparison

The intended receipt was `.artifacts/sdt-g57-w126-g50-executor-comparison.json`.
It was not finalized because the public service returned an application
timeout. The lossless partial receipts are:

- `.artifacts/sdt-g57-w126-g50-executor-comparison-aborted-after-35.json`:
  35 read-through samples, p50 `2085 ms`, p95 `2425 ms`; the command runner
  interrupted this first attempt before a second mode.
- `.artifacts/sdt-g57-w126-g50-executor-comparison-aborted-http504-028.json`:
  27 read-through samples, p50 `2865 ms`, p95 `4895 ms`; ordinal 28 returned
  HTTP `504` with `{code:"unknown_outcome",kind:"timeout",attempts:1}`.
- `.artifacts/sdt-g57-w126-g50-executor-comparison-aborted-http504-027-final.json`:
  26 read-through samples, p50 `2796 ms`, p95 `5119 ms`; ordinal 27 returned
  the same HTTP 504. Its exact error is recorded in
  `.artifacts/sdt-g57-w126-g50-executor-comparison-aborted-http504-027-error.json`.

| mode | n | p50 (ms) | p95 (ms) | expected tag-state reads/commit | expected reads saved/commit |
| --- | ---: | ---: | ---: | ---: | ---: |
| read-through | 35 / 27 / 26 partial attempts | 2085 / 2865 / 2796 | 2425 / 4895 / 5119 | 1 | 0 |
| snapshot-only | not reached | not available | not available | 0 | 1 |

The read accounting is established by the public executor contract and local
counting guard: the create-room claim is read once in read-through mode and is
covered by the supplied empty portable snapshot in snapshot-only mode. No
snapshot-only sample was accepted, so no matched G50 p50/p95 comparison,
saved-read measurement, or measurement guard pass exists. The public failure
is not a Cloudflare API authorization failure; no WAKE-122 Wrangler classifier
applies. The repeated stop at the same read-through ordinal is recorded as a
blocker, not attributed to the executor code without a complete matched
measurement.

## AC6 deployed verification

- Normal config shape: existing-arm adapted config, no resource creation.
- G15/G16: passed locally before deployment (`npm run test:g15`,
  `npm run test:g16`). No production-shaped e2e was run.
- Deployed version/source annotation: verified above; deployments list shows
  100% on version `63f57044-8e42-4820-a100-3325dc2848b2`.
- G50 receipt validator: not green because no complete two-mode receipt exists;
  the aborted receipts and exact 504 error are preserved.
- Required local gates passed on this exact source before the window: G15,
  G16, G41, G49, G51, G52, G53, G54, G55, G56, G57, G58, G61, G62,
  typecheck, lint, and `git diff --check`.
- PR/CI: not started because AC6 deployed evidence is incomplete; no PR and no
  worker completion transition were run.

## Preserved boundaries

No runtime wire member, commit semantics, trace schema, outbox/Queue/global
admission path, projector advancement, G58 health/coverage/lag/live-poll
surface, SafeWindow, ordering, fence, timeout, or existing gate was weakened.

## W127 paced AC6 continuation

W127 preserved all W126 unpaced partial receipts and first queried the persisted
G58 history on the existing W155-C pipeline for
`2026-09-05T00:17:43Z..00:27:43Z`. The exact receipt is
`.artifacts/sdt-g57-w127-g58-history-window.json`; the compact classification
is `.artifacts/sdt-g57-w127-g58-history-classification.json`.

| tick | UTC | kind | reason | partitionTag | proven frontier |
| --- | --- | --- | --- | --- | --- |
| `scheduled:1788567562422` | 00:19:22.422 | BLOCK/UNSETTLED | source present/global receipt absent | `room:sdt-g57-read-through-sdtg57w126g50b-004` | empty |
| `scheduled:1788567627452` | 00:20:27.452 | BLOCK/UNSETTLED | source_partition_set_changed_during_scan | same `...g50b-004` | empty |
| `scheduled:1788567679968` | 00:21:19.968 | BLOCK/UNSETTLED | source_partition_set_changed_during_scan | `room:sdt-g57-read-through-sdtg57w126g50c-002` | empty |
| `scheduled:1788567743243` | 00:22:23.243 | SETTLED | null | null | `063924164535707000000596266472` |
| `scheduled:1788567800982` | 00:23:20.982 | SETTLED | null | null | `063924164535707000000596266472` |
| `scheduled:1788567883762` | 00:24:43.762 | SETTLED | null | null | `063924164535707000000596266472` |
| `scheduled:1788567942121` | 00:25:42.121 | SETTLED | null | null | `063924164535707000000596266472` |
| `scheduled:1788568005340` | 00:26:45.340 | SETTLED | null | null | `063924164535707000000596266472` |

The W126 final 504 at `00:22:43.000Z` did **not** coincide with a persisted
scheduled tick: the nearest prior tick was 19,757ms earlier and the next was
37,982ms later. This records correlation only; it does not repair or alter
scheduled maintenance.

The W127 harness then used unique room IDs on the same existing arm, with no
discarded warmup and a minimum 10,000ms from each prior sample response to the
next sample start. Reset receipts, clean-count attempts, and the one stripped
environment read retry are under `.artifacts/sdt-g57-w127-*`. Three delayed
W126 request identities remained after reset (`...g50-007`, `...g50b-028`, and
`...g50c-027`); they were recorded as pre-existing contamination and not
reused.

The paced receipt is
`.artifacts/sdt-g57-w127-paced-executor-comparison-aborted-http504-snapshot-006.json`.
The snapshot-only mode preserved 5 cold-first accepted samples (p50 `2700ms`,
p95 `2960ms`) and failed at ordinal 6 with HTTP 504
`{code:"unknown_outcome",kind:"timeout",attempts:1}`. The exact command and
body are in the paired `...snapshot-006-error.json` receipt. The harness had
entered snapshot-only after the read-through arm, but its mode-state flush
replaced the root receipt before the failure; consequently the read-through
raw rows and p50/p95 are not durable and are intentionally reported as
unavailable. No snapshot-only comparison, saved-read statistic, or AC6 pass
can be claimed. No further cohort, repair, PR, or worker completion was run.

The immediate post-reset D1 read once returned code 7403 with all five
credential variables stripped; the authorized read retry after approximately
5 seconds succeeded. Both receipts are retained. No write authorization
failure occurred and no resource or migration operation was attempted.

## W142 deployed resume on the landed G65 bounded path

W142 integrated current `origin/main` at `4b1d6eb37f9e701850b2b01e9fea9095d783c77f`
and deployed exact source
`23a0e5c06ab4b75c94461ddea28f2da4e254df04` to the existing W155-C arm. The
deployment created version `b040a282-54d5-41d6-8a84-c0b75c10aa75`, with 100%
traffic and annotation `SDT-G57 W142 exact
23a0e5c06ab4b75c94461ddea28f2da4e254df04`. The deployed version view proved
`DIRECT_DOORBELL=true`, self receiver mode and proof, the W155-C
`DOWNSTREAM_DOORBELL` service binding to `MeetingRoomDownstreamDoorbell`, the
W155-C Queue producer/consumer and DLQ, and the existing W155-C pipeline/MV D1
IDs. No resource or migration operation occurred.

The exact deployment/configuration receipts are:

- `.artifacts/sdt-g57-w142-deploy-exact-23a0e5c.json.gz` (lossless raw output;
  verify with `gzip -dc .artifacts/sdt-g57-w142-deploy-exact-23a0e5c.json.gz`)
- `.artifacts/sdt-g57-w142-versions-list.json`
- `.artifacts/sdt-g57-w142-version-view-b040.json`
- `.artifacts/sdt-g57-w142-deployments-list.txt`

The five Wrangler credential names were checked as unset and stripped from
every Wrangler invocation; no `--keep-vars` was used. The G50 credential was
passed only through `G50_OBSERVABILITY_TOKEN_FILE`. The first local harness
launch used a nonexistent `./node_modules/.bin/node` path and exited 127 before
any request; it is preserved in
`.artifacts/sdt-g57-w142-g50-launch-path-error.json`. The corrected `node`
launch is the only cohort run.

Under C-0/C-13, W155-C operational rows were reset using the existing schema;
the reset receipts are the lossless compressed raw outputs
`.artifacts/sdt-g57-w142-reset-pipeline.json.gz` and
`.artifacts/sdt-g57-w142-reset-mv.json.gz`; verify them with
`gzip -dc <artifact>`. Corrected post-reset counts showed
zero `dcb_events`, source partitions, hop measurements, `mv_rows`, unsafe
receipts, unsafe rows, and unsafe kicks. A single safe-lane history row appeared
from the scheduled service during the reset/count interval and remains
recorded. The initial too-broad count query returned local SQLite code 7500 and
was corrected once with a narrower read-only query; both receipts are retained.

The fresh public comparison receipt is
`.artifacts/sdt-g57-w142-g50-executor-comparison.json`. It used cold-first
`POST /api/commands/create-room` samples, n=10 per mode, and ten-second
response-to-next-start pacing within each mode. All 20 samples were committed
with HTTP 200; no 504 or censored row occurred.

| mode | n | p50 | p95 | tag-state reads/commit | reads saved/commit |
| --- | ---: | ---: | ---: | ---: | ---: |
| read-through | 10 | 2819ms | 3073ms | 1 | 0 |
| snapshot-only | 10 | 2213ms | 2586ms | 0 | 1 |

Read-through samples were `3073, 2985, 2936, 2907, 2761, 2654, 2567,
2660, 2819, 2881`ms; snapshot-only samples were `2119, 2541, 2115, 2213,
2409, 2227, 2244, 2586, 2210, 1954`ms. The snapshot-only mode saved one
tag-state read per commit, with a 606ms p50 and 487ms p95 client-latency
difference. The optional observability query was unavailable, but the public
raw receipt and executor mode accounting are complete. W142 had no 504, so no
new G58 tick-history attribution was needed; the prior W126/W127 partial 504
receipts and their tick classification remain unchanged above.

The durable W142 handoff artifact is
[`sdt-g57-deployed-resume-wake-142.md`](../sdt-g57-deployed-resume-wake-142.md).
G15/G16, G49, G52–G55, G57, G58, G65, typecheck, lint and diff-check passed on
the integrated checkpoint, with expected red mutant receipts preserved. AC6 is
therefore evidenced by the fresh deployed comparison. PR #130 is open and
ready for review with `Closes #123`, and the canonical worker `pr-created`
transition was applied successfully.
