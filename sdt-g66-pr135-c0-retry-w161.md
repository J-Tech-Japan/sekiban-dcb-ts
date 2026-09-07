# SDT-G66 PR135 C-0 retry — W161

## Scope

- Branch/source under test: `claude/sdt-g66-local-and-production-w160`, exact
  source head `7ad3b08136dcabbf80bcdcaa9e8c7b5736693bb1`.
- Worker: `sekiban-dcb-meeting-room-cloudflare-only` only.
- No resource creation, deletion, migration, cleanup, or G32 mutation.
- All Wrangler child processes stripped
  `CLOUDFLARE_API_TOKEN`, `CF_API_TOKEN`, `CLOUDFLARE_API_KEY`, `CF_API_KEY`,
  and `WRANGLER_API_TOKEN`; no `--keep-vars`; conformance was supplied only by
  protected token-file path.

## Deployed identity

The exact source was deployed in this retry window as version
`e8665dee-6a86-41de-b11d-8d2e9dbea30c` with message
`SDT-G66 W161 exact 7ad3b081 C-0 retry corrected public MV proof`. The version
view confirmed 100% active traffic, `DIRECT_DOORBELL=true`, self receiver mode
and proof, and `DOWNSTREAM_DOORBELL` bound to
`sekiban-dcb-meeting-room-cloudflare-only#MeetingRoomDownstreamDoorbell`.
The existing production D1 IDs were
`f26d1299-82d9-4a64-8647-bc2ec86326ac` and
`b416b212-4d09-413c-9b8d-7660e475772f`; the existing production outbox and
DLQ remained attached. G32 resources were not touched.

## C-0 retry

The prior receipt `.artifacts/sdt-g66-w161-production-c0-reset.json` stopped
on `mv_active_generations` with D1 storage timeout code `7429`; no retry was
made in that window. This task's single authorized retry is
`.artifacts/sdt-g66-w161-production-c0-retry.json`. It completed 105 stripped
Wrangler invocations, including all pipeline/MV pre-counts, deletes, and
post-counts. No 7403/10000 authorization error occurred and no classifier was
needed. The retry therefore produced a clean operational starting state
without changing schema, migrations, queues, or G32 resources.

## Corrected continuous public cohort

Raw receipt: `.artifacts/sdt-g66-w161-production-corrected.json`.

The cold-first public session issued all 10 commands successfully and paced
their response completions 11,537–12,616 ms apart (minimum 11,537 ms). The
runner used response-completed-at-relative observed clocks, public unsafe
visibility, public safe query/read-head proof, and the fixed 5,000 ms unsafe /
180,000 ms safe bounds. Every command had HTTP 200 committed status and all
10 unsafe observations passed. Nine safe observations passed; sample 9 did
not reach the committed public read head within 180,000 ms and is retained as
censored. No rerun or tuning was performed.

| # | committed SUID | response ms | unsafe relative ms | unsafe | safe relative ms | safe | public safe readHead |
|---:|---|---:|---:|---|---:|---|---|
| 1 | `063924397279573000001488325244` | 3034 | 2727 | pass | 31925 | pass | null (room surface) |
| 2 | `063924397292086000000074084985` | 2613 | 2317 | pass | 35955 | pass | `063924397316151000000637031688` |
| 3 | `063924397304117000000124241296` | 1970 | 2212 | pass | 38259 | pass | `063924397340437000001622018425` |
| 4 | `063924397316151000000637031688` | 1757 | 2278 | pass | 33897 | pass | `063924397340437000001622018425` |
| 5 | `063924397328176000001049702443` | 2482 | 2262 | pass | 43463 | pass | `063924397364316000000927717473` |
| 6 | `063924397340437000001622018425` | 1612 | 2228 | pass | 39365 | pass | `063924397376364000000490188162` |
| 7 | `063924397352255000001465861665` | 1822 | 2245 | pass | 36122 | pass | `063924397376364000000490188162` |
| 8 | `063924397364316000000927717473` | 2000 | 2309 | pass | 61014 | pass | `063924397388322000000430464790` |
| 9 | `063924397376364000000490188162` | 2045 | 2233 | pass | censored | censored | did not reach committed SUID |
| 10 | `063924397388322000000430464790` | 1196 | 2253 | pass | 40384 | pass | `063924397388322000000430464790` |

Nearest-rank distributions from the receipt:

| measure | n | observed n | p50 ms | p95 ms | max ms | bound/result |
|---|---:|---:|---:|---:|---:|---|
| response | 10 | 10 | 1970 | 3034 | 3034 | recorded |
| unsafe response-relative | 10 | 10 | 2253 | 2727 | 2727 | 0/10 over 5000 ms |
| safe response-relative | 10 | 9 | 38259 | 61014 | 61014 | 9/10 observed; 1 censored at 180000 ms |

## Result

The C-0 retry itself succeeded, but the corrected deployed proof is blocked:
the strict safe criterion is not met because only 9/10 commands reached the
committed public safe read head within 180 seconds. The unsafe contract passed
10/10. The raw command, public query, read-head, tag-state and final-state
observations remain lossless in the cohort receipt. No additional cohort,
repair, reset retry, cleanup, or resource operation was attempted.
