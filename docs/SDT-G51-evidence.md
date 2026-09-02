# SDT-G51 native commit-span evidence — BLOCKED

## Result

SDT-G51 restores the native row-id projection and adds red-capable guards, but
the deployed proof required by AC5 did not complete. The final bounded retained
trace poll observed **0 of 10** exact cohort traces after its 600,000 ms upper
bound. This document deliberately does not invent a span-name tally or
per-hop medians. R-1 remains open and this branch is not ready for review.

The compact, non-secret terminal evidence is in
`.artifacts/sdt-g51-w63-live-shortfall.json`.

## Deployment identity

The normal, unchanged configuration was
`samples/meeting-room/wrangler.cloudflare-only.jsonc`; no `--keep-vars`, API
token fallback, secret write, or config mutation was used.

| Version | Source commit | Created (UTC) | Cohort result |
| --- | --- | --- | --- |
| `112c77f5-027d-4965-a5bb-4724a91b0858` | `e5123188d046f8e6e286e2aa6e521b47208d4c74` | 2026-09-02T01:31:09.054Z | 1 discarded warm-up + 10 accepted app commits; bounded poll shortfall, 0/10 traces |
| `4b50f525-4230-4cdc-a411-7ea3737800f1` | `a5c9fee75263e900e2d9f3759ef8cf9b7fc32da5` | 2026-09-02T01:49:52.277Z | fresh standalone 1 + 10 cohort; bounded poll shortfall, 0/10 traces |
| `8ef93194-ad94-4a3e-8a5f-545b7845647e` | `69ccc19654c078c3e856c17c1c827fdd6959c630` | 2026-09-02T02:03:01.981Z | final fresh standalone 1 + 10 cohort; bounded poll shortfall, 0/10 traces |

Each cohort used only `POST /api/commands/create-room`, was sequential, and
accepted all ten sampled commits. Each used exactly
`G50_OBSERVABILITY_TOKEN_FILE=/Users/tomohisa/.config/sekiban-dcb/observability-token`
for read-only retained-trace access. The sampler exits before writing its normal
raw client artifact on a proof failure, so no client rays, trace IDs, request
bodies, or token material are retained here.

The first two are diagnostic windows only. They are neither pooled nor used as
AC5 proof. The final version is the live deployment under evaluation and still
does not meet AC5.

## AC1 — deterministic regression location

`scripts/g51-journal-native-regression-check.mjs` is deterministic over the
immutable source graph. It passes at `c2dd342` and is red on `origin/main`:

```text
reference c2dd342: commitWorkerCallsJournal=true,
journalEntersActorSpan=true, reachesNativeActorSpan=true

reference origin/main: commitWorkerCallsJournal=false,
journalEntersActorSpan=false, reachesNativeActorSpan=false
```

The six-commit check is present through `53f14f5`, `beb71a3`, `0af4d0e`, and
`7cc38a4`, becomes absent at G41 `3707688`, is present on the merged historical
`b82f0d2` lineage, and is absent again on current main. The exact mechanism is
that G41 removed `CommitWorker`'s normal Journal admission/transition route.
Consequently the normal commit path no longer reaches
`JournalDurableObject.traceCommitActor()`, which was the call site that invokes
`enterNativeActorHandleSpan()` for the S16 `actor.handle` span. The
`nativeTracing` hand-off lines themselves are unchanged.

## AC2 and AC3 — native row projection and effective guard

`CommitTrace` now projects `sdt.row.id` only to real native spans for valid
`sdt.commit/v1` S-rows, after the established authority-matrix path. It remains
outside the frozen snapshot attribute matrix, so it does not alter commit
ordering, reservations, fences, or response behavior. The same projection is
used for remote native commit spans and S16 actor handlers.

The focused fake-native-tracer check requires the S00 root and every mapped
worker row to enter `enterSpan()` with its explicit `sdt.row.id`. Before this
change it was deterministically red: the entered spans had an all-`undefined`
row-id vector. After the change it is green. The self-test changes the root
condition to skip S00 and is red (`g51-native-root-omission-mutant-red`) while
the unrelated real `CommitWorker` success-row oracle remains green. The check
is part of existing `ci-g30-core` through `npm run test:g51`; no gate was
removed or relaxed.

For the app-surface evidence path, the meeting-room's in-isolate runtime
request now preserves the ingress CF-Ray strictly as an observation join. The
focused relay test verifies the method, body, and application headers are
unchanged. The final root call uses the documented module-form tracer, matching
the Durable Object entrypoints, without touching protocol control flow.

The G41 zero-Journal fixture was not changed. These checks passed on the final
head:

```text
npm run test:g51
npm run typecheck
node scripts/commit-trace-contract.mjs --check
node scripts/g41-journal-contract-check.mjs
vitest run --config vitest.config.ts --maxWorkers=1 test/g41-journal-removal.spec.ts
```

## AC4 — bounded ingestion evidence

The exporter path no longer waits on the former fixed `DEFAULT_SETTLE_MS`.
`g37-sample.mjs` and `g50-commit-latency.mjs` use a 15-second bounded poll that
re-queries exact cohort rays until every ray appears or the configured upper
bound expires. `g51-ingestion-poll-guards.mjs` proves both a two-attempt settled
case and a three-attempt honest shortfall.

For every live cohort above, the configured upper bound was 600,000 ms and the
terminal state was `shortfall` with 0/10 observed traces. Thus the observed
ingestion lag is at least the bounded 600,000 ms ceiling, not a fabricated
zero-delay value. No per-hop table is emitted for a missing trace cohort.

## AC5 — deployed proof remains blocked

The final safe retained-data tally across the final diagnostic query window was:

| Item | Observed |
| --- | --- |
| total retained events | 969 |
| `sdt.commit/v1` events | 3 |
| span-name tally | `actor.handle`: 3 |
| explicit native row tally | `S16`: 3 |
| S00/root events | 0 |
| all other required mapped Worker rows | 0 |
| exact final cohort traces | 0/10 |
| per-hop descriptive medians | unavailable; intentionally omitted |

This tally is redacted diagnostic context only, not a cohort join and not AC5
closure evidence. It establishes that native S16 data can arrive while Worker
S00 and the required mapped Worker rows still do not. Because the exact final
cohort has no retained traces, there is no valid query-window table of S00/S
rows, no client-ray proof, and no per-hop median to publish. R-1 is therefore
**not closed**.

## Next action

Investigate why the active Worker callback records no S00/Worker custom spans
while Durable Object S16 spans are retained, including the platform tracing
state at that entrypoint. Do not reuse any cohort above: a later repair must
deploy and collect its own standalone small cohort.
