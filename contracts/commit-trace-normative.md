# Commit-trace normative contract

This document names the rows, boundaries, recovery graph, attribute matrix, and
repair relationships declared by `contracts/commit-trace-manifest.json`.
The trace runtime validates the emitted row and attribute shapes against that
manifest.

## Trace accounting

The request ledger is fixed before trace export begins, and the cohort joins on
`requestId` only. `attemptId` is recorded only on a missing entry when the
incomplete trace supplies it; the trace schema version is a completeness filter,
not a join key. The delivery floor is `schemaCompleteCount >= 85` for the fixed
100-request ledger. The `rank-1..5` client-latency tail must be complete. A
missing root is `root-absent` and uses client latency as its sensitivity upper
bound; a present but incomplete root is `schema-incomplete` and uses observed
root duration. Client latency uses the sealed `nearest-rank` estimator over the
full ledger, while joined per-hop values remain conditional descriptive
estimates.

The manifest declares distinct cardinality rules for root, direct, nested,
fan-out, sequential, member, and callee rows. The trace runtime keeps a row
open through the boundary at which its facts become known.

## Manifest-declared recovery

The manifest declares the `sdt.commit.reconcile/v1` recovery graph. Each branch
declares its required rows, forbidden rows, transition sequence, terminal result,
and whether the invocation terminates. A non-terminal branch leaves the terminal
CAS row forbidden and identifies its continuation. The manifest also declares
repair links by key without making a closed lease row the parent of later item
work.

This repository exports `enterNativeReconcileRootSpan`, but no runtime caller
currently invokes it; these recovery rows and branch rules are schema
declarations, not a claim that runtime reconciliation emits rows today.

## Attribute rules

The manifest's attribute matrix has four faces: pre-admission, accepted,
reconcile-root, and repair-root. It declares required, optional, or forbidden
states for each attribute on each face, including attempt identity only after
admission, raw and derived tag identity forbidden before admission, provider
adapter values not required, fact-derived `recovery.kind` scoped to the
reconcile root, and member attributes scoped to member rows.

The manifest's `generationStateMachine` separates `firedGenerationId` from
`scheduledGenerationId`: handler entry records the fired generation observed at
entry, R01 advances only the scheduled generation, a platform retry keeps the
fired generation, and a self-rearmed fire consumes the prior scheduled
generation. The manifest forbids reattributing a handler to the generation it
scheduled.

## Fencing and compatibility fields

- Bootstrap fencing uses the coordinator's `leaseEpoch` field; its request
  surfaces are specified in the bootstrap contract.
- Allocator issuance uses `pinnedWriterEpoch`; resolution evidence repeats that
  value and terminal tag evidence may carry `tombstoneEpoch`.
- Repair lease input uses the field `epoch`, and emitted repair evidence records
  the same value as `repairEpoch`.
- Tag reservation and fence input also use the field `epoch`; these values stay
  attached to the attempt and tag evidence that supplied them.
