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
