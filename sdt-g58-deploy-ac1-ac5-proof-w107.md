# SDT-G58 deployed AC1/AC5 proof — W107

Status: **blocked** at the first deployed authenticated proof request.

The checkpoint began at branch `claude/sdt-g58-safe-lane-w93`, exact pushed
head `700c0cb4bf7c896a8b676d4613bfae53fca58519`. Local W106 product and
re-entry evidence were preserved; no new product change was made in W107.

## Wrangler and preconditions

- Repository-pinned Wrangler: `./node_modules/.bin/wrangler`, version `4.125.0`.
- The one `whoami` succeeded through OAuth at
  `2026-09-03T11:26:28Z`–`11:26:30Z`; `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID` were unset.
- OAuth credential mtime advanced from `2026-09-03T01:58:55Z` to
  `2026-09-03T04:26:29Z`, then stayed unchanged through the remaining
  Wrangler operations.
- Read-only C-0/C-13 preconditions at `11:29:58Z`–`11:30:01Z` returned
  `No migrations to apply!` for both configured D1 databases. No reset/purge
  was run.
- Metadata-only secret inventory (corrected `--format json` syntax) confirmed
  `CONFORMANCE_TOKEN` by name as `secret_text`; no value was read or rotated.
  The Observability token was not required and its contents were never read.

Raw precondition and deployment identity receipts:

- `.artifacts/sdt-g58-w107-preconditions.json`
- `.artifacts/sdt-g58-w107-deploy-identity.json`

## Exact deployment

The single normal-config deployment command was:

```text
env -u CLOUDFLARE_API_TOKEN ./node_modules/.bin/wrangler deploy --config samples/meeting-room/wrangler.cloudflare-only.jsonc --strict --message "SDT-G58 W107 AC1 AC5 proof 700c0cb4"
```

Cloudflare reported success at `2026-09-03T11:30:54Z`–`11:30:57Z`:

- URL: `https://sekiban-dcb-meeting-room-cloudflare-only.ttakaoka.workers.dev`;
- version `9e5586ad-0cb1-4d00-9c05-89306e04520f` (number 192);
- annotation `SDT-G58 W107 AC1 AC5 proof 700c0cb4` with source
  `700c0cb4bf7c896a8b676d4613bfae53fca58519`;
- deployment `33834995-7f23-4102-bea7-7c677708861e` at 100%.

The local wrapper subsequently exited 1 on `zsh:7: read-only variable: status`
after the Cloudflare success line. No deployment retry was made.

## AC1/AC5 proof result

The existing single-witness harness was invoked exactly once at
`2026-09-03T11:31:50.216Z` with the protected G53 token file. Its first
authenticated request, `GET /conformance/v1/read-health`, returned HTTP 403 in
427 ms. It failed before sending any room/reservation command, so no fresh
application cohort exists in this wake and no AC1 health fields or AC5
live-projection advancement may be claimed.

Receipt: `.artifacts/sdt-g58-w107-ac5-single.json` (run id
`cf0cf24a-2498-4029-97e5-762511edfed9`, `status=failed`,
`failure=read-health failed HTTP 403`). The bearer value is absent. Per the
authorization boundary, there was no second request, token rotation, fallback,
or deploy attempt.

## Validation and boundary

- `npm run test:g58` — passed (8 tests and all G58 guards, including the W106
  re-entry guard/mutations).
- `npm run test:g44` — passed with the correctness fixture and forced-red
  mutations unchanged.
- `npm run typecheck` — passed.
- `npm run lint` — passed with zero warnings.

SafeWindow `20,000/120,000 ms`, the 5,000 ms unsafe constant, G44/W97/W104/
W106 behavior, minimum aggregation, and SDT-G60-owned upstream paths remain
unchanged. No PR or worker completion was run. The branch was pushed with this
durable blocked evidence checkpoint.
