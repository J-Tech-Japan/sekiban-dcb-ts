# SDT-G57 deployed resume — W142

## Result

- Task: `SDT-G57-DEPLOYED-RESUME-WAKE-142`
- Issue: `J-Tech-Japan/sekiban-dcb-ts#123`
- Branch: `claude/sdt-g57-deploy-free-w126`
- Integrated/pushed checkpoint used for deployment: `23a0e5c06ab4b75c94461ddea28f2da4e254df04`
- Integrated current main: `4b1d6eb37f9e701850b2b01e9fea9095d783c77f` (landed SDT-G65)
- Status at this checkpoint: **deployed AC5/AC6 measurement complete; PR handoff follows after evidence commit**

The prior W126/W127 HTTP-504 cohorts remain preserved as partial receipts and are
not reused as an AC5 result. The fresh W142 comparison below completed both arms
without a 504 or a censored sample.

## Existing-arm deployment identity

The only deployment target was the existing throwaway W155-C arm. No Worker,
D1, Queue, DLQ, migration, or resource was created or deleted.

- Worker: `sekiban-dcb-g60-w155-c`
- URL: `https://sekiban-dcb-g60-w155-c.ttakaoka.workers.dev`
- Pipeline D1: `ac751211-fde8-4587-9d56-1e9fd8051bc3`
- MV D1: `2b60dbcf-0912-4bb2-93aa-77c26cd260e1`
- Queue: `sekiban-dcb-g60-w155-c-outbox`
- DLQ: `sekiban-dcb-g60-w155-c-outbox-dlq`
- Deployed version: `b040a282-54d5-41d6-8a84-c0b75c10aa75`
- Deployment traffic: `100%` on the W142 version
- Source annotation: `SDT-G57 W142 exact 23a0e5c06ab4b75c94461ddea28f2da4e254df04`

The version view proves the deployed configuration, not only the local file:

- `DIRECT_DOORBELL=true`
- `DIRECT_DOORBELL_RECEIVER_MODE=self`
- `DIRECT_DOORBELL_SELF_BINDING_PROOF=true`
- `DIRECT_DOORBELL_DEGRADATION=queued-degraded`
- `DIRECT_DOORBELL_MAX_INVOCATIONS=32`
- `DOWNSTREAM_DOORBELL=sekiban-dcb-g60-w155-c#MeetingRoomDownstreamDoorbell`
- `DOWNSTREAM_QUEUE=sekiban-dcb-g60-w155-c-outbox`
- the exact W155-C pipeline and MV D1 IDs above

Receipts:

- `.artifacts/sdt-g57-w142-deploy-exact-23a0e5c.json.gz` (lossless raw output;
  verify with `gzip -dc .artifacts/sdt-g57-w142-deploy-exact-23a0e5c.json.gz`)
- `.artifacts/sdt-g57-w142-versions-list.json`
- `.artifacts/sdt-g57-w142-version-view-b040.json`
- `.artifacts/sdt-g57-w142-deployments-list.txt`
- `.artifacts/sdt-g57-w142-g50-launch-path-error.json` (local runner path error,
  exit 127, before any public request)

Every Wrangler invocation was run with
`CLOUDFLARE_API_TOKEN`, `CF_API_TOKEN`, `CLOUDFLARE_API_KEY`, `CF_API_KEY`, and
`WRANGLER_API_TOKEN` stripped. The seat check recorded all five names as
`unset`; no `--keep-vars` was used. No authorization failure occurred, so no
WAKE-122 retry or classifier was invoked. The observability credential was
referenced only by `G50_OBSERVABILITY_TOKEN_FILE` path. The optional G50
telemetry query reported unavailable; the public timing/read comparison is
complete from the durable raw receipt and executor protocol accounting.

## Clean reset

Under C-0/C-13, only W155-C operational rows were reset before the fresh
comparison. Schema, bindings, queues, and migrations were unchanged. The reset
and corrected count receipts are:

- `.artifacts/sdt-g57-w142-reset-pipeline.json.gz` (lossless raw output;
  verify with `gzip -dc .artifacts/sdt-g57-w142-reset-pipeline.json.gz`)
- `.artifacts/sdt-g57-w142-reset-mv.json.gz` (lossless raw output;
  verify with `gzip -dc .artifacts/sdt-g57-w142-reset-mv.json.gz`)
- `.artifacts/sdt-g57-w142-post-reset-pipeline-counts.json` (the first count
  query returned local SQL code 7500 because its compound SELECT was too broad)
- `.artifacts/sdt-g57-w142-post-reset-pipeline-counts-corrected.json`
- `.artifacts/sdt-g57-w142-post-reset-mv-counts.json`

The corrected clean counts were:

| store/table | rows |
| --- | ---: |
| pipeline `dcb_events` | 0 |
| pipeline `serialized_dcb_source_partitions` | 0 |
| pipeline `serialized_dcb_hop_measurements` | 0 |
| MV `mv_rows` | 0 |
| MV `mv_unsafe_receipts` | 0 |
| MV `mv_unsafe_rows` | 0 |
| MV `mv_unsafe_kicks` | 0 |

One `serialized_dcb_safe_lane_history` row was written by the scheduled service
during the reset/count interval; it is a tick-history row, not cohort event
data, and remains recorded rather than being silently removed.

## Fresh matched G50 comparison

The public instrument used `POST /api/commands/create-room` with a cold first
sample, ten accepted samples per mode, and a minimum ten-second interval from
the preceding response to the next sample start within each cohort. The raw
receipt was flushed after setup and after every accepted sample:

`.artifacts/sdt-g57-w142-g50-executor-comparison.json`

All twenty fresh responses were HTTP 200 committed results. No row was censored
and no 504 occurred.

| mode | n | per-sample client ms (ordinal order) | p50 ms | p95 ms | tag-state reads/commit | reads saved/commit |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| read-through | 10 | 3073, 2985, 2936, 2907, 2761, 2654, 2567, 2660, 2819, 2881 | 2819 | 3073 | 1 | 0 |
| snapshot-only | 10 | 2119, 2541, 2115, 2213, 2409, 2227, 2244, 2586, 2210, 1954 | 2213 | 2586 | 0 | 1 |

The measured snapshot-only saving is one tag-state read per commit by the
executor contract. The observed client distribution was 606ms lower at p50 and
487ms lower at p95. The mode boundary was cold-first for snapshot-only; the
ten-second pacing rule was applied independently within each mode.

The prior W126/W127 504 receipts and G58 tick-history classification remain in
`docs/SDT-G57-evidence.md` and the existing `.artifacts/sdt-g57-w126-*` and
`.artifacts/sdt-g57-w127-*` files. W142 had no 504, so no new G58 tick-history
attribution was required and no scheduled-maintenance defect is claimed.

## AC6 and gates

AC5’s read-through versus snapshot-only measurement is complete from the fresh
matched receipt. AC6’s deployed public measurement is complete on the exact
self-mode W155-C identity above. The prior 504 cohorts are partial evidence,
not a pass or a replacement for this result.

Local gates on the integrated checkpoint were green:

- `npm run test:g15` — pass
- `npm run test:g16` — pass
- `npm run test:g49` — pass; binding/migration omission mutants red
- `npm run test:g52` — pass; omission mutants red
- `npm run test:g53` — pass; scope/control mutants red
- `npm run test:g54` — pass; production/accepted-positive mutants red
- `npm run test:g55` — pass; read-visibility mutants red
- `npm run test:g57` — pass; snapshot-only omission mutant red
- `npm run test:g58` — pass; safe-lane red-capable guards green
- `npm run test:g65` — pass; G65 ring/apply and admission mutants red
- `npm run typecheck` — pass
- `npm run lint` — pass
- `git diff --check` — pass

The G65 merge, direct self-mode binding, outbox/Queue/global admission path,
G58 maintenance/health surface, V1 wire, SafeWindow, and existing gates were
not weakened. No G59 or G64 work was started.

## Handoff

This artifact is the durable W142 deployed evidence checkpoint. The next action
is the authorized issue-to-PR handoff for #123 with `Closes #123`, followed by
the canonical worker `pr-created` transition. No separate deployment window is
needed for the evidence above.
