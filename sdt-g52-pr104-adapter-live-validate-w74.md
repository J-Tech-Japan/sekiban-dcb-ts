# SDT-G52 PR #104 adapter live validation — W74

Task: `SDT-G52-PR104-ADAPTER-LIVE-VALIDATE-W74`

Starting PR head: `303332bdabe39fc54c5b2c27308f39316a3b6f03`
PR: https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/104

## Scope and live operation

No deployment was made and no application request was sent. Exactly one read-only `--mode resume` operation ran against the persisted 51-ray W71 paced cohort at `2026-09-02T13:56:09.512Z`; its query scope was the persisted cohort window with normal script/type filters and client-side exact-ray intersection. The cohort remains version `38921aad-9faf-4ac5-bdfd-1348d7214422`, source `6db728122fefc410e7d9639d62302bb107df13be`.

The operation stopped once, without retry, at:

```
g30-trace-export:snapshot-log:snapshot log is missing mapped success row(s) S07
```

This progressed beyond W73's S00 `correlation.id` error. It is live evidence that the returned candidate reached the strict required-row check, not evidence that every candidate contains the exact nested `schema:{version}` representation. The focused fixture covers `correlation:{id}`, `service:{id}`, and `schema:{version}`; the platform identity contract remains strict: `platformRequestId` is the primary join, and a top-level correlation prefix must be at least 32 characters and prefix-match the full nested S00 value.

## Interim evidence

The valid client-only S00 measurement is W71's immutable LAX ledger: `n=50`, nearest-rank p50 `1308 ms`, p95 `2113 ms`. No validated snapshot-root, per-hop, or `do.handler` actor-class median was emitted from W74, because the normalizer rejected the candidate at S07 and intentionally did not persist an unvalidated provider payload. The evidence document and raw failure artifact state that absence explicitly; no residual ranking is fabricated.

R-3 remains: burst snapshot-root retention `2/51`, paced snapshot-root retention `1/51`, and waitUntil-free public-GET retention `0/10`; public Worker fetch invocations for this script are not retained regardless of `waitUntil`, while scanner invocations are retained.

## Validation and CI inspection

- `npm run test:g52` — passed (typecheck, 17 focused tests, and required omission-mutant checks).
- `node scripts/g30-trace-mutation-runner.mjs --self-test` — passed.
- `node scripts/g30-trace-mutation-runner.mjs` — passed, including both native and snapshot platform-ray/client-ledger join gates.
- `ci-g30-core` at dispatch — deterministic mutation-anchor ambiguity: the original anchor occurred twice after snapshot joining. The runner now uses a unique native-root anchor and a dedicated snapshot guard; no production gate was weakened.
- `ci-g43` at dispatch — unrelated 5,000 ms timeout in `test/g43-tag-sql.spec.ts`; untouched in this update.

## Changed material

- Nested snapshot-attribute fixture coverage and a dedicated snapshot platform-ray/client-join mutation gate.
- The W74 persisted resume checkpoint and sanitized failure artifact.
- Updated interim AC4/AC5 evidence, explicitly client-only where the strict snapshot check prevents a valid table.
