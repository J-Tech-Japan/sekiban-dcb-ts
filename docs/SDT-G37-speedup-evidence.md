# SDT-G37 commit-path speedup evidence

This is a lightweight before/after record, not an SDT-G30 sealed-cohort
ceremony. Each sample is one sequential 50-request client window against the
deployed primary, with a short telemetry settlement. Trace loss is reported
descriptively and never changes the client-latency denominator.

## Measurement method

- Sampler: `scripts/deploy/g37-sample.sh` and `g37-sample.mjs`.
- Fixture: a registered `RoomCreated` payload on one fixed, redacted tag;
  the one-time seed is excluded from the sample.
- Client estimator: nearest-rank p50/p95 over every accepted HTTP 200 in the
  requested 50-request window.
- Per-hop values: observed-span descriptive medians, joined by the existing
  exact CF-Ray -> correlation -> traceId exporter route. They are not added
  together and trace loss is not a correctness or performance gate.
- Secrets: each deploy rotates only `CONFORMANCE_TOKEN` through a temporary
  file; no token or raw fixture values are committed.

## AC1 baseline — before a runtime candidate

The baseline runtime source was unmodified `main`
[`c272e941be1b12ac65e05a69072f404295c38bdc`](https://github.com/J-Tech-Japan/sekiban-dcb-ts/commit/c272e941be1b12ac65e05a69072f404295c38bdc).
The runtime source tree (`packages/dcb-runtime/src` and
`samples/meeting-room/src`) was byte-identical before deployment. The
telemetry-only sampling config preserved the live G32 service/D1/DO/queue
topology and the existing receiver service binding; it did not retarget or
deploy the receiver.

| Field | Baseline value |
| --- | ---: |
| Captured | 2026-08-27T18:02:30.573Z |
| Deployed Worker version | `44930364-d507-4f20-9464-0b62a3b6cce6` |
| Client samples | 50 |
| Client p50 | **1,310 ms** |
| Client p95 | **2,202 ms** |
| Traces observed / schema-complete | 48 / 45 |
| Descriptive trace loss | 2 / 50 |
| Observed caller colo distribution | PDX: 45 |

| Row | Observed spans | Median duration (ms) |
| --- | ---: | ---: |
| S00 root | 48 | 1,247 |
| S01 | 47 | 0 |
| S02 bootstrap admit | 47 | 64 |
| S03 bootstrap release | 46 | 63 |
| S04 journal admit | 48 | 496 |
| S05a reserved | 48 | 52 |
| S05b allocated | 48 | 52 |
| S05c writing | 48 | 49 |
| S05d complete | 48 | 50 |
| S06/S07 reservation stage/member | 48 | 114 |
| S08 allocator | 48 | 84 |
| S09 | 48 | 22 |
| S10 bootstrap finalize | 48 | 29 |
| S11/S12 tag append stage/member | 48 | 54 |
| S13/S14 result state stage/member | 48 | 21 / 20 |
| S15 | 48 | 0 |
| S16 fan-out members | 573 | 0 |

The local sample artifact is
`.artifacts/g37-baseline-main-c272e941be1b.json`; it retains request IDs only
outside the published evidence so the exact telemetry join can be reproduced
without publishing customer-facing request identities.

## AC3 placement gate

The retained G30 raw Workers telemetry was audited before considering a
B-lane candidate. Its three caller observations were LAX, while all 32
provider-owned Durable Object events had no colo field: ALLOCATOR 0/4,
BOOTSTRAP 0/10, JOURNAL 0/14, and TAG 0/4. The audit therefore does **not**
claim same-colo placement. It establishes that the retained telemetry has no
positive DO-side cross-colo evidence, so neither B-1 `locationHint` nor B-2
Smart Placement is justified or deployed in this unit. The local audit is
`.artifacts/g37-do-colo-audit.json`.

The sampling deployment also exposed a separate live-topology fact: the
merged G38 receiver config names a future `...-doorbell-g38` Worker, but the
account's live primary still binds the existing
`sekiban-dcb-meeting-room-doorbell` Worker and the future Worker does not
exist. G37 preserves that binding; creating/retargeting the G38 Worker is
outside this unit.

## Candidate ledger

Each runtime candidate was isolated in its own commit series and deployed
against the same primary service. The client samples are small descriptive
windows, not a randomized controlled experiment: caller colo is recorded for
every window and prevents treating a raw delta as a placement claim.

| Candidate | Commit / deployed version | Before → after client p50 / p95 | Result |
| --- | --- | --- | --- |
| A-1 — batch post-allocation JOURNAL transitions | `0b63bbb` → `23cb1ef7-be54-40ab-8739-ff962675faaa` | 1,170 / 2,549 ms (SJC, `2d4b3748-c2d3-49d2-9821-aec821e8e714`) → 1,358 / 2,096 ms (DEN) | **Rejected and reverted** by `2bd0b50`: p95 fell, but p50 increased 188 ms and the caller colo changed. The batch made the physical S05c call zero-duration as intended, but did not establish a p50 win. Artifacts: `.artifacts/g37-baseline-before-a1-4ec4fc6f2244.json`, `.artifacts/g37-a1-journal-transition-batch-0b63bbb2a199.json`. |
| A-2 — atomic BOOTSTRAP admit+release | `4440df9` (formal sample support at `7ca5f1d`) → `aa4ec605-76f8-4b50-be8e-ce683f2d1c3e` | 1,310 / 2,202 ms (PDX baseline) → 1,434 / 2,385 ms (ATL) | **Rejected and reverted** by `4ec4fc6`: p50 and p95 both worsened, with a colo change. The initial deployment `78803f58-16f7-4504-ada8-19a780791b10` briefly returned a platform 1101 before activation; the bounded-readiness helper was added, and the formal 50-request sample then completed normally. Artifact: `.artifacts/g37-a2-atomic-bootstrap-7ca5f1de422f.json`. |
| A-3 — nested finalize piggyback | screened; no safe runtime commit | n/a | **Not adopted.** S09 is the ALLOCATOR's pre-allocation BOOTSTRAP finalize; S10 is the separate final epoch fence immediately before the first Tag append. Piggybacking S10 on the completed allocator call would create an unfenced allocation-response → append interval, so it would change the fail-closed bootstrap invariant rather than merely merge an RPC boundary. |
| A-4 — seal parallelization / response-after-seal | screened; no successful-path commit | n/a | **Not adopted.** In the current success path, client response follows JOURNAL `COMPLETE`; seal/reconcile work is only the failed-append alarm handoff (S20). Moving or parallelizing it cannot improve a successful commit window without changing recovery/read semantics, which is outside this unit. |
| A-5 — overlap JOURNAL admit with reservation fan-out | `c2dd342` → `7e6ecf4e-e78f-4690-b91d-cdf4717dcfb5`, repeat `a5dcff48-9a9c-4b2c-a5fa-6a3391b8879b` | 1,473 / 2,152 ms (PDX, `c64bd209-1217-45f9-8f01-6ac2c3030250`) → 1,302 / 1,942 ms (ATL), then **960 / 1,510 ms** (SJC) | **Adopted.** Both after windows improve over the immediate pre-A5 window (−171/−210 ms and −513/−642 ms); their p50 reductions match the overlapped 135–181 ms reservation window. The colos differ, so this is retained as a measured lightweight result rather than a claim that placement caused the gain. The direct CommitWorker fixture proves that S06/S07 begin before S04 resolves and that a rejected admission tombstones any acquired lease before allocator work. Artifacts: `.artifacts/g37-baseline-before-a5-2bd0b509bbb7.json`, `.artifacts/g37-a5-admit-reservation-overlap-c2dd3424d844.json`, `.artifacts/g37-a5-admit-reservation-overlap-repeat-c2dd3424d844.json`. |

The adopted path does not change the V1 request/response shape, trace-manifest
row/attribute universe, allocation order, or confirm-before-publish rule. It
starts the two independent requests together, requires both the durable
`RESERVED` transition and every acquire to settle before allocation, and uses
the existing force-tombstone barrier if admission rejects after an acquire.

## Post-adoption sample and residual attribution

The final A-5 repeat is the end-state lightweight sample. It is deployed from
`c2dd3424d84433de18cbe480a667a3935e586265` as version
`a5dcff48-9a9c-4b2c-a5fa-6a3391b8879b` and was captured at
2026-08-27T18:45:24.821Z.

| Field | Initial main baseline | End-state A-5 sample |
| --- | ---: | ---: |
| Client samples | 50 | 50 |
| Client p50 | 1,310 ms | **960 ms** |
| Client p95 | 2,202 ms | **1,510 ms** |
| Observed / schema-complete traces | 48 / 45 | 50 / 46 |
| Descriptive trace loss | 2 / 50 | 0 / 50 |
| Caller colo distribution | PDX: 45 | SJC: 46 |

| Residual row (end-state) | Observed spans | Descriptive median |
| --- | ---: | ---: |
| S00 root | 50 | 914 ms |
| S02 / S03 BOOTSTRAP admit / release | 49 / 50 | 48 / 48 ms |
| S04 JOURNAL admit | 50 | **408 ms** |
| S05a / b / c / d transitions | 50 each | 34 / 27 / 33 / 34 ms |
| S06 / S07 reservation stage / member | 49 / 49 | **135 / 135 ms** |
| S08 / S09 allocator / nested fence | 50 / 48 | 64 / 17 ms |
| S10 final BOOTSTRAP fence | 50 | 16 ms |
| S11 / S12 tag append stage / member | 50 each | **89 / 89 ms** |
| S13 / S14 result state stage / member | 50 each | 58 / 44 ms |
| S15 response build | 50 | 0 ms |

The 400–800 ms p50 band remains missed by 160 ms. The residual is honest:
JOURNAL admission remains the dominant single window, followed by the
reservation, append, and final state-read windows. A-3/A-4 cannot remove
those windows without moving authoritative fencing/recovery semantics. This
is the G41 decision input rather than grounds to weaken a correctness gate or
manufacture a placement claim.

## Final outcome

Adopted: A-5 reservation/admission concurrency (`c2dd342`). Rejected and
reverted: A-1 and A-2. B-lane and A-3/A-4 were not deployed for the explicit
evidence/safety reasons above.

## Verification

`npm run check` passed against a newly created, isolated local PostgreSQL
database on 2026-08-27. This covers lint, type checking, 593 Vitest tests
(one existing skip), the provider/contract checks, and all retained candidate
gates. A pre-existing shared local database initially produced unrelated
PostgreSQL queue/FK residue failures; the same affected integration suites
passed 57/57 against the isolated database, so the candidate was verified
without mutating shared test state. `git diff --check` also passed. PR CI is
the independent final verification record.
