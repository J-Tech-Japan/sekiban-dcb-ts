# SDT-G58 live-poll diagnosis — W110

Status: **completed (diagnosis/red-guard checkpoint)**

This local diagnosis began at W109’s exact pushed head
`5ce9ae4d22fd1d634660b5e81f2995c4eb89557c` on
`claude/sdt-g58-safe-lane-w93`. It made no Wrangler call, deployment, D1
mutation, application request, credential operation, cohort, PR, or worker
completion. The W109 raw receipt remains immutable.

## Causal finding

The W109 receipt has 58 HTTP health samples but only three distinct scheduled
`coverage.observedAt` groups. All three are `SETTLED` with `reason=null`:

| observedAt (UTC) | HTTP samples | coverage |
| --- | ---: | --- |
| `1788436113143` (`2026-09-03T11:48:33.143Z`) | 15 | `SETTLED / null` |
| `1788436172904` (`2026-09-03T11:49:32.904Z`) | 38 | `SETTLED / null` |
| `1788436225982` (`2026-09-03T11:50:25.982Z`) | 5 | `SETTLED / null` |

The final global head, both materialized safe heads, and both target tag-state
`lastSortedUniqueId` values are
`063924032953080000000952631413`. In contrast, RoomProjector and
ReservationProjector live heads do not reach that SUID, and both
`lastPollAt` values remain frozen at `1788428464638` throughout the 145-second
witness. The projection-lag rows report behind events (Room checkpoint empty;
Reservation checkpoint behind), so the read surface is reporting the actual
stale checkpoint rows rather than selecting a legacy row over a fresh one.

This isolates the in-scope AC5 seam: live polling has no durable attempted-poll
or outcome surface. `readMeetingRoomHealth` currently computes `lastPollAt`
only from `serialized_dcb_projection_checkpoints.updated_at`, and that column
changes only when a checkpoint advances. Consequently all of the following
remain indistinguishable and look like a silently stale poll: bootstrap route
admission or store initialization throws; tag discovery/catch-up returns no
work; a retained-frontier fence permits no advancement; or a poll was never
entered. The scheduled source order proves fresh reconciliation and the
retained-frontier hook completed before the poll call site; the SETTLED result
maps to the established unbounded live-poll behavior. The receipt gives no
lower-level exception, wrong-service, or empty-registry fact, so this
checkpoint does not fabricate one. The health/attempt observability gap itself
is the causal seam blocking AC5 diagnosis.

## Repair-ready invariant and red guard

`scripts/g58-live-poll-diagnosis-guard.mjs` preserves
`.artifacts/sdt-g58-w109-ac5-single.json` as its red baseline and emits
`.artifacts/sdt-g58-w110-red-guard.json`. Its deterministic contract covers
both RoomProjector and ReservationProjector and requires that each attempted
poll have one of `never-invoked`, `invoked-and-threw`, `invoked-but-no-work`,
`explicitly-gated`, or `advanced`, with an attempt timestamp and a bounded
reason for throws/gates. Removing the scheduled poll, retained-frontier fence,
checkpoint-derived lastPollAt contract, attempt timestamp, or throw reason is
red in the self-test. This is the preserved pre-fix/mutation evidence for the
next repair.

The W111 green repair seam is to wrap the existing scheduled
`pollLiveProjections` call and persist a per-projector attempt lifecycle, then
have the read health use that attempt timestamp for `lastPollAt` while keeping
checkpoint head/advance information separate. A no-work, explicit fence, or
exception must remain observable. This does not alter the G44 snapshot-universe
assertion, retained frontier, or any source/Queue semantics.

## Bounds and ownership

SafeWindow floor/ceiling remain `20000/120000` ms; the unsafe constant remains
`5000` ms. W97 fresh reconciliation, W104 BLOCK polling, W106 kick re-entry,
first-unsafe and maximum-SUID fences, minimum aggregation, and G44 correctness
remain unchanged. Outbox/Queue/global admission remains held by SDT-G60.
No SDT-G56 or SDT-G60 state was touched.

## Local validation

- `node scripts/g58-live-poll-diagnosis-guard.mjs --self-test` — passed; the
  scheduled-poll, fence, checkpoint, attempt-timestamp, and throw-reason
  mutations were red.
- `node scripts/g58-live-poll-diagnosis-guard.mjs` — passed and wrote the
  red-baseline receipt `.artifacts/sdt-g58-w110-red-guard.json`.
- `npm run test:g58` — passed (8 tests; all existing G58 guards/mutation
  receipts plus the W110 diagnosis guard passed).
- `npm run test:g44` — passed (8 G44 tests; all four production mutation
  cases remained red as expected).
- `npm run typecheck` — passed.
- `npm run lint` — passed with `--max-warnings=0`.
