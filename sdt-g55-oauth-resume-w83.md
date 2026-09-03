# SDT-G55 OAuth resume — W83

Issue: [#106](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/106)
Status: **blocked** — completed the authorized same-cohort D1 resume, then the
single required deployed G15 run timed out before its command sequence.

## Live identity

- Pinned Wrangler `4.125.0` OAuth `whoami` succeeded at
  `2026-09-03T01:43:07Z` with `CLOUDFLARE_API_TOKEN` unset.
- The latest read-only deployments-list record at `2026-09-03T01:43:18Z` was
  version `22b5ba16-b8aa-4927-a5f1-eeaa1769a48b` at 100% traffic.
- The read-only versions list at `2026-09-03T01:43:22Z` mapped that version to
  `SDT-G55 bb7afec95dbe2c3749f25216885a962bc6cfa20c`.

The expected deployment therefore remained live; no redeploy occurred.

## Preserved W81 cohort resume

The only remote resume query targeted the pre-existing W81 run
`3fecda14-172b-41df-992c-0f04cd8ce281`; the resume tool sent zero app requests
and made one D1 query. Its raw result is
`.artifacts/sdt-g55-oauth-resume.json`.

| Receipt / timing | Result |
| --- | --- |
| Original D1 before | 133 unsafe receipts, 0 unsafe rows |
| Resumed D1 after | 134 unsafe receipts, 0 unsafe rows |
| Active safe head | `063923995692002000000693137501` |
| Third reservation SUID | `063923995692002000000693137501` |
| Third commit → observed safe head | 1,006,099 ms at `2026-09-03T01:44:58.487Z` |

The existing first/second safe timings remain 38,356 ms and 268,852 ms from
the original artifact; the resumed observation completes only the missing
third timing. All three original reservations had already met their unsafe
visibility bound (4,407 / 3,003 / 2,512 ms).

## Gate stop

`npm run e2e:g15` was run exactly once against the deployed Worker with the
expected non-secret service identity. Its frontend-root `GET /` read timed out
after the harness's 15-second socket timeout, before it could issue a G15
command or write the requested report. The exact invocation and failure are
preserved in `.artifacts/sdt-g55-w83-g15-failure.json`.

No retry was made and G16 was not started. Consequently the ready-for-review
PR and `worker complete --outcome pr-created` steps are not authorized by a
passing AC5 gate in this wake.

## Local resume validation

- `node scripts/deploy/g55-read-visibility-resume.mjs --self-test` — passed,
  including the below-safe-head forced-red case.
- `npm run lint -- --quiet` — passed.
