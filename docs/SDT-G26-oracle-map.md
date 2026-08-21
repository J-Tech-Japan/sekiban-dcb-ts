# SDT-G26 acceptance-oracle map

| AC | Oracle / evidence |
| --- | --- |
| 1 | `packages/dcb-runtime/src/downstream/DeliveryCore.ts` is the single `processDeliveryCore(envelope, source)` order; `test/g26-delivery.spec.ts` covers ordering, typed non-stored gating, continuation, duplicate-race disposition, and wrapper-only Queue policy. The existing G25 lane proves the MV row/index/receipt/marker/kick single D1 batch. |
| 2 | `TagDurableObject.pendingOutbox` is the envelope authority. `test/g26-doorbell.spec.ts` compares the full version/service/tag/eventTags/enqueuedAt/lineage envelope bytes sent to Queue and doorbell and proves the doorbell never marks delivery. |
| 3 | `TagDurableObject.autoDrainOutbox` awaits the service-binding RPC inside `DurableObjectState.waitUntil`; `samples/meeting-room/src/worker.cloudflare-only.ts` exports the non-public `MeetingRoomDownstreamDoorbell` entrypoint. `wrangler.direct-doorbell.jsonc` targets that separate Worker, and the preflight exposes the 32-invocation budget. |
| 4 | Core results carry an envelope-bound correlation id (`source:serviceId:eventId:attemptId`); the handoff logs the same id and explicit queued-degraded reason. The four cancellation boundaries are represented in the convergence section of `docs/SDT-G26-deploy-evidence.json`; Queue replay is receipt-idempotent and the G25 atomic MV oracle remains a required regression. |
| 5 | `RuntimeWorkerConfig.deliveryClass` is the domain opt-in; deployment vars and `readDirectDoorbellConfig`/`preflightDirectDoorbell` are the deployment opt-in. Missing capability and budget mismatch are fail-fast or explicitly `queued-degraded`; no implicit fallback is reported. |
| 6 | `test/g26-fanout.spec.ts` aligns two callers after the receipt pre-read. It requires exactly one committed receipt and a typed `UNSAFE_DUPLICATE_RACE` loser; `UnsafeWindowMaterializedView.apply` keeps row/index/marker/receipt/kick in the same batch. |
| 7 | `DeliverySource` is threaded through EventStore implementations. D1/PG/Cosmos estimator writes are skipped for `fast`; `test/g26-delivery.spec.ts` asserts the internal source contract. |
| 8 | `meetingRoomDeliveryViews` creates one handler per view and `DeliveryCore` invokes every handler before aggregate disposition. Typed transient, duplicate-race, and nonretryable poison classes are retained; G25 failure findings and generation-rebuild recovery remain the operator path. |
| 9 | `test/g26-fanout.spec.ts` records a labeled local algorithmic 10-view slope only. `docs/SDT-G26-deploy-evidence.json` has separate remote 1/5/10-view p50/p95/max fields and explicitly does not use Miniflare as capacity evidence. |
| 10 | `docs/SDT-G26-deploy-evidence.json` is the candidate-bound deployed fixed-N record. It reports response→visible separately from command-start→visible, fast/Queue/cron fallback counts, and explicitly states that G26 does not claim total sub-second because POST remains G27 scope. |
| 11 | `npm run test:g25`, the existing safe-only suites, `npm run test:g20`, and the PG build remain regression lanes. The per-view lookup facade is `lookupMeetingRoomMaterializedView`; it does not change the current split-reservation deployment. |
| 12 | `.github/workflows/ci.yml` reaches `test:g26` and `test:g26:forced-red`. `scripts/g20-candidate-check.mjs` carries the non-self-referential G26 evidence rule; final candidate C is retained by the single post-C list append in the bookkeeping commit R. |

The evidence JSON is intentionally a candidate placeholder until the exact
FINAL CANDIDATE is deployed. It contains no credentials or internal/test
headers. Once populated, only the G26 evidence documents and the one retained
candidate-list append may change after C.
