# SDT-G57 deployed checkpoint — W126

## Result

- Task: `SDT-G57-DEPLOYED-WAKE-126`
- Issue: `J-Tech-Japan/sekiban-dcb-ts#123`
- Branch: `claude/sdt-g57-deploy-free-w126`
- Deployed source: `fbeb4df01cbd804b7d1d8f90703cdab1d744a06c`
- Status: **blocked**

The deploy-free AC1–AC4/local AC7 checkpoint was deployed to the existing
W155-C throwaway arm. AC5 route migration and version identity were proven, but
AC6 cannot be claimed: the required G50 read-through versus snapshot-only
comparison never reached its second arm. Three bounded public attempts ended
in read-through with HTTP 504 `unknown_outcome` before snapshot-only began.
No product repair, resource creation, PR, or worker completion transition was
performed.

## Deployed identity and no-create proof

Worker `sekiban-dcb-g60-w155-c` at
`https://sekiban-dcb-g60-w155-c.ttakaoka.workers.dev` was deployed once at
version `63f57044-8e42-4820-a100-3325dc2848b2`, deployment
`6fea8072-c0be-4e34-848e-369337155952`, with annotation:

```text
SDT-G57 W126 exact fbeb4df01cbd804b7d1d8f90703cdab1d744a06c existing W155-C arm
```

The deployment listing proves 100% traffic on that version. Existing resources
only were used: pipeline D1 `ac751211-fde8-4587-9d56-1e9fd8051bc3`, MV D1
`2b60dbcf-0912-4bb2-93aa-77c26cd260e1`, queue
`sekiban-dcb-g60-w155-c-outbox`, and DLQ
`sekiban-dcb-g60-w155-c-outbox-dlq`. No create/recreate or migration command
was issued. Operational deletes targeted only those existing W155-C D1s.

All Wrangler receipts record these five names as `UNSET` and stripped for the
process: `CLOUDFLARE_API_TOKEN`, `CF_API_TOKEN`, `CLOUDFLARE_API_KEY`,
`CF_API_KEY`, and `WRANGLER_API_TOKEN`. No `--keep-vars` was used. The
observability credential was supplied only as the path
`/Users/tomohisa/.config/sekiban-dcb/observability-token`; its value is absent
from source and evidence.

## Reset and measurement receipts

Initial pre-reset counts were pipeline `dcb_events=11`, hop measurements `126`,
hop submeasurements `226`, unsafe-writer boundaries `44`, live-poll rows `2`;
MV `mv_rows=11`, `mv_unsafe_receipts=11`, `mv_unsafe_rows=0`,
`mv_unsafe_kicks=2`, `mv_unsafe_arrivals=2`. The reset receipts and clean
counts are retained in `.artifacts/sdt-g57-w126-{reset,post-reset}-*` and the
recovery reset receipts in `.artifacts/sdt-g57-w126-{recovery,final-recovery}-*`.

The G50 harness was configured for one discarded warm-up and 50 accepted
samples per mode. The lossless partial receipts are:

| attempt | mode | committed samples | p50 (ms) | p95 (ms) | terminal result |
| --- | --- | ---: | ---: | ---: | --- |
| first | read-through | 35 | 2085 | 2425 | command-runner interruption |
| second | read-through | 27 | 2865 | 4895 | ordinal 28 HTTP 504 |
| final | read-through | 26 | 2796 | 5119 | ordinal 27 HTTP 504 |

The final exact error is in
`.artifacts/sdt-g57-w126-g50-executor-comparison-aborted-http504-027-error.json`:

```json
{"error":"[object Object]","code":"unknown_outcome","kind":"timeout","attempts":1}
```

No snapshot-only request was accepted, therefore there is no valid matched
G50 n/p50/p95 or read-saved result. The application 504 is not Cloudflare API
authorization; no Wrangler authorization classifier applies. The repeated
failure is recorded without attributing it to the new executor path.

## AC mapping and gates

- AC1–AC4 and local AC7 remain proven by the pushed deploy-free checkpoint and
  source `fbeb4df...`; the tracked red-before-green C-12 evidence is preserved.
- AC5: the public meeting-room command path parses executor envelopes and the
  browser/UI supplies portable snapshots, with read-through fallback for
  uncovered claims. The exact deployed version is verified above.
- AC6: **not proven** because the required two-mode G50 receipt is incomplete.
- Local gates passed on this exact source before deployment: `npm run test:g15`,
  `test:g16`, `test:g41`, `test:g49`, `test:g51`, `test:g52`, `test:g53`,
  `test:g54`, `test:g55`, `test:g56`, `test:g57`, `test:g58`, `test:g61`,
  `test:g62`, `npm run typecheck`, `npm run lint`, and `git diff --check`.
- `PR/CI`: not started; worker completion was not run.

No 5,000 ms contract, V1 wire, outbox/Queue/global admission behavior,
ordering, fence, SafeWindow, G58/G60/G61 boundary, or existing gate was
changed or weakened. G59 and G64 were not started.
