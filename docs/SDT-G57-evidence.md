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
