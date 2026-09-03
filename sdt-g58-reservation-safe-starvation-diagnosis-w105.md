# SDT-G58 ReservationProjector safe-starvation diagnosis — W105

Status: **completed** (diagnosis and red-capable guard checkpoint). No product
repair, deployment, Wrangler operation, application request, replacement
cohort, PR, worker completion, or host/G56/G60 mutation was performed.

## Boundary and preserved evidence

This checkpoint starts at pushed head
`f07944f7c3a5a763087edf4669980b67cd6da7c7` on
`claude/sdt-g58-safe-lane-w93`. The sole cohort is W102 run
`acc68d23-6133-446d-9470-e54fb3c28284`; its JSON receipt and exact failure log
remain unchanged at:

- `.artifacts/sdt-g58-w102-safe-proof-cohort.json`
- `.artifacts/sdt-g58-w102-safe-proof-cohort.log`

The W103 red receipt (`.artifacts/sdt-g58-w103-red-guard.json`) and W104 green
receipt (`.artifacts/sdt-g58-w104-green-guard.json`) are preserved. No token
path was read and no Cloudflare command was needed.

## W102 facts: four scheduled decisions, not 91 ticks

The raw receipt has 91 HTTP health responses but only four distinct
`coverage.observedAt` values. The 72 responses in the third group repeat one
BLOCK decision:

| observedAt (UTC) | HTTP samples | coverage/reason | Room safe head / unsafe rows | Reservation safe head / unsafe rows |
| --- | ---: | --- | --- | --- |
| `1788428250004` / 09:37:30.004Z | 5 | SETTLED / null | pre-cohort / 0 → pre-cohort / 1 | pre-cohort / 0 → pre-cohort / 3 |
| `1788428310641` / 09:38:30.641Z | 5 | SETTLED / null | row 2 / 1 → row 2 / 1 | row 2 / 4 → row 2 / 8 |
| `1788428377716` / 09:39:37.716Z | 72 | BLOCK/UNSETTLED / `source_partition_set_changed_during_scan` | row 2 / 1 → row 3 / 0 | row 2 / 9 → row 3 / 6 |
| `1788428437283` / 09:40:37.283Z | 9 | SETTLED / null | row 3 / 0 → row 10 / 0 | row 3 / 6 → row 3 / 6 |

The final health response at 09:40:59.722Z has global and RoomProjector safe
head row 10 (`063924025191103000001618685662`), ReservationProjector safe head
row 3 (`063924025106891000001134410415`) and six unsafe rows. Both live
projector aggregates retain the old `lastPollAt=1788426228497`. The W102
failure remains exactly:

```text
safe lane or live projections did not reach 063924025118818000001227710475 by safeWindowMs + 120000ms
```

## Causal seam

The current W104 scheduler is green for the earlier BLOCK live-poll defect:
the retained-frontier hook runs before `pollLiveProjections`, and a BLOCK poll
is fenced by the last proven frontier. The remaining W102 shape is a
per-view safe-lane divergence:

1. `runMeetingRoomScheduledMaintenance` performs safe catch-up before
   unsafe-kick draining and passes the retained frontier to both.
2. `d1-mv.ts` iterates `RoomProjector` then `ReservationProjector` serially in
   both catch-up and unsafe-kick drain. Queue delivery's two view branches are
   independent; this diagnosis does not change that path.
3. `MaterializedViewCatchUpRuntime.follow` stops at the first source event
   that is not SafeWindow-eligible. It cannot cross that event or an unproven
   gap. A Reservation-local first-unsafe row at row 4 therefore leaves its
   safe head at row 3 and retains the six observed unsafe rows, while the Room
   view can continue to row 10.

The deterministic W105 two-view witness uses the four observedAt groups,
retains row 3 on the BLOCK group, and gives each view a sufficient ten-event
per-tick budget. It reproduces Room row 10 / Reservation row 3 + six unsafe
rows. This establishes the focused G58 AC3 seam as **Reservation first-unsafe
eligibility/re-entry under the per-view safe catch-up cadence**; a future green
repair must re-enter that view after eligibility changes without bypassing the
barrier or G44 frontier fence.

The alternatives are separated explicitly:

- **Room-before-Reservation order:** reproduced as the production execution
  shape, but swapping the two independent views leaves the Reservation
  barrier at row 3. Ordering is relevant shape, not sufficient cause.
- **Per-tick budget starvation:** a three-event budget also prevents Room from
  reaching row 10, which contradicts the receipt. No explicit budget,
  cancellation, or deadline branch exists in the inspected catch-up path.
- **Unsafe-kick versus catch-up order:** the production order remains
  catch-up then drain. The model has the same local barrier if drain is placed
  first, while a source mutation that swaps the production calls is rejected.
- **Barrier/cadence:** the four scheduled groups, including one repeated
  BLOCK decision, are the only cadence evidence. A later SETTLED decision lets
  Room progress but does not prove that Reservation's first unsafe event was
  eligible at that call; the guard preserves this as the causal seam rather
  than fabricating an arrival timestamp.
- **D1 claim/CAS contention:** not established. The read-only health/failure
  artifacts contain no CAS, lease, or claim error fact. The runtime catches
  typed MV CAS conflicts and retries eight times; this unit does not infer a
  contention winner or modify that path.

The single 5,289 ms W99 unsafe observation (and W102's 5,353 ms row-1
eventual observation) remains a miss against the unchanged 5,000 ms contract;
neither is reclassified as an unsafe pass. SafeWindow remains 20,000/120,000
ms and upstream outbox/Queue/global admission remains held by SDT-G60.

## Red-capable guard and tests

`scripts/g58-reservation-safe-starvation-guard.mjs` is a read-only guard. It
parses the immutable W102 receipt, checks all four scheduled groups and final
per-view facts, verifies the W104 hook/fence and Room-before-Reservation
catch-up/drain source contracts, and writes
`.artifacts/sdt-g58-w105-reservation-safe-starvation.json`.

Its deterministic self-test rejects these mutations:

- remove or move the Reservation first-unsafe barrier;
- remove serial materializer iteration;
- swap catch-up and unsafe-kick draining or remove the retained frontier;
- restore the W103 BLOCK early return; and
- claim a smaller per-tick budget can explain Room row 10.

`test/g58-safe-lane-diagnosis.spec.ts` contains the matching four-tick
Room-before-Reservation model, barrier mutant, order mutation, and budget
distinction. The historical W103 red receipt and W104 green behavior remain
intact.

## Checks

- `node scripts/g58-reservation-safe-starvation-guard.mjs --self-test` — passed;
  all focused mutations were red-capable.
- `node scripts/g58-reservation-safe-starvation-guard.mjs` — passed and wrote
  the W105 diagnosis receipt.
- `npm run test:g58` — passed, including the existing W97/W104/G44-boundary
  tests and the W105 witness/guard.
- `npm run test:g44` — passed; the G44 correctness test is unchanged.
- `npm run typecheck` — passed.
- `npm run lint` — passed with zero warnings.

## Changed paths

- `scripts/g58-reservation-safe-starvation-guard.mjs`
- `test/g58-safe-lane-diagnosis.spec.ts`
- `package.json` (wires the focused guard into `test:g58`)
- `.artifacts/sdt-g58-w105-reservation-safe-starvation.json`
- `docs/SDT-G58-evidence.md`
- `sdt-g58-reservation-safe-starvation-diagnosis-w105.md`

No package/runtime product source, sample runtime, Queue/outbox/global
admission path, G44 test, SafeWindow bound, unsafe constant, W102/W103/W104
receipt, SDT-G56 state, or SDT-G60 state changed.
