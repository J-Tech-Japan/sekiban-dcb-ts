# SDT-G53 deployment evidence

Status: blocked after one authorized normal-config deployment window.

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
