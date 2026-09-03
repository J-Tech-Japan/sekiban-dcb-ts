# SDT-G58 safe/live starvation diagnosis — W103

Status: completed (diagnosis and red-capable guard checkpoint)

This is a bounded continuation from `98454c1fa6a1fd727d26290dc091c34424b55528`.
It performs no deployment, Wrangler operation, D1 mutation, application
request, replacement cohort, PR creation, or worker completion. The W102
cohort remains the sole evidence window.

## Evidence inputs

- W102 run: `acc68d23-6133-446d-9470-e54fb3c28284`
- Raw receipt: `.artifacts/sdt-g58-w102-safe-proof-cohort.json`
- Raw failure/last-health log: `.artifacts/sdt-g58-w102-safe-proof-cohort.log`
- Derived red guard: `.artifacts/sdt-g58-w103-red-guard.json`
- W102 source/deployed identity is preserved; no token path was read or used.

## Scheduled coverage groups

The receipt contains 91 HTTP health samples but only four distinct scheduled
coverage `observedAt` values. The 72 samples with the BLOCK value are one
scheduled decision repeated by the health endpoint, not 72 cron ticks.

| observedAt (UTC) | HTTP samples | coverage/reason | Room safe head (unsafe rows) | Reservation safe head (unsafe rows) | live Room head / lastPollAt | live Reservation head / lastPollAt |
| --- | ---: | --- | --- | --- | --- | --- |
| 1788428250004 (09:37:30.004Z) | 5 | SETTLED / null | `063924022962293000001512609674` (0 → 1) | `063924022962293000001512609674` (0 → 3) | `063924022962293000001512609674` / 1788426228497 | `063924022962293000001512609674` / 1788426228497 |
| 1788428310641 (09:38:30.641Z) | 5 | SETTLED / null | `063924025094541000000759003421` (1 → 1) | `063924025094541000000759003421` (4 → 8) | `063924022962293000001512609674` / 1788426228497 | `063924022962293000001512609674` / 1788426228497 |
| 1788428377716 (09:39:37.716Z) | 72 | BLOCK/UNSETTLED / `source_partition_set_changed_during_scan` | `063924025094541000000759003421` → `063924025106891000001134410415` (1 → 0) | `063924025094541000000759003421` → `063924025106891000001134410415` (9 → 6) | `063923910621199000001267017374` / 1788426228497 | `063924022962293000001512609674` / 1788426228497 |
| 1788428437283 (09:40:37.283Z) | 9 | SETTLED / null | `063924025106891000001134410415` → `063924025191103000001618685662` (0 → 0) | `063924025106891000001134410415` → `063924025106891000001134410415` (6 → 6) | `063923933985284000000088451532` / 1788426228497 | `063924022962293000001512609674` / 1788426228497 |

At the final health response (`09:40:59.722Z`), global head and
RoomProjector safe head were row 10, while ReservationProjector stopped at
row 3 with six unsafe rows. Both live heads were behind the cohort and
`lastPollAt` remained the old value. SafeWindow was always 20,000 ms;
decayed lag reached 15,616 ms and the largest estimate was 17,708 ms.

## Diagnosis

### Proven G58 AC5 scheduler starvation

`packages/dcb-runtime/src/cloudflare.ts` invokes
`beforeLiveProjectionPoll`, which performs the fenced retained-frontier pass,
then has the production branch:

```ts
if (scan.kind !== "FULL") return;
await pollLiveProjections(...);
```

The W102 BLOCK tick therefore performs retained-frontier catch-up/draining but
returns before `pollLiveProjections`. Repeated BLOCK coverage can starve every
live projector. The focused green-repair seam is to invoke the live poll after
that retained-frontier pass on BLOCK while preserving the G44 fence and last
proven frontier. No green repair is made in W103.

### Per-view safe-lane divergence

`d1-mv.ts` iterates `RoomProjector` then `ReservationProjector` serially for
both safe catch-up and unsafe-kick draining. Queue delivery starts independent
view branches concurrently (`Promise.all`). The receipt shows Room reaching
row 10 with zero unsafe rows while Reservation retains six unsafe rows and
stops at row 3. The first-unsafe barrier in
`MaterializedViewCatchUpRuntime.follow` prevents Reservation from crossing an
unsafe event or an unproven gap. This is the observed per-view starvation
shape; the read-only health surface has no CAS/lease exception field, so W103
does not invent a lower-level contention winner.

### Poll order and minimum aggregation

`ProjectionRuntime.pollRegistered` walks every tag and every registered
projector serially. The sample health surface then reports each projector's
minimum checkpoint head and minimum `lastPollAt` across its tag states. A stale
tag state consequently keeps the aggregate behind even if another tag state
advances. This explains why the reported live heads remain stale in addition
to the proven BLOCK early return; it is not evidence of an unsafe global head.

## Red-capable guard

New `scripts/g58-safe-live-starvation-guard.mjs`:

- parses the committed W102 receipt and derives all four coverage groups,
  per-view safe-head/unsafe-row progress, global heads, and projector heads and
  poll times;
- asserts the runtime BLOCK early-return seam, retained-frontier hook, serial
  materializer loops, first-unsafe SafeWindow barrier, independent Queue view
  branches, serial all-tag/projector polling, and minimum aggregation;
- self-tests a mutation removing the BLOCK return, serial MV loop, first-unsafe
  barrier, and minimum-head aggregation. Each mutation is rejected (red);
- records the current runtime behavior as `status: red-baseline` in
  `.artifacts/sdt-g58-w103-red-guard.json`, preserving the exact W102 receipt.

The 5,289 ms W99/W102 late unsafe observation remains a miss against the
unchanged 5,000 ms bound; eventual visibility is never reclassified as an
unsafe pass. SafeWindow remains 20,000/120,000 ms. Upstream outbox/Queue/global
admission ownership remains held by SDT-G60. G44 correctness, W97 same-tick
behavior, W96/W99/W102 evidence, and SDT-G56/G60 publication state are not
modified.

## Checks

Checks are recorded in this artifact after execution. No Cloudflare command or
new request is part of this checkpoint.

- `npm run test:g58` — passed (the two existing G58 Vitest files, G58
  source/mutation guards, W98 lag hygiene, W100 receipt contract, W97 green
  witness, and W103 guard).
- `npm run test:g44` — passed unchanged (8 tests plus the G44 mutation
  runner).
- `npm run typecheck` — passed (all package builds and root TypeScript check).
- `npm run lint` — passed with `--max-warnings=0`.

## Changed paths

- `scripts/g58-safe-live-starvation-guard.mjs` — receipt analysis, source
  contract checks, deterministic red-capable mutations, and red-baseline
  artifact generation.
- `package.json` — wires the new guard into `test:g58`.
- `docs/SDT-G58-evidence.md` — W103 diagnosis and scope record.
- `.artifacts/sdt-g58-w103-red-guard.json` — generated diagnosis receipt.
- `sdt-g58-safe-live-starvation-diagnosis-w103.md` — this artifact.

No package/runtime source, sample Worker source, Queue/outbox/global admission
code, G44 test, SafeWindow bound, unsafe constant, W96/W97/W99/W102 evidence,
or SDT-G56/G60 state changed.
