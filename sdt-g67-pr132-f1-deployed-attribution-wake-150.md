# SDT-G67 PR #132 F1 deployed attribution — W150

Status: **blocked for acceptance**, with the requested deployed evidence complete and preserved. No source change was made. The corrected event-to-applying-pass joins supersede the historical `1608 ms` invocation-delay claim; the corrected scheduling and pass-latency tails are reported below without weakening any bound.

## Scope and identity

- Candidate source: `766f5d328a6615582338ce52965f5017702182eb`.
- W155-C arm: `sekiban-dcb-g60-w155-c`, URL `https://sekiban-dcb-g60-w155-c.ttakaoka.workers.dev`.
- W155-C final candidate version: `3a71bc18-7c3f-4bda-abc1-be7d4aa1cee4`, 100% deployment `9748f8ae-53d7-4e1a-af8a-4a33a1b75b9d`, message/annotation contains the exact candidate source. The preceding secret-only version was `b42f0e27-f1e9-4e3a-9ed9-4fd61d6edacc`; it was not used for evidence.
- Production sample: `sekiban-dcb-meeting-room-cloudflare-only`, URL `https://sekiban-dcb-meeting-room-cloudflare-only.ttakaoka.workers.dev`.
- Production final candidate version: `2d127e8b-d0ba-4fc9-9a78-4126bdef1b42`, 100% deployment `6f971634-7bbc-4e75-bbff-e89613358515`, message/annotation contains the exact candidate source. The preceding secret-only version was `fe3648fe-afcc-4e1b-9088-707204f95aa4`; it was not used for evidence.
- W155-C configuration proof: `DIRECT_DOORBELL=true`, receiver mode `self`, self-binding proof `true`, `DOWNSTREAM_DOORBELL=sekiban-dcb-g60-w155-c#MeetingRoomDownstreamDoorbell`, pipeline D1 `ac751211-fde8-4587-9d56-1e9fd8051bc3`, MV D1 `2b60dbcf-0912-4bb2-93aa-77c26cd260e1`.
- Production configuration proof: `DIRECT_DOORBELL=false`, receiver mode `separate`, and no `DOWNSTREAM_DOORBELL` service binding; pipeline D1 `f26d1299-82d9-4a64-8647-bc2ec86326ac`, MV D1 `b416b212-4d09-413c-9b8d-7660e475772f`. Consequently production ring-arrival/direct-ring rows are zero and are not presented as a G67 direct-ring pass.
- Both existing outbox queues had one consumer and their DLQs had zero consumers in the plain queue inventory. No D1, Queue, DLQ, G32, or old-doorbell resource was created, deleted, or rebound.

Every Wrangler receipt was produced through the existing wrapper with these names recorded as `UNSET` and `noKeepVars=true`: `CLOUDFLARE_API_TOKEN`, `CF_API_TOKEN`, `CLOUDFLARE_API_KEY`, `CF_API_KEY`, `WRANGLER_API_TOKEN`. The conformance token was referenced only by the private path `G53_CONFORMANCE_TOKEN_FILE`/`--token-file`; its value is not in any receipt. The first arm read-health request returned application HTTP 403 (`read-health failed HTTP 403`), not a Cloudflare API authorization failure. Under the existing path-only conformance authority, a fresh private token was installed on W155-C and production, and each secret-only version was followed by exact-source redeployment and version/binding verification.

## Reset and cohort receipts

For each target, C-0 reset used only `DELETE` statements against operational tables; schema and migrations were not changed. The immediate final zero proofs are:

- W155-C: `.artifacts/sdt-g67-w150-w155-final-zero-pipeline.json` and `.artifacts/sdt-g67-w150-w155-final-zero-mv.json`.
- Production: `.artifacts/sdt-g67-w150-production-final-zero2-pipeline.json` and `.artifacts/sdt-g67-w150-production-final-zero2-mv.json`.

The raw cold-first paced receipts are `.artifacts/sdt-g67-w150-w155-cohort.json` and `.artifacts/sdt-g67-w150-production-cohort.json`. Each has `n=10`, at least 10 seconds between commit responses, and persisted public unsafe/safe observations. The durable query receipts and compact lossless joins are retained in `.artifacts/` under the `sdt-g67-w150-w155-*`, `sdt-g67-w150-production-*`, and attribution filenames listed in the raw-receipt index below.

## Attribution method

The actual applying pass is selected from the durable `catch_up_result_json` row whose `appliedEventDetails` contains the exact sampled SUID, preferring the public `ReservationProjector` detail and retaining all view applications in the derived JSON. For every row, `fenceEligibleAt` is the persisted `lastArrivedAt + safeWindowMs` for that event. The reported non-negative `schedulingWaitMs` is `max(0, actualApplyingPass.catchUpStartedAt - fenceEligibleAt)`; raw negative deltas are retained as `fenceToPassStartDeltaMs` because a pass can already be running when an event becomes eligible. `passLatencyMs` is the actual applying pass's `catchUpCompletedAt - catchUpStartedAt`. `lastArrivalUpdates`, owner identity, trigger, stop reason/deadline, and all raw `appliedEventDetails` remain in the derived attribution JSON. No authored event timestamp or client `received_at` was used for these values.

## W155-C arm result

| measure | n | p50 ms | p95 ms | strict misses |
|---|---:|---:|---:|---:|
| command response | 10 | 2809 | 3626 | — |
| unsafe first visibility | 10 | 2850 | 3532 | 0 over 5000 |
| safe first visibility | 10 | 61657 | 120646 | 0 at/over 180000 |
| corrected fence-eligibility → applying-pass scheduling wait | 10 | 1765 | 6600 | p95 over 5000 if that packet gate is applied |
| corrected applying-pass latency | 10 | 1186 | 8761 | p95 over 5000 |

All ten W155-C rows rung and recorded `apply_outcome=applied`; the first admission observations were fast/unknown because the durable global completion read was not observed in those bounded attempts. The actual safe applying pass was event-specific and included delivery and one fence-expiry trigger. The arm therefore proves the corrected attribution path and the unchanged unsafe/safe observation bounds, but it does not prove a <=5000 ms scheduling/pass-latency gate.

|#|eventId|SUID|response|unsafe|safe|ring/apply|admission|trigger|scheduling|actual applying pass|
|---:|---|---|---:|---:|---:|---|---|---|---:|---|
|1|`01a07882-1b74-7f3c-bf92-ebedf1c1b08f`|`063924324988440000001041685361`|3352|2826|120646|rung/applied|fast/unknown|delivery|2123|`delivery:1788728232621:e57ce47b-16ef-44b1-839e-df139766760f`|
|2|`01a07882-504b-77d6-89cc-89c1a68a40b2`|`063924325002491000000522510130`|3512|2926|107132|rung/applied|fast/unknown|delivery|313|`delivery:1788728238927:6ec91a28-e3dc-4699-a5b6-e3aac546205f`|
|3|`01a07882-84af-7c82-a086-086e161e7269`|`063924325015429000001832279219`|3075|2850|94055|rung/applied|fast/unknown|delivery|2837|`delivery:1788728247885:d15fa7e8-3610-40f6-ab8e-f04dd42911d9`|
|4|`01a07882-b6fa-759f-931b-0ed14f98d2b0`|`063924325028310000001361936111`|2712|2833|81342|rung/applied|fast/unknown|delivery|1765|`delivery:1788728276040:3fa287f5-4e40-4559-9c3c-700ea6280030`|
|5|`01a07882-e894-7ce7-b8fc-68380b6e2612`|`063924325040941000000145805155`|2582|2956|68758|rung/applied|fast/unknown|delivery|0|`delivery:1788728276040:3fa287f5-4e40-4559-9c3c-700ea6280030`|
|6|`01a07883-1984-7c82-b973-4cd418f48312`|`063924325053570000000144395544`|2586|2785|56172|rung/applied|fast/unknown|delivery|2667|`delivery:1788728287842:593a1550-5f15-432b-9c04-f23b5bd68d08`|
|7|`01a07883-4b19-712c-a45b-859d6d509075`|`063924325066798000000328411432`|3626|3147|57551|rung/applied|fast/unknown|delivery|0|`delivery:1788728318170:225cc0f2-b93b-4d97-90d0-e05a81459596`|
|8|`01a07883-802b-7956-b125-a9f923cf0687`|`063924325079863000000389715198`|2585|3143|52957|rung/applied|fast/unknown|delivery|2442|`delivery:1788728327600:ce34bf6e-124e-4b40-a531-3d70ff931dd2`|
|9|`01a07883-b196-72db-988c-de7f99efce1d`|`063924325092487000001163035396`|2809|2788|47812|rung/applied|fast/unknown|delivery|0|`delivery:1788728334062:0c682bb7-b0d9-4720-819a-7acebd4b58cf`|
|10|`01a07883-e437-75d5-8363-c3007df2f4f8`|`063924325105572000001455364113`|3114|3532|61657|rung/applied|fast/unknown|fence-expiry|6600|`fence-expiry:1788728349761:68ee4fb2-9fda-4564-997a-d0b2849a7f61`|

## Production sample result

| measure | n | p50 ms | p95 ms | strict misses |
|---|---:|---:|---:|---:|
| command response | 10 | 2428 | 2789 | — |
| unsafe first visibility | 10 | 57420 | 119515 | 9 over 5000 |
| safe first visibility | 10 | 73009 | 121185 | 0 at/over 180000 |
| corrected fence-eligibility → applying-pass scheduling wait | 10 | 1395 | 12774 | p95 over 5000 |
| corrected applying-pass latency | 10 | 1909 | 11593 | p95 over 5000 |

Production has zero direct-ring rows by deployed configuration; all ten rows have queue delivery/consumer evidence. One row's first admission observation was `fast/admitted`; the others were `fast/unknown` in the bounded observation, while the durable Queue path remained present. The safe applying triggers were delivery, fence-expiry, and cron. All ten safe observations were below 180 seconds, but the corrected scheduling/pass tails and 9/10 strict unsafe misses are reported as misses; they are not reclassified as passes. This production run is usable evidence, not a claim that the 5000 ms unsafe contract is satisfied.

|#|eventId|SUID|response|unsafe|safe|ring/apply|admission|trigger|scheduling|actual applying pass|
|---:|---|---|---:|---:|---:|---|---|---|---:|---|
|1|`01a0788b-a3df-7570-ab6a-b0b4f78e4c60`|`063924325613234000000216344999`|2428|119515|121185|none/none|fast/admitted|delivery|864|`delivery:1788728852091:7b3bfa10-7769-42f6-aa82-6e738912e57d`|
|2|`01a0788b-d5bb-765f-86d3-dd4f7bc83537`|`063924325626005000000785249135`|2364|106928|108445|none/none|fast/unknown|delivery|1395|`delivery:1788728878970:47b6759a-3f72-4879-9c62-3be674b37ebe`|
|3|`01a0788c-05f1-7314-8728-f1eeb9d723ea`|`063924325638356000000971963151`|2410|94696|96034|none/none|fast/unknown|fence-expiry|0|`fence-expiry:1788728879620:b7408690-9bd3-47cd-8ade-d17b6068d7ab`|
|4|`01a0788c-37c9-7802-8a1b-a996c948ebd3`|`063924325650952000001085479169`|2575|82312|83458|none/none|fast/unknown|delivery|1467|`delivery:1788728925896:71acce67-e935-488a-89cb-8184fd7d5f0a`|
|5|`01a0788c-697b-7d6c-89ff-c5f23f96946a`|`063924325663700000000274668691`|2789|69696|73009|none/none|fast/unknown|cron|0|`cron:1788728928644:bf91fb23-c406-4c57-9264-9d6ee308cc6c`|
|6|`01a0788c-9a9c-7c23-b109-0bbf7b14c5bd`|`063924325676274000000119057069`|2436|57420|63228|none/none|fast/unknown|delivery|0|`delivery:1788728932553:fa860d78-da79-4c46-a8cc-f643e51b1beb`|
|7|`01a0788c-c9ca-7a04-bbff-6cb832ea5481`|`063924325688458000001163742824`|2236|45375|53355|none/none|fast/unknown|delivery|1749|`delivery:1788728932241:e55b58d7-3b97-45ab-b53e-b0349804df6b`|
|8|`01a0788c-f9e2-7579-aa65-efbdc0902175`|`063924325700997000001454841064`|2517|5309|83234|none/none|fast/unknown|fence-expiry|10600|`fence-expiry:1788728965570:299bd5c5-5845-4c81-85c9-20928a277f4a`|
|9|`01a0788d-320f-7a6e-80aa-f8fa166b56a4`|`063924325715044000000323154612`|2313|19009|69206|none/none|fast/unknown|fence-expiry|12774|`fence-expiry:1788728965570:299bd5c5-5845-4c81-85c9-20928a277f4a`|
|10|`01a0788d-6141-7e75-bff6-0d45b32c7f31`|`063924325727836000000599386515`|2749|4831|62389|none/none|fast/unknown|fence-expiry|7045|`fence-expiry:1788728965570:299bd5c5-5845-4c81-85c9-20928a277f4a`|

The exact per-event `lastArrivedAt`, `fenceEligibleAt`, applying-pass timestamps, owner IDs, all-view applications, hop observations, and last-arrival update arrays are losslessly retained in `.artifacts/sdt-g67-w150-w155-attribution.json` and `.artifacts/sdt-g67-w150-production-attribution.json`. The raw pass `catch_up_result_json` remains in the corresponding pipeline-pass receipts.

## AC4/AC5 classification

- The old W146 `1608 ms` scheduling value is superseded. It was `started_at - scheduled_at` from a selected row and did not prove that row applied the sampled event.
- Corrected F1 attribution is present for all 20 samples and identifies the actual ReservationProjector applying pass (or the only available view), event-specific last arrival, eligibility, trigger, owner, and observed application.
- W155-C: unsafe and safe observations pass their respective recorded bounds, but corrected scheduling p95 `6600 ms` and pass-latency p95 `8761 ms` do not satisfy a 5000 ms scheduling/pass gate.
- Production: safe is 10/10 under 180 seconds, but corrected scheduling p95 `12774 ms`, pass-latency p95 `11593 ms`, and strict unsafe 9/10 over 5000 ms are misses. The production result is therefore blocked evidence, not a pass.
- No repair, acceptance-bound change, or second cohort was performed after these results.

## Raw receipt index

Configuration/deployment receipts include `.artifacts/sdt-g67-w150-w155-deploy.json`, `.artifacts/sdt-g67-w150-w155-redeploy-after-secret.json`, `.artifacts/sdt-g67-w150-w155-final-version-view.json`, `.artifacts/sdt-g67-w150-w155-final-deployments.json`, `.artifacts/sdt-g67-w150-production-redeploy-after-secret.json`, `.artifacts/sdt-g67-w150-production-final-version-view.json`, `.artifacts/sdt-g67-w150-production-final-deployments.json`, `.artifacts/sdt-g67-w150-production-queues-list.json`, and both migration-list receipt sets.

Reset/identity receipts include the W155-C pre/post/final reset/count receipts, the production pre-count, both C-0 reset attempts, and both final zero proofs. Cohort receipts are `.artifacts/sdt-g67-w150-w155-cohort.json` and `.artifacts/sdt-g67-w150-production-cohort.json`. Durable raw query receipts are the eleven W155-C `sdt-g67-w150-w155-*` query files and the eleven corresponding `sdt-g67-w150-production-*` query files for events, safe passes, admissions, rings, hops, subhops, unsafe-writer boundaries, global receipts, and MV unsafe receipts/rows.
