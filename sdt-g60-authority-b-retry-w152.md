# SDT-G60 Authority-B retry — W152

Task: `SDT-G60-AUTHORITY-B-RETRY-W152`
Issue: SDT-G60 / #113
Branch: `claude/sdt-g60-clean-preg53-ab-w124`
Status: **blocked — the one fresh cohort did not meet the strict `<= 5,000 ms` contract**

This is the one authorized Authority-B continuation after W151. It made no
product-code change, opened no PR, and ran no second cohort. The W144 product
repair (`9eabe0458c59b89a96af56738063a94c6934a0ee`) and W125/W127 observation
code were deployed as already banked. The source deployed here was the exact
banked branch head `4cd0a602e51ba46d7857e8711ec3e0f92cad1bf2`, which contains
the current-main merge and the requested G60 commits:

| fact | value |
|---|---|
| branch/source head | `4cd0a602e51ba46d7857e8711ec3e0f92cad1bf2` |
| fetched `origin/main` | `16ac4f571e8cba1bd1d6469789cc38b93859336f` |
| `883d9eeb` in branch | present |
| `3e5954b8` in branch | present |
| `9eabe045` in branch | present |
| W152 evidence status | no PR; no worker completion transition |

## Wrangler and authorization hygiene

Before the first Wrangler invocation, only names and set state were inspected:

| name | state |
|---|---|
| `CLOUDFLARE_API_TOKEN` | `UNSET` |
| `CF_API_TOKEN` | `UNSET` |
| `CLOUDFLARE_API_KEY` | `UNSET` |
| `CF_API_KEY` | `UNSET` |
| `WRANGLER_API_TOKEN` | `UNSET` |

Every Wrangler invocation was run with all five names removed using `env -u`
at the outer command and, for the query scripts, again in the child process.
Wrangler was `4.125.0`. No `--keep-vars` was used. No conformance or
observability token was used; no secret value was inspected, printed, logged,
or committed.

The existing normal config was used:
`/Users/tomohisa/dev/GitHub/SekibanDcbTsImplementation/.g60-w124/samples/meeting-room/wrangler.cloudflare-only.jsonc`.
The existing resources were the only resources touched:

| resource | exact target |
|---|---|
| Worker | `sekiban-dcb-meeting-room-cloudflare-only` |
| pipeline D1 | `f26d1299-82d9-4a64-8647-bc2ec86326ac` (`D1`) |
| MV D1 | `b416b212-4d09-413c-9b8d-7660e475772f` (`D1_MV`) |
| Queue/DLQ | existing config bindings; not modified |

## Authority-B retry, schema prerequisite, and clean reset

The first W151 reset receipt had failed with Cloudflare code 7403. The single
W152 Authority-B retry used the stripped environment and reached the database,
but stopped before any delete at the existing-schema prerequisite:

```text
env -u CLOUDFLARE_API_TOKEN -u CF_API_TOKEN -u CLOUDFLARE_API_KEY -u CF_API_KEY -u WRANGLER_API_TOKEN node .artifacts/sdt-g60-w152-reset.mjs --variant W152-authority-b-retry --config /Users/tomohisa/dev/GitHub/SekibanDcbTsImplementation/.g60-w124/samples/meeting-room/wrangler.cloudflare-only.jsonc --wrangler /Users/tomohisa/dev/GitHub/SekibanDcbTsImplementation/node_modules/.bin/wrangler --report /Users/tomohisa/dev/GitHub/SekibanDcbTsImplementation/.g60-w124/.artifacts/sdt-g60-w152-reset.json
```

The receipt contains 20 attempted pre-counts: 19 succeeded, including
`serialized_dcb_hop_measurements=126`; the twentieth returned code 7500,
`no such table: serialized_dcb_hop_submeasurements`. No `DELETE` was issued
by that attempt, and no 7403 or OAuth failure recurred. The exact receipt is
[`.artifacts/sdt-g60-w152-reset.json`](.artifacts/sdt-g60-w152-reset.json),
SHA-256 `c597006927c1a0197d08b99745e7a715806a9cc4faacbe0f323ea87053be4340`.

Because W127 instrumentation cannot be measured without its already-bank­ed
schema, the existing D1 was brought to the required schema with the exact
`0007_g60_post_admission_decomposition.sql` migration. This was a schema
prerequisite on the existing resource, not a product repair or resource
creation. It succeeded and verified both tables. The complete receipt is
[`.artifacts/sdt-g60-w152-migration.json`](.artifacts/sdt-g60-w152-migration.json),
SHA-256 `2ff7398545bf85c9d8b8274e8a9e3b4cbb0bf6d3eb37757457b53e7913c17706`.

The clean reset then ran once against the now-valid schema. It issued 35
pre-counts, 35 explicit `DELETE FROM` statements, and 35 post-counts. It used
no `DROP` or DDL and did not touch the Queue, DLQ, `_cf_KV`, migration table,
or code/configuration.

| operational table group | representative pre-counts | post-reset result |
|---|---:|---:|
| `dcb_events`, `dcb_event_ops` | 52, 52 | 0, 0 |
| global receipts/memberships/event arrivals | 94, 94, 94 | 0, 0, 0 |
| projection checkpoints | 98 | 0 |
| pending arrivals | 24 | 0 |
| source partitions | 49 | 0 |
| G60 hop measurements | 126 | 0 |
| G60 hop submeasurements | 0 after migration | 0 |
| MV index/rows | 49, 49 | 0, 0 |
| MV wait receipts | 24 | 0 |
| MV unsafe arrivals/kicks/receipts | 2, 2, 24 | 0, 0, 0 |
| other data-bearing listed tables | existing rows | 0 |

`serialized_dcb_safe_lane_health` and `serialized_dcb_safe_lane_history`
returned one row each after the reset because scheduled maintenance ran while
the explicit reset was completing. `mv_active_generations` and `mv_instances`
retained their two structural rows. These expected runtime metadata rows do
not contain cohort events; all data-bearing rows, including both G60 ledgers,
were zero before deployment. The complete receipt is
[`.artifacts/sdt-g60-w152-reset-after-0007.json`](.artifacts/sdt-g60-w152-reset-after-0007.json),
SHA-256 `08b97d3b9ad992f865f294f1b50a358ec8a40eb5dfdc79caa1e30b124958fe64`.

The W152 reset script and all receipts were flushed after every command. The
positive authorization result is bounded: the stripped retry, migration,
reset writes, deployment, and ledger reads did not reproduce W151's 7403.
That does not establish the historical cause beyond the earlier transient or
database-specific classification.

## Exact deployment

The deployment used one `wrangler deploy` after a read-only before-list and
one read-only after-list. The exact wrapper command was:

```text
env -u CLOUDFLARE_API_TOKEN -u CF_API_TOKEN -u CLOUDFLARE_API_KEY -u CF_API_KEY -u WRANGLER_API_TOKEN node .artifacts/sdt-g60-w126-deploy.mjs --config /Users/tomohisa/dev/GitHub/SekibanDcbTsImplementation/.g60-w124/samples/meeting-room/wrangler.cloudflare-only.jsonc --wrangler /Users/tomohisa/dev/GitHub/SekibanDcbTsImplementation/node_modules/.bin/wrangler --report /Users/tomohisa/dev/GitHub/SekibanDcbTsImplementation/.g60-w124/.artifacts/sdt-g60-w152-deploy.json --source-commit 4cd0a602e51ba46d7857e8711ec3e0f92cad1bf2
```

| identity | value |
|---|---|
| deployment | `32c8f447-4b9d-4a6a-a683-f17599b8f420` |
| active version | `a1834409-5352-4c03-9010-f6bcc94911d6` |
| traffic | `100%` |
| source annotation | `SDT-G60 W126 durable hop 4cd0a602e51ba46d7857e8711ec3e0f92cad1bf2` |
| source identity | exact `4cd0a602e51ba46d7857e8711ec3e0f92cad1bf2` in annotation |
| created | `2026-09-04T12:24:00.004322Z` |

The complete deployment receipt is
[`.artifacts/sdt-g60-w152-deploy.json`](.artifacts/sdt-g60-w152-deploy.json),
SHA-256 `f4f8dc50656c0555c31c57ba68255f2a6bf2fdd43c742ba8a5d899cc805df768`.

## One fresh paced public cohort

Exactly one cohort was run after the clean reset and exact deployment. The
instrument used only the W116 public surface: create room, reserve room, and
fully paged `GET /api/read/reservations` with `pageSize=1000`. It did not call
read-health or conformance. The raw report was flushed at setup, every list
scan, every commit, and every completed sample.

```text
node .artifacts/sdt-g60-w124-public-cohort.mjs --variant W152-existing-production --source-commit 4cd0a602e51ba46d7857e8711ec3e0f92cad1bf2 --deployed-version-id a1834409-5352-4c03-9010-f6bcc94911d6 --base-url https://sekiban-dcb-meeting-room-cloudflare-only.ttakaoka.workers.dev --report /Users/tomohisa/dev/GitHub/SekibanDcbTsImplementation/.g60-w124/.artifacts/sdt-g60-w152-public-cohort.json --count 10 --pace-ms 10000 --page-size 1000 --poll-ms 1000 --bound-ms 120000
```

Run ID: `3cefa826-e013-4adc-b209-47067e8a116f`
Started: `2026-09-04T12:24:19.555Z`
Finished: `2026-09-04T12:34:19.873Z`
Room: `g15-room-3cefa826e0134adc`
Room SUID: `063924121461490000002090537074`

All ten room/reservation command responses were HTTP 200 committed responses.
The cold first sample was ordinal 1. The ten commit-to-next-commit-start
gaps were, after the cold first sample, `44231, 56239, 58964, 65006, 58884,
57685, 71305, 45407, 57653 ms`; minimum `44231 ms`, so the required 10-second
pacing was met.

| cohort measure | result |
|---|---:|
| n | 10 |
| observed | 10 |
| censored | 0 |
| p50, observed-only | 57,681 ms |
| p95, observed-only | 71,299 ms |
| strict count over 5,000 ms | **10/10** |
| count missing or censored | 0 |
| strict `<= 5,000 ms` AC3 | **failed** |

The complete raw public receipt, including every paged response, is
[`.artifacts/sdt-g60-w152-public-cohort.json`](.artifacts/sdt-g60-w152-public-cohort.json),
SHA-256 `19d3c1b1b045526515e612b6dca47e5fe998d5a09229f460bf4ff71a6b7a3b64`.

### Per-sample public and identity values

`commit response` is the public command response receipt. `public first at`
is the first fully paged list response containing that reservation.

| # | reservation | event ID | SUID | attempt ID | commit response ms | public first at ms | response→public ms | disposition |
|---:|---|---|---|---|---:|---:|---:|---|
| 1 | `...-1` | `01a06c60-8f8e-7923-80b2-25c16da3cc09` | `063924121463267000000483465867` | `c78d61a2-0e6c-42e5-b858-64bebaec3756` | 1788524663589 | 1788524707819 | 44230 | over-5000ms |
| 2 | `...-2` | `01a06c61-43e3-7cf4-867a-7ce31eefe54f` | `063924121509472000000307495840` | `6477748f-cb37-43b1-902f-8eb121cba3e0` | 1788524709917 | 1788524766155 | 56238 | over-5000ms |
| 3 | `...-3` | `01a06c62-2755-772f-bce9-401514afd690` | `063924121567851000001316288613` | `86b5d301-8c7d-4b9f-bb1f-2e9206d73c86` | 1788524768194 | 1788524827156 | 58962 | over-5000ms |
| 4 | `...-4` | `01a06c63-1728-7226-b7dd-bc7ae9787c13` | `063924121629095000001916233847` | `613436dc-d604-4eb7-b6a8-f40e71bb7cce` | 1788524829448 | 1788524894451 | 65003 | over-5000ms |
| 5 | `...-5` | `01a06c64-1cff-78a4-a06c-c7c11a76daf3` | `063924121696129000001745743566` | `fe5ff008-9aca-440f-ac48-a614e7867eb3` | 1788524896548 | 1788524955427 | 58879 | over-5000ms |
| 6 | `...-6` | `01a06c65-0fcd-7973-89a3-8db5e9fdbb7c` | `063924121758282000001381181007` | `edc1b6b7-08de-4e53-9eee-0b7eb5b7ccda` | 1788524958602 | 1788525016283 | 57681 | over-5000ms |
| 7 | `...-7` | `01a06c65-f7ae-7058-9209-bc5319055ae6` | `063924121817614000002015565100` | `284a7b7d-6232-46b8-85ce-7106c7c7c056` | 1788525017983 | 1788525089282 | 71299 | over-5000ms |
| 8 | `...-8` | `01a06c67-1554-73ce-ac4b-d053d6fc0a17` | `063924121890860000001282242838` | `c87e6790-8dea-4136-85b7-12646d1a3e0c` | 1788525092827 | 1788525138229 | 45402 | over-5000ms |
| 9 | `...-9` | `01a06c67-d420-71f7-833e-7e312c8bf94a` | `063924121939619000001266398904` | `d748502d-7cd6-4016-9b20-16c453e00e24` | 1788525139994 | 1788525197633 | 57639 | over-5000ms |
| 10 | `...-10` | `01a06c68-bd5f-7c43-91d0-b35b067ad57b` | `063924121999302000000852513363` | `5792aa46-b3a3-4ad2-a470-35e04ed41d61` | 1788525199650 | 1788525259867 | 60217 | over-5000ms |

The full reservation IDs are in the raw receipt and in the analysis JSON; the
`...-N` display is only a width reduction in this human table.

## Durable seven-hop timestamps

The pipeline query returned 240 exact-cohort rows: 120 original seven-hop
rows and 120 W127 submeasurement rows. Each event has 24 rows, one unique
`(SUID, attemptId)` identity, and no unresolved or ambiguous correlation.
The following table selects the reservation partition for the partitioned
stages; all room-partition rows remain in the raw ledger.

| # | command receipt | Tag append committed | outbox written | Queue send returned | consumer start | recordDelivery committed | first unsafe-visible read |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1788524662670 | 1788524663468 | 1788524663468 | 1788524663588 | 1788524665272 | 1788524665723 | 1788524707776 |
| 2 | 1788524708835 | 1788524709682 | 1788524709682 | 1788524709939 | 1788524714395 | 1788524714850 | 1788524766144 |
| 3 | 1788524767061 | 1788524768047 | 1788524768047 | 1788524768333 | 1788524770009 | 1788524770460 | 1788524827133 |
| 4 | 1788524828456 | 1788524829290 | 1788524829290 | 1788524829479 | 1788524834133 | 1788524834553 | 1788524894400 |
| 5 | 1788524895487 | 1788524896316 | 1788524896316 | 1788524896588 | 1788524900173 | 1788524900727 | 1788524955414 |
| 6 | 1788524957645 | 1788524958474 | 1788524958474 | 1788524958693 | 1788524960405 | 1788524960824 | 1788525016267 |
| 7 | 1788525017006 | 1788525017814 | 1788525017814 | 1788525017997 | 1788525020416 | 1788525020879 | 1788525089205 |
| 8 | 1788525090132 | 1788525091072 | 1788525091072 | 1788525091363 | 1788525094910 | 1788525095386 | 1788525138201 |
| 9 | 1788525138976 | 1788525139808 | 1788525139808 | 1788525140002 | 1788525145637 | 1788525146080 | 1788525197620 |
| 10 | 1788525198687 | 1788525199497 | 1788525199497 | 1788525199702 | 1788525201439 | 1788525201884 | 1788525259855 |

### Original adjacent-hop aggregates

Percentiles use nearest-rank over the paired persisted rows. Values are in
ordinal order.

| adjacent hop | n | p50 | p95 | values ms |
|---|---:|---:|---:|---|
| command receipt → Tag append committed | 10 | 829 | 986 | `798, 847, 986, 834, 829, 829, 808, 940, 832, 810` |
| Tag append committed → outbox written | 10 | 0 | 0 | `0, 0, 0, 0, 0, 0, 0, 0, 0, 0` |
| outbox written → Queue send returned | 10 | 205 | 291 | `120, 257, 286, 189, 272, 219, 183, 291, 194, 205` |
| Queue send returned → consumer invocation started | 10 | 2,419 | 5,635 | `1684, 4456, 1676, 4654, 3585, 1712, 2419, 3547, 5635, 1737` |
| consumer invocation started → recordDelivery committed | 10 | 451 | 554 | `451, 455, 451, 420, 554, 419, 463, 476, 443, 445` |
| recordDelivery committed → durable first unsafe-visible read | 10 | 54,687 | 68,326 | `42053, 51294, 56673, 59847, 54687, 55443, 68326, 42815, 51540, 57971` |

## W127 post-admission boundary timestamps and outcomes

All timestamps below are for the reservation partition. `—` means that the
durable boundary was absent; it is not zero and is not treated as a successful
or error outcome. The coverage end outcome was `BLOCK/UNSETTLED` for every
sample, so the detector and both unsafe-view apply stages did not record a
completed boundary for any sample.

| # | global receipt readback start → end | source Tag acknowledgement start → end | completeness start → end / outcome | detector start → end / outcome | RoomProjector apply start → end / outcome | ReservationProjector apply start → end / outcome |
|---:|---|---|---|---|---|---|
| 1 | `1788524665723 → 1788524665771` (48 ms, available) | `1788524665771 → 1788524665875` (104 ms, acknowledged) | `1788524665875 → 1788524665921` (46 ms, BLOCK/UNSETTLED) | `—` | `—` | `—` |
| 2 | `1788524714850 → 1788524714892` (42 ms, available) | `1788524714892 → 1788524715121` (229 ms, acknowledged) | `1788524715121 → 1788524715162` (41 ms, BLOCK/UNSETTLED) | `—` | `—` | `—` |
| 3 | `1788524770460 → 1788524770498` (38 ms, available) | `1788524770498 → 1788524770779` (281 ms, acknowledged) | `1788524770779 → 1788524770829` (50 ms, BLOCK/UNSETTLED) | `—` | `—` | `—` |
| 4 | `1788524834553 → 1788524834589` (36 ms, available) | `1788524834589 → 1788524834680` (91 ms, acknowledged) | `1788524834680 → 1788524834718` (38 ms, BLOCK/UNSETTLED) | `—` | `—` | `—` |
| 5 | `1788524900727 → 1788524900771` (44 ms, available) | `1788524900771 → 1788524901025` (254 ms, acknowledged) | `1788524901025 → 1788524901065` (40 ms, BLOCK/UNSETTLED) | `—` | `—` | `—` |
| 6 | `1788524960824 → 1788524960862` (38 ms, available) | `1788524960862 → 1788524960953` (91 ms, acknowledged) | `1788524960953 → 1788524960988` (35 ms, BLOCK/UNSETTLED) | `—` | `—` | `—` |
| 7 | `1788525020879 → 1788525020921` (42 ms, available) | `1788525020921 → 1788525021007` (86 ms, acknowledged) | `1788525021007 → 1788525021046` (39 ms, BLOCK/UNSETTLED) | `—` | `—` | `—` |
| 8 | `1788525095386 → 1788525095457` (71 ms, available) | `1788525095457 → 1788525095675` (218 ms, acknowledged) | `1788525095675 → 1788525095725` (50 ms, BLOCK/UNSETTLED) | `—` | `—` | `—` |
| 9 | `1788525146080 → 1788525146125` (45 ms, available) | `1788525146125 → 1788525146340` (215 ms, acknowledged) | `1788525146340 → 1788525146383` (43 ms, BLOCK/UNSETTLED) | `—` | `—` | `—` |
| 10 | `1788525201884 → 1788525201933` (49 ms, available) | `1788525201933 → 1788525202152` (219 ms, acknowledged) | `1788525202152 → 1788525202195` (43 ms, BLOCK/UNSETTLED) | `—` | `—` | `—` |

| post-admission interval | n | missing | p50 | p95 | values ms |
|---|---:|---:|---:|---:|---|
| recordDelivery → global readback start | 10 | 0 | 0 | 0 | `0, 0, 0, 0, 0, 0, 0, 0, 0, 0` |
| global readback start → end | 10 | 0 | 42 | 71 | `48, 42, 38, 36, 44, 38, 42, 71, 45, 49` |
| source Tag acknowledgement start → end | 10 | 0 | 215 | 281 | `104, 229, 281, 91, 254, 91, 86, 218, 215, 219` |
| completeness start → end | 10 | 0 | 41 | 50 | `46, 41, 50, 38, 40, 35, 39, 50, 43, 43` |
| detector start → end | 0 | 10 | — | — | no rows |
| RoomProjector apply start → end | 0 | 10 | — | — | no rows |
| ReservationProjector apply start → end | 0 | 10 | — | — | no rows |
| recordDelivery → durable first unsafe read | 10 | 0 | 54,687 | 68,326 | `42053, 51294, 56673, 59847, 54687, 55443, 68326, 42815, 51540, 57971` |
| recordDelivery → public first visibility | 10 | 0 | 54,700 | 68,403 | `42096, 51305, 56696, 59898, 54700, 55459, 68403, 42843, 51553, 57983` |

## MV provenance and dominant interval

The MV query returned 10 exact ReservationProjector `mv_rows`, each with the
cohort SUID as `source_suid`, version 1, and the expected reserved value. It
returned zero matching `mv_unsafe_receipts` and zero matching
`mv_unsafe_rows`. The complete raw MV query is
[`.artifacts/sdt-g60-w152-mv.json`](.artifacts/sdt-g60-w152-mv.json),
SHA-256 `793491b682cd146714068a8dff961f8eb4403bb51282b45e12dce7bc95a0a696`.

| # | view | row key | source SUID | value JSON |
|---:|---|---|---|---|
| 1 | ReservationProjector | `g15-reservation-3cefa826e0134adc-1` | `063924121463267000000483465867` | `{"reservationId":"g15-reservation-3cefa826e0134adc-1","roomId":"g15-room-3cefa826e0134adc","status":"reserved","version":1}` |
| 2 | ReservationProjector | `g15-reservation-3cefa826e0134adc-2` | `063924121509472000000307495840` | `{"reservationId":"g15-reservation-3cefa826e0134adc-2","roomId":"g15-room-3cefa826e0134adc","status":"reserved","version":1}` |
| 3 | ReservationProjector | `g15-reservation-3cefa826e0134adc-3` | `063924121567851000001316288613` | `{"reservationId":"g15-reservation-3cefa826e0134adc-3","roomId":"g15-room-3cefa826e0134adc","status":"reserved","version":1}` |
| 4 | ReservationProjector | `g15-reservation-3cefa826e0134adc-4` | `063924121629095000001916233847` | `{"reservationId":"g15-reservation-3cefa826e0134adc-4","roomId":"g15-room-3cefa826e0134adc","status":"reserved","version":1}` |
| 5 | ReservationProjector | `g15-reservation-3cefa826e0134adc-5` | `063924121696129000001745743566` | `{"reservationId":"g15-reservation-3cefa826e0134adc-5","roomId":"g15-room-3cefa826e0134adc","status":"reserved","version":1}` |
| 6 | ReservationProjector | `g15-reservation-3cefa826e0134adc-6` | `063924121758282000001381181007` | `{"reservationId":"g15-reservation-3cefa826e0134adc-6","roomId":"g15-room-3cefa826e0134adc","status":"reserved","version":1}` |
| 7 | ReservationProjector | `g15-reservation-3cefa826e0134adc-7` | `063924121817614000002015565100` | `{"reservationId":"g15-reservation-3cefa826e0134adc-7","roomId":"g15-room-3cefa826e0134adc","status":"reserved","version":1}` |
| 8 | ReservationProjector | `g15-reservation-3cefa826e0134adc-8` | `063924121890860000001282242838` | `{"reservationId":"g15-reservation-3cefa826e0134adc-8","roomId":"g15-room-3cefa826e0134adc","status":"reserved","version":1}` |
| 9 | ReservationProjector | `g15-reservation-3cefa826e0134adc-9` | `063924121939619000001266398904` | `{"reservationId":"g15-reservation-3cefa826e0134adc-9","roomId":"g15-room-3cefa826e0134adc","status":"reserved","version":1}` |
| 10 | ReservationProjector | `g15-reservation-3cefa826e0134adc-10` | `063924121999302000000852513363` | `{"reservationId":"g15-reservation-3cefa826e0134adc-10","roomId":"g15-room-3cefa826e0134adc","status":"reserved","version":1}` |

For every one of the ten over-bound samples, the largest measured interval was
the `recordDelivery committed → public first visibility` residual (the
corresponding durable first-unsafe interval was also 42,053–68,326 ms). The
per-sample residuals were `42096, 51305, 56696, 59898, 54700, 55459, 68403,
42843, 51553, 57983 ms`.

This is not a named causal sub-hop. The instrumented global readback, Tag
acknowledgement, and completeness spans were short; completeness ended in
`BLOCK/UNSETTLED` for all ten, and no detector or view-apply completion rows
were recorded. Therefore the durable rows cannot name whether a detector,
view apply, later retry, or public-read path accounts for the residual. It
would be incorrect to attribute it to Queue delivery or any other specific
stage. The honest dominant classification is **unattributed post-recordDelivery
residual / missing downstream completion boundaries**. Observer perturbation is
unproven because this was one instrumented cohort with no matched control.

The compact machine-readable analysis is
[`.artifacts/sdt-g60-w152-analysis.json`](.artifacts/sdt-g60-w152-analysis.json),
SHA-256 `1d0d234ff6f806c6ec911a733301e7b03614d2784871e619012454192d31b2c5`.
The raw pipeline ledger is
[`.artifacts/sdt-g60-w152-ledger.json`](.artifacts/sdt-g60-w152-ledger.json),
SHA-256 `1f9cb9681154c7be58e6a5f2ba192b7c5f497bbb1f1b6ebf8774a7682de50257`.

## Disposition and boundaries

The one cohort is a strict AC3 failure: all ten public samples exceeded the
unchanged 5,000 ms bound. No further repair, deployment, cohort, PR, or worker
transition is authorized by this checkpoint. The W144 local repair remains the
only G60 product change. The pre-G53 A/B comparison remains deferred/open.

No outbox/Queue/global-admission behavior beyond the already-banked W144
repair was changed. The 5,000 ms contract, ordering, durability, fences,
G53 naming, G55 reads, G58 behavior, G56 hold, G62 state, and G61 state remain
unchanged. This result should route the next bounded decision to the
unattributed post-recordDelivery/coverage-starvation evidence gap; it does not
authorize a speculative lever.

## Evidence receipt hashes

| receipt | SHA-256 |
|---|---|
| `.artifacts/sdt-g60-w152-reset.json` | `c597006927c1a0197d08b99745e7a715806a9cc4faacbe0f323ea87053be4340` |
| `.artifacts/sdt-g60-w152-migration.json` | `2ff7398545bf85c9d8b8274e8a9e3b4cbb0bf6d3eb37757457b53e7913c17706` |
| `.artifacts/sdt-g60-w152-reset-after-0007.json` | `08b97d3b9ad992f865f294f1b50a358ec8a40eb5dfdc79caa1e30b124958fe64` |
| `.artifacts/sdt-g60-w152-deploy.json` | `f4f8dc50656c0555c31c57ba68255f2a6bf2fdd43c742ba8a5d899cc805df768` |
| `.artifacts/sdt-g60-w152-public-cohort.json` | `19d3c1b1b045526515e612b6dca47e5fe998d5a09229f460bf4ff71a6b7a3b64` |
| `.artifacts/sdt-g60-w152-ledger.json` | `1f9cb9681154c7be58e6a5f2ba192b7c5f497bbb1f1b6ebf8774a7682de50257` |
| `.artifacts/sdt-g60-w152-mv.json` | `793491b682cd146714068a8dff961f8eb4403bb51282b45e12dce7bc95a0a696` |
| `.artifacts/sdt-g60-w152-analysis.json` | `1d0d234ff6f806c6ec911a733301e7b03614d2784871e619012454192d31b2c5` |
