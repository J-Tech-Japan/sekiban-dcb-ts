# SDT-G66 PR135 final repair — W161

## Scope and review mapping

- PR: `J-Tech-Japan/sekiban-dcb-ts#135`
- Review: `5133812363`
- Starting exact head: `e037cac8bc7eefb2eb4f94def94ae4ea97b89ff6`
- Branch: `claude/sdt-g66-local-and-production-w160`
- Scope: corrected public-MV evidence, response-relative clocks, final-state
  proof, and red-capable guards only.
- No cleanup mutation is authorized or performed; the G32 worker, both G32 D1
  databases, G32 outbox and DLQ remain retained.

## Local repair

The runner now polls the public reservations endpoint for unsafe visibility,
requires the public reservation `readHead` to reach the committed SUID for
safe visibility, records the supporting MV/projection observations separately,
joins every affected tag to its expected version/SUID, and compares the final
public state with the exact committed set and duplicate count. Durations are
derived from observed absolute clocks relative to response completion, with
the fixed 5,000 ms unsafe and 180,000 ms safe bounds.

The guard and focused tests reject censored/late observations, false or
synthetic public reads, stale read heads, absolute-clock and inflated-bound
escapes, failed writes, missing coverage, duplicate final state, and a fully
chronological pause-to-safe mutant. Existing G60 mutant files were not changed.

## Local checks

Passing checks recorded at the repair checkpoint:

- `node --check scripts/deploy/g66-e2e.mjs`
- `node --check scripts/g66-e2e-guard.mjs`
- `node scripts/deploy/g66-e2e.mjs --self-test`
- `node scripts/g66-e2e-guard.mjs --self-test`
- `npx vitest run --config vitest.config.ts test/g66-e2e.spec.ts --pool=threads --maxWorkers=1`
- `npm run lint -- --quiet`
- `npm run typecheck`

The documented broader W161 aggregate/package-layout exceptions remain
exceptions and are not relabelled green. No Cloudflare operation is included
in this local checkpoint.

## Deployed-proof handoff

The retained W160 parent/candidate receipts are historical topology/smoke
evidence only. They used the superseded serialized visibility runner and do
not prove the corrected continuous-write public safe-query contract. A fresh
corrected deployed cohort is therefore required before final AC1–AC4 status
can be reported. Any such run must preserve the production configuration and
all G32 resources; no cleanup or resource creation is in scope.

## W161 deployed attempt — blocked before corrected cohort

The exact repaired source was deployed to the existing production sample only,
using `samples/meeting-room/wrangler.g66-production-self.jsonc` with the five
credential variables stripped from every Wrangler child process. The deploy
completed at 2026-09-07T16:36:19Z with:

- source/head: `b840c189cd1dd5cbe31400fc606b691c0293d9e9`
- active version: `566dd5dd-4d9d-4125-be6d-750722d0c210` at 100% traffic
- source annotation: `SDT-G66 W161 exact b840c189 final public MV repair`
- worker: `sekiban-dcb-meeting-room-cloudflare-only`
- self mode: `DIRECT_DOORBELL=true`, `DIRECT_DOORBELL_RECEIVER_MODE=self`,
  `DIRECT_DOORBELL_SELF_BINDING_PROOF=true`
- direct receiver: `DOWNSTREAM_DOORBELL` resolves to
  `sekiban-dcb-meeting-room-cloudflare-only#MeetingRoomDownstreamDoorbell`
- D1: `f26d1299-82d9-4a64-8647-bc2ec86326ac` and
  `b416b212-4d09-413c-9b8d-7660e475772f`
- Queue/DLQ: `sekiban-dcb-meeting-room-cloudflare-outbox` /
  `sekiban-dcb-meeting-room-cloudflare-outbox-dlq`, with the existing worker
  consumer.

The required C-0 operational reset then stopped before any sample. The durable
receipt is `.artifacts/sdt-g66-w161-production-c0-reset.json`. It records 56
stripped, path-only Wrangler child invocations: all pipeline pre-counts and
pipeline deletes completed, then the first MV delete (`mv_active_generations`)
returned Cloudflare D1 storage timeout code `7429` (“D1 DB storage operation
exceeded timeout which caused object to be reset”). This is not an auth error;
the helper made no state-changing retry and no authorization classifier was
invoked. Consequently no corrected public cohort was run, no W161 acceptance
metric is claimed, and the deployment window is blocked at the C-0 reset
boundary. The pipeline is partially reset while MV operational rows were not
reset; this state must not be treated as a clean sample.

The G32 worker, both G32 D1 databases, G32 outbox and DLQ were not touched.
The W160 parent/candidate receipts remain historical only and are not upgraded
to satisfy the corrected public-MV proof. AC1–AC4 therefore remain blocked on a
fresh clean reset and corrected cohort after a new authorized continuation.
