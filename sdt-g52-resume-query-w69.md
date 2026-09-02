# SDT-G52-RESUME-QUERY-W69 — BLOCKED AT SCHEDULE GATE

## Outcome

The W68 cohort was recovered through the single authorized fixed Workers
Observability window, then the continuation stopped before the amended paced
fallback gate. No deployment, Wrangler command, or new application request
was made in this wake.

At `2026-09-02T09:03:30Z`, the W68 two-hour gate was still in the future:
`2026-09-02T10:19:13.824Z`. The interactive runner cannot remain alive until
that gate and then through the paced cohort's 24-hour resume bound, so the
exact next action and all durable state are committed below. This is an honest
schedule stop, not a failed query, a replacement request, or evidence
stitching.

## Immutable W68 identity and recovered retention

| Field | Value |
| --- | --- |
| Cloudflare version | `38921aad-9faf-4ac5-bdfd-1348d7214422` |
| Deployed source commit | `6db728122fefc410e7d9639d62302bb107df13be` |
| Fixed recovery window | `2026-09-02T07:55:00Z` to `2026-09-02T08:35:00Z` |
| Original cohort start | `2026-09-02T08:19:13.824Z` |
| Original cohort discipline | one discarded accepted warm-up plus exactly 50 sequential accepted commits |
| Retained snapshot roots observed now | 2 / 51 invocation requests (3.92%) |
| W68 full client CF-Ray ledger | unavailable: W68 persisted its artifact only after the original bounded receipt, which failed at 0 / 50 |

The recovery read was restricted to the amendment's fixed W68 window and to
`sdt.commit-snapshot/v1` / `commit.snapshot` structured logs. It recovered the
two provider identities that were retained, but it cannot truthfully recreate
the missing 49 client CF-Ray values. The resumed state explicitly rejects a
time-nearest substitute or a second W68 scan. This is why the paced fallback
is required rather than a fabricated 50-ray resume query.

The W70 design observation is retained in the raw recovery state as context:
the same W68 window retained 1 `/append`, 1 `/allocate`, 870 spans, and 89
`/__internal/g44/source-obligations` invocations. It supports the amended
finding that burst retention is about four percent; it is not mixed into a
per-hop table.

## Delivered resume-only tooling

`scripts/deploy/g52-resume-query.mjs` now provides three disjoint modes:

- `recover-w68` performs the one-time, fixed-window, schema-constrained W68
  identity recovery.
- `start-paced` is gated by a new empty state file, sends exactly one discarded
  warm-up then exactly 50 accepted app commits at least 10 seconds apart, and
  atomically writes the warm-up and every accepted CF-Ray before it can send
  the next request.
- `resume` accepts no application URL or sender. It reloads the paced state and
  queries only its immutable 51 CF-Ray set, records schema-complete roots,
  missing request IDs, first-seen query lag per ray, client percentiles/colo,
  partial-or-complete per-hop medians, DO observation medians, and residual
  ranking.

The fixed-window recovery helper in `g30-trace-export.mjs` is deliberately
one-time. All subsequent paced reads use exact persisted CF-Ray filters.

## Persisted state and next action

| Artifact | Purpose |
| --- | --- |
| `.artifacts/sdt-g52-w69-w68-recovery.json` | Provider-backed W68 recovery receipt, including the 2 / 51 ratio and the absence of the historical full ray ledger. |
| `.artifacts/sdt-g52-w69-resume-schedule.json` | Durable decision: wait until `2026-09-02T10:19:13.824Z`, then start the one permitted paced cohort. |
| `.artifacts/sdt-g52-w69-paced-resume.json` | Reserved, initially absent paced-cohort state path. It is written before the paced warm-up and reloaded for all later exact-ray queries. |

The persisted schedule names a single `start-paced` command and a subsequent
`resume` command. Both reference only
`G50_OBSERVABILITY_TOKEN_FILE=/Users/tomohisa/.config/sekiban-dcb/observability-token`;
no credential material is present in the repository. The pacing state has a
24-hour bound from its own warm-up. It must publish a complete table only at
at least 40 / 50 schema-complete roots; otherwise, at that bound, it must
publish the larger partial table labelled `n` and record R-3 with both
cohorts' retained-invocation and retained-snapshot-root ratios. No third
cohort is permitted.

## Verification

- `npm run test:g52` passed: 14 tests, including the deployed sink and mapped
  S-row omission mutants red before green, fixed-window recovery filtering,
  per-acceptance state persistence, 10-second pacing, and exact-ray-only
  resume querying.
- `npm run lint` passed.
- The single live fixed-window recovery query returned 2 retained snapshot
  roots. It did not send any HTTP request to the Worker.

No AC4 per-hop table, client cohort summary, DO median table, residual ranking,
or PR was fabricated: those remain correctly contingent on the paced cohort
and its exact-ray resume result.
