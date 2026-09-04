# SDT-G62 local AC1–AC3 evidence

## AC2 soundness argument (written before implementation)

At the start of each reconciliation pass, the reconciler snapshots the source-partition set and each partition's upper-bound obligation sequence. It walks exactly those snapshots, enforcing the local sequence from 1 through that bound and joining every obligation to the exact global receipt. A partition registered after the snapshot is not in the pass's proof domain; therefore it is absent from that pass's cursor and will be scanned on the next pass. Its arrival cannot invalidate the completed proof for the start-of-pass set. Conversely, an existing in-scope partition whose page changes, has a missing or duplicate sequence, or is removed cannot satisfy the snapshot, page, and contiguity checks; the pass remains non-settled and no safe head may cross that gap. The frontier is therefore only the maximum SUID of receipts proven for the start-of-pass snapshots.

W132 implementation and gate results are recorded in the task artifact:
`.g62-w132/sdt-g62-local-ac1-ac3-w132.md`.
