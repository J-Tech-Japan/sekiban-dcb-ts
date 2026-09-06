# SDT-G57 paced AC6 checkpoint — W127

## Result

- Task: `SDT-G57-PACED-AC6-WAKE-127`
- Issue: `J-Tech-Japan/sekiban-dcb-ts#123`
- Branch: `claude/sdt-g57-deploy-free-w126`
- Starting checkpoint: `c47c0305151875382b32bf73e3b5ca02bd606e61`
- Deployed source: `fbeb4df01cbd804b7d1d8f90703cdab1d744a06c`
- Status: **blocked**

W126’s three unpaced HTTP-504 receipts were preserved. The existing W155-C
arm remained active at version `63f57044-8e42-4820-a100-3325dc2848b2`, 100%
traffic, with the exact W126 source annotation. No redeploy, resource creation,
migration, product repair, PR, or worker completion was performed in W127.

## G58 history classification

The persisted history window was queried from the existing pipeline D1 for
`2026-09-05T00:17:43Z..00:27:43Z` around the W126 final 504 at
`2026-09-05T00:22:43Z`. Exact raw and compact receipts:

- `.artifacts/sdt-g57-w127-g58-history-window.json`
- `.artifacts/sdt-g57-w127-g58-history-classification.json`

The nearest scheduled tick was `00:22:23.243Z`, 19,757ms before the 504, and
the next was `00:23:20.982Z`, 37,982ms after it. The persisted rows therefore
prove the 504 did **not** coincide with the every-minute scheduled tick. The
nearest tick was `SETTLED` with proven frontier
`063924164535707000000596266472`; earlier rows were BLOCK/UNSETTLED with
`source present/global receipt absent` and
`source_partition_set_changed_during_scan`. No scheduled-maintenance repair was
made.

## Paced comparison

The harness used unique W127 room IDs, `coldFirst=true` (no discarded warmup),
and response-to-next-start spacing of at least 10,000ms. It targeted 10
accepted samples per mode on the same existing arm. The reset receipts and
counts are under `.artifacts/sdt-g57-w127-*`. Three delayed W126 identities
remained after reset and were recorded as contamination rather than reused.

The snapshot-only partial receipt is
`.artifacts/sdt-g57-w127-paced-executor-comparison-aborted-http504-snapshot-006.json`:

| mode | durable accepted n | p50 (ms) | p95 (ms) | result |
| --- | ---: | ---: | ---: | --- |
| read-through | unavailable | unavailable | unavailable | entered snapshot arm, but root receipt was overwritten by mode-state flush |
| snapshot-only | 5 | 2700 | 2960 | ordinal 6 HTTP 504 |

The exact failure is in
`.artifacts/sdt-g57-w127-paced-executor-comparison-aborted-http504-snapshot-006-error.json`:

```json
{"error":"[object Object]","code":"unknown_outcome","kind":"timeout","attempts":1}
```

Because the read-through raw rows were not durable and snapshot-only stopped at
5/10, there is no valid matched p50/p95 or tag-state-read-saved comparison.
AC6 is not proven. No additional cohort was run.

## Credential and retry hygiene

Every Wrangler receipt records
`CLOUDFLARE_API_TOKEN`, `CF_API_TOKEN`, `CLOUDFLARE_API_KEY`, `CF_API_KEY`,
and `WRANGLER_API_TOKEN` as `UNSET` and stripped; no `--keep-vars` was used.
The observability credential was passed only by path. One D1 read returned code
7403 and was retried once after approximately five seconds under WAKE-122;
the retry succeeded. No write authorization failure occurred.

## Gates and remaining work

After the measurement-only harness changes, `npm run test:g57`,
`npm run typecheck`, `npm run lint`, `node --check` for both measurement
scripts, and `git diff --check` passed. The previously recorded G15/G16 and
G41/G49/G51/G52/G53/G54/G55/G56/G58/G61/G62 gates remain preserved from W126.

AC6, the matched paced comparison, PR creation, and worker completion remain
unfinished. No 5,000ms contract, V1 wire, outbox/Queue/global admission,
scheduled maintenance, SafeWindow, G58/G60/G61 boundary, or existing gate was
changed. G59, G64, and G65 were not started.
