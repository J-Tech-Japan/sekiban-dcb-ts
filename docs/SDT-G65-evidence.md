# SDT-G65 deployed acceptance evidence — W138-2

Task: `SDT-G65-PR127-DEPLOYED-ACCEPTANCE-2-WAKE-138`
PR: `J-Tech-Japan/sekiban-dcb-ts#127`
Requested exact head: `5edfd6413b1ff446e6f7475eef18c947b0ca93fe`
Branch: `claude/sdt-g65-local-wake-w128`
Arm: `sekiban-dcb-g60-w155-c`

## Disposition

**Blocked.** The fresh matched same-arm cohorts completed, but each had one
safe-bound miss and one unsafe sample over the unchanged 5,000 ms contract.
The deployed version view proved the actual `DOWNSTREAM_DOORBELL` service
binding and `DIRECT_DOORBELL=true`; nevertheless all post-cohort unsafe-writer
rows were `transport=queue`, so direct transport and healthy direct admission
were not proven. The configured-store first-write typed refusal remains
unproven because the safe existing-resource failure shapes were classified as
explicitly unconfigured and committed the new event.

No source, fixture, workflow, gate, PR state, issue claim, resource, migration,
or production worker outside the authorized W155-C arm was changed. The final
arm state was restored to the normal exact-head configuration.

## Hygiene and resource boundary

Every Wrangler command stripped these five names, which were all `UNSET` in the
seat environment: `CLOUDFLARE_API_TOKEN`, `CF_API_TOKEN`,
`CLOUDFLARE_API_KEY`, `CF_API_KEY`, and `WRANGLER_API_TOKEN`. No
`--keep-vars` was used. Conformance was supplied only through the private
`G53_CONFORMANCE_TOKEN_FILE` path; no token value was recorded.

| Resource | Identity |
| --- | --- |
| Worker | `sekiban-dcb-g60-w155-c` |
| Pipeline D1 | `ac751211-fde8-4587-9d56-1e9fd8051bc3` |
| MV D1 | `2b60dbcf-0912-4bb2-93aa-77c26cd260e1` |
| Queue / DLQ | `sekiban-dcb-g60-w155-c-outbox` / `sekiban-dcb-g60-w155-c-outbox-dlq` |

The only data mutation was the authorized schema-preserving DELETE reset before
the two matched cohorts. No migration, resource create, or resource delete was
performed. The C-0 variants reused the same existing resources.

## Version and binding proof

The baseline was deployed from the prior W138 pre-change source
`a8bb1bd493591081c24a52239c1b0e2dce2c42e1`:

| Role | Deployment | Version | Traffic | Annotation |
| --- | --- | --- | ---: | --- |
| Baseline | `2e8f0e2d-743e-4d91-8cf3-5ae2e498dc72` | `7c2a8b6e-1866-4f70-b611-0c892abf45b3` | 100% | `SDT-G65 W136 restore normal D1 exact a8bb1bd493591081c24a52239c1b0e2dce2c42e1 DIRECT_DOORBELL=true after C-0` |
| Post | `6fb3e84b-b73f-465e-b0eb-b09c1eadaa2d` | `1ce0c81b-61d0-4670-b85e-a02c06a62ab0` | 100% | `SDT-G65 W138-2 post-change exact 5edfd6413b1ff446e6f7475eef18c947b0ca93fe DIRECT_DOORBELL=true` |
| Final restore | `3077a46c-8e46-4c54-a2b1-8f33dfeaf418` | `f2964bb7-91eb-470d-ab7e-3bbb80fc52ea` | 100% | `SDT-G65 W138-2 final restore normal exact 5edfd6413b1ff446e6f7475eef18c947b0ca93fe DIRECT_DOORBELL=true` |

The exact post and final version views, not local configuration, contained:

```text
DIRECT_DOORBELL=true
DOWNSTREAM_DOORBELL=sekiban-dcb-meeting-room-doorbell#MeetingRoomDownstreamDoorbell
D1=ac751211-fde8-4587-9d56-1e9fd8051bc3
D1_MV=2b60dbcf-0912-4bb2-93aa-77c26cd260e1
```

## Cohorts

Both used `node .artifacts/g65-w128-cohort.mjs`, cold first sample, n=10,
at least 10 seconds after each preceding commit response, and fully paged
`GET /api/read/reservations`. Timing uses observed client fetch and durable
ledger `Date.now` epoch milliseconds only; authored `dcb_events.Timestamp` and
caller `received_at` are excluded.

| Metric | Baseline (`a8bb1bd`) | Post (`5edfd64`) |
| --- | ---: | ---: |
| Window | 21:56:27.674Z–22:01:39.051Z | 22:03:31.015Z–22:08:46.392Z |
| n | 10 | 10 |
| Response p50 / p95 | 2,579 / 2,992 ms | 2,824 / 3,610 ms |
| Response p95 delta | — | +618 ms, misses +150 ms |
| Response p50 delta | — | +245 ms, within 400 ms stated allowance |
| HTTP 504 | 0 | 0 |
| Unsafe p50 / p95 | 2,388 / 117,117 ms | 2,582 / 43,783 ms |
| Strict unsafe over 5,000 ms | 1/10 | 1/10 |
| Safe final-head p50 / p95 | 127,915 / 191,178 ms | 120,479 / 187,018 ms |
| Safe over 180,000 ms | 1/10 | 1/10 |
| Admission header | `unknown` 10/10 | `unknown` 10/10 |

All ten post samples eventually reached both final projector heads and all 11
cohort tag-state reads returned committed version 1. Sample 1 reached its
final head at 187,018 ms; the baseline sample 1 reached its final head at
191,178 ms. Both are real safe-bound misses.

| # | Baseline response / unsafe / safe (ms) | Post response / unsafe / safe (ms) |
| ---: | --- | --- |
| 1 | 2,579 / 117,117* / 191,178* | 3,030 / 4,764 / 187,018* |
| 2 | 2,537 / 4,362 / 178,535 | 3,479 / 2,405 / 173,184 |
| 3 | 2,518 / 2,323 / 166,016 | 3,495 / 2,424 / 159,687 |
| 4 | 2,478 / 2,290 / 153,536 | 2,773 / 2,482 / 146,913 |
| 5 | 2,992 / 4,314 / 140,543 | 2,714 / 4,565 / 134,196 |
| 6 | 2,626 / 4,460 / 127,915 | 3,610 / 2,519 / 120,479 |
| 7 | 2,563 / 2,380 / 115,351 | 2,824 / 43,783* / 107,654 |
| 8 | 2,773 / 2,290 / 102,577 | 2,950 / 2,582 / 94,703 |
| 9 | 2,763 / 4,332 / 89,812 | 2,654 / 4,761 / 82,046 |
| 10 | 2,750 / 2,388 / 77,060 | 2,619 / 4,569 / 69,205 |

`*` is a strict acceptance miss. The pre raw cohort is preserved, but its
durable rows were deleted by the required clean reset before the post cohort;
pre admission duration and pre durable sub-hop values are therefore **not
available** and are not inferred.

## Post durable hop table

The exact post ledger has 10/10 reservation admission attempts, all
`outcome=unknown`, duration p50/p95 `300/300 ms`, and no
`global_completion_observed_at`.

| Boundary | n / p50 / p95 (ms) |
| --- | ---: |
| Command receipt → Tag append | 10 / 1,050 / 1,350 |
| Tag append → outbox obligation | 10 / 0 / 0 |
| Outbox obligation → Queue send | 10 / 664 / 792 |
| Queue send → consumer start | 10 / 2,823 / 4,924 |
| Consumer start → recordDelivery | 10 / 748 / 1,232 |
| recordDelivery → ledger unsafe read | 10 / -268 / 7,567 |
| recordDelivery → public unsafe read | 10 / -230 / 38,241 |
| Global receipt readback | 10 / 123 / 268 |
| Source Tag acknowledgement | 10 / 182 / 1,825 |
| Completeness coverage | 10 / 109 / 130 |
| Detector | 3 / 274 / 352 (three paired spans) |
| Room unsafe-view apply | 10 / 73 / 365 |
| Reservation unsafe-view apply | 10 / 69 / 351 |
| Unsafe-writer Room boundary | 10 / 57 / 137 |
| Unsafe-writer Reservation boundary | 10 / 61 / 71 |

All 20 post unsafe-writer rows were `transport=queue` and
`writer_path=inline-delivery`; no direct transport row was observed. The short
apply spans therefore do not prove a direct-doorbell contribution or healthy
direct admission. Samples 1–7 are dominated by the recordDelivery-to-public
read residual; the 43,783 ms unsafe sample is the clearest case.

## C-0 D1-unavailable proof

The corrected no-D1 variant was version
`a7b897a4-b52d-4e9b-8940-595acae4b9d3`, deployment
`ad9c3114-773a-4e1d-b1e4-4e0aaa07d94c`, 100%, with the real doorbell and only
`D1_MV` bound:

| Case | Public result and recovery |
| --- | --- |
| Existing `reservation:g65-reservation-bed4c234-69b-1` | HTTP 200 `committed`, `not-admitted`, event `01a073a0-8439-73c4-9d83-aebf8c2b6bd2`; after restore one receipt, obligation 2 |
| New `room:g65-w138-unconfigured-w138-2-new-c0u2` | HTTP 200 `committed`, no typed refusal, event `01a073a0-8faa-7964-a486-951f8930bf3e`; after restore one receipt, obligation 1 |

The bound-MV variant was version `51dfe001-d60e-4dde-bb1a-4f13564c35eb`,
deployment `111b8a59-f88e-490b-99b8-dac3391a6174`, with both D1 names bound to
the existing MV ID and the real doorbell. Existing reservation 2 returned
HTTP 200/not-admitted, event `01a073a1-c839-7671-b55d-afa697ca0c46`; its new
room returned HTTP 200, event `01a073a1-d202-7868-8089-08cc8d5ee356`. The
recovery query found exactly one global receipt for each of these four events.

The MV lacks the authoritative G44 completeness schema, so this is explicitly
unconfigured at runtime. The configured-store HTTP 503
`partition_registration_unavailable` with zero event writes remains
**unproven**, not passed or manufactured.

## Receipts

The raw JSON files are ignored and retained. Gzip SHA-256 values:

| Receipt | SHA-256 |
| --- | --- |
| `sdt-g65-w138-2-pre-change-cohort.json.gz` | `d780cca4020e724fce9b0554ab37d7bb23b9bb2425686d22abd56eeced5e0c91` |
| `sdt-g65-w138-2-post-change-cohort.json.gz` | `fae3a4bfd088aeb749a7a909b7bcd7801b7657b2b3e6a628389ef16c35956326` |
| `sdt-g65-w138-2-pre-change-ledger.json.gz` | `9ad61ab9271e00b53f796d708ac10d179a5fd58db64c6f533321ccc136383520` |
| `sdt-g65-w138-2-post-change-ledger.json.gz` | `507392e19220772f6a5deed0807c1ec479127b8dfbaedde492ed89d7885aa99e` |
| `sdt-g65-w138-2-c0-unconfigured-public.json.gz` | `86ae2e154a23354ff48419026e9ba1e007c16a085e71555d08412c0d070e7581` |
| `sdt-g65-w138-2-c0-configured-failure-public.json.gz` | `41088396b2131f1a9c7dcdc0bcbee4f2f1f5df5eada79d7137e118b4e58825c6` |
| `sdt-g65-w138-2-c0-recovery-ledger.json.gz` | `b6a3bae4eb0f91b9b1ebf7e121161a32a0b53b80fd5c0656db5d794928de26d2` |
| `sdt-g65-w138-2-analysis.json.gz` | `3deff5636d3f444f4b3aab1b68641603f65347fc10d9ba8376f60d68cdebea6c` |

Lossless verification:

```sh
gzip -dc .artifacts/sdt-g65-w138-2-post-change-cohort.json.gz > /tmp/sdt-g65-w138-2-post-change-cohort.json
cmp -s /tmp/sdt-g65-w138-2-post-change-cohort.json .artifacts/sdt-g65-w138-2-post-change-cohort.json
```

The complete deployment/version/reset/C-0/cohort/ledger receipts and compact
analysis are the corresponding `.artifacts/sdt-g65-w138-2-*` files.
