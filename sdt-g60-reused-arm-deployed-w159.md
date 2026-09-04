# SDT-G60 reused-arm deployed proof — W159

Task: `SDT-G60-REUSED-ARM-DEPLOYED-W159`
Issue: SDT-G60 / #113
Branch: `claude/sdt-g60-clean-preg53-ab-w124`
Source: `6481ddf4285b5bd71b576aee4a02e0605fb102b1`
W157 repair carried: `84892e5bd5233de9c12f07dffb12b28e08bee00e`

## Deployed result

The one authorized W159 reused-arm cohort passed the strict contract: `n=10`,
observed `10`, censored `0`, p50 `189 ms`, p95 `337 ms`, and strict
`>5000 ms = 0/10`. The cold first sample was included. No tuning, second
cohort, new resource, or production operation was performed. All reservations
became visible on the fully paged public reservations read within 5,000 ms of
their command response.

The complete evidence is [`docs/SDT-G60-evidence.md`](docs/SDT-G60-evidence.md).
The raw receipts and identity-preserving analysis are:

- [`public cohort`](.artifacts/sdt-g60-w159-public-cohort.json), run
  `1a60e4cd-d573-4c22-a0a5-b398cb28e101`;
- [`seven-hop ledger`](.artifacts/sdt-g60-w159-ledger.json);
- [`MV provenance`](.artifacts/sdt-g60-w159-mv.json);
- [`analysis`](.artifacts/sdt-g60-w159-analysis.json).

## Exact arm and identity

| field | value |
|---|---|
| Worker/service | `sekiban-dcb-g60-w131-c` |
| pipeline D1 | `b03270df-9698-4a9e-94c6-c2c5726f106d` |
| MV D1 | `616dd377-42f3-49f7-b373-a1a07cedf2b3` |
| Queue / DLQ | `sekiban-dcb-g60-w131-c-outbox` / `sekiban-dcb-g60-w131-c-outbox-dlq` |
| final active version | `e2c870ee-3f3d-404d-96b1-bc480a96dda5` |
| deployment | `65dcb2f4-5aa4-40ad-9bbf-668537b6bb71` |
| traffic | 100% |
| source annotation | `SDT-G60 W159 exact 6481ddf4285b5bd71b576aee4a02e0605fb102b1 product 84892e5bd5233de9c12f07dffb12b28e08bee00e fence ce80a2a5d31fe0e74c8d488ee0d95af3e537bf0981252020ce6b22fcf62ec857` |

The existing W131-C resources were reused; no resource create or
`d1 migrations apply` was used. Missing 0008 schema objects were installed
through the repository runtime schema path and verified. Pipeline operational
rows and transient MV rows were reset under C-0/C-13 while MV instance
metadata was retained. The fresh fence secret came from a private mode-600
file; only fingerprint
`ce80a2a5d31fe0e74c8d488ee0d95af3e537bf0981252020ce6b22fcf62ec857` is
recorded. All five recognized Wrangler credential names were `UNSET` for every
Wrangler receipt, no `--keep-vars` was used, and no secret value is in the
evidence.

The secret-only publication made an unannotated version
`db71294f-3dae-476b-944f-206d98b6083c`; the one authorized unchanged
exact-source deploy produced the final annotated version above. No deploy loop
occurred.

## Cohort and durable hop result

The public instrument used G15/G16 create-room and reserve-room requests and
fully paged `GET /api/read/reservations` with page size 1,000. No conformance
health endpoint or conformance token was used. Timing is command response to
the first public list observation containing the reservation ID. Setup-room
elapsed time was 6,197 ms and is not part of the reservation distribution.

| # | reservation | event ID | SUID | commit ms | response→public ms | result |
|---:|---|---|---|---:|---:|---|
| 1 (cold) | `g15-reservation-1a60e4cdd5734c22-1` | `01a06e0d-69fa-7715-ad1f-eaf6991bdaee` | `063924149568195000001705026963` | 2,742 | 198 | within |
| 2 | `g15-reservation-1a60e4cdd5734c22-2` | `01a06e0d-9bbe-7105-aa78-5d5021e57b05` | `063924149580934000000406340974` | 2,872 | 226 | within |
| 3 | `g15-reservation-1a60e4cdd5734c22-3` | `01a06e0d-ce2e-7ee7-851a-2bdc9a107dbb` | `063924149593889000000968970887` | 3,094 | 137 | within |
| 4 | `g15-reservation-1a60e4cdd5734c22-4` | `01a06e0e-020e-7907-bacf-23b27d69f537` | `063924149607182000001635336287` | 3,192 | 168 | within |
| 5 | `g15-reservation-1a60e4cdd5734c22-5` | `01a06e0e-367b-74ae-ab41-2fb4fcc905b6` | `063924149620624000001233170953` | 3,971 | 166 | within |
| 6 | `g15-reservation-1a60e4cdd5734c22-6` | `01a06e0e-6be4-7e3a-94f3-759c601982d3` | `063924149634239000001916402820` | 3,443 | 189 | within |
| 7 | `g15-reservation-1a60e4cdd5734c22-7` | `01a06e0e-a049-763e-944b-46c97caf7d47` | `063924149647696000000495280147` | 3,486 | 337 | within |
| 8 | `g15-reservation-1a60e4cdd5734c22-8` | `01a06e0e-d598-7edf-b26f-bffedfe6b69f` | `063924149661470000000226411998` | 3,563 | 207 | within |
| 9 | `g15-reservation-1a60e4cdd5734c22-9` | `01a06e0f-0aa3-76d7-9b37-dd382e457a92` | `063924149675073000002009964515` | 3,844 | 187 | within |
| 10 | `g15-reservation-1a60e4cdd5734c22-10` | `01a06e0f-403c-7019-b705-abc644aaed08` | `063924149689043000002023902206` | 3,460 | 202 | within |

There were no censored, missing, or ambiguous public rows. Every adjacent
reservation commit was paced at least ten seconds after the preceding commit
response, and the cold first sample was retained.

The original ledger has 160 rows: command receipt 10, Tag append 20, outbox
obligation 20, Queue send 20, consumer starts 40, recordDelivery commits 40,
and public first-unsafe reads 10. Representative intervals are:

| interval | n | p50 | p95 | >5000 |
|---|---:|---:|---:|---:|
| command receipt → last Tag append | 10 | 331 ms | 740 ms | 0/10 |
| last Tag append → outbox obligation | 10 | 0 ms | 0 ms | 0/10 |
| last outbox obligation → Queue send | 10 | 1,532 ms | 1,895 ms | 0/10 |
| fast consumer → fast recordDelivery | 20 | 458 ms | 707 ms | 0/20 |
| Queue send → Queue consumer | 20 | 3,473 ms | 7,116 ms | 8/20 |
| Queue consumer → Queue recordDelivery | 20 | 498 ms | 641 ms | 0/20 |
| last fast recordDelivery → public read | 10 | 1,268 ms | 1,552 ms | 0/10 |
| command response → public unsafe read | 10 | 189 ms | 337 ms | 0/10 |

The eight Queue partition intervals above 5,000 ms were later replay
intervals; direct unsafe visibility was already complete and no public sample
failed the contract.

## Post-admission and unsafe-writer tables

All expected W127 start/end pairs were present and identity-correlated. The
full row data is in the linked ledger and analysis receipts.

| boundary | fast n/p50/p95 | Queue n/p50/p95 |
|---|---|---|
| global-receipt readback | 20 / 74 / 106 ms | 20 / 85 / 145 ms |
| source Tag acknowledgement | 20 / 109 / 330 ms | 20 / 135 / 267 ms |
| completeness coverage | 20 / 83 / 176 ms | 20 / 95 / 150 ms |
| detector | 0 / — / — | 6 / 228 / 846 ms |
| unsafe-view apply | 40 / 309 / 572 ms | 40 / 157 / 403 ms |

Unsafe writer rows prove the independent direct lane and later replay:

| path/view | n | p50 | p95 | outcome |
|---|---:|---:|---:|---|
| inline direct / ReservationProjector | 10 | 71 ms | 84 ms | 10 applied |
| inline direct / RoomProjector | 10 | 85 ms | 210 ms | 10 no-change |
| later Queue / ReservationProjector | 10 | 73 ms | 241 ms | 10 duplicate-race |
| later Queue / RoomProjector | 10 | 35 ms | 52 ms | 10 duplicate-race |

All ten direct ReservationProjector applies occurred while fast completeness
ended `BLOCK/UNSETTLED`. The later Queue envelope neither double-applied nor
regressed either view. MV evidence contains ten unsafe receipts, ten
ReservationProjector safe rows, zero remaining unsafe rows, zero unsafe
failures, and final active checkpoints at SUID
`063924149689043000002023902206`.

## Guard and gate disposition

W157/W153 pre-change red receipts and omission/old-gated mutants remain
preserved. W159 reran green focused receipts for the durable seven-hop,
post-admission, Queue-latency, and unsafe-writer guards; identity, omission,
reorder, old waitUntil-only, and boundary mutants remain red. The complete
local receipt records 23 successful commands, including G15/G16, G26, G41,
G44, G49, G51, G52, G53, G54, G55, G58, G61, G62, D1, G60 focused lanes,
typecheck, lint, and diff check. G44 is unchanged and green.

The first provable relevant completeness-gating landing remains G62 commit
`05d9d27` / PR #119. The unsafe writer originated in G26 `f7b257b`; this is a
first-provable-history statement, not a stronger causality claim.

The W131-C arm is marked reusable and remains named/intact. Production and
W130 resources remain untouched. G56 remains held and no new downstream unit
was started. This evidence checkpoint is ready for issue/PR completion.
