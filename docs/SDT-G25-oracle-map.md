# SDT-G25 acceptance-oracle map

| AC | Oracle / evidence |
| --- | --- |
| 1 | `test/g25-composition.spec.ts`: stored-only Queue hook, atomic unsafe apply, max-merged kick and `waitUntil` drain. |
| 2 | Same lane forces post-store unsafe failure: no ack, Queue retry, idempotent `UNSAFE_APPLY_RETRY` finding. The deployed Queue has a bounded retry/DLQ policy. |
| 3 | Cloudflare-only `d1-mv` applies the G23 composed store; `queryRowsWithTotal` keeps server paging and the sample UI/README distinguish tentative from definitive state. |
| 4 | `docs/SDT-G25-deploy-evidence.json` is the FINAL-CANDIDATE record for fixed-N latency distribution and cron fallback count. |
| 5 | The same evidence record requires authenticated five-endpoint conformance, raw-V1 404, restart replay, G17 negative facts, and a CHECKPOINT_AHEAD rebuild drill. |
| 6 | Existing `test:g20:gate` proves the safe-only Cloudflare composition excludes external DBs; the PG runtime remains a separate build/deploy variant. |
| 7 | `test:g25` and `test:g25:forced-red` are explicit CI steps. G25’s runtime test invokes the public handler without any internal/test service-id header. |

The evidence document stays a placeholder until the candidate is deployed. The
machine checker rejects a non-evidence source edit after the recorded candidate
and, once a SHA is recorded, recomputes both declared candidate-tree digests.
