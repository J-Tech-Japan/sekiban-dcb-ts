# SDT-G55 — read visibility evidence

Issue: [#106](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/106)  
Candidate source commit: `be2f0ee1688e92208876f3d713f3d4563b2f00f4`  
Deployment: Cloudflare version `a49d2a7e-0dd4-470d-b9ee-7854170075d9`

## Status: blocked after the one bounded deployed cohort

This document preserves the failed AC5 attempt rather than treating any part
of it as a passing stitched result. No second deployment and no replacement
room/reservation cohort was sent.

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

The candidate removes that same-invocation drain from the normal Worker and
the shared direct-doorbell fallback. It preserves durable kicks and the
existing scheduled safe catch-up/GC order. During the only cohort, the remote
facts moved from 132 receipts / 0 rows to 136 receipts / 3 rows: the three
reservation unsafe rows were retained instead of immediately pruned. The
existing measured 1.5–1.8 s queue-to-global-D1 baseline remains the prior
reference point.

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

## AC5 one-cohort receipt and blocking result

The candidate was deployed with the repository-pinned Wrangler CLI via OAuth,
normal `samples/meeting-room/wrangler.cloudflare-only.jsonc`, and no
`--keep-vars`. The Cloudflare version metadata records the candidate source
SHA in its deployment message.

The coherent cohort in `.artifacts/sdt-g55-e2e.json` created exactly one room
(`g55-room-138b0c26-7b2`) and these three reservations. The app route first
contained each reservation within the required five seconds:

| Reservation | Commit response | Commit → unsafe visible | Result |
| --- | ---: | ---: | --- |
| `g55-reservation-138b0c26-7b2-1` | 1603 ms | 3964 ms | within 5 s |
| `g55-reservation-138b0c26-7b2-2` | 1139 ms | 2355 ms | within 5 s |
| `g55-reservation-138b0c26-7b2-3` | 1339 ms | 2207 ms | within 5 s |

However, every app-list observation returned `readHead: null`, and the active
safe head remained `063923976351782000001484266421` for the cohort's bounded
120 s safe-head observation. Therefore the cohort does **not** satisfy AC1 or
AC5 and is intentionally not reported as a successful deployed verification.

The cause is deployment-integrity, not an OAuth or application-request retry:
the clean worktree had no local `node_modules`; its inherited
`../node_modules/@sekiban/dcb-runtime` link resolves to the parent checkout's
`packages/dcb-runtime`, not `.g55-w81/packages/dcb-runtime`. Wrangler bundled
that parent checkout's stale runtime `dist` while correctly bundling the
candidate sample source and annotating the version with `be2f0ee…`. The stale
runtime does not have `readListPage`, so it ignored the new selector and could
not emit `readHead`. The retained three unsafe rows explain why the old
composed read nevertheless showed list visibility.

Correcting that workspace build topology and rerunning a new deployed cohort
requires fresh authorization. This run did not redeploy, rerun the e2e, or
send any replacement application requests after the failure.

## Local validation / preservation

- `npm run lint` — passed.
- `npm run typecheck` — passed.
- `npm run test:g55` — passed: 12 tests plus all G55 forced-red mutations.
- `npm run test:g31` — passed: 33 tests and the indexed wait guard.
- `npm run test:g16` — passed: 6 tests and static UI contract.

No G54 known-divergence expectations, SDT-G56 work, SDT-G53 work, commit
path, tag-state response, trace schema, safe-window constants, G41 fixture,
G49 binding parity, G51 tracing, or G52 snapshot-sink source was changed.
