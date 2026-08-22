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
  reserves 126 loop slots / 254 wait point reads so the 120-second healthy
  pending case reaches its final pre-deadline poll; it has one absolute
  request-start deadline and a true 1000ms backoff cap.
- Adds separate real D1-MV receipt oracles for stored no-change,
  patch-not-found, and delete-without-row, plus separate non-stored collision
  and lineage gates. Real-D1 mid-wait rebuild/poison/checkpoint flips, exact
  20s/120s statement-and-row budgets, and independent 503 wire-shape checks
  close the review findings.
- Adds immutable D1 migrations for target incident aliases and active wait
  receipts; receipt GC is deliberately followed by the unique-source plus
  active-safe-head branch.
- Changes reserve/cancel to issue exactly one newest-first reservation list
  query with `waitForSortableUniqueId`; a 504 provides manual Refresh guidance
  and does not create browser polling or automatic retries.
- Adds authenticated G31 config and wait-state witness endpoints, fixed-N=10
  command-response→one-list-redraw measurement, and a GC'd old-SUID success
  probe using the existing worker/service/D1/DO/Queue identity. Scheduled MV
  safe catch-up/GC runs before generic scheduled polling so historical tag
  polling cannot starve the receipt-GC proof.

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
digest mismatch, or a source/deployed runtime mismatch. The prior G31 C/R is
retained as a checked evidence-history entry; SDT-G31-FIX-1 seals one new C
only after every review correction is present, then redeploys that C once.
