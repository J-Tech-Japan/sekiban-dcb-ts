# SDT-G58 unsafe A/B attribution — W115

- Task: \`SDT-G58-UNSAFE-AB-ATTRIBUTION-W115\`
- Issue: \`#112\`
- Verdict: **blocked; inconclusive from the bounded data**
- Branch: \`claude/sdt-g58-safe-lane-w93\`
- Config: \`samples/meeting-room/wrangler.cloudflare-only.jsonc\`
- Wrangler: \`4.125.0\`

## Scope and identity

This was evidence-only work. No product, test, or configuration source was
edited. The preserved W112 receipt
[\`sdt-g58-w112-paced-cohort.json\`](.artifacts/sdt-g58-w112-paced-cohort.json)
was not rewritten, restarted, or stitched.

Both deployments used the normal config, one exclusive Wrangler OAuth user,
path-only protected credentials, and no \`--keep-vars\`. The OAuth preflight was
not repeated. No Wrangler code 10000 or OAuth/auth failure occurred.

| Variant | Exact source | Deployment record | 100% version | Source annotation |
| --- | --- | --- | --- | --- |
| A — main | \`65a19688d743700d10cab4ba0d3940485b37aab6\` | \`9fcbd98e-210c-4cc1-8fa5-636e89f4ab96\` | \`d851c251-5645-4905-9586-503f66dbf7bb\` | \`SDT-G58 W115 A main 65a19688d743700d10cab4ba0d3940485b37aab6\` |
| B — G58 | \`8d889cfe2e550930a14a7c30c33d80b4b0759344\` | \`f45237bf-37c2-4f73-ba0e-209652187c0d\` | \`660fb952-57bf-4e7a-957e-1e929a31d6af\` | \`SDT-G58 W115 B G58 8d889cfe2e550930a14a7c30c33d80b4b0759344\` |

The active 100% versions and annotations were verified with
\`wrangler deployments list --json\` immediately after each deployment. A
local package-build attempt at exact main exposed a pre-existing
\`src/d1-mv.ts:374\` TypeScript argument-count error; no source workaround was
made, and the Wrangler deployment itself succeeded.

## Remote D1 pre-run counts

Each count was a remote read-only query immediately before that variant's
traffic attempt. No rows were written.

| Variant | Capture | \`dcb_events\` | \`mv_unsafe_receipts\` | \`mv_rows\` |
| --- | --- | ---: | ---: | ---: |
| A — main | 2026-09-03 15:40:07.3–15:40:18.3Z | 5,366 | 208 | 407 |
| B — G58 | 2026-09-03 15:43:42.3–15:43:52.3Z | 5,366 | 208 | 407 |

Raw count metadata is preserved in
[\`sdt-g58-w115-main-precounts.json\`](.artifacts/sdt-g58-w115-main-precounts.json)
and
[\`sdt-g58-w115-g58-precounts.json\`](.artifacts/sdt-g58-w115-g58-precounts.json).

## A — exact main

The one paced-witness invocation wrote
[\`sdt-g58-w115-main-cohort.json\`](.artifacts/sdt-g58-w115-main-cohort.json)
with run ID \`83e03750-eb16-4dc0-8ece-094471bebabf\`. It stopped on the initial
authenticated \`/conformance/v1/read-health\` request with HTTP 404. Exact main
does not expose the G58 health surface, so it issued zero setup-room or
reservation commands:

- n = 0; no first-visibility samples;
- p50 = unavailable; p95 = unavailable;
- over unchanged 5,000 ms = not applicable;
- no cold sample or reservation cohort was emitted.

This is a protocol/surface failure, not an OAuth failure and not a latency
measurement. A was not retried.

## B — exact G58

The one and only B cohort used
\`--paced-count 10 --pace-ms 10000 --poll-ms 2000
--continue-after-unsafe\`. It included the cold first sample, emitted 10
reservation commits, and had a minimum reservation-to-reservation spacing of
13,680 ms. Raw receipt:
[\`sdt-g58-w115-g58-cohort.json\`](.artifacts/sdt-g58-w115-g58-cohort.json).

- Run ID: \`e038aee6-3053-4f29-a1d5-b3b229d1ab79\`
- Interval: 2026-09-03T15:46:07.629Z–15:49:01.563Z
- n = 10
- Harness unsafe dispositions: 4 pass, 6 miss
- Observed first-visibility samples: n = 4; nearest-rank p50 = **3,132 ms**; p95 = **7,438 ms**
- Requested commit-to-first-visibility count over unchanged 5,000 ms: **8/10**
  (two observed values were 7,438 ms and 6,233 ms; six misses had no first
  visibility)
- Full-cohort p50/p95 and safe p50/p95 are not claimed because six samples are
  censored misses. The raw receipt retains every observation and does not
  reclassify late visibility; unsafe proof remains delegated to unpublished
  G60.

| Ordinal | Reservation SUID | First visible at (ms epoch) | Commit→first unsafe (ms) | Harness disposition | Over 5,000 ms |
| ---: | --- | ---: | ---: | --- | --- |
| 1 | \`063924047188111000000120870582\` | 1788450392218 | 3,125 | pass | no |
| 2 | \`063924047201985000001191970427\` | 1788450410449 | 7,438 | pass | yes |
| 3 | \`063924047215687000001432855132\` | 1788450420432 | 3,132 | pass | no |
| 4 | \`063924047229987000000478411011\` | 1788450437213 | 6,233 | pass | yes |
| 5 | \`063924047243484000000123629886\` | — | — | miss | yes |
| 6 | \`063924047257426000001476844191\` | — | — | miss | yes |
| 7 | \`063924047272880000000560394951\` | — | — | miss | yes |
| 8 | \`063924047286677000001602897605\` | — | — | miss | yes |
| 9 | \`063924047300719000000656602468\` | — | — | miss | yes |
| 10 | \`063924047321183000001665199681\` | — | — | miss | yes |

The harness disposition is measured from the start of its unsafe polling loop;
the requested over-5,000-ms column uses commit-to-first-visibility. This is why
ordinals 2 and 4 retain a raw \`pass\` disposition while still exceeding 5,000
ms end-to-end.

### AC1 and per-tick scheduled projector evidence

The report contains 12 health snapshots, each retaining coverage, lag,
materialized-view, live-projector, and global-head fields. All three observed
scheduled coverage groups observed both registered projectors:

| Coverage observed-at | Coverage | RoomProjector attempt / outcome / reason | ReservationProjector attempt / outcome / reason |
| ---: | --- | --- | --- |
| 1788450264204 | SETTLED | 1788450336992 / invoked-but-no-work / poll_in_progress | 1788450336992 / invoked-but-no-work / poll_in_progress |
| 1788450323627 | SETTLED | 1788450414330 / invoked-but-no-work / poll_in_progress | 1788450414330 / invoked-but-no-work / poll_in_progress |
| 1788450388415 | BLOCK/UNSETTLED / source_partition_set_changed_during_scan | 1788450467845 / invoked-and-threw / Projection checkpoint did not converge after concurrent updates | 1788450467845 / invoked-and-threw / Projection checkpoint did not converge after concurrent updates |

The final cohort SUID was
\`063924047321183000001665199681\`, equal to the final global head. The final
health state was:

- coverage: \`BLOCK/UNSETTLED\`, reason
  \`source_partition_set_changed_during_scan\`, partition
  \`reservation:g58-reservation-acc68d23-613-5\`;
- lag estimate 16,970 ms, decayed lag 16,217 ms, SafeWindow 20,000 ms, ceiling
  not exceeded;
- RoomProjector safe head
  \`063924039573941000000201368604\`;
- ReservationProjector safe head
  \`063924039573941000000201368604\`;
- RoomProjector live head
  \`063923889781699000000567681621\`, final poll
  \`invoked-and-threw\`;
- ReservationProjector live head
  \`063923889784848000001880172230\`, final poll
  \`invoked-and-threw\`;
- both materialized and live heads remained below the final cohort SUID;
- committed cohort tag-state versions were not captured because convergence
  failed before the harness could produce \`liveProjectionProof\`.

## Attribution and optional datum

The A and B pre-run row counts are identical, so this pair has no volume
contrast. A cannot supply a no-G58 first-visibility baseline because exact main
has no health route and produced no commands. B does show the G58 health/poll
path progressing from \`poll_in_progress\` to concurrent-update convergence
throws, but the bounded pair cannot distinguish D1 health/poll-write contention
from accumulated operational volume. The attribution is therefore
**inconclusive**.

The optional C-0/C-13 clean-main datum was not run. Purging or recreating
operational data would not repair exact main's missing health surface, so its
same protocol would again yield no n/p50/p95/over-5,000-ms baseline; doing that
mutation would add no attributable evidence. No third cohort was started.

## Preservation and disposition

- The unchanged 5,000 ms unsafe constant and 20,000/120,000 ms SafeWindow
  bounds were not touched.
- Outbox, Queue, global admission, issue/PR state, worker completion, G56, and
  G60 were not touched; G60 remains drafted/unpublished.
- W112 evidence and the G58 source head \`8d889cfe...\` remain preserved.
- The four W115 files are evidence-only generated receipts/count sidecars plus
  this report; no incidental prior receipt drift was edited.
- No PR was opened.
