# SDT-G58 live-poll advancement resume W114

- Task: `SDT-G58-LIVE-POLL-ADVANCEMENT-RESUME-W114`
- Issue: `J-Tech-Japan/sekiban-dcb-ts#112`
- Branch: `claude/sdt-g58-safe-lane-w93`
- Verdict: **blocked**
- Repair checkpoint: `664f60af9f17833ac6c40e4982f782ab26c70600` (pushed to `origin`)

## Scope and preserved evidence

The dirty `.g58-w93` checkpoint was resumed in place. The W112 failed receipt was
not restarted, rewritten, or discarded: [sdt-g58-w112-paced-cohort.json](.artifacts/sdt-g58-w112-paced-cohort.json)
retains run `6ad7bb99-ff63-4e8a-aa44-42487c652890`, 10 paced commits, 19 health
snapshots, and three scheduled coverage groups. Its red observation is unchanged:
both scheduled projectors were observed with outcome `invoked-but-no-work`,
reason `poll_in_progress`, while both live heads remained pre-cohort.

The checkpoint contains only the bounded path requested for this resume:

- `ProjectionRuntime.pollRegistered` uses a bounded pool of 8 independent
  tag/projector identities, preserving per-identity `catchUp`, CAS, result order,
  first-unsafe stopping, and the `maximumSuid` fence.
- `g58-live-poll-advancement-repair.spec.ts` covers both `RoomProjector` and
  `ReservationProjector` and proves concurrency.
- `g58-live-poll-advancement-guard.mjs` retains the W112 red receipt and turns red
  for serial pool removal, pool-width reduction, or projector-coverage removal.
- Scheduled poll lifecycle evidence records each projector attempt/outcome.
- The existing `5000` ms unsafe bound and `20000`/`120000` ms safe-window bounds
  are preserved. Outbox, Queue, global admission, G56, and the commit path were
  not changed.

## Local validation

All requested local gates passed from the nested checkpoint worktree:

| Gate | Observed result |
|---|---|
| Focused W112 guard self-test and guard | green; serial, width, and projector-coverage mutations red |
| `npm run test:g58` | passed; 5 test files, 13 tests; all wired G58 guards passed |
| `npm run test:g44` | passed; 8 tests and all four production mutants red |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `git diff --check` | passed before commit |

## Generated receipt drift classification

The pre-existing tracked W97/W98 receipt edits were preserved and committed with
the checkpoint. They are incidental generated drift, not new behavioral evidence:

- W97 rewrote only embedded Vitest stdout (run time/start time and the observed
  test count changed from 2 to 4 after the added G58 tests); its guard status and
  exit result remain red-baseline/exit 1.
- W98 rewrote only embedded Vitest stdout timing/start-time text; its baseline and
  mutant results, failure assertion, and `restored: true` semantics are unchanged.

## One repair deployment

Exactly one repair deployment was issued after the checkpoint push:

```
env -u CLOUDFLARE_API_TOKEN ./node_modules/.bin/wrangler deploy --config samples/meeting-room/wrangler.cloudflare-only.jsonc
```

No `--keep-vars` was used and no OAuth preflight was repeated. The deployment used
the exact pushed source commit `664f60af9f17833ac6c40e4982f782ab26c70600`, the
normal config `samples/meeting-room/wrangler.cloudflare-only.jsonc`, and local
Wrangler `4.125.0`. The config SHA-256 was
`f0c55e4676ad2f9f3adb2f2a7f42045f2827d4d99aff80a85cdaa955be54e345`; the repaired
`ProjectionRuntime.ts` SHA-256 was
`e1ef23a50943aa2fef3ec8dc1a15d30709f7937b60dc21ca46a96d229b43be37`.

Cloudflare reported:

- Worker: `sekiban-dcb-meeting-room-cloudflare-only`
- Version: `26acd091-46aa-4925-8898-65b5cdf5c3be`
- URL: `https://sekiban-dcb-meeting-room-cloudflare-only.ttakaoka.workers.dev`
- Cron: `* * * * *`

No Wrangler code 10000 or OAuth/auth failure occurred.

## One fresh replacement cohort

The first precondition-only invocation exited before starting because the relaunch
did not carry the environment variable for the protected conformance-token path.
It issued no harness request and wrote no cohort report. The only actual cohort
run then used the existing protected token file by path only; its token value was
never printed, logged, or persisted.

The actual replacement report is [sdt-g58-w114-replacement-cohort.json](.artifacts/sdt-g58-w114-replacement-cohort.json):

- Fresh run ID: `9b8befe9-144e-4f61-b3e2-50e47e611d51` (different from W112)
- Started: `2026-09-03T13:37:27.901Z`
- Finished: `2026-09-03T13:40:06.996Z`
- Commits: 10
- Commit spacing: minimum `12086` ms; every gap was at least the required `10000` ms
- Health snapshots: 17
- Scheduled coverage groups: 3
- All groups observed both registered projectors
- Harness status: failed at the bounded safe/live deadline, not retried

The final cohort SUID was `063924039573941000000201368604`, equal to the observed
global head. The final health snapshot was:

| Required proof | Final observed state |
|---|---|
| `RoomProjector` materialized safe head | `063924035863002000001774577097` — below target |
| `ReservationProjector` materialized safe head | `063924035863002000001774577097` — below target |
| `RoomProjector` live head | `063923889828717000001037107666` — below target; last poll `1788442804276`, `invoked-but-no-work`, `poll_in_progress` |
| `ReservationProjector` live head | `063923899513483000001858656775` — below target; last poll `1788442804276`, `invoked-but-no-work`, `poll_in_progress` |
| Cohort tag-state committed versions | **not captured**; the harness stopped before `liveProjectionProof` could be produced |
| Final coverage | `BLOCK/UNSETTLED`, reason `source_partition_set_changed_during_scan`, partition `reservation:g58-reservation-acc68d23-613-5` |
| Lag/safe window | estimate `14554` ms, decayed `0` ms, safe window `20000` ms, ceiling not exceeded |

Every one of the 17 health snapshots contains the AC1 coverage, lag, materialized
view, live-projector, and global-head sections. The complete per-tick projector
attempt/outcome table is retained in the JSON report; the observed scheduled
lifecycle groups were:

| Coverage observed-at | Coverage | RoomProjector attempt / outcome / reason | ReservationProjector attempt / outcome / reason |
|---:|---|---|---|
| 1788442584282 | SETTLED | 1788442583702 / invoked-but-no-work / poll_in_progress | 1788442583702 / invoked-but-no-work / poll_in_progress |
| 1788442641091 | BLOCK/UNSETTLED (`source_partition_set_changed_during_scan`) | 1788442706893 / invoked-but-no-work / poll_in_progress | 1788442706893 / invoked-but-no-work / poll_in_progress |
| 1788442715965 | BLOCK/UNSETTLED (`source_partition_set_changed_during_scan`) | 1788442804276 / invoked-but-no-work / poll_in_progress | 1788442804276 / invoked-but-no-work / poll_in_progress |

The deployed repair therefore did not produce the required AC5 proof. In
particular, both projector heads remained below the final cohort SUID and the
required committed cohort tag-state versions are absent. Per the task contract,
this is a blocked result after the single replacement proof; no further deployment,
cohort, or repair attempt was made.

## Unsafe-sample classification

Unsafe visibility is reported without reclassification and remains delegated to
unpublished G60:

- 1 sample was an unsafe pass within the unchanged 5000 ms bound (ordinal 2).
- 9 samples were misses. Ordinal 1 was observed eventually at `5576` ms and
  remains a miss; the other eight had no eventual visibility observation before
  the bounded run stopped.
- No safe p50/p95 is claimed because the cohort never produced safe convergence.

## Process disposition

The repair checkpoint and replacement evidence are committed/pushed on the branch.
No PR was opened and no worker completion command was run. G56 remains held.
