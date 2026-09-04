# SDT-G60 fresh unsafe proof — W155

Task: `SDT-G60-FRESH-UNSAFE-PROOF-W155`
Issue: SDT-G60 / #113
Branch: `claude/sdt-g60-clean-preg53-ab-w124`
Starting W154 head: `012fd7beffdeb2aaddb45b56252533d45066b5b2`
Deployed source: `31ca80dbbde5b7537ebb804e62cd14c30bfe5bcf` (W153 repair)
Status: **blocked for the strict 5,000 ms proof; fresh deployment and writer-path proof complete**

This was one WAKE-120 Route One deployment and one fresh cohort on a newly
isolated arm. No existing production or W130 resource was touched. W155 made
no product, test, configuration, PR, or repair change. The fresh arm proves
that W153's independent unsafe writer runs under a completeness `BLOCK`, but
it does not prove the unchanged unsafe contract: five of ten public reads were
strictly over 5,000 ms. No second cohort, further repair, deployment, or PR was
attempted.

## Fresh arm and credential hygiene

The throwaway resources were created and then left named and abandoned for
evidence preservation:

| resource | exact value |
|---|---|
| Worker | `sekiban-dcb-g60-w155-c` |
| Worker URL | `https://sekiban-dcb-g60-w155-c.ttakaoka.workers.dev` |
| `SDT_SERVICE_ID` | `sekiban-dcb-g60-w155-c` |
| pipeline D1 | `sekiban-dcb-g60-w155-c-pipeline` / `ac751211-fde8-4587-9d56-1e9fd8051bc3` |
| MV D1 | `sekiban-dcb-g60-w155-c-mv` / `2b60dbcf-0912-4bb2-93aa-77c26cd260e1` |
| outbox Queue | `sekiban-dcb-g60-w155-c-outbox` |
| DLQ | `sekiban-dcb-g60-w155-c-outbox-dlq` |
| G32 fence fingerprint | `6e1cf1c9454d5eb7a184265b56fcd2a369cf58cd7ff78be1011636c1f87023ed` |
| fence phase/release | `final-g32` / `after-new-bindings` |

The fence token was generated only in the private file
`/private/tmp/sdt-g60-w155-fence.kwe7X2/token` (mode `600`), supplied by stdin
to `secret put`, and never printed, logged, committed, or reused. Only the
fingerprint is present in the ignored config and deployment evidence.

All five recognized Wrangler credential variable names were **UNSET** for
every W155 Wrangler receipt: `CLOUDFLARE_API_TOKEN`, `CF_API_TOKEN`,
`CLOUDFLARE_API_KEY`, `CF_API_KEY`, and `WRANGLER_API_TOKEN`. The receipts use
Wrangler `4.125.0`, strip all five names in the child process, and record
`noKeepVars: true`. No conformance or observability credential was used by the
public instrument. No Cloudflare authorization failure occurred, so the
WAKE-108 classifier was not invoked.

## Provisioning, migrations, and clean reset

Provisioning receipts are preserved in:

- [`sdt-g60-w155-create-pipeline.json`](.artifacts/sdt-g60-w155-create-pipeline.json)
- [`sdt-g60-w155-create-mv.json`](.artifacts/sdt-g60-w155-create-mv.json)
- [`sdt-g60-w155-create-outbox-queue.json`](.artifacts/sdt-g60-w155-create-outbox-queue.json)
- [`sdt-g60-w155-create-dlq.json`](.artifacts/sdt-g60-w155-create-dlq.json)

All eight pipeline migrations, including
`0008_g60_unsafe_writer_boundaries.sql`, applied successfully. The six MV
migrations applied successfully. The exact migration and schema receipts are
[`sdt-g60-w155-apply-pipeline-migrations.json`](.artifacts/sdt-g60-w155-apply-pipeline-migrations.json),
[`sdt-g60-w155-apply-mv-migrations.json`](.artifacts/sdt-g60-w155-apply-mv-migrations.json),
[`sdt-g60-w155-verify-pipeline-schema.json`](.artifacts/sdt-g60-w155-verify-pipeline-schema.json),
and [`sdt-g60-w155-verify-mv-schema.json`](.artifacts/sdt-g60-w155-verify-mv-schema.json).
The pipeline schema read contains migration IDs 1 through 8 and the new
`serialized_dcb_unsafe_writer_boundaries` table.

Under C-0/C-13, all transient operational rows were reset without dropping
schema or queues. Before reset, the fresh application tables were empty; the
two `mv_instances` and two `mv_active_generations` bootstrap rows were
retained because the runtime requires the registered projector instances.
After reset, all 21 pipeline application tables and all 13 transient MV tables
were zero. The exact post-reset receipts are
[`sdt-g60-w155-post-reset-pipeline-counts.json`](.artifacts/sdt-g60-w155-post-reset-pipeline-counts.json)
and [`sdt-g60-w155-post-reset-mv-counts.json`](.artifacts/sdt-g60-w155-post-reset-mv-counts.json).

Two local command corrections are retained honestly. An initial MV count used
pipeline table names and returned `no such table serialized_dcb_global_receipts`;
the corrected MV-only count then succeeded. An initial reset SQL included
`BEGIN`/`COMMIT`, which D1 rejected; the same reset statements without explicit
transaction wrappers then succeeded. Neither failed command changed data. The
initial incorrect read receipts remain under `.artifacts/` and are not being
represented as successful evidence.

## Exact deployment

The exact deployment command was:

```text
node .artifacts/sdt-g60-w155-run-wrangler.mjs deploy --config .artifacts/sdt-g60-w155-wrangler.cloudflare-only.jsonc --message "SDT-G60 W155 exact 31ca80dbbde5b7537ebb804e62cd14c30bfe5bcf"
```

The helper recorded the command without any secret value. `secret put` first
created the fresh Worker's secret-only version
`a447a6e4-a9a6-404e-8da9-ef96eb547036`; the exact source deployment then
created final version `b00974ad-cb17-4b44-a8ca-72a273416f71` and deployment
`58f5e182-721d-4e3d-b0be-add80a8c10c9`. The final deployment is 100% on that
version. Its exact annotation is:

```text
SDT-G60 W155 exact 31ca80dbbde5b7537ebb804e62cd14c30bfe5bcf
```

[`sdt-g60-w155-verify-final-version-view.json`](.artifacts/sdt-g60-w155-verify-final-version-view.json)
proves the annotation, `fetch`/`queue`/`scheduled` handlers, the two fresh D1
IDs, fresh Queue binding, `SDT_SERVICE_ID`, fence phase/release/fingerprint,
and the secret binding. Version/deployment history is in
[`sdt-g60-w155-verify-versions.json`](.artifacts/sdt-g60-w155-verify-versions.json)
and [`sdt-g60-w155-verify-deployments.json`](.artifacts/sdt-g60-w155-verify-deployments.json).

## One fresh public cohort

The single cohort used the existing W116 public instrument and no conformance
surface:

- run ID: `427d3596-b5b0-45e4-81cc-882f4d716a9c`
- started: `2026-09-04T13:57:27.239Z`
- completed: `2026-09-04T13:59:28.881Z`
- protocol: G15/G16 `create-room`, then `reserve-room` with a unique reservation
- read: fully paged `GET /api/read/reservations`, `pageSize=1000`
- paced commits: 10; preceding commit-response-to-next-commit-start gaps:
  `10002, 10001, 10002, 10002, 10001, 10001, 10001, 10001, 10002 ms`
- cold first sample: included
- observation ceiling: 120,000 ms; no censored sample
- unsafe contract: unchanged strict `<= 5000 ms`

Every list response and each completed sample was flushed by the runner. The
lossless raw public receipt is
[`sdt-g60-w155-public-cohort.json`](.artifacts/sdt-g60-w155-public-cohort.json)
(SHA-256
`dbb1418416f39fab8466cb544a1a5fef26e8dcf1b89e7f7dd74dfb7f707cbf77`).

The public result is **10/10 observed, 0 censored, p50 4,010 ms, p95 9,962
ms, 5/10 strictly over 5,000 ms**. The full-cohort percentile calculation is
observed-all-samples; `countAtOrOver5000OrMissing` is also 5.

## Per-sample public and seven-hop values

The timestamp columns are Unix milliseconds from the exact reservation event's
durable ledger rows. All non-command stages use that reservation's
`reservation:<id>` source partition. `durable read` is the persisted
`first-unsafe-visible-read` boundary; `public read` is the first fully paged
public response containing the reservation. Negative record-to-read values are
reported as observed: the asynchronous durable observer rows can be committed
out of wall-clock order across delivery/public-read paths and are not silently
clamped.

| # | reservation ID | event ID | SUID | command | tag | outbox | queue | consumer | recordDelivery | durable read | public read |
|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | `g15-reservation-427d3596b5b045e4-1` | `01a06cb5-d6ec-77d5-b5e3-f4a7c65a4956` | `063924127052217000000434553763` | 1788530251500 | 1788530252458 | 1788530252458 | 1788530252569 | 1788530256266 | 1788530256818 | 1788530256497 | 1788530256518 |
| 2 | `g15-reservation-427d3596b5b045e4-2` | `01a06cb6-07ad-7187-8049-c76cae362c70` | `063924127065370000001376203321` | 1788530263981 | 1788530265601 | 1788530265601 | 1788530265775 | 1788530274211 | 1788530274822 | 1788530275846 | 1788530275896 |
| 3 | `g15-reservation-427d3596b5b045e4-3` | `01a06cb6-3a52-7392-9f07-b4d9cce45148` | `063924127077900000001291086244` | 1788530276946 | 1788530278119 | 1788530278119 | 1788530278257 | 1788530286660 | 1788530287362 | 1788530288418 | 1788530288477 |
| 4 | `g15-reservation-427d3596b5b045e4-4` | `01a06cb6-6b1f-78ef-8f0d-99114d92b93c` | `063924127090233000001169227996` | 1788530289439 | 1788530290454 | 1788530290454 | 1788530290552 | 1788530296766 | 1788530297632 | 1788530299445 | 1788530299487 |
| 5 | `g15-reservation-427d3596b5b045e4-5` | `01a06cb6-9ae4-77c4-aebd-45cd78f2ff17` | `063924127102545000000006548613` | 1788530301668 | 1788530302754 | 1788530302754 | 1788530302839 | 1788530308586 | 1788530309542 | 1788530309405 | 1788530309450 |
| 6 | `g15-reservation-427d3596b5b045e4-6` | `01a06cb6-cb42-71d0-8060-fdb08d48d17e` | `063924127116086000000637370957` | 1788530314050 | 1788530316300 | 1788530316300 | 1788530316450 | 1788530318793 | 1788530319928 | 1788530321682 | 1788530321698 |
| 7 | `g15-reservation-427d3596b5b045e4-7` | `01a06cb6-ffc3-71f8-81d9-366b713fedb9` | `063924127128367000001218051867` | 1788530327491 | 1788530328585 | 1788530328585 | 1788530328775 | 1788530332395 | 1788530333735 | 1788530332878 | 1788530332883 |
| 8 | `g15-reservation-427d3596b5b045e4-8` | `01a06cb7-303b-729f-9c9f-c4107643ad06` | `063924127140647000001410133850` | 1788530339899 | 1788530340873 | 1788530340873 | 1788530341037 | 1788530344128 | 1788530345088 | 1788530343979 | 1788530344048 |
| 9 | `g15-reservation-427d3596b5b045e4-9` | `01a06cb7-5feb-7c48-828a-ba9eae29eca0` | `063924127152821000001940694246` | 1788530352107 | 1788530353047 | 1788530353047 | 1788530353175 | 1788530354605 | 1788530355749 | 1788530357493 | 1788530357500 |
| 10 | `g15-reservation-427d3596b5b045e4-10` | `01a06cb7-9094-7e12-b5e4-6fb18dd68eca` | `063924127165439000000078915765` | 1788530364564 | 1788530365683 | 1788530365683 | 1788530365905 | 1788530368591 | 1788530369336 | 1788530368793 | 1788530368879 |

The authoritative complete identity/timestamp data is in
[`sdt-g60-w155-ledger.json`](.artifacts/sdt-g60-w155-ledger.json), whose
SHA-256 is
`eb7ac6e2558bb0d7a29765e36e7c5c8afaae39bc0132da302b40a338edc7e9a7`.

| # | response→public | disposition | command→tag | tag→outbox | outbox→queue | queue→consumer | consumer→record | record→durable read | record→public |
|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | 3689 | within | 958 | 0 | 111 | 3697 | 552 | -321 | -300 |
| 2 | 9962 | **over** | 1620 | 0 | 174 | 8436 | 611 | 1024 | 1074 |
| 3 | 9958 | **over** | 1173 | 0 | 138 | 8403 | 702 | 1056 | 1115 |
| 4 | 8714 | **over** | 1015 | 0 | 98 | 6214 | 866 | 1813 | 1855 |
| 5 | 6294 | **over** | 1086 | 0 | 85 | 5747 | 956 | -137 | -92 |
| 6 | 5083 | **over** | 2250 | 0 | 150 | 2343 | 1135 | 1754 | 1770 |
| 7 | 3962 | within | 1094 | 0 | 190 | 3620 | 1340 | -857 | -852 |
| 8 | 2847 | within | 974 | 0 | 164 | 3091 | 960 | -1109 | -1040 |
| 9 | 4010 | within | 940 | 0 | 128 | 1430 | 1144 | 1744 | 1751 |
| 10 | 2811 | within | 1119 | 0 | 222 | 2686 | 745 | -543 | -457 |

The `command receipt → durable first-public-read` values are
`4997, 11865, 11472, 10006, 7737, 7632, 5387, 4080, 5386, 4229 ms`
respectively (n=10, p50=5,387 ms, p95=11,865 ms). These are durable observer
correlations and are distinct from the public response timing contract.

## Hop and sub-hop aggregates

Percentiles use nearest-rank over the available completed values. A row with
no detector boundary is excluded from the detector statistic and remains
reported as missing below.

| hop/boundary | n | p50 (ms) | p95 (ms) | min–max (ms) | outcomes/missing |
|---|---:|---:|---:|---:|---|
| command receipt → Tag append | 10 | 1086 | 2250 | 940–2250 | complete |
| Tag append → outbox obligation | 10 | 0 | 0 | 0–0 | complete |
| outbox obligation → Queue send returned | 10 | 138 | 222 | 85–222 | complete |
| Queue send returned → consumer invocation start | 10 | **3620** | **8436** | 1430–8436 | complete; dominant in all five over-bound rows |
| consumer invocation start → recordDelivery committed | 10 | 866 | 1340 | 552–1340 | complete |
| recordDelivery → persisted first-public-read boundary | 10 | -137 | 1813 | -1109–1813 | complete; asynchronous cross-row ordering retained |
| recordDelivery → actual public visibility | 10 | -92 | 1855 | -1040–1855 | complete; asynchronous cross-row ordering retained |
| command response → actual public visibility | 10 | **4010** | **9962** | 2811–9962 | 5 strict over 5000 |
| post-record global-receipt readback | 10 | 122 | 164 | 31–164 | all `available` |
| source Tag acknowledgement | 10 | 149 | 778 | 94–778 | all `acknowledged` |
| completeness coverage | 10 | 122 | 261 | 88–261 | all `BLOCK/UNSETTLED` |
| detector | 1 | 310 | 310 | 310–310 | 1 `applied`, 9 missing |
| ReservationProjector unsafe-view apply | 10 | 60 | 374 | 28–374 | 5 `applied`, 5 `duplicate-race` |
| RoomProjector unsafe-view apply | 10 | 105 | 471 | 49–471 | 5 `applied`, 5 `duplicate-race` |
| ReservationProjector unsafe writer | 10 | 49 | 62 | 40–62 | all `applied`, path `inline-delivery` |
| RoomProjector unsafe writer | 10 | 57 | 130 | 51–130 | all `no-change`, path `inline-delivery` |

The four strict over-bound rows with their dominant hop are:

| sample | public ms | queue→consumer ms | conclusion |
|---:|---:|---:|---|
| 2 | 9962 | 8436 | Queue delivery wait is the largest observed hop |
| 3 | 9958 | 8403 | Queue delivery wait is the largest observed hop |
| 4 | 8714 | 6214 | Queue delivery wait is the largest observed hop |
| 5 | 6294 | 5747 | Queue delivery wait is the largest observed hop |
| 6 | 5083 | 2343 | Queue delivery wait remains the largest observed hop |

All completed W153 post-admission sub-hops were at most 778 ms (the sample 6
source acknowledgement), and all unsafe writer spans were at most 130 ms.
Thus these rows do not support attributing the strict failures to the unsafe
writer or to completeness coverage. They localize the observed dominant
interval to Queue send-returned through consumer invocation start.

## Independent unsafe apply under completeness BLOCK

The pipeline ledger query returned 364 rows. Across the 20 room/reservation
event-tag partition observations, all 20 completeness end boundaries were
`BLOCK/UNSETTLED`. Despite that, each reservation event has both projector
unsafe-view apply boundaries and both path-labelled writer boundaries:

- 10 ReservationProjector writer pairs: `inline-delivery`, all outcome
  `applied`, n=10, p50=49 ms, p95=62 ms.
- 10 RoomProjector writer pairs: `inline-delivery`, all outcome `no-change`,
  n=10, p50=57 ms, p95=130 ms.
- unsafe-view apply boundaries exist for both views for all ten events, with
  the applied/duplicate-race distribution in the aggregate table.
- post-record global receipt readback and source acknowledgement complete for
  all ten selected reservation partitions before these unsafe-view boundaries.

The MV query returned 10 `mv_unsafe_receipts`, all identified as
`RoomProjector`/`no-change`, and 10 `mv_rows`, each identified as the matching
`ReservationProjector` reservation row with status `reserved`, version 1, and
the exact cohort SUID. `mv_unsafe_rows` returned 0. The two
`mv_unsafe_arrivals` rows were present for the two registered views. The full
query is [`sdt-g60-w155-mv.json`](.artifacts/sdt-g60-w155-mv.json), SHA-256
`5a351521a370a4d5a955b4bcd7598760ac17fd08f48c4d3aba38304c27865a50`.

The final pipeline snapshot had one healthy scanner row and one safe-lane row:
the final settled frontier was
`063924127165439000000078915765`. The snapshot also retained one open
`GLOBAL_ARRAY_RECEIPT_ABSENT` completeness finding for sample 5. These final
snapshot facts are recorded as observation, not used to turn any `BLOCK` into
`SETTLED` or to claim a safe-lane change. The W153 source/guard remains the
proof that the independent lane does not advance the G44 safe checkpoint or
weaken its fence. W155 changed no source path.

## Landing-history statement

The first **provable relevant** landing for the coverage admission change is
G62 `05d9d27` / PR #119: it introduced the cursor-aware
`coverageForObligation` admission predicate. The unsafe writer itself was
already present at the earlier G26 landing `f7b257b`; W155 evidence does not
prove that G62 historically caused the latency distribution to change. The
W153 guard receipts remain preserved:

- [`sdt-g60-w153-unsafe-writer-red.json`](.artifacts/sdt-g60-w153-unsafe-writer-red.json)
  (pre-fix exit 1)
- [`sdt-g60-w153-unsafe-writer-mutant-red.json`](.artifacts/sdt-g60-w153-unsafe-writer-mutant-red.json)
  (old completeness-gated path exit 1)
- [`sdt-g60-w153-unsafe-writer-green.json`](.artifacts/sdt-g60-w153-unsafe-writer-green.json)
  (independent unsafe writer green under BLOCK)

W153's repair is the exact source deployed here; no new product repair was
selected in W155.

## Checkpoint and remaining work

W155's fresh resources, exact deployment receipts, one cohort receipt, and
durable ledger/MV queries are ready to be committed as one evidence
checkpoint. The strict AC1/unsafe contract is not proven because 5/10 public
samples exceed 5,000 ms. The next bounded decision must address the measured
Queue delivery wait; it must not treat the W155 writer result as authorization
for another repair or cohort in this task.

No PR or worker completion transition is made by W155. Pre-G53 A/B remains
deferred/open under Authority B. SDT-G56 remains held; G62 and G61 remain
untouched. The 5,000 ms constant, SafeWindow, outbox/Queue/global admission
behavior, ordering, durability, fences, G53 naming, G55 reads, and G58/G61
boundaries remain unchanged.
