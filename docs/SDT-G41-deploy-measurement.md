# SDT-G47 deployed measurement record

Status: **BLOCKED**

The resumed wake (`wake31-g47-impl-20260831T164200Z`) remains blocked by
`BLOCKER-CLOUDFLARE-OAUTH-EXPIRED-WAKE31`.

This wake did not perform the authorized repair or the post-G41 measurement.
The required Cloudflare authentication expired before any remote operation:

```text
WRANGLER_WRITE_LOGS=false node_modules/.bin/wrangler whoami --json
exit 1
Not logged in. Your auth token has expired and could not be refreshed, and the environment is non-interactive.
```

Named blocker: `BLOCKER-CLOUDFLARE-OAUTH-EXPIRED-WAKE30`.

Consequently, neither `migrations/d1/g32/0001_dcb_events.sql` nor
`migrations/d1/g32/0002_g44_global_completeness.sql` was applied to D1 or
D1_MV; no Worker was deployed; no G47 sample was run; and no deployed
measurement or PR was claimed. No local run substitutes for deployed
evidence. AC2, AC3, AC4, AC6, and AC7 therefore have no new claim verdict in
this record.

The repository head after recording the stop evidence is
`4ab891f727bdd72e1821fd59b100cce772aef61d` (the pre-recording head was
`58269a620a6f00997502b1103aea39d358eb62be`).
`git diff --name-only -- 'packages/*/src/**'` was empty; no
`packages/*/src` file was changed.

Machine-readable blocker evidence:
`.artifacts/sdt-g47-repair-blocker-wake31.json`.
