# SDT-G55 — read visibility evidence

Issue: [#106](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/106)
Product source commit: `be2f0ee1688e92208876f3d713f3d4563b2f00f4`
Packaging-gate commit: `bb7afec95dbe2c3749f25216885a962bc6cfa20c`
Fresh deployment: Cloudflare version `22b5ba16-b8aa-4927-a5f1-eeaa1769a48b`

## Status: blocked after the W83 deployed G15 gate timeout

The earlier version `a49d2a7e-0dd4-470d-b9ee-7854170075d9` is historical
blocked evidence only: although it was annotated with `be2f0ee…`, it bundled
the parent worktree's stale runtime distribution. It is not used in any AC5
claim below.

The fresh version was built from this worktree after a local lockfile-faithful
dependency install and passed a deterministic bundle gate before and after
upload. It then ran exactly one fresh room-plus-three-reservations cohort. Its
original final safe-head D1 query stopped on OAuth authentication code 10000.

W83 resumed only that preserved cohort after a successful fresh OAuth identity
check. Its resume reader sent zero app requests and made one remote D1 query,
completing the required post-cohort receipt and third safe timing. The first
required deployed G15 gate then timed out while reading the frontend root
before sending any G15 command. This is an honest bounded-e2e stop: no G15
retry, G16 run, replacement cohort, or evidence stitch was performed.

## AC1 / AC2 implementation and red-to-green proof

`D1MaterializedViewStore.readListPage` is the new explicit list port. Its
default is `safe`: it pages only `mv_rows` and reports the active generation's
`last_suid` as the additive `readHead`. `consistency: "unsafe"` is explicit,
uses the same service/view/active generation, and overlays only
`mv_unsafe_rows.source_suid > active.last_suid`; its `readHead` is the maximum
SUID reflected in that returned page. It does not mutate unsafe rows or their
receipts. Existing G23 composed reads retain their existing semantics.

The first run of `test/g55-read-visibility.spec.ts` against the pre-change
source was red:

- default list incorrectly returned both safe and unsafe fixture rows instead
  of only the safe row; and
- `consistency: "eventual"` incorrectly returned HTTP 200 instead of typed
  HTTP 400.

After the implementation, the focused fake-port and Miniflare D1 tests pass:
default safe rows are byte-identical to the existing list fields, the
additive `readHead` is populated, the unsafe row is visible only after opt-in,
paging/totals and page-reflected heads are asserted, and receipts remain
unchanged. `scripts/g55-read-visibility-guard.mjs --self-test` forces red for
the safe-default, unsafe-fence, route-opt-in, and immediate-commit UI mutants.

## AC3 deployed diagnosis

The pre-deploy normal-config D1 fact is preserved in
`.artifacts/sdt-g55-predeploy-d1-facts.json`:

| Fact | Value |
| --- | ---: |
| `ReservationProjector` unsafe receipts | 132 |
| `ReservationProjector` unsafe rows | 0 |
| active safe head | `063923976351782000001484266421` |

This confirms the operator's receipt-without-row observation. The code path
explains it: the normal Worker previously used
`afterStoredDownstreamDelivery` to call `ctx.waitUntil(drainMeetingRoomUnsafeKicks(env))`.
That drain calls safe `follow`; after the safe checkpoint advances,
`MaterializedViewCatchUp` calls `collectUnsafeGarbage`, deleting the matching
unsafe row and receipt-bound transient state. Receipts were retained long
enough to explain the table counts, while rows were not available to a reader.

The product candidate removes that same-invocation drain from the normal Worker and
the shared direct-doorbell fallback. It preserves durable kicks and the
existing scheduled safe catch-up/GC order. During the historical invalid cohort, the remote
facts moved from 132 receipts / 0 rows to 136 receipts / 3 rows: the three
reservation unsafe rows were retained instead of immediately pruned. The
existing measured 1.5–1.8 s queue-to-global-D1 baseline remains the prior
reference point.

The fresh packaging-repair cohort began with a separate D1 before receipt of
133 receipts / 0 rows. Its three app-list observations subsequently proved the
new rows visible under the explicit unsafe lane. In the authorized W83
same-cohort resume, one remote D1 query observed 134 receipts / 0 rows and the
active safe head `063923995692002000000693137501`. The zero remaining unsafe
rows are consistent with safe follow and garbage collection after the safe
checkpoint reaches the cohort's final reservation.

## AC4 UI change

The sample immediately changes the command status to `Committed (SUID)` once
the command HTTP response supplies a SUID. Its independent list state says
`List head X waiting for Y` or `List head X caught up to Y`, driven by the
returned `readHead`. `/api/read/reservations` in both Worker compositions
sets `consistency: "unsafe"`; raw serialized list callers still default to
safe.

The existing one server-side wait request and its safe-lane convergence rules
remain; it now updates the separate list state rather than continuing to call
a committed command “Sending”.

## AC5 fresh-cohort receipt, resumed safe timing, and gate stop

The repair installed the lockfile dependencies inside `.g55-w81`; the resolved
`node_modules/@sekiban/dcb-runtime` target is this worktree's
`packages/dcb-runtime`, not the parent checkout. `npm run build:g55:bundle`
rebuilt every workspace and made a normal-config Wrangler dry-run. The new
`scripts/g55-deployment-bundle-preflight.mjs` has forced-red in-memory mutants
for parent resolution, missing `readHead`, and an absent runtime input; it
passed against both the dry-run bundle and the exact bundle uploaded for the
fresh deployment. Each requires `readListPage`, `readHead`, and `unsafe` in
the locally rebuilt runtime and emitted Worker bundle.

Wrangler 4.125.0 authenticated via OAuth with `CLOUDFLARE_API_TOKEN` unset,
used only `samples/meeting-room/wrangler.cloudflare-only.jsonc`, and did not
use `--keep-vars`. Versions list identifies `22b5ba16-b8aa-4927-a5f1-eeaa1769a48b`
with message `SDT-G55 bb7afec95dbe2c3749f25216885a962bc6cfa20c`.

Before the fresh cohort, the app-list deployed-runtime preflight returned HTTP
200 with `readHead` `063923994759219000001209403906` in 495 ms (SJC ray
`a350f9a12d8e2db2-SJC`). This proves that the live normal-config bundle, not
only its version annotation, carried the G55 runtime response change.

The raw record is `.artifacts/sdt-g55-packaging-repair-e2e.json`. It created
exactly one room (`g55-room-3fecda14-172`) and exactly these three
reservations. All three met the unsafe visibility requirement.

| Reservation | Commit response | Commit → unsafe visible | Commit → safe head | Result |
| --- | ---: | ---: | ---: | --- |
| `g55-reservation-3fecda14-172-1` | 1539 ms | 4407 ms | 38356 ms | unsafe within 5 s; safe captured |
| `g55-reservation-3fecda14-172-2` | 1312 ms | 3003 ms | 268852 ms | unsafe within 5 s; safe captured |
| `g55-reservation-3fecda14-172-3` | 1568 ms | 2512 ms | 1006099 ms | unsafe within 5 s; safe observed in W83 resume |

The original W81 D1 query was the first and only failed one at that time:
`remote D1 query failed: exit 1`. Wrangler's captured stdout names the remote
D1 query and `Authentication error [code: 10000]`; captured stderr is the
empty string. The failure remains verbatim in the original raw artifact.

After operator-refreshed OAuth, W83 first verified live identity with the
pinned Wrangler: the latest 100%-traffic deployment-list record was version
`22b5ba16-b8aa-4927-a5f1-eeaa1769a48b` remained annotated
`SDT-G55 bb7afec95dbe2c3749f25216885a962bc6cfa20c`. No redeploy occurred.
At `2026-09-03T01:44:57.384Z`, the one authorized resume query recorded the
before receipt preserved from the original cohort (133 receipts / 0 rows), the
after receipt (134 receipts / 0 rows), and active safe head
`063923995692002000000693137501`. That head exactly equals reservation 3's
SUID, completing its commit-to-observed-safe timing at 1,006,099 ms at
`2026-09-03T01:44:58.487Z`. The original first/second safe observations remain
the authoritative 38,356 ms and 268,852 ms timings; they were not recomputed
from the later resume observation.

The single deployed G15 invocation then failed before its command sequence:
the Python harness's `GET /` frontend-root read raised
`socket.timeout: The read operation timed out` after 15 seconds. Its failure
receipt is `.artifacts/sdt-g55-w83-g15-failure.json`. G15 was not retried and
G16 was not started, so neither deployed gate is claimed green. This e2e stop
blocks a passing AC5/ready-PR claim without altering the completed same-cohort
receipt or timing evidence.

## Local validation / preservation

- `npm run lint` — passed.
- `npm run typecheck` — passed.
- `npm run test:g55` — passed: 12 tests plus all G55 forced-red mutations.
- `npm run test:g15` — passed: 9 local tests.
- `npm run test:g16` — passed: 6 tests and static UI contract.
- `npm run test:g49` — passed, including all binding/migration omission
  mutants.
- `npm run build:g55:bundle` — passed with the new local-runtime/bundle
  mutation proof before deploy; the same gate passed on the uploaded bundle.
- `node scripts/deploy/g55-read-visibility-resume.mjs --self-test` — passed,
  including the below-safe-head forced-red completion mutant.
- `npm run lint -- --quiet` — passed during W83.
- `npm run e2e:g15 -- --base-url https://sekiban-dcb-meeting-room-cloudflare-only.ttakaoka.workers.dev --report .artifacts/sdt-g55-w83-g15.json`
  — attempted exactly once; blocked at frontend-root read timeout before any
  G15 command. G16 intentionally was not started.

No G54 known-divergence expectations, SDT-G56 work, SDT-G53 work, commit
path, tag-state response, trace schema, safe-window constants, G41 fixture,
G49 binding parity, G51 tracing, or G52 snapshot-sink source was changed.
