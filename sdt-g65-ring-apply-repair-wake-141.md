# SDT-G65 RING/APPLY repair — WAKE-141

Task: `SDT-G65-RING-APPLY-REPAIR-WAKE-141`

Branch: `claude/sdt-g65-local-wake-w128`

Base/source inspected: `df77a01b2fe95186bbf2baeba2d0408167992b53`

This is a deploy-free local checkpoint. No Wrangler, Cloudflare, deployment,
resource, secret, PR, review, merge, or claim operation was performed.

## Diagnosis

W141's self-mode evidence was not evidence of an absent receiver. It recorded
11/11 durable rings as `rung`, with the direct invocation reaching
`DeliveryCore`; its durable unsafe-writer rows included fast `applied` and
`no-change` rows (and later Queue duplicate/race rows). The misleading rows
were `apply_outcome=failed` with `apply_error=null`.

The exact non-throw path is:

1. `applyG65DirectRing` invokes the shared `processDownstreamDoorbell`.
2. `processDeliveryCore` applies independent-unsafe views before the G44
   completeness callback.
3. `sourceAcknowledgementOptions` then calls
   `GlobalCompletenessReconciler.coverageForObligation`. In the fresh direct
   invocation W141 observed `BLOCK/UNSETTLED` because scheduled coverage had
   not yet proven the obligation.
4. The core returns its already successful unsafe `views` together with a
   completeness failure and `fastDisposition="failed"`.
5. The old G65 code copied only `fastDisposition` into the direct APPLY
   ledger. Because no exception escaped, `apply_error` stayed null.

This is an observability/classification defect in the G65 ledger, not a G44
fence defect and not proof that direct unsafe execution was skipped.

## Repair

`applyG65DirectRing` now classifies only the configured independent-unsafe view
results for the G65 APPLY outcome:

- all selected views `duplicate-race` → `duplicate`;
- selected views all `applied` or `duplicate-race`, with at least one
  `applied` → `applied`;
- no selected unsafe view or any selected view `failed` → `failed`.

The full-core disposition remains unchanged and is logged separately. Each
`DeliveryCoreResult.failure` is recorded with a stable diagnostic
`failureId` (`phase:view-or-core:class`), phase, class, view identity, and
error text. Thus an unresolved completeness result remains a visible
fail-closed core/Queue condition while a verified unsafe writer is recorded as
`applied` or `duplicate`. The 100 ms durable ring, `waitUntil` APPLY, outbox,
Queue ordering/retry/DLQ behavior, G44 safe fence, idempotence, and all G60
mutants are unchanged.

The local receiver test seam now permits a test-only `beforeViews` callback.
The new regression test injects an unresolved completeness failure after an
independent-unsafe view has applied and proves the durable G65 ledger ends in
`apply_outcome=applied`, `apply_error=null`. It does not change deployed
bindings or production composition.

## Red/green evidence

- Pre-change guard: `node scripts/g65-ring-apply-guard.mjs --pre-change
  --receipt .artifacts/sdt-g65-w141-ring-apply-repair-pre-change.json` exited
  1 as the expected red receipt. The pinned pre-change source lacked the
  RING/APPLY wiring and the corrected unsafe-outcome/failure diagnostics.
- Green guard and mutants:
  `node scripts/g65-ring-apply-guard.mjs --self-test --receipt
  /private/tmp/sdt-g65-w141-ring-apply-guard.json` exited 0.
  The awaited-APPLY mutant was red and the aggregate-full-core-disposition
  mutant was red.
- Focused `test/g65-ring-apply.spec.ts`: 2 tests passed, including the
  unresolved-completeness regression.
- G65 focused Vitest/admission and both G65 guard/mutation oracles: exit 0;
  the production idempotence-removal oracle was red under mutation and green
  before mutation. The six pre-existing G60 mutants remained unchanged and
  green.

## Local gates

Passed on the repaired working tree: `npm run typecheck`, `npm run lint`,
`git diff --check`, `npm run test:g26` (32 tests), `npm run test:g29:delivery`
(7 tests), `npm run test:g38:prep` (9 receiver tests and packet/config/tombstone
guards), `npm run test:g60:required`, `npm run test:g44` (8 tests and all G44
production mutants red), `npm run test:g58` (15 tests and guards),
`npm run test:g62` (G62 green/mutant-red guard), `npm run test:g61` (red-before-
green/mutant-red guard), `npm run test:g41` (8 tests and production mutants
red), and `npm run test:g43` (20 tests and all five production mutants red).

The additional CI-equivalent checks `g21`, `g22`, `g23`, `g24`, `g25`, `g28`,
`g31`, `g32:bridge`, `g42`, `g45`, `g46`, `g49`, `g52`, `g53`, and `g55` all
exited 0. Their full output and the G41/G43 runner output are retained in the
untracked `.artifacts/sdt-g65-w141-*` receipts.

One unrelated pre-existing lane exception remains: `npm run test:g54`
failed `test/g54-interop.spec.ts` R3 (1 failed, 17 passed), expecting
`invalid_payload_utf8` but observing `invalid_payload_json`. The worktree
already contained an unrelated non-fatal `TextDecoder` change in
`packages/dcb-runtime/src/commit/CommitWorker.ts`; it was not staged or
modified by this repair. The known W140 G30 trace-mutation runner exception
is preserved in `.artifacts/sdt-g65-w140-g30-core.log`; it is an environment/
runner condition, not a G65 failure, and no G30 source or gate was changed.

All prior dirty and untracked W129–W141 evidence, G58/G62 fixtures, G30
trace files, and unrelated source changes were preserved. The only intended
files in this checkpoint are the receiver classification, the test-only
seam, the G65 guard, the focused regression test, this evidence, and the
write-path explanation.

## Boundaries and next proof

This checkpoint does not claim deployed acceptance. A later authorized
deployment must reverify that the direct ledger records `applied`/`duplicate`
with the path-labelled unsafe-writer rows, that Queue replay is idempotent,
and that the unchanged unsafe/safe acceptance bounds hold. No deployed state
was touched here.
