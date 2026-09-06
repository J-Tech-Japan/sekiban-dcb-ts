# SDT-G65-PR127-DIRECT-DOORBELL-REPAIR-WAKE-138

Status: **blocked**. This checkpoint contains the scoped source/config repair
and the exact W155-C authorization receipts; it does not claim deployed proof.

## Identity and repair

- Issue/PR: `sekiban-dcb-ts#126` / PR `#127`.
- Branch: `claude/sdt-g65-local-wake-w128`.
- Pushed repair head: `ff65602d8a237b4911229f35741772abcf23e8af`.
- Existing arm only: Worker `sekiban-dcb-g60-w155-c`; pipeline D1
  `ac751211-fde8-4587-9d56-1e9fd8051bc3`; MV D1
  `2b60dbcf-0912-4bb2-93aa-77c26cd260e1`; Queue
  `sekiban-dcb-g60-w155-c-outbox`; DLQ
  `sekiban-dcb-g60-w155-c-outbox-dlq`.
- No resource creation/deletion, migration, production operation, PR review
  change, merge, or close was performed.

The defect was confirmed from the W138 version view: `DIRECT_DOORBELL=true`
was present but `DOWNSTREAM_DOORBELL` was absent, and all unsafe rows had
`transport=queue`. The repair adds the real existing service binding, not only
the Boolean. The guard now requires the exact binding to
`sekiban-dcb-meeting-room-doorbell` with entrypoint
`MeetingRoomDownstreamDoorbell`; its pre-fix receipt was red and its repaired
local run was green. No product behavior or fixture was changed.

## Local gates

The focused required gates passed before the push: `npm run test:g65:required`,
`npm run test:g60:required`, `npm run test:g58`, `npm run test:g62`,
`npm run test:g61`, `npm run test:g41`, `npm run test:g42`, `npm run test:g44`,
`npm run test:g45`, `npm run test:g46`, `npm run test:g49`, `npm run test:g53`,
`npm run test:g54`, `npm run test:g55`, `npm run test:g56`, and
`git diff --check`. The aggregate `npm run check` passed lint, typecheck/build,
G28 and the broad test/lane set through G31; its G32 real-parity runner hung
while attempting the default GitHub clone and was stopped as an
environment/network exception. The same aggregate invocation used a private
`NPM_CONFIG_CACHE`; no gate was skipped, weakened, or timeout-inflated.

## W155-C remote stop

Immediately before Wrangler use, these names were all `UNSET` and were
stripped from every invocation:
`CLOUDFLARE_API_TOKEN`, `CF_API_TOKEN`, `CLOUDFLARE_API_KEY`, `CF_API_KEY`,
`WRANGLER_API_TOKEN`. No `--keep-vars` was used and no credential value was
printed or committed.

The first authorized operation was the schema-preserving operational reset:

```sh
wrangler d1 execute D1 --remote --json --yes \
  --config .artifacts/wrangler.g65-w155-c.jsonc \
  --file .artifacts/sdt-g65-w138-direct-reset-pipeline.sql
```

Receipt: `.artifacts/sdt-g65-w138-direct-pre-reset-pipeline.json`.
It failed at the existing pipeline D1 import endpoint with Cloudflare API
code `10000`, `Authentication error`. The write was not retried.
SHA-256: `49ccbc8fd0be55e4c9f6a20bc53179ea5192c0be9713f4085a64d9001c86a4b7`.

The single permitted same-family read-only classifier was:

```sh
wrangler d1 execute D1 --remote --json --yes \
  --config .artifacts/wrangler.g65-w155-c.jsonc \
  --command "SELECT COUNT(*) AS dcb_events FROM dcb_events"
```

Receipt: `.artifacts/sdt-g65-w138-direct-auth-classifier-d1-read.json`.
It succeeded with `dcb_events=15`, but that read result cannot establish that
the rejected write is authorized. No second probe, alternate write path,
deployment, secret operation, or cohort was attempted.
SHA-256: `fac009ea32b4607cf3c2dd696eefc22adeec0c4ffae15d37c955420180a52c97`.

The exact reset inputs are also retained: pipeline SQL SHA-256
`488c1115659e1c8233c77c6bcaa0ebb1d46184021f955323ff4eafa9fe02c128` and MV
SQL SHA-256 `221a44009163a70513fb652a4e57afc2c7c5d363a0ffa9b3b2fd29fd82dc52fe`.

Therefore the required deployed precondition was not reached: the deployed
version view was not rechecked for both `DIRECT_DOORBELL=true` and the real
`DOWNSTREAM_DOORBELL` binding, and no fresh matched pre/post cohort was run.
The arm remains on the prior W138 deployed source/configuration rather than
the pushed repair; this is explicitly not claimed as a restored deployment.

## Preserved W138 acceptance classification

The prior W138 post cohort remains the relevant last deployed measurement:
sample 1 missed the 180-second safe line at `186687 ms`; `9/10` unsafe reads
were over the unchanged `5000 ms` bound. This continuation produced no new
post cohort. The prior configured-store first-write typed
`503 partition_registration_unavailable` with zero event writes also remains
unproven: the available bound-MV probe was explicitly unconfigured and
returned committed/not-admitted rather than the configured failure shape.

## Disposition

**Blocked** by the first existing-D1 reset write's Cloudflare API code `10000`
after all five recognized credential variables were stripped. The one
read-only classifier succeeded, but the stop rule prohibits retrying the write.
The repair is safely pushed at the exact head above; no deployed direct
receiver proof, new cohort, PR review-state change, or completion claim is
made. The next continuation must reopen the authorized W155-C window and
perform the deployment and fresh cohorts before acceptance can be assessed.
