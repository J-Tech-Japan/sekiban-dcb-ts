# SDT-G61 evidence — W148 post-G62 remeasurement

W148 is a single measurement-only checkpoint on `claude/sdt-g61-post-g62-remeasurement-w148` at source `0eb83959732afe7b868fd24c34eadb2035fc9100`. It deployed the exact source to the existing `sekiban-dcb-meeting-room-cloudflare-only` worker and verified version `00e992de-296c-41f5-aa1c-983a7cd7f931`, deployment `9caa533e-97b7-453b-8a49-ff1026c259d5`, 100% traffic, and annotation `SDT-G61 W148 exact 0eb83959732afe7b868fd24c34eadb2035fc9100`. Wrangler reported non-authenticated queue trigger API error `10013` after the Worker upload; it was not retried. The exact receipts are [deploy](../.artifacts/sdt-g61-w148-deploy.json), [versions](../.artifacts/sdt-g61-w148-versions.json), and [deployments](../.artifacts/sdt-g61-w148-deployments.json).

The five Wrangler token variable names were all `UNSET` at preflight, and every Wrangler invocation stripped all five with `env -u`: `CLOUDFLARE_API_TOKEN`, `CF_API_TOKEN`, `CLOUDFLARE_API_KEY`, `CF_API_KEY`, `WRANGLER_API_TOKEN`. Conformance was path-only; the health probe returned HTTP 200. No resources, migrations, secrets, or production data were changed.

## Cohort summary

One cold-first cohort ran under run ID `bbfee5e4-c080-4dbe-b570-1719a9046073`, with 10 commits paced 11,722–12,185 ms apart. Public reservation reads used page size 1,000 and were fully paged. The raw, incrementally persisted receipt is [sdt-g61-w148-public-cohort.json](../.artifacts/sdt-g61-w148-public-cohort.json).

| Measure | Result |
|---|---:|
| projector/tag safe proof | 10/10 within 180,000 ms |
| final-head commit-response p50 / p95 | 115,528 / 175,538 ms |
| unsafe first-visibility n | 10 |
| unsafe p50 / p95 | 87,030 / 132,641 ms |
| strictly over 5,000 ms | 9/10 |
| not visible at 5,000 ms checkpoint | 9/10 |
| still missing at end of observation | 0/10 |

## Scheduled ticks and projector outcomes

| Tick | Coverage | Proven frontier | RoomProjector | ReservationProjector |
|---|---|---|---|---|
| 09:55:06.665 | SETTLED | `063924107376858000002092497585` | attempted; no-work; same old head | attempted; no-work; same old head |
| 09:56:05.509 | BLOCK/UNSETTLED; `source_partition_set_changed_during_scan`; `reservation:g15-reservation-bf82916cac2447bb-10` | `063924107376858000002092497585` | attempted; advanced outcome; old head | attempted; advanced outcome; old head |
| 09:57:05.961 | BLOCK/UNSETTLED; `source_partition_set_changed_during_scan`; `reservation:g15-reservation-bf82916cac2447bb-10` | `063924107376858000002092497585` | attempted; advanced outcome; old head | attempted; advanced outcome; old head |
| 09:58:05.707 | SETTLED | `063924112650792000000557068186` | attempted; advanced; final head | attempted; advanced; final head |

All four ticks report every registered projector attempted (8/8 attempts), with no throw or fenced outcome. Both final heads were `063924112650792000000557068186`. All 11 cohort tag-state reads returned HTTP 200, committed version 1, and the expected SUID or a later final cohort SUID; details are in the raw receipt and the [full W148 report](../sdt-g61-post-g62-remeasurement-w148.md). Nine samples were still not visible at the 5,000 ms checkpoint, but all were observed later and none remained missing at the end of observation.

Conclusion: the pre-G62 non-advancement symptom is not reproduced on landed G62. The intermediate BLOCK ticks hold the prior proven frontier as expected, then a SETTLED tick advances both heads. W148 does not claim the remaining G61 local guard/process obligations and does not implement a repair.
