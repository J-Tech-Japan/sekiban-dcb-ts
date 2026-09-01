# SDT-G49 normal-config deployed evidence

## Deployed target and fresh W47 window

- Sealed deployed configuration commit: `7fcd2dbeb18d9841823c101badf8bcc28d3d99bf` (`SDT-G49 seal normal D1 G32 lineage`)
- Worker and configured service identity: `sekiban-dcb-meeting-room-cloudflare-only`
- URL: `https://sekiban-dcb-meeting-room-cloudflare-only.ttakaoka.workers.dev`
- Verified Cloudflare version: `6dd811dd-8b3d-450b-b884-55e6b9095b1d`
- Fresh W47 evidence window: 2026-09-01T16:59:05Z through 2026-09-01T17:01:14Z

The [W47 raw receipt](../.artifacts/sdt-g49-w47-window.json) begins with `wrangler whoami` while every API-token fallback variable was unset, then records the normal config, the exact local `7fcd2db` head, and `wrangler versions list`. The version query contains `6dd811dd-8b3d-450b-b884-55e6b9095b1d` annotated with that exact commit, so this window did not redeploy. Wrangler calls were sequential and limited to the implementation seat.

## Seven findings and retained repairs

| # | Finding | Repair and durable proof |
| --- | --- | --- |
| 1 | The normal config lacked `TAG_STATE` and the `v3` Durable Object migration. | Commit `3aa0809` adds the normal-config binding/migration and the derived binding-parity guard. `npm run test:g49` exercises independently red binding-omission and migration-omission mutants. |
| 2 | The normal-config D1 IDs originally named databases absent from the account. | Commit `726ff82` created the two specified databases and bound their returned IDs without changing their names. The pipeline target is now `sekiban-dcb-meeting-room-cloudflare-pipeline` / `f26d1299-82d9-4a64-8647-bc2ec86326ac`; D1_MV is `sekiban-dcb-meeting-room-cloudflare-mv` / `b416b212-4d09-413c-9b8d-7660e475772f`. |
| 3 | The normal deployment had no `SDT_SERVICE_ID`, so `TagDurableObject` suppressed downstream outbox work. | Commit `f81e24b` adds the fixed non-secret identity. Both W47 harnesses ran with the matching `G15_EXPECTED_SERVICE_ID=sekiban-dcb-meeting-room-cloudflare-only`. |
| 4 | The early fresh-D1 procedure omitted the G32 event schema, producing `D1_ERROR: no such table: dcb_events` during `recordDelivery`. | The clean pipeline baseline uses only `migrations/d1/g32/0001_dcb_events.sql` and `0002_g44_global_completeness.sql`, in order; its catalog includes `dcb_events`, `dcb_event_ops`, and the G32 `serialized_*` family. |
| 5 | Combining the root D1 lineage with the G32 baseline produced incompatible legacy `serialized_*` foreign keys and `D1_ERROR: FOREIGN KEY constraint failed` during `recordDelivery`. | The pipeline D1 was recreated under the authorized C-0 wipe after exact identity inventory. Root `migrations/d1` was not applied to its replacement; D1_MV retained its separate `migrations/mv` lineage. |
| 6 | Even after the clean replacement, the normal config still pointed pipeline D1 at the root migration directory, so a later ordinary migration run could reintroduce the incompatible lineage. | Sealed commit `7fcd2db` changes only pipeline `migrations_dir` to `../../migrations/d1/g32`, retains D1_MV at `../../migrations/mv`, and adds exact lineage checks plus independently red root-D1 and D1_MV-drift mutants. The fresh config receipt captures those exact directories. |
| 7 | Six polluted lag estimates, including a `25,312,356 ms` normal-service value, made the safe projector treat its window as indeterminate and kept `mv_rows` at zero. | The [W46 raw receipt](../.artifacts/sdt-g49-pr98-w46-window.json) records the authorized exact `DELETE FROM serialized_dcb_lag_estimates` with six changes, no normal-service estimate before one sanity create-room, `mv_rows` moving from 0 to 14, and a healthy normal-service estimate of `42803 ms` afterward. W47 did not repeat the purge, recreate either database, or replay DLQ messages. |

No runtime/domain source, queue, DLQ, D1_MV resource, or deployed E2E bound/assertion changed for this repair. The [W46 receipt checker](../scripts/g49-w46-receipt-check.mjs) preserves exact target identity, queue/DLQ non-mutation, no-replay, lag-purge, and sanity proof; the [W47 receipt checker](../scripts/g49-w47-receipt-check.mjs) binds that history to the fresh pair below.

## Schema, lineage, and no-replay evidence

The earlier replacement-pipeline catalog is retained in the [W46 raw receipt](../.artifacts/sdt-g49-pr98-w46-window.json): it identifies the pipeline database by name and UUID, records the exclusive G32 catalog (`dcb_events`, `dcb_event_ops`, and the G32-lineage `serialized_*` tables), the separate D1_MV ledger `0001_materialized_views.sql` through `0006_g31_wait_target_poison.sql`, and `mv_rows`. It separately inventories the unchanged outbox queue and DLQ before the W46 work; no DLQ message was replayed.

The normal-config receipt in the fresh W47 window records the same target IDs and the exact exclusive lineage declaration: pipeline D1 uses `../../migrations/d1/g32`, while D1_MV uses `../../migrations/mv`. The version check occurs before either fresh harness, not after a redeploy.

## AC5 external trace evidence

The design-sanctioned [external app-layer trace](../.artifacts/sdt-g49-pr98-w46-ac5-trace.json) leaves the G15/G16 harness unmodified while recording the room and reservation states that the older harness reports did not themselves durably preserve:

- Room `g49-w46-trace-room-9e4c606567df43e1` committed as `063923877189200000000803268585`, read with state `created` and the same available read head.
- Reservation `g49-w46-trace-reservation-9e4c606567df43e1` committed as `063923877194860000000345597074`, read with state `reserved` and the same available read head.

This trace is deliberately separate from the G16 list oracle: the list wire format has no head, and the W47 G16 report honestly retains `readHead: null`.

## Fresh deployed G15 then G16 evidence

The final pair is fresh and sequential, not the interrupted W46 G16 attempt:

- [G15 report](../.artifacts/sdt-g49-w47-g15.json), run `8577e1fd1f24463fab7469a8c7da9b8b`: create-room returned 200 at SUID `063923878766328000000195556096` and was visible as `created` in 990.488 ms; reserve returned 200 at SUID `063923878770241000000120824354` and was visible as `reserved` in 407.987 ms; cancel returned 200 and became visible in 420.965 ms. Raw V1 ingress probes all returned 404.
- [G16 report](../.artifacts/sdt-g49-w47-g16.json), run `9ab0c66c09e2470a92d8863853249213`: create returned 200 at SUID `063923878789406000001307699466`, reserve returned 200 at SUID `063923878796795000000074280444`, and the global reservation-list oracle found the fresh reservation after 24044.696 ms. Its final and every intermediate list observation correctly records `readHead: null`; cancel returned 200 and became visible in 1093.454 ms.

G16 was launched once as a detached process to protect its unmodified 120-second list-query bound from an interactive-runner interruption. Its [process receipt](../.artifacts/sdt-g49-w47-g16-process.json) records runner PID `24499`, npm PID `24509`, finish time 2026-09-01T17:00:32.649Z, `exitCode: 0`, `signal: null`, and the designated report present; the paired [log](../.artifacts/sdt-g49-w47-g16.log) records the exact unmodified `npm run e2e:g16` invocation.

Together, the raw W46/W47 receipts and their executable validators prove the deployed configuration/version target, preserved migration lineage, no-replay boundary, lag-pollution recovery, AC5 state/read-head trace, and one fresh successful G15-to-G16 pair.
