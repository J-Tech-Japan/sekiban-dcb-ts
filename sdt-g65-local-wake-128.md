# SDT-G65 local wake W128

Task: `SDT-G65-LOCAL-WAKE-128`
Issue: [J-Tech-Japan/sekiban-dcb-ts#126](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/126)
Branch: `claude/sdt-g65-local-wake-w128`
Base: `origin/main` at `4687efa5c49951d9966a3785be5fd7b2620c6e4f`
Implementation checkpoint: `164f97521c53b530c2dd99800ba7277bdf85182a`
Evidence checkpoint before this report commit: `b5eaf23b79e366cab7c07a2215493327be05300b`

This is the deploy-free half only. The branch is pushed. No Wrangler,
Cloudflare, deployment, resource, secret, remote D1/Queue, PR, or worker
completion operation was used. AC5/AC6 deployed measurement and AC7/AC8 final
PR/evidence processing remain for the later delegation.

## Process and preserved boundaries

The child issue preflight was run before editing:

```text
intent-cli worker issue-preflight --repo J-Tech-Japan/sekiban-dcb-ts --issue 126 --workdir /Users/tomohisa/dev/GitHub/SekibanDcbTsImplementation --format json
```

It returned `actionable=true`, `classification=ready-to-implement`, issue
`OPEN`, label `intent-target`, claim scope `execution-unit:SDT-G65`, and no
configured legacy single-team claim. The child issue claim was then applied:

```text
intent-cli worker claim --repo J-Tech-Japan/sekiban-dcb-ts --kind issue --number 126 --write --format json
```

The result was `applied=true` with `intent-issue-in-progress` and no errors.
No host claim or host registry state was changed. G57 worktrees/evidence and
all Cloudflare resources were left untouched.

## AC0 — bounded direct doorbell

`TagDurableObject.directDeliveryBeforeResponse -> deliverDirectRows` now runs
through the named `G65_DERIVED_WRITE_BUDGET_MS = 300` constant. The bounded
`Promise.race` attaches a rejection handler immediately, returns after timeout,
and leaves the same claimed envelope for the retained Queue drain. A timeout or
receiver failure is logged as a derived-write degradation/unknown outcome; it
does not turn the already durable commit into a failure. The Queue remains the
fallback and the six existing G60 mutants were not edited.

The focused test uses a real never-resolving doorbell receiver and observed a
201 response after the budget with the `x-sdt-global-admission` status still
separate from the commit status. It also uses a never-resolving D1 `prepare`
fake and observed the same 201 body/status with `unknown` admission. The test
does not wait on the intentionally unresolved observer promises.

## AC1 — synchronous global admission attempt

After the durable Tag event, outbox obligation, and local receipt, and after
the direct doorbell attempt, the Tag path invokes the same
`D1EventStore.recordDelivery(row, Date.now(), "fast")` admission method used by
the Queue consumer. It has the same 300 ms bound. The internal response carries
`x-sdt-global-admission` as `admitted`, `not-admitted`, or `unknown`; the V1 JSON
body and commit status are unchanged. `CommitWorker` merges the status across
tags, with `unknown` taking precedence over `not-admitted` and `admitted`.

The focused counting-D1 test initializes the local D1 schema and proves a
successful shared admission and a throwing D1 fake return identical 201
response bodies/statuses while only the internal admission status differs.
The hanging-D1 test proves a never-resolving D1 binding cannot gate the commit.
The durable Queue remains scheduled after either outcome.

## AC2 — ordering, identity, and idempotence

The source order is durable append → direct attempt → bounded shared admission
→ retained Queue submission. The synchronous and Queue lanes carry the same
immutable event/SUID/obligation identity and use the existing G53 lineage
checks. Existing G26 delivery tests continue to prove fan-out completion and
partial-failure recovery. The new table-driven local test covers direct-first
and Queue-first admission, duplicate replay on both lanes, and a
conflicting-payload replay under the same identity. A duplicate is a no-op and
the conflict is rejected; the safe lane and direct unsafe/safe-fence semantics
are unchanged.

## AC3 — red-before-green guards and CI reachability

Pre-change receipt:
[`.artifacts/g65-red-before-green-w128.json`](.artifacts/g65-red-before-green-w128.json)

The command was run against base `4687efa5c49951d9966a3785be5fd7b2620c6e4f`,
returned exit code 1 as expected, and recorded the missing budget, bounded
helper, shared admission, response status, and ordering wiring. The stdout and
stderr command receipts are retained beside it.

Committed green/mutant receipt:
[`.artifacts/g65-green-and-mutants-w128.json`](.artifacts/g65-green-and-mutants-w128.json)

It is green on implementation commit `164f97521c53b530c2dd99800ba7277bdf85182a`
and records red expected failures for all six new mutation classes:

1. synchronous admission omitted;
2. old unbounded doorbell restored;
3. response gated on D1;
4. direct attempt before durable acceptance;
5. double admission/idempotence removed; and
6. direct attempt omitted.

The existing G60 guard/test lane remains unmodified and its red-before-green
fixtures/mutants stayed green under `npm run test:g60:required`:

```text
scripts/g60-direct-doorbell-guard.mjs
scripts/g60-queue-latency-guard.mjs
scripts/g60-durable-hop-guard.mjs
scripts/g60-unsafe-writer-guard.mjs
scripts/g60-post-admission-guard.mjs
test/g60-unsafe-writer.spec.ts / test/g60-post-admission.spec.ts behavior lane
```

The new guard and focused tests are wired into the existing `.github/workflows/ci.yml`
`ci-g26-g27` job after the unchanged G60 step:

```text
npm run test:g65:required
SDT_G65_FORCE_FAILURE=1 npm run test:g65:forced-red
```

The forced-red probe is expected to fail inside the guard command; the workflow
fails if it unexpectedly passes. No existing G26/G27/G60 command, gate, or
timeout was removed or changed.

## AC4 — write-path contract

[`docs/write-path.md`](docs/write-path.md) records the two-lane contract,
implementation details versus contract guarantees, the 300 ms rationale, the
historical measurements, the chosen durable-acceptance response-independence
rule, G44/safe-lane boundaries, and the required crash/duplicate/partial
fan-out/D1-outage/sustained-write test classes.

The preserved measurement context is: SDT-G60 direct doorbell p50 189 ms/p95
337 ms/0 over 5,000 ms; Queue observations 1.4–2.7 s with a longer tail; safe
visibility 42–95 s; the G52 root observation about 520 ms at n=1; and the
pre-G60 client response p50 about 1,308 ms. These are historical inputs, not a
deployed G65 result. The deployed AC0 target and the 1,308 ±150 ms client
baseline therefore remain explicitly unproven in this local half.

## Local gate results

All commands below ran on the branch after the implementation checkpoint;
expected mutation/red probes are recorded as red inside their passing runners.

| Command | Result |
| --- | --- |
| `npm run test:g65` | PASS; 4 focused tests, bounded doorbell/D1 hangs, counting D1, and six G65 red mutants |
| `npm run test:g60:required` | PASS; unchanged G60 behavior and six G60 mutants green |
| `npm run test:g26` | PASS; 4 files, 32 tests |
| `npm run test:g29:mapping` | PASS; 92 tests plus mapping runner |
| `npm run test:g29:delivery` | PASS; 7 tests plus delivery matrix |
| `npm run test:g29:diagnostics` | PASS; 12 tests |
| `npm run test:g29:compatibility` | PASS; 5 tests |
| `npm run test:g41` | PASS; 8 tests and production mutants red |
| `npm run test:g44` | PASS; 8 tests and atomic production mutants red |
| `npm run test:g49` | PASS; binding/migration/lineage mutants red |
| `npm run test:g53` | PASS; 10 tests and scope mutants red |
| `npm run test:g54` | PASS; 18 tests and both mutation checks red |
| `npm run test:g55` | PASS; 12 tests and read-visibility guard |
| `npm run test:g58` | PASS; 5 files, 15 tests, all existing G58 red-capable outputs green |
| `npm run test:g61` | PASS; retained-frontier red-before-green and mutant receipt |
| `npm run test:g62` | PASS; G62 green receipt and three existing mutants red |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS with `--max-warnings=0` |
| `git diff --check` | PASS |

The G58/G61/G62 guard runners rewrite environment-specific generated receipt
metadata when run from a different worktree. That incidental drift was
identified and reverted; no unrelated generated receipt or existing guard was
committed.

## Remaining boundary

AC5/AC6 are deliberately not claimed here. They still require a later
authorized deployed arm measurement: fresh n≥10 baseline and post-change
cohorts, per-commit global/unsafe/safe visibility, synchronous admission
outcome/duration, and the D1-unavailable cohort. AC7 evidence consolidation and
AC8 PR/worker completion also remain unfinished. No Cloudflare operation was
attempted in this checkpoint.
