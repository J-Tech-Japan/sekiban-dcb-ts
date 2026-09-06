# SDT-G67 amended acceptance, cleanup, and PR handoff — W147

Task: `SDT-G67-AMENDED-ACCEPTANCE-CLEANUP-PR-WAKE-147`

Status at handoff: **completed for the bounded W147 objective**. The final
amended production gates are satisfied by retained W146 evidence; the
authorized W131-C resources were retired. No cohort was rerun. The PR and
hosted-check state are recorded after the evidence commit in the canonical
handoff.

## Scope and source identity

- Repository: `J-Tech-Japan/sekiban-dcb-ts`
- Branch: `claude/sdt-g67-local-wake-w142`
- Starting evidence head: `a83f7c21f94d1ed5c25cf0b2e3f4f034904f7b9a`
- Comparison base: `origin/main` at
  `868f2fc63bb02fb2c127e750c1d22516cc0fcff6`
- Measured candidate source: `d596192f3b0ddb0ab6b70d10ed8b8c04cd5489ae`
- The immutable evidence-commit SHA, PR number, and hosted-check state are
  supplied by the final canonical report/PR because the artifact is itself
  part of that commit; no post-push evidence edit is required.

This task did not change product code, tests, fixtures, workflows, acceptance
criteria, or deployed configuration. The only tracked source change in this
checkpoint is the amended evidence publication plus the W147 cleanup receipts.
Pre-existing unrelated dirty files and the retained W145 raw receipts were
left untouched.

## Final amended AC4/AC5 reconciliation

The W145 and W146 raw receipts were sufficient to derive the required
attribution columns. Neither arm nor production was rerun.

W145 retained the cold-first, paced `n=10` parent/candidate arm cohorts. The
candidate recorded 56 fence stops, 9 completed fence-expiry passes, and
`SafeWindow=20000 ms`. Its candidate residual scheduling-wait p95 was 936 ms;
its pass-latency p95 was 27598 ms. These are retained observations and are not
silently reclassified as a pass.

W146 is the final production proof for the amended packet:

- Worker: `sekiban-dcb-meeting-room-cloudflare-only`
- Candidate source: `d596192f3b0ddb0ab6b70d10ed8b8c04cd5489ae`
- Version: `11c907ff-dde3-44c3-928e-550303d47aac`, 100% traffic
- Run: `7b5cdd0f-ed47-46a2-8f7c-b2d04e9aff20`, cold first, `n=10`, paced
- Production config: `DIRECT_DOORBELL=false`; receiver mode absent/
  unconfigured; no `DOWNSTREAM_DOORBELL` service binding
- Ring population: zero; direct-ring and strict unsafe rows are therefore
  non-gated attribution facts for G67, not omitted evidence
- Owned production gates: scheduling-wait p95 `1608 ms <= 5000 ms`; safe first
  visibility `10/10 < 180000 ms`
- Strict unsafe observation: `10/10` exceeded the 5000 ms observation bound;
  all ten eventually became visible. This remains an honest retained miss.
- Pass-latency p95: `16983 ms`. This is broader than arm catch-up cost: it
  includes production Queue-arrival, fence, and deferred-pass timing, rather
  than only catch-up execution. Pass latency, fence wait, ring arrival, Queue
  arrival, and strict unsafe are reported attribution, not final G67 gates.

The production distributions from observed clocks are:

| measure | n | p50 (ms) | p95 (ms) | disposition |
|---|---:|---:|---:|---|
| command response | 10 | 2059 | 2388 | measured |
| Queue arrival | 10 | 12205 | 22514 | attribution |
| fence wait | 10 | 54995 | 62698 | attribution |
| scheduling wait | 10 | 219 | 1608 | **owned gate passed** |
| pass latency | 10 | 9939 | 16983 | attribution, not a gate |
| safe first visibility | 10 | 76684 | 116916 | measured; 10/10 under 180 s |
| unsafe eventual visibility | 10 | 55070 | 115342 | strict 5 s observation missed 10/10 |

The per-sample table is committed in `docs/SDT-G67-evidence.md`, with exact
SUID, response, unsafe, safe, ring-arrival, Queue-arrival, fence-wait,
scheduling-wait, pass, trigger, and stop-reason columns. The retained durable
receipts contain 126 seven-hop rows, 252 post-admission rows, and 320 safe-pass
rows. Delivery, fence-expiry, and cron triggers are present; the final safe
history ends SETTLED at the final cohort SUID.

## Authorized W131-C cleanup

Fresh read-only resolution identified exactly these throwaway targets and
confirmed W155-C and production identities were distinct:

| resource | identity |
|---|---|
| Worker | `sekiban-dcb-g60-w131-c` |
| pipeline D1 | `sekiban-dcb-g60-w131-c-pipeline` / `b03270df-9698-4a9e-94c6-c2c5726f106d` |
| MV D1 | `sekiban-dcb-g60-w131-c-mv` / `616dd377-42f3-49f7-b373-a1a07cedf2b3` |
| outbox Queue | `sekiban-dcb-g60-w131-c-outbox` / `1bd200864a804e78bd83da26a343deb4` |
| DLQ | `sekiban-dcb-g60-w131-c-outbox-dlq` / `607750c269894fa3b29e019a2db23908` |

The outbox had one W131-C consumer; the DLQ had zero. Cleanup then completed
in the authorized order:

1. removed Worker `sekiban-dcb-g60-w131-c` from the outbox consumer list;
2. deleted Worker `sekiban-dcb-g60-w131-c`;
3. deleted pipeline D1;
4. deleted MV D1;
5. deleted outbox Queue;
6. deleted outbox DLQ.

The post-delete Worker read returned Cloudflare code 10007 (Worker absent),
which is the expected absence proof and was not retried. Final D1 and Queue
inventories show all W131-C names absent. W155-C remains present with pipeline
`ac751211-fde8-4587-9d56-1e9fd8051bc3`, MV
`2b60dbcf-0912-4bb2-93aa-77c26cd260e1`, its outbox/DLQ and consumer state
unchanged. Production D1 IDs
`f26d1299-82d9-4a64-8647-bc2ec86326ac` and
`b416b212-4d09-413c-9b8d-7660e475772f`, production queues, G32, G26, and the
old doorbell worker were not touched.

Receipt files are:

```text
.artifacts/sdt-g67-amended-acceptance-cleanup-pr-wake-147-w147-worker-resolution.json
.artifacts/sdt-g67-amended-acceptance-cleanup-pr-wake-147-w147-d1-resolution.json
.artifacts/sdt-g67-amended-acceptance-cleanup-pr-wake-147-w147-queue-resolution.json
.artifacts/sdt-g67-amended-acceptance-cleanup-pr-wake-147-w147-detach-outbox-consumer.json
.artifacts/sdt-g67-amended-acceptance-cleanup-pr-wake-147-w147-queue-after-detach.json
.artifacts/sdt-g67-amended-acceptance-cleanup-pr-wake-147-w147-delete-worker.json
.artifacts/sdt-g67-amended-acceptance-cleanup-pr-wake-147-w147-worker-after-delete.json
.artifacts/sdt-g67-amended-acceptance-cleanup-pr-wake-147-w147-delete-d1-pipeline.json
.artifacts/sdt-g67-amended-acceptance-cleanup-pr-wake-147-w147-delete-d1-mv.json
.artifacts/sdt-g67-amended-acceptance-cleanup-pr-wake-147-w147-delete-queue-outbox.json
.artifacts/sdt-g67-amended-acceptance-cleanup-pr-wake-147-w147-delete-queue-dlq.json
.artifacts/sdt-g67-amended-acceptance-cleanup-pr-wake-147-w147-final-d1-inventory.json
.artifacts/sdt-g67-amended-acceptance-cleanup-pr-wake-147-w147-final-queue-inventory.json
.artifacts/sdt-g67-amended-acceptance-cleanup-pr-wake-147-w147-final-production-worker-inventory.json
```

Every Wrangler receipt records the five credential variable names as
`UNSET`, records `noKeepVars: true`, and contains no credential value. No
resource was created. No retry was made for a failed state-changing cleanup
operation.

## Local CI-equivalent evidence

The scoped docs/receipts change was checked with `git diff --check`. The
following focused and affected lanes passed:

```text
npm run test:g67
npm run test:g44
npm run test:g58
npm run test:g60:required
npm run test:g61
npm run test:g62
npm run test:g65:required
npm run test:g51
npm run test:g30:candidate
npm run test:g32:candidate
npm run test:g31:candidate
npm run test:g29:candidate
npm run test:g20
npm run test:g20:gate
npm run test:g20:candidate
npm run test:cosmos-wiring
node scripts/g40-ci-coverage-check.mjs
node scripts/g40-ci-mutation-proof.mjs
node scripts/g40-verify-needs.mjs --self-test
npm run test:store-contract
npm run test:d1
npm run test:mv
npm run test:boundaries
npm run test:consumer
npm run build
npm run test:g16
npm run test:g38:prep
npm run test:g44
npm run test:g45
npm run test:g46
npm run test:g49
npm run test:g41
```

The local aggregate is not called green. Exact exceptions are preserved:

- `npm run test:g17`, `test:g21`, `test:g22`, and `test:g32` hit the local
  PostgreSQL `password authentication failed for user "postgres"` (`28P01`);
  the serial aggregate then stalled after the G32 output and was timeboxed.
- `npm run test:g43` reproduced the known scheduler race: AC6 expected
  event `0ecb1824-ac84-78df-9698-d91b9abfdcfe` but observed pending event
  `11cb1824-b19d-78df-96b1-de1b9abfdffe` at line 443. This is unrelated to
  the docs-only W147 change.
- `npm run test:g30` reached the known trace-mutation output and was
  timeboxed at 120 seconds, terminated with SIGINT; its candidate lane passed
  separately. This is the documented runner/environment exception.
- `npm run e2e:g15:local` and `npm run e2e:g16:local` exited 2 because
  `POSTGRES_URL` is unavailable; they did not silently skip.
- `npm run test:cosmos` and `npm run test:g22:cosmos` exited 1 because the
  emulator endpoint/key was unavailable.

No gate, timeout, fixture, assertion, source, or workflow was weakened to
obtain these results. Generated local-install noise was removed recoverably;
unrelated historical dirt remains unstaged.

## Handoff

The amended production-owned gates are satisfied from retained receipts, the
authorized W131-C resources are absent, and the evidence amendment is ready
for review. The non-draft PR is opened against `main` with `Closes #129`;
the final canonical report records its number, exact evidence head, worker
completion result, and hosted CI state.
