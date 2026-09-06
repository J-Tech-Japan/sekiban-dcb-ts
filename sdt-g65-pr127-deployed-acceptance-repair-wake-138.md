# SDT-G65-PR127-DEPLOYED-ACCEPTANCE-REPAIR-WAKE-138

Status: **blocked**. This is deployed evidence only; no product, fixture, gate,
merge, or review-state change was made.

## Identity and hygiene

- Issue/PR: J-Tech-Japan/sekiban-dcb-ts#126 / PR #127.
- Branch: `claude/sdt-g65-local-wake-w128`.
- Exact requested source: `4e952e1d8af4a62c42f911eff1d8b8829b929544`.
- Existing arm only: Worker `sekiban-dcb-g60-w155-c`, pipeline D1
  `ac751211-fde8-4587-9d56-1e9fd8051bc3`, MV D1
  `2b60dbcf-0912-4bb2-93aa-77c26cd260e1`, Queue
  `sekiban-dcb-g60-w155-c-outbox`, DLQ
  `sekiban-dcb-g60-w155-c-outbox-dlq`. No resource was created or deleted and
  no migration was run.
- The five Wrangler credential names were `UNSET` in the seat environment and
  were stripped from every Wrangler invocation: `CLOUDFLARE_API_TOKEN`,
  `CF_API_TOKEN`, `CLOUDFLARE_API_KEY`, `CF_API_KEY`,
  `WRANGLER_API_TOKEN`. No `--keep-vars` was used. Conformance was supplied by
  private file path only; the secret value is not in this repository.
- Final restoration is version
  `6a1f331a-cbcf-40a7-b50b-02edb427a9b8`, deployment
  `c6885b62-ae56-488f-a3dc-968c55d528af`, 100% traffic, annotation
  `SDT-G65 W138 final restore exact 4e952e1d8af4a62c42f911eff1d8b8829b929544 DIRECT_DOORBELL=true`.
  The deployed version view proves `DIRECT_DOORBELL=true` and the normal D1,
  MV, and Queue bindings.

The version view has `DOWNSTREAM_QUEUE` but no `DOWNSTREAM_DOORBELL` binding.
Therefore the Boolean variable was true, but the direct receiver lane was not
actually available on W155-C. Durable unsafe-writer rows in both cohorts have
`transport=queue`, so AC0's non-positive direct-doorbell contribution and a
healthy direct-admission success were not proven by this arm.

## Matched cohorts

Both runs were cold-first, n=10, paced at least 10 seconds after each prior
commit response, and used the fully paged public reservation list. All ten
commit responses in each run were HTTP 200 `committed`; neither run returned a
504. The cohort harness persisted raw receipts incrementally.

| Arm | Source / version / deployment | Window | Result |
| --- | --- | --- | --- |
| Pre-change | `a8bb1bd493591081c24a52239c1b0e0dce2c42e1` / `8089e932-68b0-409e-88e1-e7835553db62` / `e20479c3-53d4-49e0-ba5e-b1f7a72a2620` | 19:19:19.954Z–19:22:36.341Z | 10/10 safe final heads within 180 s |
| Post-change | `4e952e1d8af4a62c42f911eff1d8b8829b929544` / `0a1642b4-db1b-4a7f-8212-f3c204fe1482` / `214bb3fa-68c7-41e0-9c34-9b66e34695ba` | 19:25:11.359Z–19:30:20.731Z | 10/10 completed, but 9/10 unsafe over 5 s and one safe head exceeded 180 s |

Observed distributions (p50/p95 are nearest-rank, observed rows only):

| Metric | Pre-change | Post-change |
| --- | ---: | ---: |
| Client response | 2,309 / 2,574 ms | 2,284 / 2,640 ms |
| Response p95 delta | — | +66 ms (within +150 ms) |
| Response p50 delta | — | -25 ms (within 300 ms admission budget +100 ms) |
| Admission attempt duration | 300 / 300 ms, 10/10 `unknown` | 300 / 300 ms, 10/10 `unknown` |
| `global_completion_observed_at` | 0/10 observed; header `unknown` 10/10 | 0/10 observed; header `unknown` 10/10 |
| First public unsafe visibility | 4,583 / 116,931 ms; 4/10 >5,000 | 57,145 / 117,933 ms; 9/10 >5,000 |
| Final safe visibility | 117,435 / 179,888 ms; 10/10 <=180 s | 124,847 / 186,687 ms; 9/10 <=180 s |

The durable event and global-receipt rows exist for every sample, but no
sample's admission attempt observed a completion timestamp before the response.
Thus healthy configured-store direct admission was not demonstrated. The
post-change response timing criterion passed, but the unchanged unsafe 5,000
ms criterion failed 9/10 and the safe 180-second line failed for sample 1.

### Complete per-sample observed table

`global` is `outcome / admission duration / global completion clock`; `safe`
is commit response to final projector-head proof; `q->consumer` and
`delivery->unsafe` are durable observed intervals. A negative interval is
retained as cross-observer ordering evidence and is not treated as work.

| Arm/# | Response | Global | Unsafe | Safe | q->consumer | delivery->unsafe |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| Pre/1 | 2,503 | unknown / 300 / — | 116,931 | 179,888 | 5,660 | 109,878 |
| Pre/2 | 2,366 | unknown / 300 / — | 4,492 | 167,306 | 3,280 | -148 |
| Pre/3 | 2,351 | unknown / 300 / — | 4,612 | 154,953 | 3,121 | 15 |
| Pre/4 | 2,285 | unknown / 300 / — | 79,901 | 142,666 | 5,195 | 73,095 |
| Pre/5 | 2,294 | unknown / 300 / — | 5,174 | 130,011 | 4,544 | -1,015 |
| Pre/6 | 2,574 | unknown / 300 / — | 55,002 | 117,435 | 5,557 | 47,744 |
| Pre/7 | 2,249 | unknown / 300 / — | 4,462 | 105,184 | 2,247 | 601 |
| Pre/8 | 2,473 | unknown / 300 / — | 4,583 | 92,483 | 3,109 | 103 |
| Pre/9 | 2,309 | unknown / 300 / — | 4,457 | 80,172 | 2,589 | 490 |
| Pre/10 | 2,179 | unknown / 300 / — | 4,399 | 67,990 | 2,133 | 745 |
| Post/1 | 2,397 | unknown / 300 / — | 117,933 | 186,687 | 4,896 | 111,766 |
| Post/2 | 2,094 | unknown / 300 / — | 105,946 | 174,558 | 20,560 | 83,871 |
| Post/3 | 2,284 | unknown / 300 / — | 93,655 | 162,075 | 22,518 | 69,630 |
| Post/4 | 2,392 | unknown / 300 / — | 81,452 | 149,681 | 23,285 | 56,256 |
| Post/5 | 2,438 | unknown / 300 / — | 69,013 | 136,907 | 16,597 | 50,805 |
| Post/6 | 1,935 | unknown / 300 / — | 57,145 | 124,847 | 16,022 | 39,124 |
| Post/7 | 2,195 | unknown / 300 / — | 45,304 | 112,651 | 9,349 | 33,993 |
| Post/8 | 2,640 | unknown / 300 / — | 5,145 | 100,009 | 3,159 | 491 |
| Post/9 | 2,590 | unknown / 300 / — | 4,621 | 87,417 | 3,568 | -1,271 |
| Post/10 | 2,274 | unknown / 300 / — | 5,220 | 74,686 | 4,481 | -2,294 |

For post samples 1–7, the dominant observed interval is the residual from
recordDelivery to the public read. Sample 8 has no single interval above 5 s;
its 5,145 ms total is the overlap of the 3,159 ms queue dispatch interval and
the 2,640 ms response clock. Sample 10 likewise has no positive delivery
residual; its 5,220 ms total overlaps the 4,481 ms queue interval and the
response clock. Post samples 1–7 therefore remain queue/residual failures, not
direct-doorbell failures; the W155-C binding did not expose that receiver.

### Durable sub-hop distributions

| Boundary | Pre n/p50/p95 | Post n/p50/p95 |
| --- | ---: | ---: |
| command receipt -> Tag append | 10 / 1,028 / 1,139 | 10 / 1,050 / 1,350 |
| Tag append -> outbox obligation | 10 / 0 / 0 | 10 / 0 / 0 |
| outbox obligation -> Queue send | 10 / 1,108 / 1,195 | 10 / 1,097 / 1,159 |
| Queue send -> consumer start | 10 / 3,121 / 5,660 | 10 / 9,349 / 23,285 |
| consumer start -> recordDelivery commit | 10 / 760 / 931 | 10 / 1,205 / 2,332 |
| recordDelivery -> ledger unsafe read | 10 / 474 / 5,962 | 10 / 1,230 / 6,908 |
| recordDelivery -> public unsafe read | 10 / 490 / 109,878 | 10 / 39,124 / 111,766 |
| global receipt readback duration | 10 / 129 / 154 | 10 / 128 / 270 |
| source Tag acknowledgement | 10 / 163 / 310 | 10 / 164 / 427 |
| completeness coverage | 10 / 85 / 157, all `BLOCK/UNSETTLED` | 10 / 120 / 298; 8 `BLOCK/UNSETTLED`, 2 `SETTLED` |
| detector | 4 / 286 / 440 | 8 / 432 / 865 |
| Room unsafe-view apply | 10 / 128 / 305 | 10 / 229 / 877 |
| Reservation unsafe-view apply | 10 / 89 / 269 | 10 / 200 / 539 |
| inline writer, Room / Reservation | 10 / 85 / 142 / 66 / 105 | 10 / 75 / 231 / 65 / 108 |

The short sub-hops do not establish the missing direct lane; all writer rows
are `transport=queue`, `writer_path=inline-delivery`. The large post-change
latency is therefore left as measured queue/residual behavior.

## AC1/AC5 D1-unavailable evidence

The unconfigured-D1 deployment was version
`88ecfb3c-42cd-4e04-bc36-223c263b5448`, exact source message, 100% traffic,
`DIRECT_DOORBELL=true`, and no `D1` binding. On that version, an existing
registered reservation cancellation returned HTTP 200 `committed` with
`x-sdt-global-admission: not-admitted`; after normal restoration the recovery
ledger contains event `01a0730f-d43b-7ba4-8724-61dbbe3eed0c` and a global
receipt at `1788636930502` (obligation sequence 2). This is the required
existing-partition commit/not-admitted then Queue-admitted behavior.

The same unconfigured run's new room
`g65-w138-unconfigured-new-u1` returned HTTP 200 `committed`/
`not-admitted`, event `01a0730f-dcca-7b9a-b6ef-e978aa3c2940`, and later a
global receipt. This is not a typed refusal and is correctly classified as the
WAKE-134 unconfigured-store path.

The additional bound-MV probe used version
`3427a406-a1f1-4900-b601-66261f884526` with `DIRECT_DOORBELL=true`, D1 bound
to the existing MV ID, and no resource creation. Its existing-partition
operation returned 200/not-admitted, while its new room
`g65-w138-configured-failure-new-c1` also returned 200/not-admitted with event
`01a07310-8518-7245-af65-ef28e49fcd37`; the recovery query later found a
global receipt. Because the bound database lacks the G44 authority schema, the
runtime classified it as explicitly unconfigured, not as a configured-store
registration failure. It therefore cannot prove
`503 partition_registration_unavailable` or zero event writes.

Accordingly, the deployed configured-store first-write refusal remains
unproven. No authorized operation in this task could manufacture a configured
runtime D1 failure without altering a schema/resource or adding another repair.

## Receipts and verification

Expanded receipts remain in the ignored `.artifacts/` directory and were
losslessly gzip-compressed. The following SHA-256 values are over the gzip
files:

| Receipt | gzip SHA-256 |
| --- | --- |
| `sdt-g65-w138-pre-change-cohort.json.gz` | `e8612b9b3d26e05467d58dd749a5f99e8cd6088c60cda1e1954613f87ab470c9` |
| `sdt-g65-w138-post-change-cohort.json.gz` | `568ed6ff88f1c8ca81616d6c2f40bd19fc4affa0ccbdcc9852c36b906f6fee9d` |
| `sdt-g65-w138-pre-change-ledger.json.gz` | `ac3ff93917b194faefa698610afa6d7c02d5e1d76f010c0aaf0aae4d4fb66d34` |
| `sdt-g65-w138-post-change-ledger.json.gz` | `b72aa968f49458f7fb276ede10eb4cccb68238cd93072f1d4c6a004b00ea8298` |
| `sdt-g65-w138-d1-unconfigured-public.json.gz` | `d919594741bc607ee8298cd7f48bf1353c6261469bd5224e2694a4c781f17d9b` |
| `sdt-g65-w138-d1-configured-failure-public.json.gz` | `b12ed39969bf96f0d79c4d6dcd94693dd4c8254d452646b4c09443db87b21664` |
| `sdt-g65-w138-d1-recovery-ledger.json.gz` | `95e168d885ac6cce39e43bdcd7e0172dd7f91f514bf9166495c1ad9815ed123b` |
| `sdt-g65-w138-analysis.json.gz` | `b869217056f966c3c6d88675e060793ff64073854b5b6c382860c7c0c874de37` |

Round-trip verification passed with, for example:

```sh
gzip -dc .artifacts/sdt-g65-w138-post-change-cohort.json.gz > /tmp/sdt-g65-w138-post-change-cohort.json
cmp -s /tmp/sdt-g65-w138-post-change-cohort.json .artifacts/sdt-g65-w138-post-change-cohort.json
```

The compact review table is this artifact; the complete raw cohort, ledger,
deployment/version, reset, and D1 proof receipts are the corresponding
`.artifacts/sdt-g65-w138-*.json` and `.json.gz` files.

## Disposition

`git diff --check` passed for the evidence-only update. No code or fixture gate
was changed. W138 is blocked because the post-change cohort missed the
unchanged unsafe contract, the direct receiver binding was absent despite the
Boolean variable, healthy synchronous admission remained `unknown`, and the
deployed configured-store typed refusal was not reproduced. The final Worker
was restored to the exact requested source/configuration at 100%. No PR merge,
review-state change, resource operation, or additional cohort was performed.
