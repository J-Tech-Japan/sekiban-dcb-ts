# SDT-G31: real MV `waitFor` and automatic sample list refresh

Closes #66

This draft implements the D1-MV wait contract and the meeting-room sample's
single server-side post-commit list refresh.

## Delivered

- Adds a durable source-target point lookup and generation/definition-bound MV
  wait receipt. A request succeeds only through a receipt or a unique source
  target plus active safe head; a safe head alone cannot alias a missing SUID.
- Gates every wait probe, including the last success proof, on collision or
  lineage incidents, checkpoint-ahead, rebuild, and target poison. The loop
  has a fixed 125-iteration / 252 point-read maximum and one absolute
  request-start deadline.
- Adds immutable D1 migrations for target incident aliases and active wait
  receipts; receipt GC is deliberately followed by the unique-source plus
  active-safe-head branch.
- Changes reserve/cancel to issue exactly one newest-first reservation list
  query with `waitForSortableUniqueId`; a 504 provides manual Refresh guidance
  and does not create browser polling or automatic retries.
- Adds authenticated G31 config and wait-state witness endpoints, fixed-N=10
  command-response→one-list-redraw measurement, and a GC'd old-SUID success
  probe using the existing worker/service/D1/DO/Queue identity.

## Verification

The complete correspondence is in
[docs/SDT-G31-oracle-map.md](./SDT-G31-oracle-map.md). CI runs the bounded
wait, sample wiring, witness, structural, candidate, and forced-red lanes in
addition to the retained G13–G29 suite.

## Candidate protocol

The final sealed C contains all runtime, migrations, sample, tests, CI,
documentation, witness tooling, manifest, and candidate gate material. Its
tree digests are computed before deployment. R changes only the final evidence
and appends C exactly once to the CI retained-candidate list. The candidate
gate rejects all other post-C material changes, a non-final deployment, a
digest mismatch, or a source/deployed runtime mismatch.
