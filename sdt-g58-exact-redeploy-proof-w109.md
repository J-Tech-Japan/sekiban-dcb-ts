# SDT-G58 exact redeploy proof — W109

Status: **blocked**

This checkpoint started from pushed branch `claude/sdt-g58-safe-lane-w93`
at `2978a2699fa7adfdab13a460fb82780b791ebf32`. It performed the single
authorized provenance-recovery deployment, then stopped at the first bounded
AC5 live-projector failure. No PR or worker completion was run.

## Credential and deployment boundary

- A filesystem-only existence check confirmed the private W108 token path
  `/Users/tomohisa/dev/GitHub/SekibanDcbTsImplementation/.g58-w93/.artifacts/.sdt-g58-w108-conformance-token`.
  The value was never read, printed, logged, copied, or committed, and no
  second credential was generated. The Observability token was not needed and
  was not read.
- The one exclusive Wrangler window used the repository-pinned Wrangler
  `4.125.0`, OAuth only, with `CLOUDFLARE_API_TOKEN` unset. `whoami` succeeded
  at `2026-09-03T11:47:44Z`; metadata-only secret list at `11:47:45Z`
  confirmed `CONFORMANCE_TOKEN` is present as `secret_text` without exposing a
  value. The Wrangler credential/config mtime was `1788434789` before and
  after.
- A temporary detached worktree was created at exact product commit
  `700c0cb4bf7c896a8b676d4613bfae53fca58519`. No product file was changed.
  The one normal-config deploy (no `--keep-vars`) ran at
  `11:47:46Z`–`11:47:55Z`:

  ```text
  env -u CLOUDFLARE_API_TOKEN ./node_modules/.bin/wrangler deploy --config samples/meeting-room/wrangler.cloudflare-only.jsonc --strict --message "SDT-G58 W109 exact product 700c0cb4bf7c896a8b676d4613bfae53fca58519"
  ```

- Pre-proof readback established 100% exact provenance: version
  `7b4e30eb-5666-46d6-8a8e-57ffa9edb07a` (number 194), deployment
  `88923566-dde8-47c2-ac48-d17b3c28a541`, annotation
  `SDT-G58 W109 exact product 700c0cb4bf7c896a8b676d4613bfae53fca58519`.
  Raw receipts are `.artifacts/sdt-g58-w109-versions.json`,
  `.artifacts/sdt-g58-w109-deployments.json`,
  `.artifacts/sdt-g58-w109-deploy-identity.json`, and the sanitized Wrangler
  logs.

## AC1/AC5 witness

After provenance passed, the existing single-witness harness was invoked once
at `2026-09-03T11:49:09.071Z` and finished at `11:51:34.927Z`:

```text
env -u CLOUDFLARE_API_TOKEN G53_CONFORMANCE_TOKEN_FILE=/Users/tomohisa/dev/GitHub/SekibanDcbTsImplementation/.g58-w93/.artifacts/.sdt-g58-w108-conformance-token node scripts/deploy/g58-safe-lane-e2e.mjs --mode single --base-url https://sekiban-dcb-meeting-room-cloudflare-only.ttakaoka.workers.dev --token-file /Users/tomohisa/dev/GitHub/SekibanDcbTsImplementation/.g58-w93/.artifacts/.sdt-g58-w108-conformance-token --report .artifacts/sdt-g58-w109-ac5-single.json
```

The first authenticated read-health was HTTP 200, coverage `SETTLED`,
`safeWindowMs=20000`, with both materialized views and pre-cohort live heads.
The witness then accepted exactly one room command (SUID
`063924032951123000000681124863`) and one reservation command (SUID
`063924032953080000000952631413`). The reservation was unsafe-visible in
`2567 ms` and reached both materialized safe heads in `42492 ms`.

AC5 nevertheless failed at the harness deadline (`safeWindowMs + 120000 ms`):

- RoomProjector live head:
  `063924025191103000001618685662`;
- ReservationProjector live head:
  `063923872440789000000196782566`;
- both `lastPollAt` values remained `1788428464638` (the old pre-witness
  timestamp);
- tag-state `lastSortedUniqueId` values had reached the target, but projection
  lag reported `behindEvents=2` for the room and `behindEvents=1` for the
  reservation, so live-head and projection-row readiness were false.

The exact failure was:

```text
safe lane or live projections did not reach 063924032953080000000952631413 by safeWindowMs + 120000ms
```

The complete 58-health-snapshot receipt is
`.artifacts/sdt-g58-w109-ac5-single.json`; it contains CF-Ray values, health
gates, accepted SUIDs, unsafe/safe timings, and no credential value. This is a
deployed AC5 live-projector failure after successful exact-source provenance,
not an OAuth or deployment failure. The paced cohort was not started because
the packet requires AC1/AC5 to pass first. No retry, replacement request,
second deploy, D1 reset, or evidence stitching occurred.

## Scope and disposition

The 5,000 ms unsafe constant, SafeWindow floor/ceiling `20000/120000`,
G44/W97/W104/W106 guards, first-unsafe/fence/order semantics, minimum
aggregation, and SDT-G60-owned outbox/Queue/global-admission path remain
unchanged. The temporary detached worktree was removed after the raw receipts
and this evidence were durable. This wake is **blocked** pending a focused
in-scope AC5 live-projector diagnosis/repair; it does not claim the required
paced cohort or full AC1/AC5 proof.

