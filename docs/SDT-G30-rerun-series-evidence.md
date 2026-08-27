# SDT-G30 same-C rerun series evidence

Status: **fail-closed; design decision required.** Candidate
`258ab6141988c81c64209faaa65009f1f27258f2` was kept unchanged for the
entire series. Its CI run `33021977272` was green before the live work.
The candidate contains the migration-preflight environment isolation: only
the id-verified binding `wrangler d1 migrations list` child has
`CLOUDFLARE_ACCOUNT_ID` unset. The sealed config's database-id check remains
the identity authority.

The direct read-only preflight immediately before run 5 returned `No
migrations to apply` for both `D1` and `D1_MV`. Run 5 then repeated the full
local G30 suite, including the production-mutation matrix, before deploying
A(off) and B(on). It reached 100 accepted requests in both phases.

## Frozen AC5 outcome

The fixed rule was unchanged for every B cohort: 100 client requests,
schema-complete count at least 95, tail ranks 1 through 5 complete, and no
replacement of missing identities. Missing identities stay `UNKNOWN`; they
never count as a pass.

| Attempt | Furthest phase | B schema-complete | Tail ranks 1-5 | Outcome |
| --- | --- | ---: | --- | --- |
| 1 | B, 100 accepted | 89/100 | complete | delivery budget failed |
| 2 | B, 100 accepted | 91/100 | complete | delivery budget failed |
| 3 | B, 100 accepted | 93/100 | rank 3 missing | delivery and tail gates failed |
| 4 | A, 26 accepted | — | — | transport reset followed by failed durable reread; no resend or replacement window |
| 5 | B, 100 accepted | 91/100 | complete | delivery budget failed |

All five permitted attempts are exhausted. A-prime was intentionally not
started after any B gate failure.

## Loss distribution

- Attempt 1: 11 missing identities (2 `root-absent`, 9
  `schema-incomplete`); ordinals 11, 15, 18, 19, 20, 24, 41, 42, 43, 51, and
  79. `S05a` was the most frequent missing row (7 occurrences), with losses
  across the remaining required row set.
- Attempt 2: 9 `schema-incomplete` identities; ordinals 7, 41, 42, 48, 51,
  58, 60, 63, and 64. Every one was emitted-but-not-ingested `S05a`; none was
  expected-not-emitted.
- Attempt 3: 7 missing identities (1 `root-absent`, 6
  `schema-incomplete`); ordinals 3, 6, 19, 26, 27, 52, and 60. The rank-3
  identity was incomplete. `S05a` was absent in 6 identities; the emitted-row
  inventory classified five incomplete identities as ingestion loss, with no
  expected-not-emitted row.
- Attempt 4: the first A window had 26 accepted entries before a transport
  `TypeError`. The triggering attempt was not resent; its durable fixed-tag
  reread also failed with `TypeError`, so the run stopped without B or A-prime.
- Attempt 5: 9 missing identities (1 `root-absent`, 8
  `schema-incomplete`); ordinals 2, 13, 21, 52, 68, 69, 70, 78, and 81. No
  tail identity was missing. Missing-row occurrence counts were `S05a` 5,
  `S02`/`S03` 3 each, `S01`/`S04`/`S05b`/`S05c`/`S05d`/`S08`/`S09`/`S10`/`S11`
  2 each, and `S00`/`S06`/`S07`/`S12`/`S13`/`S14`/`S15` 1 each. Seven
  incomplete identities had emitted-but-not-ingested rows, one incomplete
  identity was missing `S09` without an emitted-row diff, and the root-absent
  identity had no inventory available. Expected-not-emitted remained empty.

The authoritative local derived record is
`.artifacts/g30-b0-rerun-series.json`; it intentionally excludes raw telemetry,
trace/correlation/request identifiers, tags, payloads, and credentials. The
run-5 failure artifact similarly retains only local redacted diagnostic data.

## Decision requested

No sixth run, no budget change, and no runtime/protocol change was made. The
observed B success counts are 89, 91, 93, and 91 after four complete B
cohorts, all below the frozen 95/100 floor. A design decision is required to
re-evaluate AC5's provider-loss premise or authorize a separately scoped
remediation; this task is not authorized to make either change.
