# SDT-G61 post-G62 remeasurement — W148

Task: `SDT-G61-POST-G62-REMEASUREMENT-W148`
Issue: J-Tech-Japan/sekiban-dcb-ts#114
Branch: `claude/sdt-g61-post-g62-remeasurement-w148`
Checkpoint source: `0eb83959732afe7b868fd24c34eadb2035fc9100`
Mode: one deployed measurement-only checkpoint; no product repair, PR, or worker completion transition.

## Result

The pre-G62 projector non-advancement symptom did not survive on the landed G62 source in this fresh cohort. Both `RoomProjector` and `ReservationProjector` were attempted on every observed scheduled tick. The two middle ticks were `BLOCK/UNSETTLED` with reason `source_partition_set_changed_during_scan` and retained the previous head, but the subsequent `SETTLED` tick advanced both projectors to the final cohort SUID. All eleven cohort tag-state reads (room plus ten reservations) returned committed version `1`, and all ten samples met the 180,000 ms safe bound.

This is measurement evidence, not a claim that all G61 acceptance criteria are complete. The remaining G61 work includes consolidating the deployed AC1/AC5 telemetry diagnosis, retaining the AC3 red/green/mutant guard evidence, running the required local gates, and the later PR/AC7 process. No repair or head/tag-state acceptance change was made in W148. Unsafe visibility is recorded only for SDT-G60.

## Identity, authorization, and deployment

- Origin main was fetched and verified at `0eb83959732afe7b868fd24c34eadb2035fc9100`, the requested post-G56 merge.
- Existing worker only: `sekiban-dcb-meeting-room-cloudflare-only`.
- Existing configuration only: `samples/meeting-room/wrangler.cloudflare-only.jsonc`.
- Existing bindings remained in use: pipeline D1 `f26d1299-82d9-4a64-8647-bc2ec86326ac`, MV D1 `b416b212-4d09-413c-9b8d-7660e475772f`, queue `sekiban-dcb-meeting-room-cloudflare-outbox`, and its configured DLQ.
- The five Wrangler-recognized credential variable names were all `UNSET` at preflight: `CLOUDFLARE_API_TOKEN`, `CF_API_TOKEN`, `CLOUDFLARE_API_KEY`, `CF_API_KEY`, `WRANGLER_API_TOKEN`. Every Wrangler invocation used `env -u` for all five. No credential value, prefix, length, or secret was recorded.
- The conformance credential was supplied only through a private `G53_CONFORMANCE_TOKEN_FILE` path. The existing health probe returned HTTP 200, so no rotation or second deployment was needed.
- No resource creation, migration, secret write, or production-data reset was performed.

The single deploy write uploaded the exact source and verified the following active deployment:

| Field | Verified value |
|---|---|
| Worker version | `00e992de-296c-41f5-aa1c-983a7cd7f931` |
| Deployment | `9caa533e-97b7-453b-8a49-ff1026c259d5` |
| Traffic | 100% |
| Annotation | `SDT-G61 W148 exact 0eb83959732afe7b868fd24c34eadb2035fc9100` |

Wrangler uploaded the Worker and deployed triggers, but reported a non-authenticated queue-consumer API error `10013` while partially updating the queue trigger configuration; the command exited 1. This was not code `10000`, OAuth failure, or API authorization failure. It was not retried. The exact command and stdout/stderr are preserved in [the deploy receipt](.artifacts/sdt-g61-w148-deploy.json); [versions](.artifacts/sdt-g61-w148-versions.json) and [deployments](.artifacts/sdt-g61-w148-deployments.json) prove the active exact version, annotation, and traffic.

## Cohort protocol and headline timings

The one and only W148 cohort had run ID `bbfee5e4-c080-4dbe-b570-1719a9046073`, room `g61-room-bbfee5e4-c08`, and ran from `2026-09-04T09:55:29.951Z` through `2026-09-04T09:58:42.182Z`. The cold first sample was included. There were 10 reservation commits; the nine inter-commit intervals were all at least 10,000 ms (observed range 11,722–12,185 ms). Public reservation visibility used page size 1,000 and was fully paged on every read; raw responses were flushed into the cohort receipt as they completed.

Unsafe first visibility is explicitly evidence-only:

| Measure | Value |
|---|---:|
| n | 10 |
| observed | 10 |
| not visible at the 5,000 ms checkpoint | 9 |
| strictly over 5,000 ms | 9 |
| still missing/censored at the end of observation | 0 |
| p50 commit response → first unsafe-visible read | 87,030 ms |
| p95 commit response → first unsafe-visible read | 132,641 ms |

The G61 safe proof was complete for all 10 samples. The nine rows marked `censoredAtBound=true` in the raw receipt were not visible at the 5,000 ms checkpoint, but each became observed later; none remained missing at the end of the safe-bound observation.

| Measure | Value |
|---|---:|
| projector-head safe-proof n | 10 |
| projector-head safe-proof censored | 0 |
| commit response → final cohort head p50 | 115,528 ms |
| commit response → final cohort head p95 | 175,538 ms |
| within 180,000 ms | 10/10 |
| committed cohort tag-state proof | 11/11 |

The full raw measurement, including every request/response and intermediate health snapshot, is [the cohort receipt](.artifacts/sdt-g61-w148-public-cohort.json). The wrapper and harness used to preserve the receipts are [the Wrangler receipt helper](.artifacts/g61-w148-wrangler-receipt.mjs), [the health probe](.artifacts/g61-w148-health-probe.mjs), and [the cohort instrument](.artifacts/g61-w148-public-cohort.mjs).

## Per-sample receipt table

`head Δ` is commit-response time to the first observation at which both final cohort heads were reached. `tag Δ` is commit-response time to the committed tag-state reads. Unsafe values are not a G61 pass/fail condition.

| # | Reservation / cohort SUID | Commit received (UTC) | Commit response ms | Pace ms | First unsafe-visible (UTC) | Unsafe ms | Unsafe disposition | Tag Δ ms | Final head Δ ms |
|---:|---|---|---:|---:|---|---:|---|---:|---:|
| 1 | `g61-reservation-bbfee5e4-c08-1` / `063924112543597000001208680050` | 09:55:43.945 | 1,788 | 11,816 | 09:57:37.109 | 113,164 | over 5,000 | 112,960 | 175,538 |
| 2 | `g61-reservation-bbfee5e4-c08-2` / `063924112555649000001770011478` | 09:55:56.130 | 1,965 | 12,185 | 09:55:58.536 | 2,406 | within 5,000 | 100,775 | 163,353 |
| 3 | `g61-reservation-bbfee5e4-c08-3` / `063924112567779000000440931796` | 09:56:08.303 | 2,172 | 12,173 | 09:58:20.944 | 132,641 | over 5,000 | 88,602 | 151,180 |
| 4 | `g61-reservation-bbfee5e4-c08-4` / `063924112579651000001611189261` | 09:56:20.175 | 1,870 | 11,872 | 09:58:21.356 | 121,181 | over 5,000 | 76,730 | 139,308 |
| 5 | `g61-reservation-bbfee5e4-c08-5` / `063924112591607000000979277334` | 09:56:32.095 | 1,918 | 11,920 | 09:58:21.831 | 109,736 | over 5,000 | 64,810 | 127,388 |
| 6 | `g61-reservation-bbfee5e4-c08-6` / `063924112603554000001196836228` | 09:56:43.955 | 1,858 | 11,860 | 09:58:22.290 | 98,335 | over 5,000 | 52,950 | 115,528 |
| 7 | `g61-reservation-bbfee5e4-c08-7` / `063924112615250000002107574174` | 09:56:55.677 | 1,719 | 11,722 | 09:58:22.707 | 87,030 | over 5,000 | 41,228 | 103,806 |
| 8 | `g61-reservation-bbfee5e4-c08-8` / `063924112627164000001602293955` | 09:57:07.545 | 1,866 | 11,868 | 09:58:23.116 | 75,571 | over 5,000 | 29,360 | 91,938 |
| 9 | `g61-reservation-bbfee5e4-c08-9` / `063924112638867000001602067292` | 09:57:19.377 | 1,831 | 11,832 | 09:58:23.570 | 64,193 | over 5,000 | 17,528 | 80,106 |
| 10 | `g61-reservation-bbfee5e4-c08-10` / `063924112650792000000557068186` | 09:57:31.139 | 1,759 | 11,762 | 09:58:24.089 | 52,950 | over 5,000 | 5,766 | 68,344 |

## Persisted scheduled-tick and per-projector evidence

The receipt persisted four distinct scheduled ticks. Every row has `everyRegisteredProjectorAttempted=true`; therefore the 8 registered-projector poll observations are 8/8 attempted. No `throw` or `fenced` outcome was observed in these four rows. The raw health snapshots retain the surrounding observations and exact response bodies.

| Tick ID | Observed (UTC) | Coverage kind | Reason | Partition tag | Proven frontier SUID | RoomProjector | ReservationProjector |
|---|---|---|---|---|---|---|---|
| `scheduled:1788515706665` | 09:55:06.665 | `SETTLED` | — | — | `063924107376858000002092497585` | attempted 09:55:13.176; `no-work` (`invoked-but-no-work`); head `063924107376858000002092497585` | attempted 09:55:13.176; `no-work` (`invoked-but-no-work`); head `063924107376858000002092497585` |
| `scheduled:1788515765509` | 09:56:05.509 | `BLOCK/UNSETTLED` | `source_partition_set_changed_during_scan` | `reservation:g15-reservation-bf82916cac2447bb-10` | `063924107376858000002092497585` | attempted 09:56:12.691; `advanced`; head `063924107376858000002092497585` | attempted 09:56:12.691; `advanced`; head `063924107376858000002092497585` |
| `scheduled:1788515825961` | 09:57:05.961 | `BLOCK/UNSETTLED` | `source_partition_set_changed_during_scan` | `reservation:g15-reservation-bf82916cac2447bb-10` | `063924107376858000002092497585` | attempted 09:57:13.478; `advanced`; head `063924107376858000002092497585` | attempted 09:57:13.478; `advanced`; head `063924107376858000002092497585` |
| `scheduled:1788515885707` | 09:58:05.707 | `SETTLED` | — | — | `063924112650792000000557068186` | attempted 09:58:19.446; `advanced`; head `063924112650792000000557068186` | attempted 09:58:19.446; `advanced`; head `063924112650792000000557068186` |

The two BLOCK ticks therefore held the last proven frontier and the prior projector heads, but they did not stop scheduled invocation. The later SETTLED tick proved the final frontier and both projector heads reached it. The receipt’s raw `pollReason` values are preserved; where the normalized outcome is `advanced`, the raw outcome is also `advanced`, and where the normalized outcome is `no-work`, the raw outcome is `invoked-but-no-work`.

## Final projector and tag-state proof

Both final live heads were observed as `063924112650792000000557068186` at `2026-09-04T09:58:39.483Z`:

| Projector | Final head | Reached within bound |
|---|---|---|
| RoomProjector | `063924112650792000000557068186` | yes, 10/10 sample deadlines |
| ReservationProjector | `063924112650792000000557068186` | yes, 10/10 sample deadlines |

Every cohort tag was read with HTTP 200 and committed version `1` at `2026-09-04T09:57:36.905Z`; the later repeated reads are also retained in the raw receipt.

| Tag state | Expected cohort SUID | Observed lastSortedUniqueId | Version |
|---|---|---|---:|
| `room:g61-room-bbfee5e4-c08:RoomProjector` | `063924112531638000001259513391` | `063924112650792000000557068186` | 1 |
| `reservation:g61-reservation-bbfee5e4-c08-1:ReservationProjector` | `063924112543597000001208680050` | `063924112543597000001208680050` | 1 |
| `reservation:g61-reservation-bbfee5e4-c08-2:ReservationProjector` | `063924112555649000001770011478` | `063924112555649000001770011478` | 1 |
| `reservation:g61-reservation-bbfee5e4-c08-3:ReservationProjector` | `063924112567779000000440931796` | `063924112567779000000440931796` | 1 |
| `reservation:g61-reservation-bbfee5e4-c08-4:ReservationProjector` | `063924112579651000001611189261` | `063924112579651000001611189261` | 1 |
| `reservation:g61-reservation-bbfee5e4-c08-5:ReservationProjector` | `063924112591607000000979277334` | `063924112591607000000979277334` | 1 |
| `reservation:g61-reservation-bbfee5e4-c08-6:ReservationProjector` | `063924112603554000001196836228` | `063924112603554000001196836228` | 1 |
| `reservation:g61-reservation-bbfee5e4-c08-7:ReservationProjector` | `063924112615250000002107574174` | `063924112615250000002107574174` | 1 |
| `reservation:g61-reservation-bbfee5e4-c08-8:ReservationProjector` | `063924112627164000001602293955` | `063924112627164000001602293955` | 1 |
| `reservation:g61-reservation-bbfee5e4-c08-9:ReservationProjector` | `063924112638867000001602067292` | `063924112638867000001602067292` | 1 |
| `reservation:g61-reservation-bbfee5e4-c08-10:ReservationProjector` | `063924112650792000000557068186` | `063924112650792000000557068186` | 1 |

## Boundaries and next state

- W148 made no product, test, configuration, issue, PR, or acceptance-criteria change.
- The 5,000 ms unsafe contract remains unchanged; its 9/10 over-bound observations are retained for SDT-G60 and do not fail G61.
- No outbox, Queue producer/consumer behavior, global-D1 admission, G53/G55 behavior, G58 surface, SafeWindow, or ordering/fence behavior was changed.
- Actual head/tag-state convergence is measured here for G61 only; no repair was selected or implemented.
- G56 remains completed/held as previously directed; SDT-G60 remains the unsafe-latency unit. No later unit was started and no PR or worker completion transition was performed in W148.
