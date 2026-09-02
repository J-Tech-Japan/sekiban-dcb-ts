# SDT-G50 config-vars deploy and measure — W56

**Task:** `SDT-G50-CONFIG-VARS-DEPLOY-MEASURE-W56`
**Status:** blocked — the one fresh cohort had no retained active per-hop rows
**Execution unit:** `execution-unit:SDT-G50`

## Authorized config amendment

Committed only `samples/meeting-room/wrangler.cloudflare-only.jsonc` as
`2cfe5c5284caadc836b2b608820b1396dd8da67e`
(`fix(g50): restore normal config cutover vars`). The commit adds exactly:

| Variable | Value |
| --- | --- |
| `G32_COMPONENT` | `primary` |
| `G32_CUTOVER_PHASE` | `final-g32` |
| `G32_FREEZE_RELEASE` | `after-new-bindings` |
| `G32_CUTOVER_FENCE_FINGERPRINT` | `fab7cd0045f5e568c0d72cfadc9dfe6f5bc2236903773e3ea2ede81cfaf1cf19` |

No other config change, secret mutation, or `--keep-vars` use occurred.

## OAuth deployment identity

The repository-pinned `./node_modules/.bin/wrangler whoami` succeeded with
OAuth and no API-token fallback. The resulting head was deployed with the
normal config and a source-SHA deployment message:

| Field | Observed value |
| --- | --- |
| Service | `sekiban-dcb-meeting-room-cloudflare-only` |
| URL | `https://sekiban-dcb-meeting-room-cloudflare-only.ttakaoka.workers.dev` |
| New Cloudflare version ID | `5610dd9d-2dfa-497b-99e9-9d6903deceab` |
| Deployed source SHA | `2cfe5c5284caadc836b2b608820b1396dd8da67e` |
| Deployment message | `SDT-G50 W56 2cfe5c5284caadc836b2b608820b1396dd8da67e` |

Wrangler’s deploy output confirmed all four configured G32 variables.

## Required accepted-commit preflight

After activation settlement, the separate preflight `POST /api/commands/create-room`
returned `200`, `kind=committed`, CF-Ray `a347acf33b3bb7b9-PDX`, and SUID
`063923898167640000000601610025`. This fixed the prior W55 HTTP 503 condition
before the measured cohort began.

## Fresh cohort stop

One new cohort was started with one discarded warm-up and 50 requested
sequential app-surface samples. Its single retained-trace query then failed
validation with this exact error:

```text
g50-commit-latency:retained telemetry is missing active per-hop rows: S00, S01, S02, S03, S06, S07, S08, S09, S10, S11, S12, S13, S14, S15, S16
```

The sampler writes the raw artifact only after those required trace rows
validate, so no raw sample, client p50/p95, or colo distribution was emitted.
The cohort is therefore unusable for AC1–AC5 and is not restated as a partial
measurement. I did not retry the trace query, rerun a cohort, use a fallback,
or stitch any prior evidence. The exact deployment, preflight, and error
receipt is [`.artifacts/sdt-g50-w56-trace-schema-failure.json`](.artifacts/sdt-g50-w56-trace-schema-failure.json).

The sampler received only the permitted token-file path through
`G50_OBSERVABILITY_TOKEN_FILE=/Users/tomohisa/.config/sekiban-dcb/observability-token`.
No token contents were printed, logged, copied, or committed.

## Evidence boundary and follow-up candidates

Because retained per-hop data is absent, W56 makes no new AC3 comparison to
G37 (960/1510 ms SJC) or G30 (2564 ms SJC), no G47-cited S04/S05 removal
claim, no residual ranking, and no eighth or ninth finding. Reusing any of
those statements here would be stitched evidence rather than a fresh result.

Observability parity and config-var parity remain future guard candidates only;
this unit did not extend the G49 binding-parity guard.

## Preservation

The four-var config commit is local and unpushed. Existing uncommitted G50
tooling/evidence and unrelated artifacts were preserved. With no valid raw
cohort, no tooling/evidence commit, push, PR, or
`worker complete --outcome pr-created` transition was performed.
