# SDT-G52 PR #104 DO ownership resume — W75

Task: `SDT-G52-PR104-DO-OWNERSHIP-RESUME-W75`

Starting PR head: `7271e28b8bb7932fcf0b83bec7e4ff3488ebe8bd`

## Repair and ownership boundary

PR #104 was canonically claimed after blocker comment `5511476075`. The snapshot-log required-row guard now recognizes the Worker/DO boundary: `S07`, `S09`, `S12`, `S14`, and `S16` are DO-owned and are not required in a Worker-local snapshot. The manifest and native trace semantics were not changed. The remaining Worker-owned success rows stay fail-closed.

Focused fixtures prove that a snapshot without every DO-owned member/callback row remains valid, while omission of Worker-owned `S10` still fails. The G52 resume fixture proves that the resume path counts a Worker-only root as schema-complete and still rejects a missing Worker row. `npm run test:g52` passed with 18 tests; the G30 mutation matrix self-test recognizes the new ownership-split gate.

## Sole W75 live resume

Exactly one read-only resume ran against the existing paced 51-ray ledger at `2026-09-02T15:02:18.190Z`. It sent no application request, deployed nothing, and was not retried. It retained one snapshot root and one schema-complete measured root; 49 of 50 measured samples remain absent. The one first-seen lag was 16,241,210 ms.

The valid Worker snapshot rows are source-labelled `n=1`; client S00 remains LAX `n=50`, nearest-rank p50/p95 `1308/2113 ms`. The full-cohort retained `sdt.observe/v1 do.handler` result has `n=0`, so `TAG`, `ALLOCATOR`, and remote actor-class medians are explicitly unavailable. The evidence retains the singleton Worker-only residual ordering and R-3 retention result without fabricating DO timings.

## CI and lifecycle

The previous `ci-foundation` failure included unrelated full-suite/G43 timeout failures. This repair will receive exactly one replacement `ci-foundation` run on its pushed head. Its final URL/status and any recurring G43 classification are recorded after that run; no G43 test or timeout is changed in this task.
