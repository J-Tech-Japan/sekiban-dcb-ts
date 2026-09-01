# SDT-G47 post-G41 deployed measurement

Status: **complete measurement record; the same-colo AC2 claim is withdrawn**.

This record covers the authorized SDT-G47 repair and the one artifact-bearing
post-repair measurement. The measurement was made by the existing
scripts/deploy/g37-sample.sh / scripts/deploy/g37-sample.mjs flow. No
packages/*/src file was changed.

## Result in one sentence

For a **WARM TagStateDO**, the observed client p50/p95 difference between a
1-event and a 5000-event tag was **26/44 ms**; however, the same-colo claim is
**withdrawn** because the sampled windows were **PDX** and **EWR** rather than
one colo.

The exact claim verdict is:

~~~
WITHDRAWN (sameColo=false)
~~~

The numbers remain a descriptive deployed observation. They do not establish
history-length sensitivity across colos and are not an acceptance gate.

## Repair

The diagnosed production error was schema drift: the deployed databases lacked
the G44 EventDigest column and completeness tables. The committed migration
files were applied remotely in order, with the same helper used before the
Worker deployment to verify that the final run was idempotent.

| Remote D1 | 0001 dcb_events | 0002 G44 completeness | Post-apply verification |
| --- | ---: | ---: | --- |
| sekiban-dcb-meeting-room-g32-9043d626fe1149cb-pipeline | 17 already present / 0 applied | 10 applied | pendingVerified=true, pendingMissing=[], EventDigest present, required objects and columns present |
| sekiban-dcb-meeting-room-g32-9043d626fe1149cb-mv | 17 applied | 10 applied | pendingVerified=true, pendingMissing=[], EventDigest present, required objects present |

The initial D1 catalog showed all 0001 statements present and all ten 0002
statements missing. The initial D1_MV catalog lacked the required 0001/0002
objects. No data reset or database recreation was needed; that operation was
authorized by C-0 but was not performed.

Raw repair receipts:

- [D1 repair receipt](../.artifacts/sdt-g47-repair-wake32-d1.json)
- [D1_MV repair receipt](../.artifacts/sdt-g47-repair-wake32-d1-mv.json)

The deployment script now derives CLOUDFLARE_ACCOUNT_ID from non-interactive
wrangler whoami, checks both remote databases before the Worker deployment,
applies only missing statements from
migrations/d1/g32/0001_dcb_events.sql and
migrations/d1/g32/0002_g44_global_completeness.sql, verifies the resulting
schema, and removes its mode-600 temporary SQL files. The final pre-deploy
check was a no-op on both databases: every migration statement was skipped and
pendingMissing=[].

The final script also validates the profile before deployment and waits five
seconds after deployment by default for Worker/secret propagation. This avoids
creating a deployment whose first conformance request is sent before the
rotated secret is available.

## Focused non-live guards

The accepted guards were run before the successful live measurement:

~~~
node scripts/deploy/g37-sample-guards.mjs
fullHistoryLengthProfile passed: serviceId guard-service-full, windows 1/5000,
  cold reads 1/79, warmup 1 each, 50 sampled
firstSeedPartialWriteNoArtifact passed: exit 1, no artifact, one first seed request
defaultSingleProfileRegression passed: serviceId guard-service-single,
  sampleCount 3, artifact true
~~~

The first-seed partial_write guard confirms that the sampler does not publish
a measurement artifact for an incomplete seed.

## Deployment and measurement provenance

The successful run used a new service identity and candidate namespace:

| Field | Value |
| --- | --- |
| source commit deployed | e7317fc3f74c6d34e2f200c6212595935b5f3b48 |
| deployed Worker version | number 169, id 8f7fd0b3-0a64-4afe-af5a-c3869e79cd2e |
| deployed at | 2026-09-01T00:27:50.26765Z |
| service identity | sdt-g47-repair-wake32c-20260831 |
| candidate | sdt-g47-repair-post-migration-wake32c-20260831 |
| profile | history-length |
| session | one sequential g37-sample.mjs process |
| deployment count in measurement | 1 |
| sample count | 50 per window |
| captured at | 2026-09-01T00:30:49.862Z |
| client colos | short PDX; long EWR |

Invocation:

~~~
SDT_SERVICE_ID=sdt-g47-repair-wake32c-20260831 \
G37_CANDIDATE=sdt-g47-repair-post-migration-wake32c-20260831 \
G37_PROFILE=history-length G37_SAMPLES=50 G37_DEPLOY_SETTLE_SECONDS=5 \
WRANGLER_WRITE_LOGS=false bash scripts/deploy/g37-sample.sh
~~~

The resulting raw measurement is
[.artifacts/g37-sdt-g47-repair-post-migration-wake32c-20260831-e7317fc3f74c.json](../.artifacts/g37-sdt-g47-repair-post-migration-wake32c-20260831-e7317fc3f74c.json).
The before/after deployed-version receipts are
[versions-before](../.artifacts/g37-sdt-g47-repair-post-migration-wake32c-20260831-e7317fc3f74c-versions-before.json)
and
[versions-after](../.artifacts/g37-sdt-g47-repair-post-migration-wake32c-20260831-e7317fc3f74c-versions-after.json).
The no-op migration receipts are
[migrations-d1](../.artifacts/g37-sdt-g47-repair-post-migration-wake32c-20260831-e7317fc3f74c-migrations-d1.json)
and
[migrations-d1-mv](../.artifacts/g37-sdt-g47-repair-post-migration-wake32c-20260831-e7317fc3f74c-migrations-d1-mv.json).

### Discarded setup attempts

Two earlier deployments in this wake are disclosed and excluded from the
measurement. Neither produced a measurement artifact. The third attempt above
is the only successful, artifact-bearing sample.

| Attempt | Version | Service / candidate | Outcome |
| ---: | --- | --- | --- |
| 1 | 167 / b7b3f2be-c48f-4619-8abd-a7681403ab3c | sdt-g47-repair-wake32-20260831 / sdt-g47-repair-post-migration-wake32-20260831 | stopped before HTTP because the invalid profile value history was rejected; no measurement artifact |
| 2 | 168 / f5ee416a-0360-429a-9ae2-a73788a3d74c | sdt-g47-repair-wake32b-20260831 / sdt-g47-repair-post-migration-wake32b-20260831 | first seed returned HTTP 403, code unauthorized, Conformance authentication required, Ray a34023876c7e45c2-ATL; no measurement artifact |
| 3 | 169 / 8f7fd0b3-0a64-4afe-af5a-c3869e79cd2e | sdt-g47-repair-wake32c-20260831 / sdt-g47-repair-post-migration-wake32c-20260831 | completed after profile prevalidation and the five-second propagation settle |

The attempt ledger, including the raw version receipt names, is
[sdt-g47-repair-wake32-attempts.json](../.artifacts/sdt-g47-repair-wake32-attempts.json).

## Review repair — derived ledger correction

The PR review at pinned head `90b83653c554936e1b40fce157e297117e23c2b8`
found that the original `captureHistoryLengthWindow` ledger formula used
`historyLength + index`. The sampled operation is a read-only TagStateDO read,
so that formula falsely implied that history grew on every read. The source now
records the constant window history for every row.

The existing raw artifact was corrected as derived evidence, without a deploy
or sampling rerun:

- all 100 ledger rows now agree with their window's before/after history;
- 98 rows and 196 derived history fields were corrected (the first row of each
  window already matched);
- short is constant `1 → 1` and long is constant `5000 → 5000`;
- request IDs, timestamps, status, colo, latency values, client summaries,
  seed receipts, cold replay, warm-up, and the withdrawn same-colo verdict were
  not changed;
- the raw artifact records `measurementRerun=false` and the prior/corrected
  formulas under `evidenceCorrection`.

The repair guard checks every row in both windows and deliberately mutates one
copy of a row to prove the guard rejects the false history. It is non-live and
does not call Cloudflare.

## AC2 — warm history-length observation

The sampler discarded exactly one warm-up read for each window. The warm
condition was:

> the bounded cold replay reached READY, then exactly one TagStateDO read was discarded before the sampled window

The two windows were:

| Window | Actual history before → after | Discarded warm-up | Sampled client colo | p50 / p95 |
| --- | ---: | --- | --- | ---: |
| short | 1 → 1 | 89 ms, PDX, HTTP 200 | PDX | 84 / 95 ms |
| long | 5000 → 5000 | 114 ms, EWR, HTTP 200 | EWR | 110 / 139 ms |

The descriptive differences (long minus short) are p50 26 ms and p95
44 ms. Since the windows did not share a colo, the same-colo AC2 claim is
withdrawn. No history-length sensitivity verdict across colos is asserted.

## AC3 — cold replay information

Cold replay is a one-time rebuild cost and is informational, not a failure:

| Window | History | Cold replay | Result |
| --- | ---: | --- | --- |
| short | 1 | 1 request, 667 ms, PDX, first/final HTTP 200 | informational; bounded replay reached READY |
| long | 5000 | 79 requests, 78 rebuild-in-progress responses, 11,953 ms, final HTTP 200; replay colos ATL/EWR | informational; the linear full replay is expected |

The cold values and the discarded warm-up values are separate from the 50
sampled reads in each window. They must not be read as evidence that the warm
path retained O(history) work.

## AC4 — per-hop status and structural Journal evidence

The observability token file was not supplied. Therefore the sampler did not
query telemetry and every current per-hop datum is explicitly UNKNOWN for that
reason.

| Hop | Current observation |
| --- | --- |
| S04 | **PRESENT, ZERO-WORK OBSERVATION; per-hop UNKNOWN** |
| S05a–S05e | **PRESENT, ZERO-WORK OBSERVATIONS; per-hop UNKNOWN** |
| S13 | **UNKNOWN** — observability token file was not supplied |
| S14 | **UNKNOWN** — observability token file was not supplied |

S04/S05 were not reported as missing. Their frozen G30 trace-schema identifiers
remain present by design. The structural G41 evidence is that the normal commit
path creates **no Journal actor span** and performs **no Journal namespace
resolution**. The focused G41 contract/test evidence is in
[docs/SDT-G41-evidence.md](SDT-G41-evidence.md),
[contracts/g41-journal-duty-inventory.json](../contracts/g41-journal-duty-inventory.json),
and test/g41-journal-removal.spec.ts; npm run test:g41 passed its 8/8
focused tests and all three production mutants were red. Retained Journal
bindings and named non-commit diagnostic callers are not evidence of a normal
commit-path Journal operation.

The exact per-hop UNKNOWN reason in the raw measurement is:

~~~
G37 observability token file was not supplied; per-hop telemetry was not queried, so AC4 per-hop values are UNKNOWN.
~~~

## AC5 — outliers

No cause is assigned to any latency outlier. This lightweight run does not
separate Durable Object eviction from other causes, and no eviction-detection
machinery was added.

## AC6 — provenance

The deployed version, source commit, exact service identity, candidate, actual
history lengths, both window colos, one-session/deployment count, and 50-sample
count are recorded above and in the raw artifact. The final pre-deploy migration
receipts and deployed-version receipts are committed with this document.

## AC7 — historical context only

These are not today's baseline and are not used to apportion improvement across
G43/G44/G45/G46/G41:

- G37's historical end-state observation was client p50/p95 **960/1510 ms**,
  with S13/S14 **58/44 ms**, in **SJC**. See
  [docs/SDT-G37-speedup-evidence.md](SDT-G37-speedup-evidence.md).
- G30's historical **2564 ms** observation was in **SJC**, from
  .artifacts/g30-b0-B.json and its trace receipt.

The retracted G30 384 ms floor claim is not reintroduced.

## Verification and process

The following checks passed before the PR was prepared:

~~~
npm run lint
node --check scripts/deploy/g37-d1-migrations.mjs
bash -n scripts/deploy/g37-sample.sh
node scripts/g44-contract-check.mjs --self-test
node scripts/g41-journal-contract-check.mjs
npm run test:g41       # focused 8/8; three production mutants red
npm run test:g44       # focused 8/8; four production mutants red
~~~

The target files are limited to the deployment helper, deployment script,
documentation, and raw evidence. git diff --name-only --
'packages/*/src/**' is empty. The deployed Worker source commit is
e7317fc3f74c6d34e2f200c6212595935b5f3b48; the final PR head is recorded in
the PR body together with Closes #93.

These results are **not an acceptance gate** and are not reusable as one. The
structural gates remain the individual in-repository ACs.

## Artifact index

- scripts/deploy/g37-d1-migrations.mjs
- scripts/deploy/g37-sample.sh
- .artifacts/sdt-g47-repair-wake32-d1.json
- .artifacts/sdt-g47-repair-wake32-d1-mv.json
- .artifacts/g37-sdt-g47-repair-post-migration-wake32c-20260831-e7317fc3f74c.json
- .artifacts/sdt-g47-repair-wake32-attempts.json
- the final run's migrations-* and versions-* receipts with the same candidate/source prefix
