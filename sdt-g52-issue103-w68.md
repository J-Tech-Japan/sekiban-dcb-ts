# SDT-G52-ISSUE103-W68 — BLOCKED

## Outcome

No ready-for-review PR was opened because AC4's retained-log evidence is
blocked. The normal-config deployment succeeded, but the one allowed fresh
measurement window ended with no retained snapshot-log trace roots:

```text
g52-commit-breakdown:retained snapshot trace count is 0; expected 50
```

The sampler reached that receipt only after one discarded accepted warm-up and
exactly 50 sequential accepted `POST /api/commands/create-room` requests. It
then exhausted its bounded exact-CF-Ray ingestion poll. No replacement
requests, second measurement window, manual trace query, or evidence stitch
was performed.

## Deployment identity and measurement discipline

| Field | Value |
| --- | --- |
| Cloudflare version | `38921aad-9faf-4ac5-bdfd-1348d7214422` |
| Deployed source commit | `6db728122fefc410e7d9639d62302bb107df13be` |
| Normal config | `samples/meeting-room/wrangler.cloudflare-only.jsonc` |
| App surface | `POST /api/commands/create-room` |
| Cohort | one discarded accepted warm-up, then exactly 50 sequential accepted commits |
| Retained root requirement | 50 `snapshot-log` roots, each untruncated and schema-complete |
| Terminal retained result | 0 roots observed / 50 required |

The repository-pinned Wrangler completed OAuth-only `whoami` and deployed the
unchanged normal config. No API-token fallback, `--keep-vars`, config change,
or secret rewrite was used. Retained-trace access was supplied only through
`G50_OBSERVABILITY_TOKEN_FILE=/Users/tomohisa/.config/sekiban-dcb/observability-token`;
no token material was printed, copied, or committed.

The sampler writes `.artifacts/sdt-g52-commit-breakdown.json` only after the
50-root receipt passes. Because that receipt failed, no raw success artifact
or `docs/SDT-G52-commit-breakdown.md` was fabricated.

## Delivered implementation and local proof

Commit `6db728122fefc410e7d9639d62302bb107df13be` contains the blocked
implementation work:

- an observation-only, one-record successful `CommitTrace` console sink with
  an explicit 192 KiB deterministic byte guard below Workers Logs' 256 KiB
  record limit;
- deployed-composition wiring in both Cloudflare Worker entry paths;
- a log-root exporter path that joins the retained snapshot's ingress CF-Ray
  and correlation with Worker/DO observations, while keeping one root source
  per trace;
- explicit rejection of `$cloudflare.truncated: true`, missing mapped
  Worker-owned rows, and missing deployed sink wiring;
- a G52 1 + 50 sampler/checker that would recompute client nearest-rank
  percentiles, colo distribution, log-root per-hop medians, DO handler
  medians, and residual ranking from a settled artifact.

The Worker-local snapshot correctly treats S09 and S16 as DO-owned callback
rows; their timing is not fabricated in a public-Worker snapshot and would be
reported through the separately joined `sdt.observe/v1` DO handler table.
S04/S05 remain excluded from the G52 residual table as the G41/G47
structurally removed Journal path.

Checks passed before deployment:

- `npm run lint`
- `npm run test:g52` — 11 tests, including the deployed-sink omission mutant
  and missing-mapped-row omission mutant both red before the guard accepted
  the implementation
- focused `test/g30-trace.spec.ts` and `test/g30-b0.spec.ts` — 103 tests
  passed
- `npm run test:g51` passed in this isolated checkout before the G52 deploy
  window

## Stop boundary

The issue's required per-hop table, client percentiles/colo evidence, DO
medians, truncation observation, and residual ranking cannot be truthfully
published without retained snapshot logs. The deployed 51 requests are not
reusable. A follow-up must first diagnose/re-establish queryable Workers Logs
retention for the structured sink, then use a new standalone deployment and
cohort; it must not stitch this failed window into later evidence.
