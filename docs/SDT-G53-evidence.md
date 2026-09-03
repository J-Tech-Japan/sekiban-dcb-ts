# SDT-G53 deployment evidence

Status: blocked at the W89 authenticated scope-mismatch verifier after the
downstream repair, one normal-config deployment, and fresh G15/G16 receipts
completed. The failed verifier was not retried.

## Deployed identity

| Field | Value |
| --- | --- |
| Worker | `sekiban-dcb-meeting-room-cloudflare-only` |
| workers.dev URL | `https://sekiban-dcb-meeting-room-cloudflare-only.ttakaoka.workers.dev` |
| deployed source commit | `357153794b830cce45fbcf54f33eb49191976f75` |
| Cloudflare version | `c23306bf-70a5-4d81-a871-3a3b0a6ffe81` |
| deployment receipt | version message `SDT-G53 357153794b830cce45fbcf54f33eb49191976f75` |
| deployment config | `samples/meeting-room/wrangler.cloudflare-only.jsonc` |

The deployment used the repository-pinned Wrangler binary under OAuth, with
no API-token fallback and no `--keep-vars`. The G53 physical-name grammar is
deliberately a C-0 rename: every pre-existing Durable Object instance is
unreachable by design; no alias or migration path was introduced.

## Local contract proof

The following completed green against the committed source before deployment:

- `npm run lint` and `npm run typecheck`;
- `npm run test:g15`, `npm run test:g16`, and the focused `test:g53` fixtures;
- `node scripts/g53-scope-identity-check.mjs --self-test` and the normal check;
- `node scripts/g53-scope-mutation-runner.mjs`, with both comparison-removed
  and identity-missing-pass-through production mutants red;
- existing G21, G22, G41, G42, G46, G49, and G51 lanes.

The G53 static check permits the platform `idFromName` call only in
`ScopeName.ts`; all runtime and sample call sites use the same exported
`buildScopeName`/`parseScopeName` grammar. The control-route test proves a
`scope.mismatch` response is emitted before the Durable Object namespace is
resolved and that its structured `sdt.scope/v1` warning excludes the deployment
identity.

## Deployed app proof

The unmodified G15 harness passed once against the deployed workers.dev URL.
Its raw receipt is `.artifacts/sdt-g53-w87-g15.json`:

| Measurement | Result |
| --- | --- |
| create command | HTTP 200; 2,971.347 ms; SUID `063924004616150000001596524746` |
| create visibility | 170.784 ms |
| reservation command | HTTP 200; 1,993.106 ms; SUID `063924004618274000001716627492` |
| reservation visibility | 324.401 ms |
| cancellation command | HTTP 200; 1,287.231 ms; SUID `063924004619994000002012400444` |
| cancellation visibility | 228.389 ms |
| invalid command | HTTP 400 `invalid_command_input` |
| safe-window bound | 120,000 ms in runtime, served UI, and harness |

## W88 receipt continuation and honest AC5 stop

Before the authorized W88 G16 run, a separate, non-command warm-up `GET /`
returned HTTP 200 in `0.206415 s` at `2026-09-03T04:09:30Z`, below its
30-second bound. It is not counted as a G16 command.

The unmodified deployed G16 harness then ran exactly once. It did not hit its
15-second per-request socket limit: its final page-two request took
`7,404.298 ms`. Instead, it reached the unchanged 120,000 ms reservation-list
visibility bound. The final page scan had `totalCount=23`, `totalPages=2`, and
`pageItemsTotal=23`, but did not contain the new reservation on either page;
the final elapsed time was `125,350.705 ms`. The complete preserved error and
the three final observations are in
`.artifacts/sdt-g53-w88-g16-failure.json`.

Because this was not a 15-second socket timeout, the narrow authorization to
raise only that socket bound to 30 seconds does not apply. No harness code was
changed and no second G16 invocation was issued. The 120-second safe-window
and all oracle semantics remain unchanged.

The W88 stop rule therefore also prevents the authenticated mismatch step. No
`CONFORMANCE_TOKEN` secret was installed, rotated, read, guessed, copied,
logged, or committed; the Observability credential was not used as a
substitute. The deployed `scope.mismatch` probe was not sent.

AC5 remains incomplete, so no PR has been opened from this checkpoint.

## W89 downstream scope cutover repair

### Reproduction and hop trace before repair

At `2026-09-03T04:22:30.545Z`, one diagnostic room and reservation were
accepted by the deployed G53 Worker. The reservation response carried SUID
`063924006150182000000680543461` and event id
`01a06581-0604-7839-8fc4-6b9f799cf818`. Its scoped Tag state was present as
`reservation:g53-w89-reservation-5ca9433a1cb7411a:ReservationProjector` with
that exact head, so commit admission and the new physical Tag scope were not
the failure.

The downstream facts pinpointed the next hop:

| Hop | Observed fact |
| --- | --- |
| source outbox | The diagnostic room/reservation appeared in the source-partition registry; the service had 341 registered source partitions. |
| Queue | `sekiban-dcb-meeting-room-cloudflare-outbox` had the primary Worker as its sole consumer, with `max_retries=3` and the configured DLQ. |
| global D1 admission | Neither diagnostic event existed in `dcb_events` or `dcb_event_ops`. |
| delivery incident | The reservation had a `serialized_dcb_wait_target_incidents` row with `LINEAGE_MISMATCH`. |

The old global allocator binding was
`5b4aa018-94ee-412f-8155-47c8cbfeaefe`; the incoming scoped allocator lineage
was `11a7b3b1-dd35-49dc-b459-c51f9588520d`. The source scanner was also
`UNKNOWN` with `source_partition_unreadable:503`, because historic registry
rows resolve to Durable Object instances abandoned by the G53 physical-name
grammar. This is a producer/consumer cutover-state mismatch, not a silent
commit or materialized-view failure.

### Repair and local guard

Commit `002e33ef1fbc071632f5ba3118f1018aae7a2652` adds the one-time
`scripts/deploy/g53-scope-cutover-reset.sql` procedure and makes the G44
source fixture use `buildScopeName`. The focused fixture now performs the
actual path: canonical Tag source -> outbox Queue payload ->
`processDownstreamDelivery` -> global D1 receipt -> source acknowledgement ->
FULL scanner frontier. Its old-name OutboxDrain mutant (`service|tag`) turns
the exact focused fixture red after a successful package build.

Green local evidence before deployment:

- `npm run test:g53` (including control-route and downstream old-name mutants);
- `npm run test:g44`, `npm run test:g15`, and `npm run test:g16`;
- `npm run lint` and `npm run typecheck`.

The normal-config dry build also passed with bundle SHA-256
`10af754e221dc3973ed9ee2d0f3373c9eec7a5646d96eb70c0602d1673c2380b`.

### Deployment, authorized C-0/C-13 reset, and fresh receipts

The repository-pinned OAuth Wrangler deployed commit `002e33ef1fbc071632f5ba3118f1018aae7a2652`
with `samples/meeting-room/wrangler.cloudflare-only.jsonc`, no API-token
fallback and no `--keep-vars`. Code version
`6b24a78a-c09b-48bd-bf26-751b22a63384` was deployed at 100% with message
`SDT-G53 downstream scope repair 002e33ef1fbc071632f5ba3118f1018aae7a2652`.

Under C-0/C-13, the one-time reset removed the service's retired global
allocator binding, source-partition registry, scanner health, and completeness
findings: 358 rows across those four tables. It intentionally retained
`dcb_events`, delivery/wait-target incidents, receipts, and other audit data.
Because the source registry does not encode the old physical grammar, this
also abandons the diagnostic unacknowledged source entries; that is an explicit
authorized cutover consequence, not a migration claim.

Post-reset, the new allocator binding is
`11a7b3b1-dd35-49dc-b459-c51f9588520d`; four fresh scoped partitions are
registered and scanner health is `HEALTHY`. All six fresh G15/G16 command
SUIDs are present in global `dcb_events`, proving the repaired path reaches
global D1 before either materialized-view lane observes it.

| Fresh receipt | Result |
| --- | --- |
| G15 run `c4470758a37a4fed83915d0d81a3c177` | create/reserve/cancel HTTP 200, visible in 366.200 / 236.777 / 168.561 ms; SUIDs `063924007110245000000872153413`, `063924007114460000001927391132`, and `063924007115933000000866071434`. |
| recorded warm-up | one `GET /` at `2026-09-03T04:38:47Z`: HTTP 200 in 12.623597 s, under the separate 30-second bound; not a G16 command. |
| G16 run `eb73659b923e46ebad9e54ddc7bf3134` | create/reserve/cancel HTTP 200, projection visibility 268.587 / 252.527 / 189.241 ms; reservation-list page-two item visible in 5,532.056 ms, with 25 total rows across two pages. |

### Bounded authenticated mismatch proof: blocked without retry

After G15/G16, a fresh private `CONFORMANCE_TOKEN` was generated through
`G53_CONFORMANCE_TOKEN_FILE` and installed once with the pinned OAuth
Wrangler. Cloudflare recorded the resulting secret-only active version as
`0c3818e7-8d6c-47f8-8a03-bb66d25391ec`; no second code deployment occurred.
The one authorized `g53-scope-mismatch-e2e.mjs` invocation then failed at
`verifyScopeMismatch` with the exact stderr message:

`Error: G53 mismatch probe did not return typed scope.mismatch`

The harness intentionally does not persist a non-passing response payload, so
no status or body is inferred here. The private token's contents and path were
never printed, copied into evidence, or committed. Per the bounded rule, no
second probe was sent. That final typed-control receipt remains incomplete,
so this checkpoint has no PR or worker-complete outcome despite the repaired
downstream and G15/G16 receipts.
