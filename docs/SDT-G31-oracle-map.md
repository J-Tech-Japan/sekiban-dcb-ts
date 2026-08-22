# SDT-G31 oracle correspondence

| AC | Contract | Executable oracle | Mutation / failure proof |
| --- | --- | --- | --- |
| 1 | `waitFor` succeeds only on an active receipt or a uniquely stored source target plus an active safe head at/after it. | Separate real D1-MV fixtures prove active receipts for stored `no-change`, `patch-not-found`, and `delete-without-row`; separate fast-receipt and receipt-GC/source+safe-head fixtures prove both branches. | Removing any stored-outcome receipt insertion makes that outcome's own `targetReceipt` assertion red. A high safe head without a source target stays 504; the old receipt cannot satisfy a promoted generation/definition. |
| 2 | SUID collision and lineage mismatch win before either success condition. | Separate real D1 delivery fixtures cover a collision whose existing event already has an aliased receipt, and a non-stored lineage mismatch. Both return exact 503 `projection_unavailable`. | Removing either non-stored gate makes its independently named fixture red; the collision cannot alias the existing receipt into a success. |
| 3 | Every loop and success recheck reads active-generation checkpoint/rebuild/poison facts through bounded point reads. | Three independent real D1 fixtures open CHECKPOINT_AHEAD, rebuild-required, or target poison only after a healthy receipt proof and before the mandatory confirmation; each returns 503. Two actual-Miniflare-D1 budget fixtures meter executed SQL statements and rows read rather than port calls. | Omitted per-iteration/final recheck, a specific rebuild/poison gate removal, a full scan, or N+1 growth is red. `scripts/g31-waitfor-check.mjs` also guards the indexed structural path. |
| 4 | The deadline is one absolute request-start snapshot with capped backoff. | Separate fixtures prove receipt fast-path, receipt-GC queue fallback, ceiling timeout, a 20s exact clock advance, a 120s exact clock advance, and a healthy receipt arriving in the final 120s poll slot. | A 800ms cap, early iteration/query cutoff, deadline re-snapshot, sleep past the absolute bound, ceiling bypass, or a post-deadline probe is red. |
| 5 | Timeout retains V1 status/code/key shape and only gains read-oriented guidance; unavailable remains 503. | The timeout fixture independently asserts HTTP 504, `timeout`, exact `{code,error}` keys, and refresh text. The unavailable fixture independently asserts HTTP 503, `projection_unavailable`, and the same exact keys. | Collapsing 503 to 504, changing either code, or adding/removing a wire key is red. |
| 6 | Reserve/cancel make exactly one newest-first list query carrying the committed SUID; 504 tells the user to Refresh with no browser retry. | `test/g31-sample.spec.ts` runs the public proxy and helper, inspects the exact internal list-query bytes, and checks static reserve/cancel wiring. | Extra refresh calls, forwarded hostile headers, tag-state polling, timer retry, or missing manual Refresh wording are red. |
| 7 | The sealed final C is deployed once under the existing identity; scheduled safe MV catch-up/GC runs before generic polling, and witness set preservation plus fixed-N commit-response→list-redraw timing are recorded. | `samples/meeting-room/src/worker.cloudflare-only.ts`, `scripts/deploy/g31-deploy-witness.sh`, `g31-witness.mjs`, `g31-measure.mjs`, `g31-record-evidence.mjs`, `test/g31-witness.spec.ts`, and `test/g31-sample.spec.ts`. | Generic scheduled work preceding safe catch-up, changed service/database/queue/generation/source commit, lost pre-captured row/head/list entry, receiver Queue consumer, fewer than 10 raw cycles, or old-SUID-with-receipt probe failure aborts evidence. |
| 8 | C/R is non-self-referential and all material is digest authority. | `docs/SDT-G31-required-roots.json`, `scripts/g31-candidate-check.mjs`, and CI's normal/forced-red candidate lanes. The new evidence keeps the prior witnessed C/R as a validated history entry. | Missing/empty root, wrong digest, changed historical C/R identity, `deploymentRequired:false`, deployed/source mismatch, or any post-C path beyond evidence plus one retained SHA is red. |

## Bounded wait budget

The D1-MV loop reserves 126 slots so that the healthy 120-second case has a
final pre-deadline poll instead of a premature cap return. Backoff is 25, 50,
100, 200, 400, 800, then 1000 ms; every requested sleep is clamped to the
remaining absolute deadline. A normal pending waiter makes these exact real-D1
budgets:

| Published SafeWindow | Paired source/MV wait probes | Wait point-read statements | Total executed D1 statements | Returned rows read |
| --- | ---: | ---: | ---: | ---: |
| 20s floor | 26 | 52 | 54 | 53 |
| 120s ceiling | 126 | 252 | 254 | 253 |

The total column includes one request-start lag lookup and one initial
CHECKPOINT_AHEAD gate; the healthy initial gate has no finding row, hence the
one-row difference. A success discovered at the exact deadline may use its
mandatory confirmation, raising the explicit wait-only maximum to 127 paired
probes / 254 point-read statements (256 executed statements including the two
request-start gates). The lag estimate is sampled once, the deadline never
extends or shrinks, and a non-normal flapping proof that exhausts the read cap
waits out the remaining deadline without issuing another query.

## Witness protocol

After all implementation material is sealed in C, the deploy script executes:
preflight → public pre-witness set → additive migration apply → receiver
consumer check/remove → receiver deploy → primary deploy with a protected
rotated conformance token → authenticated post-witness/source assertion →
fixed N=10 one-list-query measurements → old GC'd SUID success probe. R then
contains only this evidence document and the one C SHA retained by CI.
