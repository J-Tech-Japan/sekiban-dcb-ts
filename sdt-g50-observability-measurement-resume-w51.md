# SDT-G50 issue #99 — W51 honest stop

## Status: blocked — the one retained-trace measurement window failed

The supplied approved read-only Observability token file was referenced only by
path and was not printed, copied, or committed.  Authentication for the fresh
Wrangler identity gate succeeded, but the single AC1/AC2 measurement window
failed at retained-trace validation.  Per the delegation, this stopped the
window with no retry, fallback, stitched evidence, redeploy, PR, or
worker-complete transition.

## Fresh deployed identity

The first sequential Wrangler operation was the token-free identity gate.  Its
receipt is
[`sdt-g50-w51-deployed-identity.json`](.artifacts/sdt-g50-w51-deployed-identity.json).
It records successful `whoami` and `versions list` calls and the decision:

```text
reuse-existing-deployment-no-redeploy
```

The exact live version was
`6dd811dd-8b3d-450b-b884-55e6b9095b1d`, annotated with
`7fcd2dbeb18d9841823c101badf8bcc28d3d99bf`.  The configured normal-config
SHA-256 matched current main `e4707fdef800e1c2f84c8bebfb7225607861d0c9`, and
the runtime/domain diff was empty.  Therefore no deployment was appropriate.

## Single measurement window and exact failing step

The preserved sampler was invoked once against
`https://sekiban-dcb-meeting-room-cloudflare-only.ttakaoka.workers.dev` using
the authorized file path
`/Users/tomohisa/.config/sekiban-dcb/observability-token`.  Its protocol sends
one accepted discarded warm-up and then exactly 50 sequential
`POST /api/commands/create-room` requests before waiting for retained trace
telemetry.  The process reached its post-settlement `requiredTelemetryRows`
validation, which means no command-phase rejection occurred.

The exact terminal error was:

```text
g50-commit-latency:retained telemetry is missing active per-hop rows:
S00, S01, S02, S03, S06, S07, S08, S09, S10, S11, S12, S13, S14, S15, S16
```

Because a successful artifact is written only after that validation, no
`.artifacts/sdt-g50-w51-commit-latency.json` sample was produced.  The failure
is recorded here rather than fabricating a client/per-hop report from partial
state.  No query retry was made after the failed validation, and no replacement
app commands were sent.

## Scope and lifecycle preservation

- The host-supplied `execution-unit:SDT-G50` claim remains owned by
  `implementation`; the existing canonical child issue claim remains active.
- The preserved branch remains `claude/sdt-g50-commit-latency` at
  `e4707fdef800e1c2f84c8bebfb7225607861d0c9` plus its uncommitted W49 tooling.
- No change was made beneath `packages/**` or `samples/meeting-room/src/**`.
- The local active-hop-missing mutation guard remains red; its prior passing
  result does not substitute for the failed live trace evidence.

## Required follow-up

Investigate why Workers Observability returned no usable active commit rows for
the exact CF-Ray cohort.  A later delegated run must start a wholly fresh
identity and measurement window; this W51 command cohort must not be reused or
stitched into later evidence.
