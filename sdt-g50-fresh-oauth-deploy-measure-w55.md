# SDT-G50 fresh OAuth deploy and measure — W55

**Task:** `SDT-G50-FRESH-OAUTH-DEPLOY-MEASURE-W55`
**Status:** blocked — the deployed app command returned HTTP 503 before a coherent measurement window could start
**Execution unit:** `execution-unit:SDT-G50`

## OAuth and sandbox persistence proof

The first Wrangler operation used the repository-pinned executable exactly as required:

```sh
env -u CLOUDFLARE_API_TOKEN -u CF_API_TOKEN -u CLOUDFLARE_API_KEY -u CF_API_KEY -u WRANGLER_API_TOKEN -u CLOUDFLARE_EMAIL -u G50_OBSERVABILITY_TOKEN_FILE ./node_modules/.bin/wrangler whoami
```

`wrangler 4.125.0` completed successfully and identified an OAuth login. No API-token fallback was used. The config file was inspected only by metadata, never by content:

| Checkpoint | `default.toml` mtime epoch | Local timestamp |
| --- | ---: | --- |
| Before this seat's Wrangler operations | 1788299329 | 2026-09-01T14:48:49-0700 |
| After this seat's final Wrangler operation | 1788299329 | 2026-09-01T14:48:49-0700 |

The mtime did **not** advance. OAuth `whoami`, deployment, and version-list operations all succeeded, but none required a refresh rotation during this seat, so the newly writable sandbox path was not exercised by a write.

## Deployment identity

The preserved branch head was deployed with `samples/meeting-room/wrangler.cloudflare-only.jsonc`, without a config edit:

| Field | Observed value |
| --- | --- |
| Service | `sekiban-dcb-meeting-room-cloudflare-only` |
| URL | `https://sekiban-dcb-meeting-room-cloudflare-only.ttakaoka.workers.dev` |
| New Cloudflare version ID | `94e3ceb1-eb5d-45bd-99a4-16bbb04cef02` |
| Deployed local source SHA | `be7969d57e723f2e8e1a70ccefb54b70252a40b8` |
| Source commit subject | `chore(g50): enable normal config observability` |

The post-deploy pinned-Wrangler version listing observed the new version as number 176, created at `2026-09-01T21:52:58.687945Z`.

## Measurement stop

The non-live G50 guards passed before live traffic: they enforce one discarded accepted warm-up, exactly 50 sequential accepted app-surface commits, nearest-rank p50/p95, and rejection of missing active trace hops.

The live sampler then stopped at its required first condition twice:

1. After the normal post-deploy settlement, the first warm-up `POST /api/commands/create-room` returned HTTP 503 at SJC before any accepted commit.
2. I waited a further full 60-second settlement interval and verified `GET /` returned HTTP 200. The one newly started warm-up again returned HTTP 503 at SJC before any accepted commit.

Both receipts are preserved in [`.artifacts/sdt-g50-w55-prewindow-failures.json`](.artifacts/sdt-g50-w55-prewindow-failures.json). They are pre-window failures, not samples: no accepted warm-up, no accepted sample, no trace data, and no client statistic were reused from either.

The sampler received the permitted token-file *path* only through `G50_OBSERVABILITY_TOKEN_FILE=/Users/tomohisa/.config/sekiban-dcb/observability-token`. Its contents were never printed, logged, copied, or committed. The sampler aborted before sending a retained-trace query.

## Evidence boundary

No fresh 50-commit coherent window exists, so AC3–AC5 cannot honestly be claimed. In particular, this wake deliberately does **not** present the G37 960/1510 ms SJC or G30 2564 ms SJC comparison, an S04/S05 removal statement citing G47, a residual ranking, or an eighth observation about prior observability absence as new W55 evidence. Doing so would stitch older facts to an absent sample.

Observability-config parity remains a future guard candidate only; W55 did not extend the G49 binding-parity guard.

## Preservation and next state

The existing G50 tooling, identity receipts, branch `claude/sdt-g50-commit-latency`, and unrelated worktree artifacts were preserved. No source/config repair was attempted. Because the app command did not admit a single warm-up commit, no measurement evidence is available to commit, push, or place in a PR; no PR and no `worker complete --outcome pr-created` action was taken.
