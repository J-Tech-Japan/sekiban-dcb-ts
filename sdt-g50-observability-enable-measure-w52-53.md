# SDT-G50 W52–53 observability-enable measurement report

Status: **blocked**

## Authorized local change completed before the deployment window

- Branch: `claude/sdt-g50-commit-latency`
- Local commit: `be7969d57e723f2e8e1a70ccefb54b70252a40b8` (`chore(g50): enable normal config observability`)
- Changed only `samples/meeting-room/wrangler.cloudflare-only.jsonc`, adding the exact `observability` block from `wrangler.g37-primary.jsonc`:
  - `enabled: true`
  - persisted invocation logs with head sampling rate `1`
  - persisted traces with head sampling rate `1`
- Local parity and guard/lint/test checks passed before the commit:
  - `node scripts/deploy/g50-deployed-identity-guards.mjs`
  - `node scripts/deploy/g50-commit-latency-guards.mjs`
  - `node scripts/deploy/g37-sample-guards.mjs`
  - `npm run lint -- --no-fix`
  - `npm run test:g49`
  - `npm run test:g37:evidence`
  - `git diff --check`

The planned evidence correctly treats normal-config observability absence as the eighth configured-looking-but-inert finding.  The existing G49 binding-parity checker was intentionally not extended; observability parity remains a future guard candidate.

## Fresh W52 deployment-window receipt

The sole-Wrangler window began with the required token-free deployed-identity check.  It succeeded far enough to establish that the deployed version could not be reused after the authorized config commit:

- deployed service: `sekiban-dcb-meeting-room-cloudflare-only`
- previous version: `6dd811dd-8b3d-450b-b884-55e6b9095b1d`
- current main identity: equivalent
- normal-config identity: not equivalent (`configMatches: false`)
- decision: `identity-mismatch-deploy-current-main-required`
- pre-deploy receipt: `.artifacts/sdt-g50-w52-predeploy-identity.json`

The next, sequential command was the authorized normal-config deploy, with all API-token fallback variables unset and only `G50_OBSERVABILITY_TOKEN_FILE=/Users/tomohisa/.config/sekiban-dcb/observability-token` present as the read-only trace-query token path:

```text
./node_modules/.bin/wrangler deploy --config samples/meeting-room/wrangler.cloudflare-only.jsonc --message "SDT-G50 observability enabled be7969d57e723f2e8e1a70ccefb54b70252a40b8"
```

It exited `1` before deployment. Wrangler reported that, in this non-interactive runner, `CLOUDFLARE_API_TOKEN` was required; it also failed to write its user-preferences debug log with `EPERM`. No API token was supplied, no alternate authentication mechanism was used, and no retry was made.

Consequently:

- no new Cloudflare version was deployed;
- no warm-up or accepted measurement requests were sent;
- no W51 telemetry cohort was reused;
- no retained-trace query, latency statistics, raw measurement artifacts, PR, or worker-complete transition was created;
- no runtime/domain code, G49 guard, or harness was changed.

This is an honest authentication/window stop at the first deploy step. A future authorized continuation must begin a wholly new sole-Wrangler window after OAuth is usable again; it must not stitch this incomplete window into a measurement cohort.
