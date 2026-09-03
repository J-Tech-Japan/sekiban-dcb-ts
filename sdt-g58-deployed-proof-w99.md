# SDT-G58 deployed proof W99

Status: **blocked** at the unchanged unsafe-visibility contract.

This wake began from `a7da2589272842115fb7f8a0c0050f2c2e3494e9` on
`claude/sdt-g58-safe-lane-w93`. It performed the one authorized deployment and
C-0 lag-row purge, then one fresh paced application window. It did not send a
replacement request, run G15/G16 after the failure, stitch evidence, open a PR,
or touch SDT-G56.

## Deployment and purge

Pinned Wrangler OAuth `whoami` passed at 08:58:53.3Z–08:58:56.3Z with all
API-token fallback variables unset. The normal config deployed the exact branch
source once at 09:00:07.3Z–09:00:19.3Z:

- version `2ec23a75-8365-484b-9c8f-1197d3499cec` (version 191);
- annotation `SDT-G58 W99 deployed proof a7da2589272842115fb7f8a0c0050f2c2e3494e9`;
- raw logs/identity: `.artifacts/sdt-g58-w99-deploy.log` and
  `.artifacts/sdt-g58-w99-versions.json`.

The pre-purge inventory found two rows in
`serialized_dcb_lag_estimates`: retired service
`sdt-g47-repair-wake32c-20260831` with estimate `61,546,651 ms`, and deployed
service `sekiban-dcb-meeting-room-cloudflare-only` with estimate `6,591 ms`.
The checked-in `scripts/deploy/g58-ac4-retired-lag-purge.sql` ran exactly once
under C-0/C-13. Its raw receipt reports success, `rows_read=2`,
`rows_written=1`, and `changes=2`; the post-purge inventory contains only the
deployed service row with estimate `6,591 ms`. No D1_MV, queue, event, or
application rows were reset.

## Single fresh paced cohort

Run ID: `97edc4cd-5910-410a-9de9-9f9cbc6fb969`,
`2026-09-03T09:02:04.058Z`–`09:02:48.358Z`.

The runner requested one setup-room command and 10 reservations, paced at
least 10 seconds, with 250 ms list polling. It retained the existing
`unsafeBoundMs=5,000` and safe deadline `safeWindowMs + 120,000 ms`; no
acceptance bound was changed. The setup room was accepted at SUID
`063924022926070000001564666749`.

| Reservation | Commit receipt | First unsafe-visible | Result |
| --- | --- | --- | --- |
| `...-1` | `09:02:18.623Z`, SUID `063924022938171000000990740165` | `09:02:24.015Z` / `5,392 ms` | **fails <=5 s** |
| `...-2` | `09:02:30.658Z`, SUID `063924022950280000000689507569` | `09:02:33.455Z` / `2,797 ms` | pass |
| `...-3` | accepted-command path reached; existing harness does not persist its response before unsafe success | not visible by 5,000 ms | **bounded failure** |

The raw report `.artifacts/sdt-g58-w99-paced-cohort.json` and runner log
`.artifacts/sdt-g58-w99-paced-cohort.log` are committed unchanged. Observed
successful unsafe values have nearest-rank p50 `2,797 ms` and p95 `5,392 ms`;
a full-cohort p50/p95 and safe p50/p95 are intentionally undefined because the
window stopped at reservation 3. No SUID is fabricated for that incomplete
row.

The exact failure was:

```
unsafe reservation g58-reservation-97edc4cd-591-3 was not visible within 5000ms
```

The row-3 health snapshot at `09:02:43.222Z` recorded
`BLOCK/UNSETTLED`, reason `source_partition_set_changed_during_scan`,
`decayedMs=6279`, `safeWindowMs=20000`, global head
`063924022950280000000689507569`, ReservationProjector safe head still
`063924019311336000000431147168`, and two unsafe rows. Earlier health samples
were `SETTLED`/`reason=null`; every fine list observation is retained in the
raw report.

Because the authoritative <=5-second unsafe contract failed, this is a
durable blocked checkpoint. Safe visibility, live-projector/tag-state
completion, `e2e:g58` completion, G15, and G16 were not claimed or run after
the failure. A focused in-scope follow-up must diagnose the row-3
unsafe/gate behavior; changing the published 20-second floor or 120-second
ceiling is not proposed.

Evidence checkpoint commit: `a65062ed9f6156d0fbbfb1b5112b959a1753058c`.
