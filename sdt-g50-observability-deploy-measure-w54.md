# SDT-G50 observability deploy and measure — W54

**Task:** `SDT-G50-OBSERVABILITY-DEPLOY-MEASURE-W54`
**Status:** blocked — OAuth preflight failed after the authorized relaunch
**Execution unit:** `execution-unit:SDT-G50`

## Stop condition

The required token-free Wrangler preflight was attempted once with the
repository-pinned Wrangler executable. OAuth authentication was not refreshed
in this non-interactive seat. Per the delegated stop condition, no deployment,
retained-trace query, sampler wait, warm-up, measurement commit, API-token
fallback, or retry was performed.

The first shell lookup for a global `wrangler` executable exited 127
(`env: wrangler: No such file or directory`) and did not invoke Wrangler or
Cloudflare. The single actual Wrangler invocation below used the repository's
pinned `wrangler` 4.125.0 executable.

## Token-free OAuth preflight

Command (no credential value was read, printed, copied, or committed):

```sh
env -u CLOUDFLARE_API_TOKEN -u CF_API_TOKEN -u CLOUDFLARE_API_KEY -u CLOUDFLARE_EMAIL -u G50_OBSERVABILITY_TOKEN_FILE ./node_modules/.bin/wrangler whoami
```

Exit status: `1`

Wrangler diagnostic text, verbatim apart from terminal colour-control bytes:

```text
 ⛅️ wrangler 4.125.0
────────────────────
Getting User settings...

✘ [ERROR] Not logged in. Your auth token has expired and could not be refreshed, and the environment is non-interactive. Run `wrangler login` in an interactive terminal or set a CLOUDFLARE_API_TOKEN.

  Run `wrangler whoami` to check your current authentication status.


🪵  Logs were written to "/Users/tomohisa/Library/Preferences/.wrangler/logs/wrangler-2026-09-01_21-22-41_806.log"
```

No `EPERM` path was emitted. The Wrangler-created log path above is retained
as the original diagnostic location; this task did not read or copy it.

## Evidence boundary

- Branch head observed before stopping: `be7969d5` on
  `claude/sdt-g50-commit-latency`; it was not deployed.
- No new Cloudflare version ID or deployed source SHA exists for W54.
- `G50_OBSERVABILITY_TOKEN_FILE` was not set for the OAuth check and the
  retained-trace token file was not accessed.
- There is no fresh coherent 50-commit window, client nearest-rank p50/p95,
  per-hop retained trace, or colo distribution. Consequently, AC3–AC5 cannot
  be claimed from this wake.
- The requested colo-honest G37 (960/1510 ms SJC) and G30 (2564 ms SJC)
  comparison, the explicit G47-backed S04/S05 removal, and residual ranking
  are deliberately not restated as W54 evidence: doing so without a fresh
  measurement would stitch prior evidence into this failed wake.
- Observability config parity remains a future guard candidate only; this wake
  made no extension to the G49 binding-parity guard.

## Worktree preservation

Pre-existing G50 deployment tooling under `scripts/deploy`, identity receipts,
and unrelated worktree artifacts were left untouched. No commit, push, PR, or
`worker complete --outcome pr-created` action was taken because authentication
blocked the deployment prerequisite.
