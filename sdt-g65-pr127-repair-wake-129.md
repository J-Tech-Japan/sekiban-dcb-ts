# SDT-G65 PR #127 repair checkpoint — W129

Task: `SDT-G65-PR127-REPAIR-WAKE-129`
Issue: [J-Tech-Japan/sekiban-dcb-ts#126](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/126)
PR: [#127](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/127)
Branch: `claude/sdt-g65-local-wake-w128`
Reviewed head: `68454969e6b9c15bb22e5e57bfd388167477dbfb`
Repair/evidence head: `ccfa0b0c2ea7a9f42f61bd241c5fa52e3ef2676a`
Base: `origin/main` at `4687efa5c49951d9966a3785be5fd7b2620c6e4f`

This checkpoint repairs the four canonical findings from review 5119543782,
pushes the repair, and records the required deployed evidence before rereview.
It does not self-approve, merge, or run worker-complete again.

## F1 — durable acceptance and G44 proof

The repair separates local SQLite/public commit durability from the best-effort
runtime D1 source-partition registration probe. The probe is scheduled after the
commit and its failure or hang cannot turn a durable local commit into a 503.
The D1 delivery path atomically upserts the source partition together with the
event, global membership, and receipt. Consequently G44 still has precise
source authority when a global delivery is admitted and remains fail-closed
when that atomic proof is absent; no obligation is swallowed.

The new migration is
`migrations/d1/g32/0009_g65_admission_attempts.sql`. The focused real SQLite /
public test leaves the runtime D1 binding unavailable and proves HTTP 200,
`kind=committed`, with the unchanged V1 JSON body. A separate atomic-batch
failure test proves that partial global-admission rows are not left behind.
The deployed unavailable-binding receipt is the actual runtime proof, not a
mock-only claim; see the F1 table below.

## F2 — red-capable production guard

`scripts/g65-admission-guard.mjs` now exercises the real D1/shared path in both
orders, duplicate replay, conflicting identity, and atomic failure. Its
omission, unbounded-wait, response-gating, reordered-durability, duplicate,
and omitted-direct-delivery mutants all fail red; the post-change guard is
green. The six pre-existing SDT-G60 mutants were not modified. The guard uses
production behavior rather than a private in-memory map, so a false pass from
an unconnected oracle is removed.

## F3 — authored timestamps withdrawn; correlated admission ledger

Authored event `Timestamp` and caller/outbox `received_at` values are no longer
presented as visibility timing. The new durable
`serialized_dcb_g65_admission_attempts` table correlates service, event, SUID,
partition, and attempt identity and records:

- `admission_started_at` and `admission_finished_at` from `Date.now()` epoch
  milliseconds;
- `outcome` (`admitted`, `not-admitted`, or `unknown`);
- `global_completion_observed_at`; and
- `clock_origin = Date.now epoch ms`.

The observer is scheduled through `waitUntil`, never awaited as an admission,
acknowledgement, projection, retry, or response decision. Direct-doorbell work
and the explicit synchronous-admission attempt remain separate contributions.
The W129 ledger has 36 rows for 11 distinct event/attempt identities; every
row has a 300 ms bounded attempt, `unknown` outcome, and null global completion
observation. Thus the bounded-attempt distribution is n=11, p50=300 ms,
p95=300 ms, with admitted=0, not-admitted=0, unknown=11. No unsupported
causal timing claim is made.

## F4 — V1-compatible admission outcome and write-path boundaries

The transport preserves the existing V1 JSON body and adds the documented
`x-sdt-global-admission` response header. Healthy and unavailable public
receipts capture `unknown` and `not-admitted`, respectively. The write-path
documentation corrects the G35 inheritance boundary and keeps the durable
outbox obligation, local receipt, Queue/global admission ordering, retries, and
DLQ behavior unchanged. Trailing whitespace was removed from
`sdt-g65-local-wake-128.md`.

## Local red/green and required gates

All commands below exited zero. Expected mutant failures are part of the
passing guard runners and are retained as red receipts:

| Gate | Result |
| --- | --- |
| `npm run test:g65` | PASS; focused behavior plus six red mutants |
| `npm run test:g60:required` | PASS; unchanged G60 guards/mutants |
| `npm run test:g26` | PASS; 32 tests |
| `npm run test:g29:mapping` | PASS; 92 tests |
| `npm run test:g29:delivery` | PASS; 7 tests |
| `npm run test:g29:diagnostics` | PASS; 12 tests |
| `npm run test:g29:compatibility` | PASS; 5 tests |
| `npm run test:g41` | PASS; production mutants red |
| `npm run test:g44` | PASS; atomic production mutants red |
| `npm run test:g49` | PASS; binding/migration/lineage mutants red |
| `npm run test:g51` | PASS; native span/guard runners |
| `npm run test:g52` | PASS; 18 tests and omission mutants red |
| `npm run test:g53` | PASS; scope/control/downstream mutants red |
| `npm run test:g54` | PASS; 18 tests and omission mutants red |
| `npm run test:g55` | PASS; 12 tests and read-visibility mutations red |
| `npm run test:g56` | PASS; assert-empty contract and omission mutant red |
| `npm run test:g58` | PASS; existing G58 guards |
| `npm run test:g61` | PASS; retained-frontier mutant red |
| `npm run test:g62` | PASS; cursor-aware mutants red |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS with `--max-warnings=0` |
| `git diff --check` | PASS |

The incidental generated receipt drift from local G58/G62 runner execution is
left unstaged and is not part of this repair commit.

## Deployed identity and Cloudflare hygiene

Only the existing W155-C arm was used; no Worker, D1, Queue, or DLQ was
created:

| Resource | Identity |
| --- | --- |
| Worker | `sekiban-dcb-g60-w155-c` |
| Pipeline D1 | `ac751211-fde8-4587-9d56-1e9fd8051bc3` |
| MV D1 | `2b60dbcf-0912-4bb2-93aa-77c26cd260e1` |
| Queue / DLQ | `sekiban-dcb-g60-w155-c-outbox` / `sekiban-dcb-g60-w155-c-outbox-dlq` |

Migration `0009_g65_admission_attempts.sql` was applied once. The first
stripped-environment idempotent `migrations list` read returned Cloudflare
7403; after approximately five seconds the one authorized read retry
succeeded, and the apply then succeeded once. The exact receipts are
`.artifacts/sdt-g65-w129-migrations-list.log` and
`.artifacts/sdt-g65-w129-migrations-apply.log`.

For every Wrangler invocation the following variable names were stripped and
were `UNSET`: `CLOUDFLARE_API_TOKEN`, `CF_API_TOKEN`,
`CLOUDFLARE_API_KEY`, `CF_API_KEY`, `WRANGLER_API_TOKEN`. The conformance
credential was referenced by path only; no secret value was printed, logged, or
committed, and `--keep-vars` was never used.

The normal exact deployment was:

- version `0be239ed-5553-4f0b-b29a-1c344b082de1`;
- deployment `46d79582-80c9-49c2-852d-2585021b6f8f`;
- 100% traffic;
- annotation `SDT-G65 W129 repair exact ccfa0b0c2ea7a9f42f61bd241c5fa52e3ef2676a`.

The unavailable-D1 deployment was version
`51b6a2a6-968b-475d-b679-cb519e84d0fc`, deployment
`9be2e34d-75f9-4881-8b6d-5432522f3975`, 100% traffic, annotation
`SDT-G65 W129 F1 unavailable-D1 exact ccfa0b0c2ea7a9f42f61bd241c5fa52e3ef2676a`.
The normal binding was restored with version
`2b1dae1e-5b3d-4c48-8e64-67a8cf64b850`, deployment
`d1b85541-6339-4f41-a3ae-10f0f260264b`, 100% traffic, and annotation
`SDT-G65 W129 restore normal D1 exact ccfa0b0c2ea7a9f42f61bd241c5fa52e3ef2676a`.

## Deployed receipts

### Healthy arm

One cold-first public cohort of n=10 was paced at least ten seconds after each
preceding response. Every sample committed, and all 11 cohort tag-state reads
returned version 1. The additive admission header was `unknown` for 10/10.

| Metric | n | p50 | p95 | Count / note |
| --- | ---: | ---: | ---: | --- |
| Client response | 10 | 2,197 ms | 3,356 ms | all HTTP 200 committed |
| Unsafe first visibility | 10 | 56,642 ms | 118,113 ms | 10/10 over 5,000 ms; evidence only |
| Safe/projector head | 10 | 172,470 ms | 235,238 ms | 5/10 within 180 s; 5/10 late |
| Admission attempt | 11 | 300 ms | 300 ms | 0 admitted, 0 not-admitted, 11 unknown |

Per-sample receipt table (milliseconds; `safe/head` is final projector-head
observation from commit response):

| # | SUID | Response | Unsafe | Safe/head | Tag state |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | `063924178210984000001726691723` | 2,518 | 118,113 | 235,238 | 117,926 |
| 2 | `063924178224722000000360555581` | 3,356 | 104,403 | 221,303 | 103,991 |
| 3 | `063924178237013000002045136300` | 2,066 | 92,575 | 209,236 | 91,924 |
| 4 | `063924178249243000000862815092` | 2,235 | 80,542 | 196,992 | 79,680 |
| 5 | `063924178261468000000443208851` | 2,197 | 68,721 | 184,794 | 67,482 |
| 6 | `063924178273513000001618644650` | 2,323 | 56,642 | 172,470 | 55,158 |
| 7 | `063924178285821000001542062552` | 2,017 | 44,898 | 160,452 | 43,140 |
| 8 | `063924178298169000001652676251` | 2,356 | 32,874 | 148,094 | 30,782 |
| 9 | `063924178310280000000037521988` | 2,089 | 36,310 | 136,004 | 18,692 |
| 10 | `063924178322440000001456939849` | 2,194 | 24,294 | 123,809 | 6,497 |

All 68 health snapshots, paging bodies, tag reads, scheduled polls, and final
head observations are in the lossless compressed receipt
`.artifacts/sdt-g65-w129-healthy-cohort.json.gz`. Its gzip SHA-256 is
`691257836b8e5cb9e1d3d78df6f6c589f079eafd000f973a953d65b9cb626667`.
Decompress with:

```sh
gzip -dc .artifacts/sdt-g65-w129-healthy-cohort.json.gz > .artifacts/sdt-g65-w129-healthy-cohort.json
```

The decompressed output was verified byte-for-byte against the retained local
expanded receipt; the expanded duplicate is not staged.

### Runtime D1 unavailable arm

The exact source was deployed with only runtime D1 unavailable. One cold-first
public reservation returned HTTP 200, body `kind=committed`, response elapsed
1,939 ms, and header `x-sdt-global-admission: not-admitted`. The fully paged
public list did not show the reservation at the 5,000 ms bound. Receipt metrics
are n=1, observed=0, censored=1, and `countAtOrOver5000OrMissing=1`; no
percentile is claimed from that censored row. This is the actual deployed F1
proof that local durable acceptance does not depend on the runtime D1 probe,
while global admission remains explicit and not falsely reported as admitted.

Raw receipt: `.artifacts/sdt-g65-w129-d1-unavailable.json`.

### Durable hop rows

The W129 durable query is `.artifacts/sdt-g65-w129-ledger-query.log`. It
contains 36 ledger rows for 11 distinct event identities/attempt identities.
Every row has `Date.now epoch ms` clock origin, a 300 ms bounded attempt,
`unknown` outcome, and null global completion observation. The complete
W128-derived post-admission and unsafe-writer tables remain preserved in the
existing evidence document; W129 does not reinterpret their authored clocks.

## Boundary statement

The repair keeps the V1 wire/body, 5,000 ms constant, reservation/fence
protocol, durable outbox/local receipt ordering, Queue global admission,
ordering/retry/DLQ behavior, G44 safe-lane fence, and G58/G62 behavior
unchanged. Unsafe timing remains evidence only for SDT-G60. The W129 healthy
cohort is a failed timing measurement, not a reason to weaken a gate or claim
G65 acceptance. PR #127 is pushed at
`ccfa0b0c2ea7a9f42f61bd241c5fa52e3ef2676a` and awaits reviewer rereview; no
self-approval, merge, or worker-complete transition was run.
