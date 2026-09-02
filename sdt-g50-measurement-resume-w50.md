# SDT-G50 issue #99 — W50 measurement-resume status

## Status: question — sanctioned retained-telemetry credential is missing

The fresh sole-Wrangler checkpoint succeeded, but AC2 cannot be performed with
the credentials supplied to this seat.  I stopped before sending a warm-up or
any of the 50 app-surface commits, so no partial or untraceable measurement
window exists to stitch later.

## Canonical and branch state

- Host-supplied claim remains authoritative: `execution-unit:SDT-G50` is
  owned by `implementation` on `sekiban-dcb-ts-orch`
  (`passed=true/status=owned`).
- The canonical child issue #99 claim from W49 remains active
  (`intent-issue-in-progress`); W50 did not attempt to reacquire either the
  host claim or the existing lifecycle label.
- Preserved branch: `claude/sdt-g50-commit-latency`, based on
  `e4707fdef800e1c2f84c8bebfb7225607861d0c9`.
- Existing local guards remain green, including the required missing-active-hop
  red mutant.  No diff exists under `packages/**` or
  `samples/meeting-room/src/**`.

## Fresh sole-Wrangler identity window

At `2026-09-01T19:21:28.200Z`, the preserved identity gate started with
token-free `wrangler whoami --json` and then sequentially ran the read-only
version listing.  API-token fallback variables were unset.  The receipt is
[`sdt-g50-w50-deployed-identity.json`](.artifacts/sdt-g50-w50-deployed-identity.json).

It proves all four reuse checks:

| Check | Result |
| --- | --- |
| OAuth `whoami` | exit 0 |
| Version listing | exit 0 |
| Version | `6dd811dd-8b3d-450b-b884-55e6b9095b1d` annotated with `7fcd2dbeb18d9841823c101badf8bcc28d3d99bf` |
| Config equivalence | matching SHA-256 `0ae3bf5ec67547e707ea091da472d09cb681b532407264e15339400f8dd08862` |
| Runtime/domain diff to main | empty |

The resulting decision is `reuse-existing-deployment-no-redeploy`; no Wrangler
mutation or deployment was performed.

## Exact blocker

The preserved G37-derived telemetry path invokes the Workers Observability
query endpoint with `Authorization: Bearer <token>` and accepts that credential
only through a file passed as `--observability-token-file` (or
`G50_OBSERVABILITY_TOKEN_FILE`; older G37/G30 aliases are also supported by
the original tooling).  At the start of this window all of the following were
unset:

```text
G50_OBSERVABILITY_TOKEN_FILE
G37_OBSERVABILITY_TOKEN_FILE
G30_OBSERVABILITY_TOKEN_FILE
```

No approved token file or alternate retained-trace export mechanism was
provided.  OAuth successfully authorizes Wrangler, but it does not supply a
sanctioned token-file input to the existing exact CF-Ray-to-trace exporter.
Extracting or repurposing OAuth state as a bearer token would be an
unauthorized auth workaround, so it was not attempted.

## Required direction

Please provide an approved, non-secret file path through
`G50_OBSERVABILITY_TOKEN_FILE` (or explicitly authorize a different existing
retained-trace mechanism) with the required Workers Observability read scope.
After that, restart a fresh compact measurement window from token-free
`wrangler whoami`, rerun the identity gate, and then issue the one discarded
warm-up plus exactly 50 sequential app commits.  Do not reuse this successful
identity check as the later measurement window.
