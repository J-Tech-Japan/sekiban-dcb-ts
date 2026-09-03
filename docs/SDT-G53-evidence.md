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

## Honest AC5 stop

The one unmodified G16 invocation was started with its required deployed URL,
configured service identity, and report target
`.artifacts/sdt-g53-w87-g16.json`. Its command receipt yielded after 30.2
seconds without a terminal result, and no G16 report was subsequently
persisted. No second G16 invocation was issued. Therefore it is not counted as
a pass and cannot be reconstructed from individual requests.

The negative mismatch endpoint is intentionally authenticated. No authorized
`G53_CONFORMANCE_TOKEN_FILE` (or existing G14/G20/G29/G31/G32/G37/G42/G54/G55
conformance-token-file alias) was available to this seat; only the separately
authorized observability credential exists, and it was neither read nor used.
The secret was not rotated, guessed, copied, logged, or committed. Consequently
the deployed `scope.mismatch` probe was not sent.

AC5 is incomplete solely on those two explicit missing receipts. This evidence
does not claim a passing G16 result or a deployed mismatch result, and no PR
has been opened from this blocked checkpoint.
