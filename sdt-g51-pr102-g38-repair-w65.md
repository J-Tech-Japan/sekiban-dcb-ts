# SDT-G51 PR #102 G38 repair — W65

## Scope

- PR: [#102](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/102)
- Reviewed starting head: `680ad6b73c1687fb879e59f6f8143e7e3d5311ef`
- Repair source commit: `2e807e8c48d45b5a8ffddf3fc36359285f395aa2`
- Review: `5085458115`; actionable blocker comment: `5504214388`

## Defect and baseline

At the reviewed head, `worker.cloudflare-only.ts` entered the public P1
`sdt.g51.probe.p1` span before the existing `command()` primary-component
admission gate. The tracing-less G38 fixture therefore threw
`TypeError: Cannot read properties of undefined (reading 'enterSpan')` for
each of `receiver`, absent, and `unknown` component values.

`npm run test:g38:prep` was red at that exact head: three parameterized
`test/g38-receiver-surface.spec.ts` cases failed at the pre-repair
`ctx.tracing.enterSpan` call. The other G38 preparation contracts completed
before that deterministic failure.

## Repair

The public `/api/commands/*` branch now applies the established
`rejectUnlessPrimaryComponent(env, "command")` check before dereferencing
`ctx.tracing`; the command-level check remains as the downstream defensive
boundary. Consequently every non-`primary` value remains fail-closed without
any port or tracing access. A valid `primary` command still enters the single
P1 span and sets its single public application attribute before dispatch.

Changed paths are deliberately limited to:

- `samples/meeting-room/src/worker.cloudflare-only.ts`
- `test/g38-receiver-surface.spec.ts`
- `scripts/deploy/g51-probe-ladder-guards.mjs`

The strengthened G38 fixture makes a `tracing` property access throw for the
three rejected component values and asserts zero accesses. Its new admitted
primary test supplies a tracing recorder and proves exactly
`sdt.g51.probe.p1` plus `sdt.g51.probe=p1`. The existing G51 shape guard now
also requires that explicit admission precede the public-boundary P1 span.

## Checks

Passed locally:

- `./node_modules/.bin/vitest run --config vitest.config.ts test/g38-receiver-surface.spec.ts` — 9/9.
- `node scripts/deploy/g51-probe-ladder-guards.mjs`.
- `npm run test:g51`.
- `npm run build:packages && npm run test:g38:prep`.
- `npm run lint`, `npm run typecheck`, `npm run test:g37:evidence`, the G50
  recorded-artifact guards/checker, and `npm run test:g17:rollout-order`.

The local full foundation sequence reached unrelated PostgreSQL-backed tests
without the CI service container. `npm test` and `npm run test:g17` therefore
reported only connection/proxy failures; no repair-specific assertion failed.
This is retained as a local environment limitation, not hidden or repaired in
this PR.

Service-backed GitHub Actions run
[`33590140028`](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/33590140028)
for the repair source commit passed the relevant replacement contexts:
`ci-foundation`, `ci-g38`, and `ci-g41`.

## Explicit non-actions

No Wrangler command, deployment, measurement, retained-trace query, or
evidence mutation was performed. The deployed P1 `0/10` conclusion and all
prior evidence artifacts remain unchanged. No `packages/**`, configuration,
or unrelated path was modified; G30, G38, G41, and G51 gates remain present.
