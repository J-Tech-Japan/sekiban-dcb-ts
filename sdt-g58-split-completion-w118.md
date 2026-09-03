# SDT-G58-SPLIT-COMPLETION-W118

Status: **blocked**

The preserved `claude/sdt-g58-safe-lane-w93` branch resumed at the operator
split in host commit `0bc0e2fd5`. This checkpoint does not diagnose or repair
projector-head advancement; that proof belongs to SDT-G61/#114. It preserves
the W111 live-poll observability repair at `a9bee26`, the existing AC3/AC4
safe-lane work, and the W112 bounded-pool evidence.

## Source and deployment

- W118 source checkpoint: `e94ffa1eb935d901234f67738b6e9be8122a0eb3`, pushed to `claude/sdt-g58-safe-lane-w93`.
- Normal config: `samples/meeting-room/wrangler.cloudflare-only.jsonc`.
- Config SHA-256: `f0c55e4676ad2f9f3adb2f2a7f42045f2827d4d99aff80a85cdaa955be54e345`.
- Exactly one W118 Wrangler 4.125.0 deployment was performed with API-token environment variables unset, OAuth only, and no `--keep-vars`.
- Active version: `b1d15a65-cee9-4f4b-b342-395c3a28c66a` (version 202), deployment `ebccecc3-02a2-476f-bb8d-6970069f8a79`, 100% traffic.
- Source annotation: `SDT-G58 W118 split completion e94ffa1`; it matches the exact local source SHA prefix. Full sanitized readback is [the deployment identity receipt](.artifacts/sdt-g58-w118-deploy-identity.json).

## AC1 — health surface

The preserved completed [W94 bearer-only read proof](.artifacts/sdt-g58-w94-ac1-ac5-readproof-repaired.json) verifies coverage, lag, materialized-view, and live-projection health fields without app requests or a projection-lag query. The deployed W118 AC6 run also authenticated `GET /conformance/v1/read-health` and recorded 30 health snapshots containing coverage kind/reason, decayed lag, safe window, both materialized views, and both projector rows.

## AC2 — amended paced cohort

The one fresh, non-stitched cohort is preserved in [the raw receipt](.artifacts/sdt-g58-w118-ac2-paced-cohort.json). It accepted ten reservations, including the cold first sample. All commit spacings met the 10-second requirement: `13997, 12913, 13033, 12830, 12723, 12951, 12814, 13194, 12816, 13966 ms` (minimum `12723 ms`). It recorded 32 health snapshots and four observed coverage ticks.

| # | commit UTC | SUID | spacing ms | unsafe raw result | commit-to-safe |
|---:|---|---|---:|---|---:|
| 1 | 17:27:32.449Z | `063924053251522000001725631009` | 13997 | runner pass; raw commit-to-unsafe 5170 ms | censored |
| 2 | 17:27:45.362Z | `063924053264349000001244092179` | 12913 | miss; censored | censored |
| 3 | 17:27:58.395Z | `063924053277255000001323688585` | 13033 | miss; censored | censored |
| 4 | 17:28:11.225Z | `063924053290189000000736742739` | 12830 | miss; censored | censored |
| 5 | 17:28:23.948Z | `063924053303126000001047542373` | 12723 | miss; censored | censored |
| 6 | 17:28:36.899Z | `063924053315853000001193660926` | 12951 | miss; censored | censored |
| 7 | 17:28:49.713Z | `063924053328710000000066374337` | 12814 | miss; censored | censored |
| 8 | 17:29:02.907Z | `063924053341627000001182203812` | 13194 | miss; censored | censored |
| 9 | 17:29:15.723Z | `063924053354735000000331309543` | 12816 | miss; censored | censored |
| 10 | 17:29:29.689Z | `063924053368759000000482611667` | 13966 | miss; censored | censored |

The cohort stopped at the amended 180-second safe line with:

```text
safe lane did not reach 063924053251522000001725631009 within the 180000ms paced safe acceptance line
```

No reservation reached safe visibility, so commit-to-safe `n=0`, `p50=N/A`,
and `p95=N/A`. The last health state was
`BLOCK/UNSETTLED`, reason `source_partition_set_changed_during_scan`,
`decayedMs=0`, `safeWindowMs=20000`; the receipt has both projector attempt
rows on every observed tick. Unsafe timing is recorded only and is not a G58
failure: one raw commit-to-unsafe value was 5170 ms and the other nine were
censored.

This missing safe-convergence proof is the blocking condition. It is not
repaired or retried in W118.

## AC3 — coverage ordering and guard

[The AC3 guard receipt](.artifacts/sdt-g58-w118-ac3-guard.json) records:

```text
{"selfTest":"g58-safe-lane-mutations-red"}
{"guard":"g58-safe-lane","status":"pass"}
```

Fresh FULL-frontier reconciliation and retained-frontier BLOCK handling remain
ordered before coverage persistence and the live-projector poll. Retained
frontier, no-frontier, scheduled-poll, shortened-paced-line, and removed
attempt-telemetry mutations all turn the guard red.

## AC4 — retired-lag purge

Under C-0, [the purge receipt](.artifacts/sdt-g58-w118-ac4-retired-lag-purge.json)
records the exact operation against the normal-config pipeline D1:

```sql
DELETE FROM serialized_dcb_lag_estimates
WHERE service_id <> 'sekiban-dcb-meeting-room-cloudflare-only';
```

Before and after there was one current-service lag row and zero retired lag
rows; `changes=0`, so no operational row was removed. The pre-purge counts
were pipeline `dcb_events=11`, projection checkpoints `22`, and MV
`mv_unsafe_receipts=11`, `mv_rows=11`.

## AC5 — live-poll observability

[W111's green guard receipt](.artifacts/sdt-g58-w111-green-guard.json) remains
green for attempt timestamps, terminal outcomes, attempt-derived `lastPollAt`,
and unchanged checkpoint heads/fences. [The immutable W112 red receipt](.artifacts/sdt-g58-w112-paced-cohort.json) and its red-capable guard remain
preserved; no W117 projector-head repair was attempted.

The deployed W118 AC6 receipt provides the before/after surface:

| state | RoomProjector | ReservationProjector |
|---|---|---|
| baseline | head `063924050289760000000088044272`; `lastPollAt=1788456409853`; `invoked-but-no-work` / `poll_in_progress` | same |
| final | head `063924053368759000000482611667`; `lastPollAt=1788456719828`; `advanced` | same |
| attempt telemetry advanced | true | true |
| cohort final SUID | `063924053488305000000669856102` | `063924053488305000000669856102` |

The AC6 receipt contains three observed coverage ticks and 30 health snapshots;
each tick has both registered projector rows and
`allRegisteredProjectorsObserved=true`. Final projection-lag rows were behind
by 2 and 1 events, and both tag-state reads returned the cohort SUID with
version 1. These are observed before-state facts for G61, not G58 assertions.

## AC6 — amended deployed e2e

[The single `e2e:g58` receipt](.artifacts/sdt-g58-w118-ac6-e2e.json) completed
for run `49e01282-95e9-4fec-92a6-98f9cb502c05`:

- `n=1` reservation; safe visibility `95629 ms`, safe `p50=95629 ms`, safe `p95=95629 ms`.
- Unsafe visibility was an SDT-G60-owned miss with eventual visibility at `7134 ms`; over/missing count `1` and no G58 failure.
- Both projector attempt telemetry values advanced after baseline.
- The e2e did not assert unsafe visibility within 5000 ms or projector-head convergence.

## Gates

All requested local gates passed without weakening, removing, or inflating a
gate: `test:g15` (9 tests), `test:g16` (6), `test:g41` (8 plus red mutants),
`test:g44` (8 plus red mutants), `test:g49`, `test:g51`, `test:g52` (18),
`test:g53` (10), `test:g54` (18), `test:g55` (12), `test:g58` (13 plus all
G58 guards), `typecheck`, and `lint` with zero warnings.

The G58 guard run generated timestamp-only stdout churn in tracked W97/W98
guard receipts. Those incidental generated changes were restored exactly to
their committed contents and are not part of W118.

## Scope and disposition

The 5000 ms constant, SafeWindow 20000/120000 ms bounds, fences, ordering,
first-unsafe barrier, minimum aggregation, Tag outbox, Queue paths, and global
D1 admission path were not weakened or changed. G60 remains unpublished and
owns unsafe timing; G61 owns projector-head/tag-state convergence; G56 remains
held; no G57/G59 action was taken.

Because AC2's required deployed safe-convergence proof is absent, this report
is blocked. No PR was opened and no issue/worker completion transition was run.
The consolidated evidence is in [docs/SDT-G58-evidence.md](docs/SDT-G58-evidence.md).
