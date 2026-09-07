# SDT-G66 phase-one evidence — W162

## Status and scope

This is a documentation-only phase-one checkpoint for PR #135 and issue
`#128`. It makes no runtime, test, deployment, reset, cleanup, or Cloudflare
change. The exact current source checkpoint is
`6e370aa41c90b07d5b9eef812858b59eec64a108`. The deployed corrected cohort was
run from source `7ad3b08136dcabbf80bcdcaa9e8c7b5736693bb1` as version
`e8665dee-6a86-41de-b11d-8d2e9dbea30c`.

The phase-one result is fail-closed: 10 commands committed and all 10 unsafe
observations passed, but only 9 of 10 safe public read-head proofs completed
before the fixed 180,000 ms bound. AC2 therefore remains outstanding. No
rerun or tuning is claimed; SDT-G69 owns the unchanged-cohort follow-up after
its approved change.

## Corrected production cohort

Receipt: `.artifacts/sdt-g66-w161-production-corrected.json`.

- Cold-first continuous cohort: 10 commands, response-completion spacing
  11,537–12,616 ms (minimum 11,537 ms).
- Response: n=10, p50/p95 `1970/3034 ms`.
- Unsafe response-relative visibility: n=10, p50/p95 `2253/2727 ms`,
  0/10 over the unchanged 5,000 ms bound.
- Safe public read-head proof: 9 completed, 1 censored at 180,000 ms;
  observed n=9 p50/p95 `38259/61014 ms`. This is not a 10-row pass
  distribution. The strict 10/10 safe result is failed/blocked.

### Exact censored sample 9

The row is the ninth `reserve-room` command for reservation
`g66-w161-production-corrected-w161-product-r08`.

| clock/field | retained value |
|---|---|
| commit started | `1788800575342` |
| commit completed | `1788800577387` |
| commit response | `2045 ms`, HTTP 200, admission `unknown` |
| committed SUID | `063924397376364000000490188162` |
| tag writes | room version 17 at `2026-09-07T17:02:56.571Z`; reservation version 1 at `2026-09-07T17:02:56.631Z` |
| unsafe first visible | `1788800579620`, response-relative `2233 ms`, pass |
| safe bound | `180000 ms` |
| safe bound exceeded | `1788800757569` |
| safe first visible / response-relative safe time | `null` / `null` |
| final safe health observed | received `1788800757112`, observed `1788800757569`, HTTP 200 |
| final coverage | SETTLED; frontier `063924397388322000000430464790`, coverage observed `1788800691406` |
| final safe/MV read head | `063924397388322000000430464790` |
| target-safe result | public read did not reach committed SUID `063924397376364000000490188162`; censored |

The raw safe object has no successful target observation (`observations: 0`),
and its final public query retains `waitForSuid` equal to the committed SUID
with `visible: false`. The later observed frontier/read head is retained as
evidence, not substituted for the target proof.

## Causal attribution and operator answer

The phase-one safe miss is attributed to the retained G68 diagnosis: repeated
delivery arrivals can update `LastArrivedAt` and restart the SafeWindow/fence-
expiry deadline. The receipt therefore shows a committed event and a settled
later frontier without a valid target-safe observation inside the bound; it
does not justify relabelling the censored row as safe.

Operator answer: the write and unsafe lanes worked—every command committed and
all 10 unsafe observations passed within 5 seconds. The safe lane did not close
the acceptance gate—sample 9 remained censored at 180 seconds—so this phase is
fail-closed at 9/10. The split answer is intentional: unsafe success is not
safe-frontier certification. AC2 remains outstanding, and SDT-G69 is the
follow-up owner for the unchanged-cohort proof after its approved moving-fence
change; this checkpoint performs no rerun or behavior change.

## Read-only production topology

Topology receipt: `.artifacts/sdt-g66-w161-production-topology.json`.

Bound D1s were:

| binding | database | ID |
|---|---|---|
| `D1` | `sekiban-dcb-meeting-room-cloudflare-pipeline` | `f26d1299-82d9-4a64-8647-bc2ec86326ac` |
| `D1_MV` | `sekiban-dcb-meeting-room-cloudflare-mv` | `b416b212-4d09-413c-9b8d-7660e475772f` |

The complete retained Queue inventory/consumer list is:

| queue | producers | consumers |
|---|---|---|
| `sekiban-dcb-g60-w129-a-outbox` | `worker:sekiban-dcb-g60-w129-a` | `worker:sekiban-dcb-g60-w129-a` |
| `sekiban-dcb-g60-w129-a-outbox-dlq` | none | none |
| `sekiban-dcb-g60-w129-b-outbox` | `worker:sekiban-dcb-g60-w129-b` | `worker:sekiban-dcb-g60-w129-b` |
| `sekiban-dcb-g60-w129-b-outbox-dlq` | none | none |
| `sekiban-dcb-g60-w155-c-outbox` | `worker:sekiban-dcb-g60-w155-c` | `worker:sekiban-dcb-g60-w155-c` |
| `sekiban-dcb-g60-w155-c-outbox-dlq` | none | none |
| `sekiban-dcb-meeting-room-cloudflare-outbox` | `worker:sekiban-dcb-meeting-room-cloudflare-only` | `worker:sekiban-dcb-meeting-room-cloudflare-only` |
| `sekiban-dcb-meeting-room-cloudflare-outbox-dlq` | none | none |
| `sekiban-dcb-meeting-room-g32-9043d626fe1149cb-outbox` | none | `worker:sekiban-dcb-meeting-room-cloudflare-only` |
| `sekiban-dcb-meeting-room-g32-9043d626fe1149cb-outbox-dlq` | none | none |

The production worker uses its own outbox for current delivery. No G32 D1 ID
is bound; the G32 outbox remains separately consumed by the protected
production worker. No G32 resource was changed.

## Verification

Only documentation/evidence checks are in scope for W162. The retained raw
receipts are lossless and unchanged. No cohort, deployment, cleanup, or
behavior operation was repeated.
