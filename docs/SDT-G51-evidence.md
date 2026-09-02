# SDT-G51 native commit-span evidence — AC1–AC4 delivered; AC5 platform limitation recorded

## Decision

The amended AC5 probe ladder stops at P1. A deliberately trivial custom span
in the public sample Worker fetch handler was not retained for any request in
a fresh, exact app-surface cohort. This is a platform-retention limitation of
the current public-Worker/Workers Observability path, not evidence that a
specific commit-path row is absent.

This PR lands the accepted AC1–AC4 implementation and its guards. It does
not claim that the deployed service now retains S00 or the mapped S-rows.
R-1 is narrowed to this statement:

> On the current sampled, normal-config public Worker deployment, a direct
> ctx.tracing.enterSpan() with one attribute is not retained by the bounded
> exact-CF-Ray query. Commit-path custom-span absence therefore cannot be
> distinguished further through retained public-Worker telemetry alone.

The terminal compact evidence is .artifacts/sdt-g51-w64-p1-probe.json. It
contains no token contents, raw provider events, client request identities,
trace IDs, or request bodies.

## Deployment identity and cohort integrity

The deployment used the unchanged normal config
samples/meeting-room/wrangler.cloudflare-only.jsonc. The repository-pinned
./node_modules/.bin/wrangler used OAuth only; no API-token fallback,
--keep-vars, secret write, or config mutation was used. Read-only retained
trace access used exactly
G50_OBSERVABILITY_TOKEN_FILE=/Users/tomohisa/.config/sekiban-dcb/observability-token;
only that path was referenced.

| Version | Source commit | Created (UTC) | Purpose and result |
| --- | --- | --- | --- |
| 112c77f5-027d-4965-a5bb-4724a91b0858 | e5123188d046f8e6e286e2aa6e521b47208d4c74 | 2026-09-02T01:31:09.054Z | W63 diagnostic only; 1 discarded warm-up + 10 accepted commits; trace shortfall 0/10 |
| 4b50f525-4230-4cdc-a411-7ea3737800f1 | a5c9fee75263e900e2d9f3759ef8cf9b7fc32da5 | 2026-09-02T01:49:52.277Z | W63 diagnostic only; standalone 1 + 10; trace shortfall 0/10 |
| 8ef93194-ad94-4a3e-8a5f-545b7845647e | 69ccc19654c078c3e856c17c1c827fdd6959c630 | 2026-09-02T02:03:01.981Z | W63 diagnostic only; standalone 1 + 10; trace shortfall 0/10 |
| 0e801aeb-086e-4c18-bc79-b61bf5e9e304 | 9f3348a7d4ca693a54bb119c8d230f1015a663fc | 2026-09-02T03:28:15.363Z | W64 P1; fresh standalone 1 + 10; direct probe retained for 0/10 |

The W63 windows are context only and are not pooled with W64. The W64 P1
window is one discarded, accepted POST /api/commands/create-room warm-up
followed by exactly ten sequential, accepted app-surface commits; it has no
replacement request or stitched evidence.

## AC1 — deterministic regression location

scripts/g51-journal-native-regression-check.mjs is deterministic over the
immutable source graph. It passes at c2dd342 and is red on origin/main:

~~~text
reference c2dd342: commitWorkerCallsJournal=true,
journalEntersActorSpan=true, reachesNativeActorSpan=true

reference origin/main: commitWorkerCallsJournal=false,
journalEntersActorSpan=false, reachesNativeActorSpan=false
~~~

The six-commit check remains present through 53f14f5, beb71a3, 0af4d0e, and
7cc38a4, becomes absent at G41 3707688, is present on the historical b82f0d2
lineage, and is absent again on current main. G41 removed CommitWorker's
normal Journal admission/transition route. The normal commit path therefore
no longer reaches JournalDurableObject.traceCommitActor(), the call site that
invokes enterNativeActorHandleSpan() for S16 actor.handle; the nativeTracing
hand-off lines are not the regression.

## AC2 and AC3 — row projection and a red-capable guard

CommitTrace projects sdt.row.id only to real native spans for valid
sdt.commit/v1 S-rows, including S00 and S16. The projection stays outside the
frozen snapshot attribute matrix and does not alter commit ordering,
reservation, fence, or response behavior.

The fake-native-tracer guard requires S00 and every mapped Worker S-row to
enter enterSpan() with its explicit sdt.row.id. The pre-fix vector was
deterministically all undefined; after the fix it is green. Its root-omission
mutant is independently red (g51-native-root-omission-mutant-red) while the
unrelated real CommitWorker success-row oracle remains green. The guard runs
in ci-g30-core through npm run test:g51; no gate was removed, weakened, or
given a longer timeout.

The app-surface ingress CF-Ray relay remains observation-only. Its focused
test proves that the in-isolate request keeps its method, body, and application
headers. The final commit root uses the documented module-form tracer without
changing protocol control flow. The G41 zero-Journal fixture remains unchanged.

## AC4 — bounded ingestion poll

The exporter no longer uses the former fixed DEFAULT_SETTLE_MS wait.
g37-sample.mjs and g50-commit-latency.mjs re-query an immutable exact-ray
cohort every 15 seconds until it settles or reaches an explicit upper bound.
g51-ingestion-poll-guards.mjs exercises both a settled case and an honest
shortfall.

P1 provides a new live confirmation: the query window was
2026-09-02T03:27:41.239Z through 2026-09-02T03:39:58.234Z. The poll began at
03:28:58.232Z, made 40 exact-ray attempts, and reached its 600,000 ms deadline
at 03:38:58.622Z with an honest shortfall of 0/10. It did not turn that
shortfall into an empty success or a time-nearest join.

## Amended AC5 — P1 public-Worker probe

P1 is a control span placed directly in the sample Worker's fetch handler
for /api/commands/*, before command dispatch:

~~~text
ctx.tracing.enterSpan("sdt.g51.probe.p1", ...)
span.setAttribute("sdt.g51.probe", "p1")
~~~

It has exactly one application attribute. The probe sampler constrains both
$metadata.rayId to the immutable ten-request cohort and
$metadata.spanName to sdt.g51.probe.p1; it independently verifies the
returned name and attribute before counting a request. Its local guard also
proves the query rejects unrelated names, reports rayless retained spans
honestly, and keeps P1 at the direct fetch boundary.

| P1 fact | Observed |
| --- | ---: |
| discarded warm-up / accepted samples | 1 / 10 |
| caller colo | PDX: 10 |
| client p50 / p95 | 1,590 / 1,960 ms |
| bounded query attempts | 40 |
| exact rays with matching retained P1 | 0 / 10 |
| retained P1 spans | 0 |
| retained P1 spans with expected attribute | 0 |
| rayless/unjoinable retained P1 spans | 0 |
| terminal verdict | no-retained-probe-span-for-exact-cohort |

This is the amended stop condition. P2, P3, and P4 were not deployed, and no
second window was consumed: P1 itself is not retained, so a deeper nested or
S00-shaped probe would not explain the loss. The original S00/S-row live proof
is intentionally neither fabricated nor inferred from P1.

## Follow-up boundary

The next R-1 slice should use two independent signals:

1. A Durable-Object-side native-span probe, because the earlier diagnostic
   tally retained S16 actor.handle there.
2. Client-timing (and, if available, provider timing) evidence for the same
   app-surface cohort, so latency work does not depend on absent public-Worker
   custom spans.

It must use a new standalone deployment/cohort after the provider behavior is
understood; it must not reuse any W63 or W64 request window.

## Checks on the P1 source commit

~~~text
npm run test:g51
npm run typecheck
node scripts/deploy/g51-probe-ladder-guards.mjs
~~~

All passed at 9f3348a7d4ca693a54bb119c8d230f1015a663fc. The G41 contract and
focused fixture also passed unchanged during W63 and remain part of CI.
