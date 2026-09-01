# SDT-G49 normal-config deployed evidence

## Deployed target

- Commit deployed: `08e89961ab98f473a2ca6acfa08cead6daca9616`
- Worker: `sekiban-dcb-meeting-room-cloudflare-only`
- URL: `https://sekiban-dcb-meeting-room-cloudflare-only.ttakaoka.workers.dev`
- Cloudflare version: `52350239-bd50-4b51-997f-f9eb88e9dfd9`
- Window: OAuth was checked with API-token variables unset. All Wrangler calls in this window were sequential and made only by the implementation seat.

This is a deployed normal-config measurement, not a local Miniflare result. The deployment used `samples/meeting-room/wrangler.cloudflare-only.jsonc` and retained `SDT_SERVICE_ID=sekiban-dcb-meeting-room-cloudflare-only` from that config.

## Five configured-looking-but-inert findings and repairs

| Finding | Repair retained on this branch |
| --- | --- |
| The normal config lacked `TAG_STATE` and the `v3` Durable Object migration. | Commit `3aa0809` adds the derived-binding parity guard and the normal-config `TAG_STATE`/`v3` declaration. `npm run test:g49` passed; its binding-omission and migration-omission mutants were independently red. |
| The normal-config D1 IDs originally named absent databases. | Commit `726ff82` provisioned the two named resources and bound them in the normal config. |
| The normal deployment had no `SDT_SERVICE_ID`, so `TagDurableObject` suppressed downstream outbox work. | Commit `f81e24b` adds the fixed non-secret service identity to the normal config. Both deployed harnesses were run with the matching `G15_EXPECTED_SERVICE_ID`. |
| The early fresh-D1 migration procedure omitted the G32 event schema, yielding `D1_ERROR: no such table: dcb_events` during `recordDelivery`. | The clean replacement D1 received only `migrations/d1/g32/0001_dcb_events.sql` then `0002_g44_global_completeness.sql`, in that order. |
| Combining the root D1 lineage with the G32 baseline made a hybrid schema whose legacy `serialized_*` tables had incompatible foreign keys, producing `D1_ERROR: FOREIGN KEY constraint failed` at `recordDelivery`. | The old pipeline D1 was deleted only after its name/UUID inventory matched; it was recreated with the same name and bound at the new ID in commit `08e8996`. The root `migrations/d1` set was not applied to the replacement. |

No queue, DLQ, or D1_MV resource was deleted or recreated, and no parked DLQ message was replayed. No runtime/domain source or E2E harness assertion was changed.

## Baseline and schema evidence

- Inventory before the authorized delete matched only `sekiban-dcb-meeting-room-cloudflare-pipeline` at `23d8696c-92ae-4753-bb37-86583b1f2923`.
- The recreated pipeline D1 ID is `f26d1299-82d9-4a64-8647-bc2ec86326ac`.
- The committed raw receipt [`.artifacts/sdt-g49-w45-g32-baseline-migrations.json`](../.artifacts/sdt-g49-w45-g32-baseline-migrations.json) records 17 applied statements from G32 `0001` and 10 applied statements from G44 `0002`, with `pendingVerified: true`, `pendingMissing: []`, 27 required objects, and `dcb_events.EventDigest` present.
- Direct remote catalog proof for D1 returned `dcb_events`, `dcb_event_ops`, and the G32-lineage serialized tables: `serialized_dcb_allocator_bindings`, `serialized_dcb_event_arrivals`, `serialized_dcb_lag_estimates`, `serialized_dcb_pending_arrivals`, `serialized_dcb_inconsistency_findings`, `serialized_dcb_delivery_incidents`, `serialized_dcb_projection_checkpoints`, `serialized_dcb_wait_target_incidents`, `serialized_dcb_source_partitions`, `serialized_dcb_global_memberships`, `serialized_dcb_global_receipts`, `serialized_dcb_completeness_scanner_health`, and `serialized_dcb_completeness_findings`.
- D1_MV remained intact: its `d1_migrations` ledger contains `0001_materialized_views.sql` through `0006_g31_wait_target_poison.sql`, and direct catalog verification returned `mv_rows`.

## Deployed goal-element-4 evidence

The committed reports are [G15](../.artifacts/sdt-g49-w45-08e8996-g15.json) and [G16](../.artifacts/sdt-g49-w45-08e8996-g16.json), both against the deployed URL above.

- G15 run `30293e5a9da742e59641fa8ddea2f613`: create-room returned 200 with SUID `063923872354752000000491745875`; `/api/read/room` became visible with state `created`, read head `063923872354752000000491745875`, and 1112.824 ms commit-to-visible latency. Reserve returned 200 with SUID `063923872359973000001263571888`; `/api/read/reservation` became visible with state `reserved` in 813.285 ms. Cancel returned 200 and became visible in 522.580 ms.
- G16 run `f49d584bf1fd45e6bfea05ee239d584e`: create returned 200 with SUID `063923872371114000001393014600`; its room read became visible at that head in 458.854 ms. Reserve returned 200 with SUID `063923872374269000000773862859`; the reservation read became visible in 937.802 ms. The `/api/read/reservations` list-query oracle returned 200 and contained reservation `g15-reservation-f49d584bf1fd45e6` after 62626.291 ms; this wire format has no read-head, so the report records `readHead: null` and the final observation `itemCount: 4`, `containsReservation: true`. Cancel returned 200 and became visible in 463.441 ms.

Together these reports verify goal element 4 for the deployed two-scope normal-config pipeline: command acceptance, projection visibility, room and reservation reads, and the deployed global reservation list-query oracle.
