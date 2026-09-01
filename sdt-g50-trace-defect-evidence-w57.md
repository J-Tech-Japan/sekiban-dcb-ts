# SDT-G50 trace-defect evidence — W57

**Task:** `SDT-G50-TRACE-DEFECT-EVIDENCE-W57`
**Status:** completed — client evidence and trace defect documented
**PR:** [#100](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/100) (`Closes #99`)

## Verified deployment

- Pinned-Wrangler OAuth succeeded without an API-token fallback.
- `versions list` mapped version `5610dd9d-2dfa-497b-99e9-9d6903deceab`
  (version 177) to `2cfe5c5284caadc836b2b608820b1396dd8da67e` through
  `SDT-G50 W56 2cfe5c5284caadc836b2b608820b1396dd8da67e`.
- `deployments list` verified that version at 100% traffic. No config change
  or redeploy occurred in W57.

## One fresh cohort

The single run `sdtg50w57-20260901-2242` contains one accepted discarded
warm-up, 50 sequential accepted `POST /api/commands/create-room` samples, and
one retained-trace query attempt:

| Client evidence | Observed |
| --- | --- |
| Caller colo distribution | PDX: 50 |
| Nearest-rank client p50 / p95 | 1,596 / 2,052 ms |
| Discarded warm-up / failed samples | 1 / 0 |
| Retained normalized traces / S-row medians | 0 / none |
| Missing active rows | S00–S03 and S06–S16 |

The sampler now writes this valid client artifact even when native span rows are
missing. It does not create or imply a per-hop table. The change was locally
checked with a no-row fixture before the live run.

## Evidence and defect disposition

- [Client evidence document](docs/SDT-G50-commit-latency.md)
- [Raw client sample](.artifacts/sdt-g50-w57-commit-latency.json)
- The document's exactly titled `Per-hop breakdown BLOCKED by defect` section
  records the query window, empty span-name tally, G37 contrast, exporter
  `sdt.row.id` expectation, G47 S04/S05 removal, and R-1 follow-up input.
- Findings eight through ten are recorded without fabricating trace data.
  Observability/config-var parity remain future guard candidates; G49 was not
  extended.

## Completion

`intent-cli worker complete --outcome pr-created` applied the canonical
issue-side transition. Its child-cwd `linked_pr_synced=false` warning is the
host/review-runtime linkage follow-up, not an implementation-side recovery
action.

Focused verification: `npm run test:g49` passed, including its binding and
migration-parity mutation checks.
