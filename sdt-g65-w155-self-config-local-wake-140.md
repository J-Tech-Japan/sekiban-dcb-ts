# SDT-G65 W155-C self-config local checkpoint (WAKE-140)

Status: completed local checkpoint with documented unrelated/environment
exceptions. This artifact does not claim deployed AC5/AC6 completion.

## Scope and checkpoint

- Repository: `J-Tech-Japan/sekiban-dcb-ts`
- Branch: `claude/sdt-g65-local-wake-w128`
- Starting head: `abecf9df201ce3bd845a11dbad9476b1cf770810`
- Scoped source/config/guard/docs checkpoint: `9dd49f47b327797f3034a25c6fd48f7322e0d286`
- Cloudflare/Wrangler/deployment/resource/PR/review/merge/claim operations: none
- Existing unrelated dirty files and ignored receipts: preserved

The checkpoint contains only the W155-C self-binding configuration, its
validation guard, the existing G65 guard's exact-arm wiring expectations, and
the SDT-G65 evidence update. The later deployed window still owes same-arm
cold-first baseline and candidate cohorts in self mode; the W139
separate-receiver receipts remain failed stop evidence and were not reused.

## Exact-head hosted CI classification

Workflow:
<https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34000676089>

`ci-g21-g25` job:
<https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34000676089/job/101398855200>

G21, G22, G23, and G25, plus the G24 step, passed. The only failed step was
the existing G54 envelope-boundary assertion at
`test/g54-envelope-boundary.spec.ts:136`: expected `PT0S`, observed
`PT0.001S`. This is the known 1 ms wall-clock/timing flake and is unrelated
to the W155-C configuration. No test, fixture, timeout, workflow, or gate was
changed. The raw hosted log is
`.artifacts/sdt-g65-w140-ci-g21-g25-job.log`, SHA-256
`5080f88af7db761e8884d8231a1087115dcfe8849f381f15dd2bd21c3433c555`.
The captured workflow receipt is
`.artifacts/sdt-g65-w140-ci-run-status.json`, SHA-256
`3c58245775775fadc49a7b1f1f92e9ab6bd1b9e3fa22ce3a17810e817117d17f`.

## Reproducible W155-C configuration

Tracked config: `.artifacts/wrangler.g65-w155-c.jsonc`.

| Field | Required value and local result |
| --- | --- |
| Worker / `SDT_SERVICE_ID` | `sekiban-dcb-g60-w155-c` |
| `DIRECT_DOORBELL` | `true` |
| `DIRECT_DOORBELL_RECEIVER_MODE` | `self` |
| `DIRECT_DOORBELL_SELF_BINDING_PROOF` | `true` |
| `DIRECT_DOORBELL_DEGRADATION` | `queued-degraded` |
| `DIRECT_DOORBELL_MAX_INVOCATIONS` | `32` |
| `DOWNSTREAM_DOORBELL.service` | `sekiban-dcb-g60-w155-c` |
| `DOWNSTREAM_DOORBELL.entrypoint` | `MeetingRoomDownstreamDoorbell` |
| Pipeline D1 | `ac751211-fde8-4587-9d56-1e9fd8051bc3` |
| MV D1 | `2b60dbcf-0912-4bb2-93aa-77c26cd260e1` |
| Outbox Queue | `sekiban-dcb-g60-w155-c-outbox` |
| DLQ | `sekiban-dcb-g60-w155-c-outbox-dlq` |

`node scripts/g65-w155-self-config-guard.mjs --self-test` passed the real
configuration. Its mutant changing the mode to `separate` and the service to
the stale shared receiver returned `red-as-expected`, with both mismatches
reported. The existing `scripts/g65-admission-guard.mjs` now checks this
exact self mode, proof, arm service, D1 pair, Queue, and DLQ; it does not
weaken the admission or G60 guards.

## Local guard and lane results

The focused `npm run test:g65:required` passed: the G65 Vitest behavior tests
passed (2 files, 16 tests), the admission guard and all of its existing
omission, unbounded-doorbell, response-gated-on-D1, durability-order,
idempotence-removal, and omitted-direct mutants remained red, and the
RING/APPLY awaited-apply mutant remained red. The W155-C self-config mutant
also remained red.

The full command receipt is `.artifacts/sdt-g65-w140-ci-equivalent.log`,
SHA-256
`243395de52a5c1416475c8548e02157ebfbab6a291baf0453ba8968769cca598`.
Its runnable local lane groups completed as follows: G17/G20/G26/G27/G28-
G32, G37/G38, G41-G49, G50-G55, G58, G60-G62, G65, candidate/coverage
probes, store/D1/MV/boundary/consumer/build checks, typecheck, lint, and
diff-check. Forced-red probes were run and returned their expected failures.
The exact commands and exit records are in the receipt; no gate was skipped
or altered to obtain this summary.

Documented exceptions:

1. `npm test` had five failures outside this W140 change: the G32 non-UTF8
   status case, the G43 alarm wait, the G54 R3 error-kind case, and the repair
   vertical-slice timeout. It reported 85 passed files and 1 skipped.
2. `npm run test:g32` reproduced the non-UTF8 `400` versus `500` failure at
   `test/g32-payload-admission.spec.ts:140`.
3. `npm run test:g54` reproduced the R3
   `invalid_payload_utf8` versus `invalid_payload_json` mismatch. This is
   separate from the hosted G54 1 ms duration flake.
4. G28 package-boundary checks could not write `/Users/tomohisa/.npm/_logs`;
   their source and negative probes passed.
5. `npm run test:g30` advanced through
   `all-production-config-mutants-red`, then produced no output for 60
   seconds. Only that known runner was terminated. Receipt:
   `.artifacts/sdt-g65-w140-g30-core.log`, SHA-256
   `da5079e3d71a74b6929dfdedc94f43d3a1440f4de23b16d907fcd6776dc34bef`.
   G30 candidate and G51 passed; the G30 forced-red rerun was not claimed
   after the core runner stall.
6. Local e2e/Cloudflare emulator provisioning was not run because this unit
   explicitly forbids Wrangler, Cloudflare, deployment, and resource
   operations. `test:cosmos-wiring` passed.

These exceptions are recorded rather than treated as green. The next unit
must deploy the explicit self configuration, verify the real deployed
receiver binding before sampling, and collect both required cold-first
paced cohorts. The W155-C arm's D1, Queue, and DLQ identifiers above were not
changed.
