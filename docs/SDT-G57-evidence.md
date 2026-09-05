# SDT-G57 evidence

This document records the deploy-free checkpoint plus the single deployed
AC5/AC6 window for issue #123. It is intentionally limited to the executor
facade and sample migration; G59 and G64 are not part of this unit.

## Identity and boundaries

- Issue: `J-Tech-Japan/sekiban-dcb-ts#123`
- Branch: `claude/sdt-g57-deploy-free-w126`
- Deploy-free predecessor: `5c80bbfcce9e59a39224420cb633edbe9574a3ba`
- Deployed source: `TO_BE_FILLED_AFTER_COMMIT`
- Existing throwaway arm only: `TO_BE_FILLED_AFTER_DEPLOY`
- No Cloudflare resource was created or recreated.
- Every Wrangler invocation used the five-variable stripped environment,
  omitted `--keep-vars`, and used only the existing arm's config/resources.

## AC1–AC4 and local AC7

The deploy-free checkpoint is preserved in
[`sdt-g57-deploy-free-w126.md`](../sdt-g57-deploy-free-w126.md). It records the
C-12 red fixture, the green facade suite, exact V1 byte identity, zero-read
snapshot-only behavior, assert-empty/omitted claim mapping, typed cloud
credential rejection, and the unchanged G41/G49/G51/G52/G54/G56 boundaries.

## AC5 sample migration

The meeting-room server route parses the executor envelope and calls
`createSekibanExecutor` over the in-process transport. The browser retains
portable JSON snapshots by projector/tag. A known RoomProjector or
ReservationProjector snapshot selects `snapshot-only`; an uncovered claim
uses the default `read-through` path. Reservation list/query read heads and
commit result heads are retained as portable snapshot heads. The public V1
wire and response protocol remain unchanged.

### G50 comparison

The deployed receipt is `.artifacts/sdt-g57-w126-g50-executor-comparison.json`.
It contains a discarded warm-up and 50 accepted public create-room samples in
each mode, every raw request/response receipt, the deployed identity, and the
optional retained telemetry result. The guard recomputes the summaries and
rejects mode or percentile mutants.

| mode | n | p50 (ms) | p95 (ms) | expected tag-state reads/commit | expected reads saved/commit |
| --- | ---: | ---: | ---: | ---: | ---: |
| read-through | `TO_BE_FILLED` | `TO_BE_FILLED` | `TO_BE_FILLED` | 1 | 0 |
| snapshot-only | `TO_BE_FILLED` | `TO_BE_FILLED` | `TO_BE_FILLED` | 0 | 1 |

The read accounting is established by the public executor contract and local
counting guard: the create-room claim is read once in read-through mode and is
covered by the supplied empty portable snapshot in snapshot-only mode. The
latency comparison is informational; no threshold is imposed by G57.

## AC6 deployed verification

- Normal config shape: existing-arm adapted config, no resource creation.
- G15/G16: `TO_BE_FILLED`
- Deployed version/source annotation: `TO_BE_FILLED`
- G50 receipt validator: `TO_BE_FILLED`
- Required local gates: `TO_BE_FILLED`
- PR/CI: `TO_BE_FILLED`

The five recognized Wrangler credential variable names were reported as
set/unset only and stripped for every Wrangler command. Observability, when
requested, was read only through the `G50_OBSERVABILITY_TOKEN_FILE` path; no
token value is stored here.

## Preserved boundaries

No runtime wire member, commit semantics, trace schema, outbox/Queue/global
admission path, projector advancement, G58 health/coverage/lag/live-poll
surface, SafeWindow, ordering, fence, timeout, or existing gate was weakened.
