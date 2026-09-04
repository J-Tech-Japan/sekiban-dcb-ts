# SDT-G62 PR119 cursor repair — W141

Task: `SDT-G62-PR119-CURSOR-REPAIR-W141`
PR: [J-Tech-Japan/sekiban-dcb-ts#119](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/119)
Issue: [#116](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/116)
Starting branch/head: `claude/sdt-g62-local-ac1-ac3-w132` / `44f98e22652c42db06b77a01f02f201293e506e4`

## Review finding and bounded repair

W140 review [5109479654](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/119#pullrequestreview-5109479654) found that `DownstreamAdapter.sourceAcknowledgementOptions` used service-level `coverage(serviceId, arrivedAt)` and did not prove that the delivered `(serviceId, tag, obligationSequence)` belonged to the successful snapshot cursor. The repair adds `GlobalCompletenessReconciler.coverageForObligation(...)`, which parses the persisted `sdt-g58-settled-frontier/v1` cursor and returns `BLOCK/UNSETTLED` unless the exact tag snapshot upper bound includes the delivery's local obligation sequence. The existing service-level health API remains unchanged for health consumers; the downstream view gate now consumes the precise obligation-aware proof.

No G44 test, 5,000 ms contract, SafeWindow, outbox, Queue, global-D1 admission, ordering, fence, G53/G55/G58/G60/G61 surface, or Cloudflare resource was changed.

## Soundness argument

The proof domain is the immutable source-partition vector captured at the start of a reconciliation pass. The pass walks every captured partition from local sequence 1 through its captured upper bound, checks the exact source page bounds and contiguity, and joins each obligation to its exact global receipt before persisting the cursor and derived frontier. A partition or obligation arriving after that snapshot is outside the cursor and remains unproven until a later pass includes its exact `(serviceId, tag, obligationSequence)`. Therefore a service-level `HEALTHY` bit cannot admit B after an A-only pass. Conversely, a gap, changed page bound, or removed start partition prevents the cursor from settling, so no safe head can cross an unproven in-scope gap. The frontier is never taken from a materialized-view head.

## Local red/green evidence

The AC1 guard's exact `origin/main` pre-fix receipt is `test/fixtures/g62-ac1-real-red-before-green.json`, schema `sdt-g62-w141-ac1-real-red-receipt/v1`, status `red-before-green`, and exit code 1. It uses real Tag commits, source registry rows, outbox acknowledgement handoffs, and D1 global receipts. The three committed stream SUIDs are:

- `062135596802001000000000000001`
- `062135596802002000000000000002`
- `062135596802003000000000000003`

The retained baseline frontier is `062135596801000000061937829279`. Each of the three origin/main passes recorded `UNKNOWN` / `BLOCK/UNSETTLED`, reason `source_partition_set_changed_during_scan`, and that same retained frontier. This is the preserved red-before-green reproduction of the old discard-the-whole-pass behavior against real obligations.

The repaired green receipt is `test/fixtures/g62-w141-ac1-ac3-green.json` (3 focused tests passed). The AC2 integration sequence is real A-only proof → committed/registered B with a persisted global receipt → B blocked before view application because B is absent from the cursor → later scan including B → B applied. The mutant receipt `test/fixtures/g62-w141-mutants-red.json` records exit code 1 for all required mutations:

| mutant | expected red reason |
| --- | --- |
| restore discard-the-whole-pass | `source_partition_set_changed_during_scan` |
| remove start-partition contiguity check | `source_page_sequence_outside_snapshot` |
| omit delivery cursor-membership check | `obligation_not_in_settled_cursor` |

The historical W132 fixture `test/fixtures/g62-ac3-green.json` and `test/fixtures/g62-ac3-mutants-red.json` were restored unchanged. The unchanged G44 suite remains green.

## Local gates

Focused command:

```text
./node_modules/.bin/vitest run --config vitest.config.ts --no-cache --maxWorkers=1 test/g62-global-completeness.spec.ts
```

Result: 3/3 tests passed.

The following all exited 0 without weakened assertions or inflated timeouts:

```text
npm run test:g41
npm run test:g44
npm run test:g49
npm run test:g51
npm run test:g52
npm run test:g53
npm run test:g54
npm run test:g55
npm run test:g58
npm run test:g62
npm run typecheck
npm run lint -- --max-warnings=0
git diff --check
```

`test:g44` reported 8/8 tests and four production mutants red. `test:g62` reported the three focused green oracles and all three required mutants red. G41 printed existing Durable Object teardown warnings while still exiting 0; they are not W141 failures. Running G58 rewrote four generated receipts incidentally; those files were restored and are not staged.

## Deployment and fresh proof

Pending the single authorized deployment to the existing normal-config worker/resources. This section will be completed only after the repaired commit is pushed, exact source/version/bindings/100% traffic are verified, and one fresh cold-first paced cohort of ten reservations has completed.

## Scope and preserved evidence

The W139 deployed cohort and its token-path evidence remain preserved and are not reused as W141 proof. No new Cloudflare resource is authorized. Wrangler invocations, if reached, will strip `CLOUDFLARE_API_TOKEN`, `CF_API_TOKEN`, `CLOUDFLARE_API_KEY`, `CF_API_KEY`, and `WRANGLER_API_TOKEN`; credential reporting will contain names/set-state only and tokens will be referenced by path only. G56, G60, and G61 remain outside this continuation.
