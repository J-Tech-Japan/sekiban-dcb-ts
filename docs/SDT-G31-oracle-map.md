# SDT-G31 oracle correspondence

| AC | Contract | Executable oracle | Mutation / failure proof |
| --- | --- | --- | --- |
| 1 | `waitFor` succeeds only on an active receipt or a uniquely stored source target plus an active safe head at/after it. | `test/g31-waitfor.spec.ts` applies a real receipt, garbage-collects it, and then proves the source-plus-safe-head branch. | A high safe head without a source target stays 504; the old receipt cannot satisfy a promoted generation/definition. |
| 2 | SUID collision and lineage mismatch win before either success condition. | The real D1 delivery path records both alias classes; the wait request returns 503. | Collision/lineage aliases never reach a receipt or safe-head success result. |
| 3 | Every loop and success recheck reads active-generation checkpoint/rebuild/poison facts through bounded point reads. | The integration fixture injects each gate and a success-time checkpoint flip; it records source/MV read counts and a no-`readAllEvents` source oracle. | Full scan, omitted final recheck, read-budget growth, and an old generation receipt/poison are independently red. `scripts/g31-waitfor-check.mjs` guards the structural path. |
| 4 | The deadline is one absolute request-start snapshot with jittered capped backoff. | The deterministic clock fixture starts at 100 and expires at 20,100, while a frozen clock reaches the 125-iteration cap. | Recomputing the deadline after polls changes the exact deadline/cap fixture. |
| 5 | Timeout retains V1 status/code/key shape and only gains read-oriented guidance; unavailable remains 503. | The wait fixture asserts HTTP 504, `timeout`, exact key set, and refresh language. | Collapsing 503 to 504 or adding wire keys fails the status/shape assertions. |
| 6 | Reserve/cancel make exactly one newest-first list query carrying the committed SUID; 504 tells the user to Refresh with no browser retry. | `test/g31-sample.spec.ts` runs the public proxy and helper, inspects the exact internal list-query bytes, and checks static reserve/cancel wiring. | Extra refresh calls, forwarded hostile headers, tag-state polling, timer retry, or missing manual Refresh wording are red. |
| 7 | The sealed final C is deployed once under the existing identity; witness set preservation and fixed-N commit-response→list-redraw timing are recorded. | `scripts/deploy/g31-deploy-witness.sh`, `g31-witness.mjs`, `g31-measure.mjs`, `g31-record-evidence.mjs`, and `test/g31-witness.spec.ts`. | Changed service/database/queue/generation/source commit, lost pre-captured row/head/list entry, receiver Queue consumer, fewer than 10 raw cycles, or old-SUID-with-receipt probe failure aborts evidence. |
| 8 | C/R is non-self-referential and all material is digest authority. | `docs/SDT-G31-required-roots.json`, `scripts/g31-candidate-check.mjs`, and CI's normal/forced-red candidate lanes. | Missing/empty root, wrong digest, `deploymentRequired:false`, deployed/source mismatch, or any post-C path beyond evidence plus one retained SHA is red. |

## Bounded wait budget

The D1-MV wait loop takes at most 125 iterations. It uses 25, 50, 100, 200,
400, 800, then capped 1000 ms backoff and permits at most 126 paired probes:
252 total source/MV point-read statements, including a mandatory final proof
before returning success. The request-start deadline remains absolute even if a
clock or lag source changes later.

## Witness protocol

After all implementation material is sealed in C, the deploy script executes:
preflight → public pre-witness set → additive migration apply → receiver
consumer check/remove → receiver deploy → primary deploy with a protected
rotated conformance token → authenticated post-witness/source assertion →
fixed N=10 one-list-query measurements → old GC'd SUID success probe. R then
contains only this evidence document and the one C SHA retained by CI.
