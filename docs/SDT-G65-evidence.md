# SDT-G65 deployed repair evidence (W136)

Task: `SDT-G65-PR127-PUBLIC-REFUSAL-DEPLOYED-REPAIR-WAKE-136`
Issue: [J-Tech-Japan/sekiban-dcb-ts#126](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/126)
PR: [#127](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/127)
Branch: `claude/sdt-g65-local-wake-w128`
Local/deployed repair head: `a8bb1bd493591081c24a52239c1b0e2dce2c42e1`

This document is regenerated from W136 receipts only. It does not claim
SDT-G65 completion: the required ten-sample post-change cohort stopped at
sample 7 on an application `504 unknown_outcome`, and the configured-store
first-partition refusal was not reproduced by the authorized deployed
unconfigured-binding check.

## Evidence classification and boundaries

- W128 measurements are historical and superseded; their old admission
  figures are not current W136 evidence.
- W130 was a failed/superseded cohort line, not deployed proof for this task.
- W131-W134 are local repair/checkpoint evidence only.
- W136 is the current deployed evidence below. The only product change in
  this checkpoint is the public serialization of the already-local,
  configured first-partition registration refusal from `a8bb1bd`.
- Existing W155-C resources were reused. No Cloudflare resource was created or
  deleted, and no migration was run in W136.
- The five recognized Wrangler credential variable names were `UNSET` for
  every W136 Wrangler invocation: `CLOUDFLARE_API_TOKEN`, `CF_API_TOKEN`,
  `CLOUDFLARE_API_KEY`, `CF_API_KEY`, and `WRANGLER_API_TOKEN`. Commands used
  the receipt wrapper with all five removed; no `--keep-vars` was used.
  Conformance was passed by private file path only. The initial application
  403 was `{code: unauthorized, error: Conformance authentication required}`;
  it was the application handler, so a fresh private conformance secret was
  installed and the exact source was redeployed afterward. No secret value is
  present in this repository.

## Existing arm and deployed identities

| Resource | Identity |
| --- | --- |
| Worker | `sekiban-dcb-g60-w155-c` |
| Pipeline D1 | `ac751211-fde8-4587-9d56-1e9fd8051bc3` |
| MV D1 | `2b60dbcf-0912-4bb2-93aa-77c26cd260e1` |
| Queue / DLQ | `sekiban-dcb-g60-w155-c-outbox` / `sekiban-dcb-g60-w155-c-outbox-dlq` |

The pre-change source was exact `96482c288127ee082751d3beebcd36708f9d9561`.
After secret publication, exact identity and `DIRECT_DOORBELL=true` were
restored in version `f1837521-395b-40d2-a39f-947687139064`, deployment
`dd1bef66-2d5d-45c2-bb0e-3ef1ae48f8ee`, at 100% traffic.

The post-change source was exact `a8bb1bd493591081c24a52239c1b0e2dce2c42e1`.
Version `1f4a0966-81b4-42fc-8489-49c2ec7b854e`, deployment
`2ae6ea08-df5e-4a45-890e-608bbb3c4e10`, was 100% traffic with annotation
`SDT-G65 W136 post-change exact a8bb1bd493591081c24a52239c1b0e2dce2c42e1 DIRECT_DOORBELL=true`.

For C-0, the runtime-D1-unavailable variant was version
`2967f040-e1d4-46d2-8f66-636f68ca391b`, with `DIRECT_DOORBELL=true` and no
`D1` binding. The normal configuration was restored at 100% in version
`7c2a8b6e-1866-4f70-b611-0c892abf45b3`, deployment
`2e8f0e2d-743e-4d91-8cf3-5ae2e498dc72`, exact source `a8bb1bd` and
`DIRECT_DOORBELL=true`.

## F1 local public API proof

`npm run test:g65` passed before deployment. The added public CommitWorker
tests are:

- configured first-partition registration failure: HTTP 503,
  `partition_registration_unavailable`, `retryable: true`, bounded response,
  and zero authoritative `tag_event` rows;
- configured first-partition registration hang: the same typed 503 and bounded
  response, with zero `tag_event` rows;
- mixed envelope: the existing partition is written while the new partition
  remains refused; the public response is the existing typed HTTP 500
  `partial_write` shape, with the new partition having zero authoritative
  event rows.

The focused file `test/g65-admission.spec.ts` passed all 14 tests. The local
implementation therefore proves the configured failure/hang contract. The
deployed C-0 check below intentionally uses an absent binding, which is the
explicitly unconfigured case and must not be relabeled as configured-store
failure.

## W136 public cohorts

Both cohorts used the public create-room/reserve-room surface, cold first
sample, ten-second minimum spacing after the preceding commit response, and
fully paged reservation reads. Timing uses observed fetch receipt clocks and
durable observed ledger clocks only. It does not derive latency from authored
`dcb_events.Timestamp` or caller `received_at`.

| Metric | Pre-change (`96482c2`, n=10) | Post-change (`a8bb1bd`, n=6 accepted) |
| --- | ---: | ---: |
| Client send-to-response p50 / p95 | 2,344 / 3,259 ms | 2,246 / 2,396 ms |
| Unsafe first visibility p50 / p95 | 35,896 / 119,427 ms (10/10 observed over 5,000 ms) | 4,800 / 5,301 ms for 4 observed; 2/6 censored at 5,000 ms |
| Strict observed count over 5,000 ms | 10/10 | 1/4 observed; 3/6 over-or-censored |
| Safe final projector head p50 / p95 | 145,229 / 207,599 ms; 7/10 <=180 s | not established; cohort stopped |
| Header `x-sdt-global-admission` | `unknown` 10/10 | `unknown` 6/6 |

The pre-change cohort ended after the 180-second safe-bound check with all ten
projector/tag targets eventually observed, but seven of ten were within the
180-second line. The post-change cohort accepted six reservations; reservation
7 returned HTTP 504 `unknown_outcome` after 2,359 ms and the harness stopped.
No post-change ten-sample acceptance or safe-bound claim is made.

### Per-sample observed results

`queue->consumer` and `delivery->public-unsafe` are milliseconds. A blank
value is censored or unavailable. Negative delivery/read values are retained
as cross-observer ordering observations from direct delivery, not interpreted
as negative causal work.

| Arm/# | Response | Unsafe | Safe | Queue->consumer | Delivery->public unsafe | Inline Room / Reservation writer |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Pre/1 | 2,332 | 119,427 | 207,599 | 6,329 | 111,533 | 85 / 74 |
| Pre/2 | 2,329 | 5,001 | 195,268 | 3,235 | 126 | 75 / 61 |
| Pre/3 | 2,344 | 95,439 | 182,923 | 5,086 | 88,395 | 78 / 105 |
| Pre/4 | 2,795 | 83,359 | 170,126 | 7,634 | 73,825 | 159 / 81 |
| Pre/5 | 2,332 | 71,670 | 157,792 | 4,419 | 65,613 | 54 / 54 |
| Pre/6 | 2,561 | 60,054 | 145,229 | 4,893 | 53,608 | 57 / 56 |
| Pre/7 | 2,348 | 5,573 | 132,881 | 3,908 | -125 | 82 / 73 |
| Pre/8 | 2,594 | 35,896 | 120,285 | 4,249 | 29,913 | 76 / 65 |
| Pre/9 | 2,261 | 5,532 | 108,024 | 2,024 | 1,736 | 58 / 77 |
| Pre/10 | 3,259 | 11,205 | 94,763 | 5,356 | 4,033 | 63 / 62 |
| Post/1 | 2,380 | 4,919 | — | 3,542 | 44 | 50 / 55 |
| Post/2 | 2,254 | 4,612 | — | 3,567 | -771 | 72 / 76 |
| Post/3 | 2,110 | 5,301 | — | 4,581 | -1,247 | 57 / 69 |
| Post/4 | 2,246 | 4,800 | — | 3,215 | 205 | 57 / 53 |
| Post/5 | 2,396 | censored | — | 5,169 | — | 110 / 74 |
| Post/6 | 2,230 | censored | — | 4,515 | — | 74 / 63 |

## Durable hop/sub-hop distributions

The following are n / p50 / p95 in milliseconds. `global dcb_events
visibility` has no valid observed completion/read clock in this run: the D1
rows and global receipt rows are present, but the admission ledger's
`global_completion_observed_at` is null for all sampled attempts. The
post-record global-receipt readback span is a separate observed measurement.

| Boundary | Pre | Post |
| --- | ---: | ---: |
| command receipt -> Tag append | 10 / 1,131 / 2,131 | 6 / 1,067 / 1,131 |
| Tag append -> outbox obligation | 10 / 0 / 0 | 6 / 0 / 0 |
| outbox obligation -> Queue send | 10 / 1,114 / 1,184 | 6 / 1,084 / 1,112 |
| Queue send -> consumer start | 10 / 4,419 / 7,634 | 6 / 3,567 / 5,169 |
| consumer start -> recordDelivery commit | 10 / 991 / 1,194 | 6 / 847 / 1,384 |
| recordDelivery -> public unsafe read | 10 / 29,913 / 111,533 | 4 / -771 / 205 |
| post-record global-receipt readback duration | 10 / 91 / 139 | 6 / 64 / 148 |
| source Tag acknowledgement duration | 10 / 172 / 549 | 6 / 153 / 236 |
| completeness coverage duration | 10 / 128 / 284 | 6 / 95 / 165; all `BLOCK/UNSETTLED` |
| detector duration | 0 / — / — | 0 / — / — |
| Room unsafe-view apply | 10 / 136 / 371 | 6 / 57 / 284 |
| Reservation unsafe-view apply | 10 / 72 / 336 | 6 / 46 / 250 |
| inline unsafe Room writer | 10 / 75 / 159 | 6 / 57 / 110 |
| inline unsafe Reservation writer | 10 / 65 / 105 | 6 / 63 / 76 |
| recordDelivery -> ledger unsafe read | 10 / 3,069 / 6,740 | 5 / -43 / 5,651 |
| residual delivery -> public read | 10 / 29,913 / 111,533 | 4 / -771 / 205 |

The post-change direct unsafe boundaries are short and public visibility was
observed before or near recordDelivery in several rows, consistent with the
independent direct writer. This does not rescue the incomplete cohort: one
observed sample exceeded 5,000 ms, two were censored, and the seventh commit
returned `unknown_outcome`.

## C-0 runtime-D1-unavailable proof

The existing-tag operation was `cancel-reservation` on the already registered
tag `reservation:g65-reservation-65defd04-76a-1`. Under the absent `D1`
binding it returned HTTP 200 with header `not-admitted`. After normal D1
restoration, the public list reached `{status: cancelled, version: 2}` after
84 fully paged reads; the D1 ledger contains its global receipt. The recovery
receipt records 84 observations over about 102 seconds. The polling helper
exited nonzero only after writing the complete receipt because its final
console summary referenced an undefined local `final`; the durable receipt's
`recoveredExactlyOnce: true` and final row are authoritative for this
measurement, and the helper was not retried.

The brand-new room tag was `room:g65-w136-new-first-da855b66-4b9`. It returned
HTTP 200 with `not-admitted`, not the required configured-store HTTP 503
`partition_registration_unavailable`. D1 readback shows event
`01a071bb-6f65-795d-984a-02c4fba48363`, SUID
`063924211304954000001191258191`, and one global receipt. This is the expected
unconfigured-store behavior under the narrow AC1 scope, so deployed configured
first-partition refusal remains unproven in W136. The local public tests are
the configured failure/hang proof; a later task must supply a real configured
store failure/hang deployment if required.

## Receipts and lossless verification

Large raw JSON receipts are retained as gzip artifacts; expanded copies remain
ignored working files and are not committed as duplicates. For each compressed
receipt, `gzip -dc <file>.gz > <file>` followed by `cmp -s <file> <file>.gz`
decompression verification was run. SHA-256 values:

| Raw receipt | Raw SHA-256 | Gzip SHA-256 |
| --- | --- | --- |
| `sdt-g65-w136-pre-cohort-final.json` | `34f48072ee0bf6c9a390feb3c0e27652c9948e7f156262793b53d2c6cc5c9386` | `b9ccd9b0761c9ee57d667c4367513b30812ea30df25b01c6dba7028e5722171d` |
| `sdt-g65-w136-post-cohort.json` | `ef63de3394158bf18ff79bd866152bf1f68d20e5b06a976eaf12d84750b8d3d1` | `3f0646692f3ac8a0e4da097a43f6985e65bd7e14f087b3ceb48b0542682c9cf5` |
| `sdt-g65-w136-pre-ledger.json` | `f2125a659429b818d4c5d2caba60eb1e92a3a6c37c262cbadaa2e262b438a1a3` | `21783b44d80f687093697951be6d373d5450ca74fa893f3ac5d410d7b9fd6e85` |
| `sdt-g65-w136-post-ledger.json` | `45c94f5c83b0830ef9229854c23f661ea1a30371dcfeb1847da3be483aede8c8` | `e6a16556dae1ed934a858b58190fb2cb17f30370cac90aa94d3a817b8c471028` |
| `sdt-g65-w136-d1-recovery.json` | `07592fc414d2911aab4b0c1501a4a198e11d0f058232b066b03ed83721281e1b` | `339a7ca68da8ddd49c1515421770e1559966f1f753caf212ff196706ff66c1ab` |
| `sdt-g65-w136-d1-unavailable-public.json` | `6c47e738ba27ec2baa36c36d21ade395b7a8b1da255178443dd95e8f02e0da65` | `dc50b4b01a9ca8efb975a3290f710b83d787267f0949ea59405f9e6731bb9f4a` |
| `sdt-g65-w136-d1-unavailable-ledger.json` | `76ebf8d767cefcaf74c6448c7bd97cfa2b640a8329daf2c82f54b26e94ebb586` | `d2a9b848958124527f6a12711b9bb7c2acd0362dddd3a60f765fab897b6ea200` |

Example:

```sh
gzip -dc .artifacts/sdt-g65-w136-pre-cohort-final.json.gz > /tmp/sdt-g65-w136-pre-cohort-final.json
cmp -s /tmp/sdt-g65-w136-pre-cohort-final.json .artifacts/sdt-g65-w136-pre-cohort-final.json
```

Compact review data is in `sdt-g65-w136-analysis.json` and
`sdt-g65-w136-sample-detail.json`. Deployment/version/traffic receipts are the
`sdt-g65-w136-*.json` files in `.artifacts/`.

## Local gates and disposition

Before deployment, the local checkpoint passed the focused F1 public tests and
the required G44, G53, G55, G58, G60, G62, G61, G41, G26, typecheck, lint and
diff checks. The existing G60 mutants remained red as designed; no gate was
weakened. The complete local command/result list is recorded in the W136 task
artifact.

Disposition: **blocked before rereview/completion**. The deployed evidence is
not an AC5/AC1 pass: the post-change cohort is incomplete and contains an
observed 5-second miss, and the absent-binding arm cannot prove the configured
new-partition typed refusal. No further cohort, tuning, resource operation,
merge, or issue closure was performed.
