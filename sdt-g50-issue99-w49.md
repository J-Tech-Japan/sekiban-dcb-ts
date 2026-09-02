# SDT-G50 issue #99 — W49 honest stop

## Status

Blocked before the deployed-version identity check could complete.  No PR was
created and no worker-complete transition was attempted, because AC1 and AC2
require one fresh, coherent deployed measurement window.

## Canonical lifecycle and starting point

- Host-provided claim evidence: `execution-unit:SDT-G50` is owned by
  `implementation` on `sekiban-dcb-ts-orch`; host acquire commit
  `5231d16ff7f4cfb337ea58f725c969e99863c6b7` and verify result
  `passed=true/status=owned`.
- The canonical GitHub-only child issue claim for #99 was applied before work
  began (`intent-issue-in-progress`).
- Dedicated local branch: `claude/sdt-g50-commit-latency`, based exactly on
  `origin/main` / `e4707fdef800e1c2f84c8bebfb7225607861d0c9`.

## Required sole-Wrangler window checkpoint

At `2026-09-01T18:16:43.649Z`, with
`CLOUDFLARE_API_TOKEN`, `CF_API_TOKEN`, `CLOUDFLARE_API_KEY`, `CF_API_KEY`,
and `WRANGLER_API_TOKEN` unset, the first and only Wrangler invocation was:

```text
wrangler whoami --json
```

It exited 1: the OAuth token had expired and could not be refreshed in the
non-interactive environment.  The complete target-identifying receipt is
[`sdt-g50-w49-deployed-identity.json`](.artifacts/sdt-g50-w49-deployed-identity.json).
It records `decision: identity-check-failed-no-deploy`, `whoami.status: 1`,
and no `versions` member, proving that the script stopped before a second
Wrangler command.

Consequently, this window performed no `versions list`, deployment, D1/queue
mutation, app-command request, telemetry query, or retry.  No API-token
fallback was used and no evidence was stitched from an earlier window.

## Preserved local implementation work

The uncommitted branch work is intentionally retained for an OAuth-refresh
continuation rather than discarded:

- `scripts/deploy/g50-deployed-identity.mjs` and its non-live guards provide
  the required reuse-versus-redeploy receipt, including config/runtime
  equivalence from deployed `7fcd2dbeb18d9841823c101badf8bcc28d3d99bf` to
  current main.
- `scripts/deploy/g50-commit-latency.mjs`, its guards, and its checker provide
  one discarded warm-up plus exactly 50 sequential app-surface commits,
  retained same-window trace rows, nearest-rank client p50/p95, colo
  distribution, explicit G41-removed S04/S05 rows, and red mutants for a
  missing active hop.
- `scripts/deploy/g37-sample.mjs` is minimally extended to expose its existing
  summaries and to fail closed when a caller requires retained telemetry.

Local checks already passed before the OAuth checkpoint:

```text
node scripts/deploy/g50-deployed-identity-guards.mjs
node scripts/deploy/g50-commit-latency-guards.mjs
node scripts/deploy/g37-sample-guards.mjs
npm run lint -- --no-fix
npm run test:g37:evidence
npm run test:g49
git diff --check
```

`git diff --name-only -- packages samples/meeting-room/src` was empty.

## Resumption requirement

After an operator refreshes OAuth, start a new sole-Wrangler window from the
token-free `whoami` checkpoint and rerun the whole identity/measurement
window.  Do not reuse this failed checkpoint as measurement evidence.
