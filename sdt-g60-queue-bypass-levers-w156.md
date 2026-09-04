# SDT-G60 queue-bypass levers — W156

Task: `SDT-G60-QUEUE-BYPASS-LEVERS-W156`
Issue: SDT-G60 / #113
Branch: `claude/sdt-g60-clean-preg53-ab-w124`
Starting W155 checkpoint: `014def2355e84a52f35cb7ab942bf212e0770eb5`
Source exercised: `31ca80dbbde5b7537ebb804e62cd14c30bfe5bcf`
Result: **blocked at the first post-cohort durable-ledger read by Cloudflare API authorization code 7403**

## Stop decision

Checkpoint 1 completed. The isolated W155 arm was deployed with consumer
`max_batch_size=1` and `max_batch_timeout=1`, and one fresh cold-first cohort
of ten was completed. The first durable ledger read after that cohort returned
Cloudflare API code 7403 with all five Wrangler credential variables stripped.
Its single same-family read-only classifier (`d1 execute ... SELECT 1`) also
returned success only as a probe result, not as the requested ledger read.
The independently launched MV read was preserved and returned the same 7403;
its receipt contains its one same-family probe as well. No further Wrangler
operation was attempted. This is an authorization stop, not a latency result
for the structural lever.

Because the W156 rule stops on the first authorization failure after the
classifier, checkpoint 2 was not run: no direct-delivery change, structural
repair, second deployment, second reset, or second cohort was performed. No
product file, test, gate, PR, production resource, W130 arm, or W155 source
was changed.

## Wrangler hygiene and preserved arm

The five recognized credential names were **UNSET** in the seat environment
and were also stripped in every W156 Wrangler child process:

| name | state |
|---|---|
| `CLOUDFLARE_API_TOKEN` | UNSET |
| `CF_API_TOKEN` | UNSET |
| `CLOUDFLARE_API_KEY` | UNSET |
| `CF_API_KEY` | UNSET |
| `WRANGLER_API_TOKEN` | UNSET |

The W156 receipts record `noKeepVars: true`. No conformance or observability
credential was used. No secret value was read or printed.

Only the preserved W155 throwaway arm was used:

| resource | value |
|---|---|
| Worker | `sekiban-dcb-g60-w155-c` |
| URL | `https://sekiban-dcb-g60-w155-c.ttakaoka.workers.dev` |
| pipeline D1 | `sekiban-dcb-g60-w155-c-pipeline` / `ac751211-fde8-4587-9d56-1e9fd8051bc3` |
| MV D1 | `sekiban-dcb-g60-w155-c-mv` / `2b60dbcf-0912-4bb2-93aa-77c26cd260e1` |
| Queue | `sekiban-dcb-g60-w155-c-outbox` |
| DLQ | `sekiban-dcb-g60-w155-c-outbox-dlq` |

Production and the W130 arms were untouched.

## Checkpoint 1: configuration measurement

The local Wrangler 4.125.0 schema inspection found producer properties
`binding`, `queue`, `delivery_delay`, and `remote`; consumer properties include
`max_batch_size` and `max_batch_timeout`. There is no supported producer-side
lone-message immediate-dispatch setting. `delivery_delay` is a delay, so no
producer setting was added. The inspection is preserved in
[`sdt-g60-w156-producer-config-inspection.json`](.artifacts/sdt-g60-w156-producer-config-inspection.json).

The deployed checkpoint-1 config retained the W155 source and bindings and
set only the consumer measurement to:

```json
{ "max_batch_size": 1, "max_batch_timeout": 1 }
```

Deployment succeeded with all five variables stripped. The Worker version was
`db1b9e55-609b-4e7a-adf0-a5f30e9335c9`, deployment
`292dd9c3-4c5f-4c9c-800c-27ef3d619916`, at 100%, with exact annotation:

```text
SDT-G60 W156 checkpoint1 max_batch_size=1 exact 31ca80dbbde5b7537ebb804e62cd14c30bfe5bcf
```

The version view proves the two arm D1 IDs, Queue binding, source handlers,
and the unchanged W155 runtime variables. Deployment/config receipts:

- [`sdt-g60-w156-checkpoint1-deploy.json`](.artifacts/sdt-g60-w156-checkpoint1-deploy.json)
- [`sdt-g60-w156-checkpoint1-version-view.json`](.artifacts/sdt-g60-w156-checkpoint1-version-view.json)
- [`sdt-g60-w156-checkpoint1-deployments-list.json`](.artifacts/sdt-g60-w156-checkpoint1-deployments-list.json)
- [`sdt-g60-w156-checkpoint1-versions-list.json`](.artifacts/sdt-g60-w156-checkpoint1-versions-list.json)

The arm contained W155 operational rows before reset. The exact pre-reset
count receipts show 21 global receipts, 11 events, 126 seven-hop rows, 214
sub-hop rows, 44 unsafe-writer-boundary rows, and 11 MV rows (with two MV
instance/bootstrap rows). The reset then succeeded on pipeline and MV D1
without dropping schema or queues. Post-reset count receipts show zero event,
global, hop, sub-hop, writer, unsafe receipt, and MV row data; the required
two `mv_instances` and two `mv_active_generations` rows remained. The service
recreated health/finding/bootstrap maintenance rows between reset and the
post-reset reads; these are recorded as observed baseline, not treated as
cohort data.

- [`sdt-g60-w156-checkpoint1-pre-reset-pipeline-counts-command-corrected.json`](.artifacts/sdt-g60-w156-checkpoint1-pre-reset-pipeline-counts-command-corrected.json)
- [`sdt-g60-w156-checkpoint1-pre-reset-mv-counts-command-corrected.json`](.artifacts/sdt-g60-w156-checkpoint1-pre-reset-mv-counts-command-corrected.json)
- [`sdt-g60-w156-checkpoint1-reset-pipeline.json`](.artifacts/sdt-g60-w156-checkpoint1-reset-pipeline.json)
- [`sdt-g60-w156-checkpoint1-reset-mv.json`](.artifacts/sdt-g60-w156-checkpoint1-reset-mv.json)
- [`sdt-g60-w156-checkpoint1-post-reset-pipeline-counts.json`](.artifacts/sdt-g60-w156-checkpoint1-post-reset-pipeline-counts.json)
- [`sdt-g60-w156-checkpoint1-post-reset-mv-counts.json`](.artifacts/sdt-g60-w156-checkpoint1-post-reset-mv-counts.json)

## Checkpoint-1 public cohort

Run ID: `59b8e2b2-e5ad-42c9-8a1b-58225828a9d7`
Room: `g15-room-59b8e2b2e5ad42c9`
Protocol: W116/G15/G16 create-room, ten reserve-room commits, fully paged
`GET /api/read/reservations`, `pageSize=1000`
Pacing: at least 10,000 ms from each preceding commit response
Cold first sample: included
Observation ceiling: 120,000 ms; censored: 0
Public result: **n=10, p50=4,958 ms, p95=23,927 ms, 5/10 strictly over
5,000 ms**

| # | reservation | event ID | SUID | commit response (ms epoch) | first public visibility (ms epoch) | latency (ms) | disposition |
|---:|---|---|---|---:|---:|---:|---|
| 1 | `g15-reservation-59b8e2b2e5ad42c9-1` | `01a06cd6-86a4-7c4f-a819-a5c7d3a51502` | `063924129194341000002032783610` | 1788532394841 | 1788532410729 | 15888 | over-5000ms |
| 2 | `g15-reservation-59b8e2b2e5ad42c9-2` | `01a06cd6-cd25-7e86-aada-8d21a061ab92` | `063924129212531000000822520682` | 1788532414064 | 1788532437991 | 23927 | over-5000ms |
| 3 | `g15-reservation-59b8e2b2e5ad42c9-3` | `01a06cd7-387d-74fb-93bd-233057113dbf` | `063924129239863000001905602983` | 1788532440494 | 1788532447785 | 7291 | over-5000ms |
| 4 | `g15-reservation-59b8e2b2e5ad42c9-4` | `01a06cd7-68bc-7997-87ed-e85bd23dc3b8` | `063924129252298000001380228363` | 1788532452926 | 1788532459161 | 6235 | over-5000ms |
| 5 | `g15-reservation-59b8e2b2e5ad42c9-5` | `01a06cd7-98a2-7df9-994c-81ad3ff492d2` | `063924129264900000001435176970` | 1788532465536 | 1788532470494 | 4958 | within-5000ms |
| 6 | `g15-reservation-59b8e2b2e5ad42c9-6` | `01a06cd7-ce10-72d2-a7e0-9993d9d29a1e` | `063924129278249000001390727247` | 1788532478918 | 1788532482746 | 3828 | within-5000ms |
| 7 | `g15-reservation-59b8e2b2e5ad42c9-7` | `01a06cd8-00bf-7ae0-9855-5f150c7acd11` | `063924129291571000000344812695` | 1788532492049 | 1788532494817 | 2768 | within-5000ms |
| 8 | `g15-reservation-59b8e2b2e5ad42c9-8` | `01a06cd8-33e8-7224-bc32-586bf95aaf69` | `063924129305215000001073678370` | 1788532505715 | 1788532512220 | 6505 | over-5000ms |
| 9 | `g15-reservation-59b8e2b2e5ad42c9-9` | `01a06cd8-67af-7017-9e44-e764a8d2bc3f` | `063924129317632000001936019052` | 1788532518208 | 1788532521052 | 2844 | within-5000ms |
| 10 | `g15-reservation-59b8e2b2e5ad42c9-10` | `01a06cd8-97f6-7278-a6be-ac1a2bb19d65` | `063924129330531000001484447132` | 1788532531506 | 1788532534163 | 2657 | within-5000ms |

The raw receipt was flushed incrementally by the existing public instrument and
is preserved at
[`sdt-g60-w156-checkpoint1-public-cohort.json`](.artifacts/sdt-g60-w156-checkpoint1-public-cohort.json).
SHA-256: `557f47ce3b2d056923829ef37354dad4a590ae2bd8086ce4c53725feca097331`.
This is a checkpoint-1 public timing result only; no durable hop percentile or
dominant-hop claim is made because the required post-cohort ledger reads were
blocked.

## Authorization receipts and exact stop

The first post-cohort pipeline ledger read targeted the W155 arm pipeline D1
and exited 1 with Cloudflare API code 7403 (`not valid or not authorized to
access this service`). Its exact command, stdout/stderr, stripped-variable
states, and classifier are in
[`sdt-g60-w156-checkpoint1-ledger.json`](.artifacts/sdt-g60-w156-checkpoint1-ledger.json).
The exact classifier was the one read-only same-family command:

```text
d1 execute D1 --remote --json --yes --config <W156 checkpoint-1 config> --command "SELECT 1 AS authorization_probe"
```

It exited 0 with `authorization_probe: 1`. It did not authorize a retry of the
failed ledger query.

The MV ledger read was launched in the same read-only batch before the first
result was returned. It independently exited 1 with code 7403 against the arm
MV D1; its one same-family `D1_MV` `SELECT 1 AS authorization_probe` also exited
0. Both exact outputs are preserved in
[`sdt-g60-w156-checkpoint1-mv.json`](.artifacts/sdt-g60-w156-checkpoint1-mv.json).
No additional probe or write was issued after these receipts.

Consequently the following required W156 data is **not available and is not
claimed**: checkpoint-1 durable seven-hop/sub-hop table, MV unsafe receipt/row
provenance, checkpoint-1 dominant hop, checkpoint-2 structural direct-delivery
repair, checkpoint-2 deployment, checkpoint-2 cohort, comparison of both
lever distributions, G60 final contract proof, gates, PR, and worker
completion. The next continuation must resolve the account-level D1 read
authorization condition before attempting any W156 post-cohort read or the
second lever.

## Preserved boundaries

The W155 proof that the independent unsafe writer runs during completeness
`BLOCK` remains unchanged and is retained. The W155 first-provable history
statement—G62 `05d9d27` / PR #119 as the first repository/deployed evidence for
the relevant coverage admission change, without asserting stronger historical
causality—also remains unchanged. The 5,000 ms contract, outbox/Queue/global
admission behavior, ordering, durability, fences, G53/G55/G58 behavior, and
production resources were not changed. No PR was opened and no downstream unit
was started.

## Receipt inventory

All W156-specific receipts are kept under `.artifacts/` and should be read as
the durable source of exact command/output evidence. Selected SHA-256 values:

| receipt | SHA-256 |
|---|---|
| checkpoint-1 public cohort | `557f47ce3b2d056923829ef37354dad4a590ae2bd8086ce4c53725feca097331` |
| checkpoint-1 deploy | `92d6e96241007b585d83bb6b690776b23e8c02e75aa60bdda526339e9370af47` |
| checkpoint-1 version view | `294a225c130b3598fa8b7a657828f6cad02618b12b6b55d6e31b59297088a413` |
| checkpoint-1 deployments list | `aa5c5e04b06afbe1c54527af8765336da4a6fc85ebbabac9504efcef4a5407ca` |
| producer inspection | `1e697cdcdcba180dd07242a2c0e77812b1cd8eafadad24fd9964d5f0f92d77e6` |
| pipeline ledger stop/classifier | recorded in `sdt-g60-w156-checkpoint1-ledger.json` |
| MV ledger stop/classifier | recorded in `sdt-g60-w156-checkpoint1-mv.json` |
