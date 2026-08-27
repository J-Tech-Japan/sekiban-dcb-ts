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

| Candidate | Commit series | Outcome | Client p50 / p95 | Delta vs baseline | Notes |
| --- | --- | --- | ---: | ---: | --- |
| Baseline | `c272e94` runtime | retained | 1,310 / 2,202 ms | — | AC1 sample above |

This table is extended only after each candidate's independent deployment and
sample. Rejected candidates remain documented with their sample and are
reverted before final CI.

## Final outcome

Pending A-lane candidate measurements.
