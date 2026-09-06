# SDT-G67 AC4 event-drive repair — W142

Task: `SDT-G67-AC4-EVENT-DRIVE-REPAIR-WAKE-142`  
Issue: `J-Tech-Japan/sekiban-dcb-ts#129`  
Branch: `claude/sdt-g67-local-wake-w142`  
Starting head: `6d691275dd763bb8fb8fad1c6d2a49bd18d45d00`  
Checkpoint SHA: **pinned after the scoped push below**

## Classification and bounded decision

The W142 rehearsal did not prove that Queue delivery failed to invoke the
safe-lane pass: the candidate ledger contained 150 `kick` rows, including 10
completed kick rows. It did prove that the prior durable record could not
attribute effective catch-up to a delivery. The pass schema had no delivery
event/attempt/partition/obligation identity, its durable safe-head fields were
`null`, and its previous safe-head query targeted a projection-checkpoint
table that is not the MV schema used by this arm. The earlier 140 coalesced
rows therefore could not distinguish an effective catch-up from a recorded or
coalesced request, nor establish a delivery-to-safe relationship.

The narrow repair is local and observation-only around the existing G44/G62
pass body:

1. Queue delivery supplies its event, attempt, partition, and obligation
   identity to the kick scheduler.
2. A coalesced request replaces the pending request, and the follow-up
   single-flight pass runs that latest request rather than reusing the first
   delivery's identity.
3. The existing `runMeetingRoomScheduledMaintenance` coverage/frontier and MV
   catch-up body remains the effective work. A wrapper records its observed
   start, completion, outcome, and error without changing its decision or
   frontier semantics.
4. The append-only pass ledger now records delivery ownership and the observed
   catch-up lifecycle. Safe-head observation uses the existing MV active
   generation/instance tables; it is never substituted for a proven frontier.
5. Cron remains the backstop. No Queue acknowledgement, admission, ordering,
   retry, DLQ, G44 fence, G62 maintenance, or projector semantics were
   changed.

This is not a deployed latency claim. The next authorized arm measurement must
use the new non-null attribution fields and distinguish a completed effective
kick from a cron fallback. No Wrangler, Cloudflare, reset, deployment, PR, or
resource operation was performed for this checkpoint.

## Preserved W142 deployed evidence

The exact parent was `868f2fc63bb02fb2c127e750c1d22516cc0fcff6`; the candidate
was `6d691275dd763bb8fb8fad1c6d2a49bd18d45d00`. On the isolated W155-C arm:

| arm | response p50/p95 | unsafe p50/p95 | unsafe over 5,000 ms | safe p50/p95 | safe under 180 s |
|---|---:|---:|---:|---:|---:|
| parent | 2,746 / 3,105 ms | 2,867 / 3,103 ms | 0/10 | 77,828 / 123,321 ms | 10/10 |
| candidate | 2,658 / 2,952 ms | 2,892 / 3,095 ms | 0/10 | 68,725 / **117,444 ms** | 10/10 |

The candidate response and unsafe relative gates passed, but safe p95 exceeded
the AC4 arm target of 60,000 ms. Production was correctly not touched. The
complete prior tables and raw receipts remain in the staged
`.artifacts/sdt-g67-w142-rerehearsal-*` files and
`sdt-g67-ac4-rerehearsal-wake-142.md`.

The candidate durable rows were 150 `kick` and four `cron`: 140 coalesced, 10
completed kicks, three completed cron passes, and one failed cron pass with
`CHECKPOINT_AHEAD`. The completed kick rows show that the notification path
ran, but the old schema could not prove which delivery owned a pass or whether
its effective catch-up completed. The new fields are deliberately nullable for
historical rows; null historical fields are not reported as proof.

## Scoped implementation

- `migrations/d1/g32/0012_g67_safe_lane_pass_ownership.sql` adds append-only
  observation columns and a delivery-identity index to the existing pass
  ledger.
- `samples/meeting-room/src/safe-lane-kick.ts` carries owner identity and
  preserves single-flight/coalescing while assigning the latest pending owner
  to the follow-up pass.
- `samples/meeting-room/src/worker.cloudflare-only.ts` passes Queue identity
  into the kick and records the actual effective catch-up lifecycle separately
  from the aggregate DeliveryCore result.
- `samples/meeting-room/src/d1-mv.ts` persists/reads the owner and lifecycle
  fields and observes heads through the MV active-generation schema.
- `test/g67-safe-lane.spec.ts`, `scripts/g67-safe-lane-guard.mjs`, and
  `test/helpers/g44-d1-migration.ts` cover the new ledger and test setup.

## Red/green evidence

The local G67 suite passed 6/6 tests. The pre-change receipt is
`test/fixtures/g67-red-before-green.json`; the green receipt is
`test/fixtures/g67-green.json`; and
`test/fixtures/g67-mutants-red.json` records all four required mutants red:

- omitted event-driven kick;
- reuse of the first rather than the latest coalesced owner;
- advancing under a BLOCK/UNSETTLED frontier;
- awaiting the Queue kick hook.

The first and third preserve the existing G67 frontier/kick protections; the
second is the new durable attribution/coalescing guard; the fourth preserves
the non-blocking notification contract.

## Local gates

| command | result |
|---|---|
| `npx vitest run --config vitest.config.ts test/g67-safe-lane.spec.ts --no-cache --maxWorkers=1` | PASS, 6 tests |
| `npm run test:g67` | PASS, tests, self-test, pre-fix red, and four mutants red |
| `node scripts/g67-safe-lane-guard.mjs --self-test` / `--pre-fix` / default | PASS; red-before-green and all mutants red |
| `npm run test:g44` | PASS, 8/8 and four G44 mutants red |
| `npm run test:g58` | PASS, 5 files/15 tests |
| `npm run test:g61` | PASS, red-before-green/green/mutants |
| `npm run test:g62` | PASS, guards and three mutants red |
| `npm run test:g60:required` | PASS, 14/14 and six G60 mutants red |
| `npm run test:g65:required` | PASS, 17/17 and G65 guards/mutants |
| `npm run test:g26` | PASS, 4 files/32 tests |
| `npm run test:g27` | PASS, 1 file/6 tests |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `git diff --check` | PASS |

The broad `npm test` aggregate was not green and is not being relabeled. Its
terminal output ended with 4 failed files, 88 passed, 1 skipped; 768 tests
passed and 1 was skipped. The failures were the known G43 re-arm race,
unrelated commit/repair/tag timeout cases, and Vitest worker teardown/SQLite
alarm environment errors. This output was captured during the checkpoint; no
timeout, assertion, fixture, or gate was changed, and no G67 focused test
failed.

## Handoff

This is a pushed local repair checkpoint, not AC4 completion. The required
next step is one separately authorized deployed rehearsal using the new
delivery ownership and effective-catch-up fields. The safe p95 miss above
remains preserved as failed evidence; no production cohort is implied.
