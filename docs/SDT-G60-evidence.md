# SDT-G60 evidence

Issue: SDT-G60 / #113
Branch: `claude/sdt-g60-clean-preg53-ab-w124`
W159 source: `6481ddf4285b5bd71b576aee4a02e0605fb102b1`
W157 product repair: `84892e5bd5233de9c12f07dffb12b28e08bee00e`

W159 is the final reused-arm deployed proof after the direct-doorbell repair.
The one fresh cold-first cohort passed the unchanged unsafe-visibility contract:
all ten reservations were visible on the public unsafe read within 5,000 ms of
their command response. No tuning or second cohort was performed.

## Contract and deployment

W157 starts the existing direct unsafe doorbell after the durable Tag event,
outbox obligation, and local receipt complete, and before the command response
returns. The existing Queue remains enabled and remains the owner of durable
global admission, ordering, retries, and DLQ behavior. Later Queue delivery is
idempotent through the existing `active.lastSuid`/upsert semantics.

The safe completeness fence, safe-lane semantics, reservation/fence protocol,
G58/G62 scheduled maintenance, G53 naming, G55 reads, V1 wire, durability, and
the 5,000 ms contract were not changed. Direct unsafe apply is independent of
completeness and does not advance a safe checkpoint.

Only the existing W131-C throwaway resources were used. No resource was
created, and production and prior W130 arms were untouched.

| resource | value |
|---|---|
| Worker/service | `sekiban-dcb-g60-w131-c` |
| public URL | `https://sekiban-dcb-g60-w131-c.ttakaoka.workers.dev` |
| pipeline D1 | `sekiban-dcb-g60-w131-c-pipeline` / `b03270df-9698-4a9e-94c6-c2c5726f106d` |
| MV D1 | `sekiban-dcb-g60-w131-c-mv` / `616dd377-42f3-49f7-b373-a1a07cedf2b3` |
| Queue / DLQ | `sekiban-dcb-g60-w131-c-outbox` / `sekiban-dcb-g60-w131-c-outbox-dlq` |
| final active version | `e2c870ee-3f3d-404d-96b1-bc480a96dda5` |
| deployment | `65dcb2f4-5aa4-40ad-9bbf-668537b6bb71` |
| traffic | 100% |

Final source annotation:

```text
SDT-G60 W159 exact 6481ddf4285b5bd71b576aee4a02e0605fb102b1 product 84892e5bd5233de9c12f07dffb12b28e08bee00e fence ce80a2a5d31fe0e74c8d488ee0d95af3e537bf0981252020ce6b22fcf62ec857
```

A fresh per-arm G32 fence token was generated in a private mode-600 file
outside the repository. Only its lowercase SHA-256 fingerprint was recorded:
`ce80a2a5d31fe0e74c8d488ee0d95af3e537bf0981252020ce6b22fcf62ec857`.
The token value was never printed, logged, committed, or included here.
`G32_CUTOVER_PHASE=final-g32` and `G32_FREEZE_RELEASE=after-new-bindings`
were used. Every Wrangler receipt records the five recognized credential names
as `UNSET`, uses no `--keep-vars`, and uses no conformance or observability
token.

The existing schema was inspected. The missing W127/W153 writer-boundary DDL
was installed once through the repository runtime schema helper and verified;
no D1 resource was created and `wrangler d1 migrations apply` was not used.
Operational pipeline and transient MV rows were reset under C-0/C-13 without
dropping schema, MV instance metadata, or queues. Post-reset counts were zero
for the listed operational tables; `mv_instances=2` and
`mv_active_generations=2` were retained. An initial local compound-SELECT
count query hit SQLite `too many terms in compound SELECT`; the scalar read-only
query used for the actual verification succeeded. This was an evidence-query
correction, not an auth failure or additional mutation.

Receipts: [config](../.artifacts/sdt-g60-w159-wrangler.cloudflare-only.jsonc),
[schema](../.artifacts/sdt-g60-w159-runtime-schema-0008.json),
[pre-reset pipeline counts](../.artifacts/sdt-g60-w159-pre-reset-pipeline-counts-scalar-command.json),
[pre-reset MV counts](../.artifacts/sdt-g60-w159-pre-reset-mv-counts-scalar-command.json),
[pipeline reset](../.artifacts/sdt-g60-w159-reset-pipeline.json),
[MV reset](../.artifacts/sdt-g60-w159-reset-mv.json),
[post-reset pipeline counts](../.artifacts/sdt-g60-w159-post-reset-pipeline-counts.json),
[post-reset MV counts](../.artifacts/sdt-g60-w159-post-reset-mv-counts.json),
[secret put](../.artifacts/sdt-g60-w159-put-fence-secret.json),
[post-secret versions](../.artifacts/sdt-g60-w159-versions-after-secret.json),
[deploy](../.artifacts/sdt-g60-w159-deploy.json),
[version](../.artifacts/sdt-g60-w159-verify-versions.json),
[deployment](../.artifacts/sdt-g60-w159-verify-deployments.json), and
[final source/binding view](../.artifacts/sdt-g60-w159-verify-final-version-view.json).

The secret-only publication made unannotated version
`db71294f-3dae-476b-944f-206d98b6083c`; one unchanged exact-source deploy made
the final annotated version above. No deploy loop occurred.

## Public cohort

The [raw cohort receipt](../.artifacts/sdt-g60-w159-public-cohort.json) was
flushed after setup, each commit, every fully paged public-list scan, and each
completed sample. Run ID:
`1a60e4cd-d573-4c22-a0a5-b398cb28e101`. It ran from
`2026-09-04T20:12:40.820Z` to `2026-09-04T20:14:50.895Z`.

The instrument used G15/G16 create-room and reserve-room requests followed by
fully paged `GET /api/read/reservations` (page size 1,000). No conformance
health endpoint or conformance token was used. Setup took 6,197 ms and is not
a reservation sample. Timing is command response receipt to the first public
list observation containing the reservation ID.

| # | reservation | event ID | SUID | commit ms | response→public ms |
|---:|---|---|---|---:|---:|
| 1 (cold) | `g15-reservation-1a60e4cdd5734c22-1` | `01a06e0d-69fa-7715-ad1f-eaf6991bdaee` | `063924149568195000001705026963` | 2,742 | 198 |
| 2 | `g15-reservation-1a60e4cdd5734c22-2` | `01a06e0d-9bbe-7105-aa78-5d5021e57b05` | `063924149580934000000406340974` | 2,872 | 226 |
| 3 | `g15-reservation-1a60e4cdd5734c22-3` | `01a06e0d-ce2e-7ee7-851a-2bdc9a107dbb` | `063924149593889000000968970887` | 3,094 | 137 |
| 4 | `g15-reservation-1a60e4cdd5734c22-4` | `01a06e0e-020e-7907-bacf-23b27d69f537` | `063924149607182000001635336287` | 3,192 | 168 |
| 5 | `g15-reservation-1a60e4cdd5734c22-5` | `01a06e0e-367b-74ae-ab41-2fb4fcc905b6` | `063924149620624000001233170953` | 3,971 | 166 |
| 6 | `g15-reservation-1a60e4cdd5734c22-6` | `01a06e0e-6be4-7e3a-94f3-759c601982d3` | `063924149634239000001916402820` | 3,443 | 189 |
| 7 | `g15-reservation-1a60e4cdd5734c22-7` | `01a06e0e-a049-763e-944b-46c97caf7d47` | `063924149647696000000495280147` | 3,486 | 337 |
| 8 | `g15-reservation-1a60e4cdd5734c22-8` | `01a06e0e-d598-7edf-b26f-bffedfe6b69f` | `063924149661470000000226411998` | 3,563 | 207 |
| 9 | `g15-reservation-1a60e4cdd5734c22-9` | `01a06e0f-0aa3-76d7-9b37-dd382e457a92` | `063924149675073000002009964515` | 3,844 | 187 |
| 10 | `g15-reservation-1a60e4cdd5734c22-10` | `01a06e0f-403c-7019-b705-abc644aaed08` | `063924149689043000002023902206` | 3,460 | 202 |

Result: `n=10`, observed `10`, censored `0`, p50 `189 ms`, p95 `337 ms`,
strict `>5000 ms = 0/10`, and `>=5000 ms or missing = 0/10`. Every adjacent
commit was paced at least ten seconds after the preceding commit response.

## Complete durable hop result

The [full ledger](../.artifacts/sdt-g60-w159-ledger.json), [MV receipt](../.artifacts/sdt-g60-w159-mv.json),
and [derived identity-preserving analysis](../.artifacts/sdt-g60-w159-analysis.json)
retain every row with event ID, SUID, attempt ID, service ID, partition,
transport, outcome, and timestamp.

| stage | rows |
|---|---:|
| command receipt | 10 |
| Tag append committed | 20 |
| outbox obligation written | 20 |
| Queue send returned | 20 |
| consumer invocation started | 40 (20 fast/direct, 20 Queue) |
| recordDelivery batch committed | 40 (20 fast/direct, 20 Queue) |
| first unsafe-visible public read | 10 |

| interval | n | p50 | p95 | strict >5000 |
|---|---:|---:|---:|---:|
| command receipt → last Tag append | 10 | 331 ms | 740 ms | 0/10 |
| last Tag append → outbox obligation | 10 | 0 ms | 0 ms | 0/10 |
| last outbox obligation → Queue send | 10 | 1,532 ms | 1,895 ms | 0/10 |
| fast consumer → fast recordDelivery | 20 | 458 ms | 707 ms | 0/20 |
| Queue send → Queue consumer | 20 | 3,473 ms | 7,116 ms | 8/20 |
| Queue consumer → Queue recordDelivery | 20 | 498 ms | 641 ms | 0/20 |
| last fast recordDelivery → public read | 10 | 1,268 ms | 1,552 ms | 0/10 |
| command response → public unsafe read | 10 | 189 ms | 337 ms | 0/10 |

The eight Queue partition intervals above 5,000 ms were later replay intervals;
they did not delay direct unsafe visibility and are not public contract
failures.

## Post-admission and writer boundaries

All W127 start/end pairs were present and identity-correlated:

| boundary | fast n/p50/p95 | Queue n/p50/p95 |
|---|---|---|
| global-receipt readback | 20 / 74 / 106 ms | 20 / 85 / 145 ms |
| source Tag acknowledgement | 20 / 109 / 330 ms | 20 / 135 / 267 ms |
| completeness coverage | 20 / 83 / 176 ms | 20 / 95 / 150 ms |
| detector | 0 / — / — | 6 / 228 / 846 ms |
| unsafe-view apply | 40 / 309 / 572 ms | 40 / 157 / 403 ms |

| writer path/view | n | p50 | p95 | outcomes |
|---|---:|---:|---:|---|
| inline direct / ReservationProjector | 10 | 71 ms | 84 ms | 10 applied |
| inline direct / RoomProjector | 10 | 85 ms | 210 ms | 10 no-change |
| later Queue / ReservationProjector | 10 | 73 ms | 241 ms | 10 duplicate-race |
| later Queue / RoomProjector | 10 | 35 ms | 52 ms | 10 duplicate-race |

Every direct ReservationProjector apply completed while fast completeness ended
`BLOCK/UNSETTLED`. Later Queue envelopes did not double-apply or regress either
view. MV evidence has ten unsafe receipts, ten ReservationProjector safe rows,
zero remaining unsafe rows, zero unsafe failures, and both active instances at
final cohort SUID `063924149689043000002023902206`. The ten reservation
tag-state rows have version 1.

Safe history recorded these ticks:

| tick | kind | proven frontier |
|---|---|---|
| `scheduled:1788552663143` | SETTLED | empty initial frontier |
| `scheduled:1788552783211` | SETTLED | `063924149580934000000406340974` |
| `scheduled:1788552843961` | SETTLED | `063924149634239000001916402820` |
| `scheduled:1788552904687` | SETTLED | `063924149689043000002023902206` |
| `scheduled:1788552964290` | SETTLED | `063924149689043000002023902206` |
| `scheduled:1788553024303` | SETTLED | `063924149689043000002023902206` |
| `scheduled:1788553084318` | SETTLED | `063924149689043000002023902206` |

## Guards, history, and gates

W157/W153 red-before-green receipts remain preserved: direct-doorbell
pre-change, unsafe-writer pre-change, and omission/old-gated mutant receipts
are red. W159 green receipts retain red identity, omission, reorder, old
waitUntil-only, and incomplete-boundary mutants:

- [durable seven-hop guard](../.artifacts/sdt-g60-w159-durable-hop-guard.json)
- [post-admission guard](../.artifacts/sdt-g60-w159-post-admission-guard.json)
- [Queue latency guard](../.artifacts/sdt-g60-w159-queue-latency-guard.json)
- [unsafe-writer guard](../.artifacts/sdt-g60-w159-unsafe-writer-guard.json)
- [W157 direct red](../.artifacts/sdt-g60-w157-direct-doorbell-red.json)
- [W153 writer red](../.artifacts/sdt-g60-w153-unsafe-writer-red.json)
- [W153 writer mutant red](../.artifacts/sdt-g60-w153-unsafe-writer-mutant-red.json)

[The local gate receipt](../.artifacts/sdt-g60-w159-local-gates.json) records
23 successful commands: G15/G16, G26, G41, G44, G49, G51, G52, G53, G54,
G55, G58, G61, G62, D1, the G60 focused lanes, typecheck, lint, and diff
check. G44 is unchanged and green; no gate was weakened, skipped, or
timeout-inflated. The two durable guards were also invoked directly after the
aggregate receipt was created.

The first provable relevant completeness-gating landing remains G62 commit
`05d9d27` / PR #119. The unsafe writer originated in G26 `f7b257b`; this is a
first-provable-history statement, not a stronger causality claim.

The W131-C arm is marked reusable and remains named/intact. Production and W130
resources remain untouched. G56 remains held and no new downstream unit was
started. W159 completes the deployed G60 evidence needed for issue/PR
completion.
