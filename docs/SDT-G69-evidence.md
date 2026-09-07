# SDT-G69 safety evidence

This document records the safety half of SDT-G69/#133. It does not claim the
first-arrival fence or the deployed AC4/AC5 proof.

## AC1 result: live ordering defect

The real local proof used one allocator request for a lower-SUID and a
higher-SUID candidate, then drove the actual Tag append, D1 `recordDelivery`,
G44 coverage, G62 safe-lane pass, and MV read path. No `SETTLED` result or
coverage mock was injected. The higher event became safe before the lower event
was appended/admitted. After the lower event arrived, the detector recorded a
`LATE_LOWER_SUID` `ORDER_VIOLATION` and the safe pass failed closed.

```json
{
  "lowerAllocatedBeforeHigherCommit": true,
  "higherSafeBeforeLowerAdmission": true,
  "detector": "LATE_LOWER_SUID",
  "lowerError": "Materialized-view source admitted a lower SUID after the projection checkpoint"
}
```

This is the consultation counterexample in the current implementation. AC1
therefore does not prove that the existing gate closes the allocation-to-arrival
gap. The first-arrival fence remains unimplemented; SafeWindow, G44/G62
frontier semantics, retries, and drain behavior remain unchanged.

## AC2 safety additions

- `D1EventStore.findLateLowerSuid` checks for a lower SUID whose first durable
  arrival is after the MV checkpoint. A detected event is persisted as an
  `ORDER_VIOLATION` incident and the safe lane fails closed. An already-known
  replay is excluded by its earlier `FirstArrivedAt`.
- Lag estimation no longer excludes an observation merely because a higher SUID
  is already present. The lower-SUID observation can raise the decayed estimate.
- The guard proves both behaviors. The omission detector mutant and restored
  higher-SUID lag-exclusion mutant each exit 1.

## AC3 append-only receipt

Migration `0015_g69_admission_attempts.sql` adds the diagnostic-only
`serialized_dcb_g69_admission_attempts` table. Each `recordDelivery` attempt
records event/tag/source, Queue message and attempt identity, allocator lineage,
obligation sequence, enqueue/arrival/observation clocks, before/after first and
last arrival values, receipt status, retry reason, and `Date.now epoch ms` clock
origin. The receipt is append-only and best effort; no delivery, retry, G44,
MV, or public-read path consumes it. The receipt omission mutant exits 1.

## AC4/AC5 status

AC4 is outstanding because AC1 found a live ordering defect. No first-arrival
fence, SafeWindow change, deployment, production cohort, retry change, drain
change, or G32 operation was performed. AC5 is consequently outstanding and
issue #133 remains open. The PR references #133; it does not close it.

## Verification

At the exact W164 source checkpoint, the following safety checks passed:

- `npm run lint`
- `npm run build --workspace @sekiban/dcb-runtime`
- real focused proof: 1 file, 2 tests passed
- `npm run test:g69`: baseline passed; all three red mutants exited 1 and were
  restored

The current isolated worktree also attempted the relevant G44, G58, G62, G67,
G61, G60 required, G65 required, G41, G43, G26, G27, and typecheck lanes.
Those commands stop before their tests at the known shared-parent
`build:packages`/typecheck resolution problem: stale parent package resolution
reports missing `ExecuteCommandResult`/`SnapshotReader.head` and already-landed
G60/G65/G67 exports/options in the meeting-room sample. They are recorded as
environment exceptions, not green results, and no unrelated package or sample
file was changed to mask them. Hosted exact-head CI remains required before
rereview.

The full red/green receipt is retained at
`.artifacts/sdt-g69-ordering-red-green.json`; W164's complete proof and lane
record remain in `sdt-g69-local-ordering-proof-w164.md`.
