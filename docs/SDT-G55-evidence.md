# SDT-G55 — read visibility evidence

Issue: [#106](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/106)
Product source commit: `be2f0ee1688e92208876f3d713f3d4563b2f00f4`
Packaging-gate commit: `bb7afec95dbe2c3749f25216885a962bc6cfa20c`
Fresh deployment: Cloudflare version `22b5ba16-b8aa-4927-a5f1-eeaa1769a48b`

## Status: blocked after the one fresh packaging-repair cohort

The earlier version `a49d2a7e-0dd4-470d-b9ee-7854170075d9` is historical
blocked evidence only: although it was annotated with `be2f0ee…`, it bundled
the parent worktree's stale runtime distribution. It is not used in any AC5
claim below.

The fresh version was built from this worktree after a local lockfile-faithful
dependency install and passed a deterministic bundle gate before and after
upload. It then ran exactly one fresh room-plus-three-reservations cohort. The
cohort's final safe-head D1 query failed with OAuth authentication code 10000,
so its third safe timing and the requested post-cohort D1 receipt are honestly
unavailable. No retry, replacement cohort, or evidence stitch was performed.

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
new rows visible under the explicit unsafe lane. The required after receipt
was not queried because the first remote D1 authentication failure is the
window's stopping point.

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

## AC5 fresh-cohort receipt and blocking result

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
| `g55-reservation-3fecda14-172-3` | 1568 ms | 2512 ms | unavailable | unsafe within 5 s; query stopped |

After the second safe timing, the next remote D1 call was the first and only
failed one:
`remote D1 query failed: exit 1`. Wrangler's captured stdout names the remote
D1 query and `Authentication error [code: 10000]`; captured stderr is the
empty string. The failure is retained verbatim in the raw artifact. This is a
credential/e2e stop, not a reason to fabricate the third safe timing or D1
after receipt. G15/G16 deployed e2e was not started after that stop, so neither
is claimed green for this window.

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

No G54 known-divergence expectations, SDT-G56 work, SDT-G53 work, commit
path, tag-state response, trace schema, safe-window constants, G41 fixture,
G49 binding parity, G51 tracing, or G52 snapshot-sink source was changed.
