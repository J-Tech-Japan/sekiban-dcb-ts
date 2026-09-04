# SDT-G60 stripped-environment sub-hop resume (W143)

Task: `SDT-G60-STRIPPED-ENV-SUBHOP-RESUME-W143`
Status: **completed — one bounded fresh-resource measurement; no product repair, PR, or landing**
Branch: `claude/sdt-g60-clean-preg53-ab-w124`
Exact source head: `3e5954b8c6ea2f29d664f09417b4c09e6cef4880`
Evidence checkpoint: `07dbf3f` (evidence-only; pushed)
Recorded on: 2026-09-04

This continuation used only a new W131-C resource set. The production Worker/database/queues and both W130 arms were not touched. The named W131-C resources are intentionally retained as abandoned evidence resources; no destructive cleanup was performed.

## Wrangler environment and authorization result

The required five Wrangler-recognized environment names were all unset before the W143 write window, and every subsequent Wrangler invocation removed all five with `env -u`:

| name | status |
|---|---|
| `CLOUDFLARE_API_TOKEN` | `UNSET` |
| `CF_API_TOKEN` | `UNSET` |
| `CLOUDFLARE_API_KEY` | `UNSET` |
| `CF_API_KEY` | `UNSET` |
| `WRANGLER_API_TOKEN` | `UNSET` |

The first shell attempt used the correct stripped form but a nonexistent local `./node_modules/.bin/wrangler` path and exited 127; it made no Cloudflare request. One plainly local binary-path correction used the known parent-level Wrangler binary. The one actual retry of the previously failed W131-C pipeline create succeeded:

```text
env -u CLOUDFLARE_API_TOKEN -u CF_API_TOKEN -u CLOUDFLARE_API_KEY -u CF_API_KEY -u WRANGLER_API_TOKEN /Users/tomohisa/dev/GitHub/SekibanDcbTsImplementation/node_modules/.bin/wrangler d1 create sekiban-dcb-g60-w131-c-pipeline --location wnam
```

It returned exit 0 and database ID `b03270df-9698-4a9e-94c6-c2c5726f106d`. The MV D1 and both Queues also succeeded with exit 0. No W143 Cloudflare authorization failure occurred, so no same-family classifier was invoked and no failed Cloudflare write was retried. The W137 code-10000 failure and W128 code-7403 write failure did not reproduce when the stray Wrangler-recognized token environment was removed. The bounded operational finding is credential-environment contamination rather than a fresh-resource D1/Queue permission failure; this run does not identify which historical stray name produced each earlier error.

The complete provisioning receipt is [`.artifacts/sdt-g60-w143-w131-c-d1-create.json`](.artifacts/sdt-g60-w143-w131-c-d1-create.json). It contains the local 127 receipt, the one actual D1 create receipt, all four resource names/IDs, the no-retry decision, and names-only environment state.

## Fresh W131-C resources and fence

| resource | exact name or ID |
|---|---|
| Worker | `sekiban-dcb-g60-w131-c` |
| Worker URL | `https://sekiban-dcb-g60-w131-c.ttakaoka.workers.dev` |
| pipeline D1 | `sekiban-dcb-g60-w131-c-pipeline` / `b03270df-9698-4a9e-94c6-c2c5726f106d` |
| MV D1 | `sekiban-dcb-g60-w131-c-mv` / `616dd377-42f3-49f7-b373-a1a07cedf2b3` |
| outbox Queue | `sekiban-dcb-g60-w131-c-outbox` |
| dead-letter Queue | `sekiban-dcb-g60-w131-c-outbox-dlq` |
| service ID | `sekiban-dcb-g60-w131-c` |

The evidence-only adapted config was [`.artifacts/sdt-g60-w143-c-wrangler.cloudflare-only.jsonc`](.artifacts/sdt-g60-w143-c-wrangler.cloudflare-only.jsonc). It uses the normal config shape, exact W127 source, the four fresh bindings, `G32_CUTOVER_PHASE=final-g32`, `G32_FREEZE_RELEASE=after-new-bindings`, and fingerprint `856d12ed5d96cf9a37f89c9d754694e20a1029e85a50a4c9fefc15a101fcad9c`. A new token was generated privately at `/private/tmp/sdt-g60-w143-c-fence.Tj7iU5/token` with mode `600`; only its lowercase SHA-256 fingerprint is recorded. The secret value was supplied only through stdin to `secret put`, never printed, logged, placed in argv, or committed. No G50 observability credential or conformance token was used.

The pipeline applied all seven exact G32 migrations through `0007_g60_post_admission_decomposition.sql`; the MV D1 applied all six exact MV migrations. A read-only check returned both `serialized_dcb_hop_measurements` and `serialized_dcb_hop_submeasurements`. The migration and table-check receipt is [`.artifacts/sdt-g60-w143-c-migrations.json`](.artifacts/sdt-g60-w143-c-migrations.json).

## Exact deployment identity

The initial deploy created version `44a8bc2f-1d16-439e-92de-2bdbb8e63cc9` with the exact source/fingerprint message. The secret publication created version `94a96421-d490-45cd-bccb-dfd745c2988b` with only `workers/triggered_by=secret`; it therefore did not prove exact source. One authorized unchanged exact-source/config redeploy then created final version `450c506e-1485-4d15-aa5d-882d34a8480d`.

Final read-only identity proof:

- deployment ID: `8d11c4f1-7918-4bc6-bbb7-491a859b65fd`
- final version: `450c506e-1485-4d15-aa5d-882d34a8480d`
- traffic: `100%`
- full annotation: `SDT-G60 W143 exact 3e5954b8c6ea2f29d664f09417b4c09e6cef4880 fence 856d12ed5d96cf9a37f89c9d754694e20a1029e85a50a4c9fefc15a101fcad9c`
- exact W127 source: proven by the full version annotation
- exact fence fingerprint: proven by the full version annotation and `G32_CUTOVER_FENCE_FINGERPRINT` binding
- `D1`: `b03270df-9698-4a9e-94c6-c2c5726f106d`
- `D1_MV`: `616dd377-42f3-49f7-b373-a1a07cedf2b3`
- `DOWNSTREAM_QUEUE`: `sekiban-dcb-g60-w131-c-outbox`
- handlers: `fetch`, `queue`, `scheduled`

The complete deployment/secret receipts are [`.artifacts/sdt-g60-w143-c-deploy.json`](.artifacts/sdt-g60-w143-c-deploy.json) and [`.artifacts/sdt-g60-w143-c-secret.json`](.artifacts/sdt-g60-w143-c-secret.json). All Wrangler commands used the stripped environment and no `--keep-vars`.

## One fresh public cohort

Exactly one new cohort was run after final identity verification. It used only:

- `POST /api/commands/create-room`, body `{roomId,name:"SDT-G15"}`;
- `POST /api/commands/reserve-room`, body `{roomId,reservationId,userId:"g15"}`;
- fully paged `GET /api/read/reservations?pageNumber=...&pageSize=1000&newestFirst=true` until the target reservation appeared or the fixed observation ceiling elapsed.

No `/conformance` route, `read-health`, conformance token, or observability token was used. The cohort runner flushed its raw report after setup, every list scan, each accepted commit, and each completed sample. The exact command was:

```text
node .artifacts/sdt-g60-w124-public-cohort.mjs --variant W143-W131-C --source-commit 3e5954b8c6ea2f29d664f09417b4c09e6cef4880 --deployed-version-id 450c506e-1485-4d15-aa5d-882d34a8480d --base-url https://sekiban-dcb-g60-w131-c.ttakaoka.workers.dev --report .artifacts/sdt-g60-w143-c-cohort.json --count 10 --pace-ms 10000 --page-size 1000 --poll-ms 1000 --bound-ms 120000
```

Run ID: `448fac49-1368-4891-a3f6-6277805b18e0`
Started: `2026-09-04T07:29:38.620Z`
Finished: `2026-09-04T07:33:21.552Z`
Room: `g15-room-448fac4913684891`
Room SUID: `063924103780237000001679285080`
Commit response spacing after the cold first sample: minimum `11,313 ms`; all nine required gaps were at least 10,000 ms.

Public timing is command-response receipt to the first fully paged list response containing the target reservation. The unchanged 5,000 ms contract is recorded only:

| measure | result |
|---|---:|
| cohort n | 10 |
| observed n | 9 |
| censored n | 1 (cold sample 1, missing by fixed 120,000 ms observation ceiling) |
| observed-only p50 | 4,681 ms |
| observed-only p95 | 9,286 ms |
| strict count over 5,000 ms | 4/10 |
| count over-or-missing 5,000 ms | 5/10 |
| observed values in ordinal order | `—, 4681, 9286, 9160, 9140, 9168, 2414, 3519, 3694, 4557 ms` |

Raw public receipts, including every raw page response, are in [`.artifacts/sdt-g60-w143-c-cohort.json`](.artifacts/sdt-g60-w143-c-cohort.json). The one censored value is not substituted into either percentile.

## Durable correlation and sub-hop aggregates

The stripped-environment D1 query returned 348 rows for the ten exact reservation event IDs: 120 original seven-hop rows and 228 W127 submeasurement rows. Each sample has one attempt ID and 12 original-hop rows (the two committed source partitions account for the repeated partition-tagged stages). The full query SQL, raw stdout, exact event/SUID identity list, and all returned rows are in [`.artifacts/sdt-g60-w143-c-ledger.json`](.artifacts/sdt-g60-w143-c-ledger.json).

The per-sample sub-hop figures below select the reservation source partition for the reservation event. The corresponding room-partition rows remain in the raw ledger and were retained; selecting one stable event partition avoids mixing the room and reservation deliveries in a single duration. `record→public` is the public first-visibility timestamp minus that partition's recorded `record-delivery-batch-committed` timestamp. Negative values are reported as observed and are not clamped: they show that the asynchronously persisted observer timestamp order cannot be treated as a causal public-read boundary.

| boundary or interval | n | p50 | p95 | all values in ordinal order | outcomes / note |
|---|---:|---:|---:|---|---|
| queue send → consumer start | 10 | 4,724 ms | 9,175 ms | `5954, 4724, 8831, 9175, 7533, 7186, 2579, 2743, 2033, 3671` | dominant observed pre-admission interval for over-bound rows |
| consumer start → record-delivery committed | 10 | 627 ms | 978 ms | `978, 627, 495, 861, 839, 439, 649, 568, 386, 700` | all present |
| record-delivery committed → global readback start | 10 | 0 ms | 0 ms | `0, 0, 0, 0, 0, 0, 0, 0, 0, 0` | all present |
| global-receipt readback | 10 | 110 ms | 135 ms | `127, 129, 101, 50, 110, 55, 105, 128, 124, 135` | all `available` |
| source Tag acknowledgement | 10 | 271 ms | 411 ms | `335, 371, 161, 217, 280, 226, 411, 282, 241, 271` | all `acknowledged` |
| completeness coverage | 10 | 82 ms | 572 ms | `572, 80, 48, 116, 64, 79, 136, 121, 82, 122` | 9 `SETTLED`; sample 1 `BLOCK/UNSETTLED` |
| detector | 9 | 350 ms | 425 ms | `—, 379, 339, 419, 350, 277, 425, 315, 242, 420` | 9 `applied`; sample 1 missing |
| RoomProjector unsafe-view apply | 9 | 161 ms | 495 ms | `—, 161, 142, 122, 427, 495, 136, 119, 449, 175` | 2 `applied`, 7 `duplicate-race`; sample 1 missing |
| ReservationProjector unsafe-view apply | 9 | 115 ms | 382 ms | `—, 130, 97, 89, 382, 332, 103, 103, 285, 115` | 2 `applied`, 7 `duplicate-race`; sample 1 missing |
| last completed record-delivery → public first visibility | 9 | 187 ms | 1,630 ms | `—, -520, -10, -772, 927, 1630, -602, 238, 1324, 187` | 4 negative timestamp-order values; not treated as causal latency |
| public first visibility → last persisted sub-boundary | 9 | -801 ms | 498 ms | `—, -1640, -801, -1696, -304, 498, -1815, -727, 186, -936` | 7 negative values; observer ordering ambiguity |

The first sample's W127 chain stopped at `completeness-coverage:end` with `BLOCK/UNSETTLED`; detector and both view-apply boundaries are absent for the reservation partition. Its ledger `first-unsafe-visible-read` row is at `116,307 ms` after that partition's recorded delivery, but the public cohort never found the reservation by the fixed `120,000 ms` ceiling. That ledger row is therefore not promoted to a public-list visibility result.

## Per-sample exact values

Commit and ledger timestamps below are epoch milliseconds from the raw receipts. The public disposition is the paged public-list result; `—` means censored or a missing boundary, not zero.

| # | reservation ID | event ID | SUID | attempt ID | commit received | public ms / disposition | ledger first-unsafe |
|---:|---|---|---|---|---:|---:|---:|
| 1 | `g15-reservation-448fac4913684891-1` | `01a06b52-c5ce-7d6b-9d76-a5d5872194fd` | `063924103781982000001994323723` | `a9c52cc2-1e8a-444b-95c1-3842680a46ac` | 1788506982274 | `— / missing-by-120000ms` | 1788507105645 |
| 2 | `g15-reservation-448fac4913684891-2` | `01a06b54-a187-7395-b114-13d86b74f3ef` | `063924103903917000002130751144` | `915042b2-3110-4799-98e0-f68f05b82b02` | 1788507104399 | `4681 / within-5000ms` | 1788507109090 |
| 3 | `g15-reservation-448fac4913684891-3` | `01a06b54-ce99-7ec7-9126-1518a4984d5a` | `063924103915366000001512967560` | `2cc477e3-6c06-47a7-9f56-b84caf22b5e3` | 1788507115712 | `9286 / over-5000ms` | 1788507125001 |
| 4 | `g15-reservation-448fac4913684891-4` | `01a06b54-fb5c-75c2-a398-5ef2d5103cbe` | `063924103926805000001509745972` | `2b93a350-b2c0-48a0-b549-571149320276` | 1788507127133 | `9160 / over-5000ms` | 1788507136289 |
| 5 | `g15-reservation-448fac4913684891-5` | `01a06b55-28ce-76cd-a845-7330f7a561cf` | `063924103938434000001115246821` | `6638bc45-8dd7-4737-9761-4548edb193b3` | 1788507138779 | `9140 / over-5000ms` | 1788507147917 |
| 6 | `g15-reservation-448fac4913684891-6` | `01a06b55-554c-7786-b55f-ef0098238a99` | `063924103949832000000423997189` | `5549a277-c35c-48f6-ad73-973c96684d6d` | 1788507150149 | `9168 / over-5000ms` | 1788507159316 |
| 7 | `g15-reservation-448fac4913684891-7` | `01a06b55-827f-73a1-b845-af1ee6242e8f` | `063924103961396000000988529375` | `eac5e38d-1569-46dc-8290-09b91874564d` | 1788507162056 | `2414 / within-5000ms` | 1788507164394 |
| 8 | `g15-reservation-448fac4913684891-8` | `01a06b55-b0bb-71f6-84fe-4dc7bdb66348` | `063924103973240000001421704648` | `7e549370-c379-4201-b1ac-0f7962da12a5` | 1788507173530 | `3519 / within-5000ms` | 1788507176969 |
| 9 | `g15-reservation-448fac4913684891-9` | `01a06b55-ddab-75c0-aca4-5b8d260f8d9b` | `063924103985176000001073418623` | `03303be0-3e18-4667-98a7-e11bac00b082` | 1788507185572 | `3694 / within-5000ms` | 1788507189265 |
| 10 | `g15-reservation-448fac4913684891-10` | `01a06b56-0c37-737a-a95c-9cd75dca8f04` | `063924103996663000001421498456` | `748cd93f-1a73-47ae-bc05-1f864dcbb4b4` | 1788507196978 | `4557 / within-5000ms` | 1788507201526 |

| # | queue→consumer | consumer→record | global / ack / coverage | detector | Room apply | Reservation apply | record→public |
|---:|---:|---:|---|---:|---|---|---:|
| 1 | 5954 | 978 | `127 / 335 / 572 BLOCK/UNSETTLED` | — | — | — | — |
| 2 | 4724 | 627 | `129 / 371 / 80 SETTLED` | 379 | `161 duplicate-race` | `130 duplicate-race` | -520 |
| 3 | 8831 | 495 | `101 / 161 / 48 SETTLED` | 339 | `142 duplicate-race` | `97 duplicate-race` | -10 |
| 4 | 9175 | 861 | `50 / 217 / 116 SETTLED` | 419 | `122 duplicate-race` | `89 duplicate-race` | -772 |
| 5 | 7533 | 839 | `110 / 280 / 64 SETTLED` | 350 | `427 duplicate-race` | `382 duplicate-race` | 927 |
| 6 | 7186 | 439 | `55 / 226 / 79 SETTLED` | 277 | `495 applied` | `332 applied` | 1630 |
| 7 | 2579 | 649 | `105 / 411 / 136 SETTLED` | 425 | `136 duplicate-race` | `103 duplicate-race` | -602 |
| 8 | 2743 | 568 | `128 / 282 / 121 SETTLED` | 315 | `119 duplicate-race` | `103 duplicate-race` | 238 |
| 9 | 2033 | 386 | `124 / 241 / 82 SETTLED` | 242 | `449 applied` | `285 applied` | 1324 |
| 10 | 3671 | 700 | `135 / 271 / 122 SETTLED` | 420 | `175 duplicate-race` | `115 duplicate-race` | 187 |

## MV provenance and dominant intervals

The fresh-MV query returned 19 exact-cohort rows: 9 `mv_unsafe_receipts` rows, all `RoomProjector`/`no-change`, 10 `ReservationProjector` `mv_rows` rows, and zero matching `mv_unsafe_rows`. Every reservation MV row has the exact cohort SUID as `source_suid`, row version 1, and the expected `reserved` value. The complete raw MV query and rows are in [`.artifacts/sdt-g60-w143-c-mv.json`](.artifacts/sdt-g60-w143-c-mv.json).

Dominant observed interval for every strict-over or censored sample:

- **Sample 1 (censored):** no completed numeric sub-hop can be named as the 120-second censor. The responsible persisted condition is `completeness-coverage=BLOCK/UNSETTLED` followed by missing detector and both unsafe-view-apply boundaries for the reservation partition; the ledger-to-unsafe residual is 116,307 ms. The exact ReservationProjector MV row exists, but the public list never returned it within the ceiling. This is reported as an incomplete/stalled post-admission path, not fabricated as a latency percentile.
- **Sample 3:** Queue send→consumer start `8,831 ms`; all completed post-admission stages are at most `339 ms`; dominant observed interval is the Queue/consumer wait.
- **Sample 4:** Queue send→consumer start `9,175 ms`; all completed post-admission stages are at most `419 ms`; dominant observed interval is the Queue/consumer wait.
- **Sample 5:** Queue send→consumer start `7,533 ms`; all completed post-admission stages are at most `427 ms`; dominant observed interval is the Queue/consumer wait.
- **Sample 6:** Queue send→consumer start `7,186 ms`; all completed post-admission stages are at most `495 ms`; dominant observed interval is the Queue/consumer wait.

Thus the four strict over-bound public samples are not explained by a long W127 post-admission sub-hop. The post-admission spans are short, while the pre-admission Queue/consumer wait is several seconds. Several public-visible timestamps precede the asynchronously persisted delivery/sub-boundary timestamps, so the residual fields are explicitly ambiguous rather than treated as proof of a public-read or delivery ordering. Observer perturbation is unproven because this is one fresh arm without a matched control. No repair lever was selected or implemented.

The 5,000 ms contract, ordering, durability, fences, G53 naming, G55 reads, and G58 behavior were unchanged. No outbox/Queue/global-admission code was changed. G56 remains held; G62/G61 remain outside this continuation. No product repair, PR, or landing was performed; the only commit was the evidence-only checkpoint recorded above.
