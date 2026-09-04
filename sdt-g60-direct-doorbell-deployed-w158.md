# SDT-G60 direct-doorbell deployed proof — W158

Task: `SDT-G60-DIRECT-DOORBELL-DEPLOYED-W158`

Issue: `J-Tech-Japan/sekiban-dcb-ts#113`

Branch: `claude/sdt-g60-clean-preg53-ab-w124`

Verified source/report head: `ae81feeae0452780f7a815e7d02fe7fba9054739`

Product repair carried by that head: `84892e5bd5233de9c12f07dffb12b28e08bee00e`

Pushed W158 evidence checkpoint: `a9292c2` (`docs(g60): record W158 fresh
resource auth block`)
Status: **blocked before fresh-arm provisioning**

## Bounded result

The first fresh-resource D1 create write reached the Cloudflare API with the
five standing Wrangler credential names stripped and returned Cloudflare API
code `10000` (`Authentication error`). Per W158/WAKE-108, this was not a D1
`7403` retry case: the failed create was not retried. Exactly one same-family
read-only classifier, `wrangler d1 list --json`, was run and succeeded, but
the requested fresh pipeline database was absent. The W158 operation therefore
stopped before any other fresh resource, migration, secret, Worker deployment,
or public cohort. No production or prior-arm resource was touched.

The exact failed write and classifier outputs are retained in:

- [`sdt-g60-w158-create-pipeline.json`](.artifacts/sdt-g60-w158-create-pipeline.json)
- [`sdt-g60-w158-auth-classifier-d1-list.json`](.artifacts/sdt-g60-w158-auth-classifier-d1-list.json)
- [`sdt-g60-w158-local-wrapper-correction.json`](.artifacts/sdt-g60-w158-local-wrapper-correction.json)

Receipt SHA-256 values:

| receipt | SHA-256 |
|---|---|
| create-pipeline | `43551a1979bc7fbd147847f25bb3e3cbf51465a92d521ac15bd00925ee97bd8a` |
| auth-classifier-d1-list | `8122058554066b22cd3dbea00b625f7669751fc5981422215b85732cad654e57` |
| local-wrapper-correction | `1ede77b67460596d39e62c5ff0df7e11f57ecd883ce4cdd5e4d03d77b1cde371` |

## Authorization hygiene and exact operations

The seat environment was reported before the first Wrangler operation, and the
receipt wrapper records the same state for both Cloudflare calls:

| variable name | state |
|---|---|
| `CLOUDFLARE_API_TOKEN` | unset |
| `CF_API_TOKEN` | unset |
| `CLOUDFLARE_API_KEY` | unset |
| `CF_API_KEY` | unset |
| `WRANGLER_API_TOKEN` | unset |

Every actual Wrangler child process was launched with all five names removed
from its environment. `noKeepVars: true` is recorded in both receipts. No
observability or conformance credential was used; no token was generated or
written.

The corrected remote write command, with no secret or credential value in its
arguments, was:

```text
env -u CLOUDFLARE_API_TOKEN -u CF_API_TOKEN -u CLOUDFLARE_API_KEY -u CF_API_KEY -u WRANGLER_API_TOKEN node .artifacts/sdt-g60-w158-wrangler-invoke.mjs --label create-pipeline --report .artifacts/sdt-g60-w158-create-pipeline.json --wrangler /Users/tomohisa/dev/GitHub/SekibanDcbTsImplementation/node_modules/.bin/wrangler -- d1 create sekiban-dcb-g60-w158-d-pipeline --location wnam
```

It started at `2026-09-04T19:50:38.242Z`, exited `1` at
`2026-09-04T19:50:40.406Z`, and returned:

```text
A request to the Cloudflare API (/accounts/3ede2188f4cf39a28e0aa3722d3d02c5/d1/database) failed.
Authentication error [code: 10000]
```

The only classifier was:

```text
env -u CLOUDFLARE_API_TOKEN -u CF_API_TOKEN -u CLOUDFLARE_API_KEY -u CF_API_KEY -u WRANGLER_API_TOKEN node .artifacts/sdt-g60-w158-wrangler-invoke.mjs --label auth-classifier-d1-list --report .artifacts/sdt-g60-w158-auth-classifier-d1-list.json --wrangler /Users/tomohisa/dev/GitHub/SekibanDcbTsImplementation/node_modules/.bin/wrangler -- d1 list --json
```

It started at `2026-09-04T19:50:57.768Z`, exited `0` at
`2026-09-04T19:50:58.813Z`, and its complete JSON output lists the previously
known W130/W131/W155 and production databases but no
`sekiban-dcb-g60-w158-d-pipeline`. This classifies the first fresh-resource
write as an account/API authorization condition requiring operator resolution;
the successful list did not make the failed create state present.

The initial local wrapper attempt at `2026-09-04T19:50:21.764Z` was a
non-Cloudflare `spawnSync ENOENT` because the child worktree has no local
`node_modules/.bin/wrangler`. It sent no Cloudflare request. The sole local
correction used the existing parent-repository Wrangler binary, and is recorded
separately; the D1 create request then failed once as described above.

## Fresh-arm plan not executed

The intended isolated names were reserved only as names in the failed command;
none was created:

| role | intended name | created/verified |
|---|---|---|
| primary Worker | `sekiban-dcb-g60-w158-d` | no |
| direct receiver support Worker | `sekiban-dcb-g60-w158-d-doorbell` | no |
| pipeline D1 | `sekiban-dcb-g60-w158-d-pipeline` | no; first write failed |
| MV D1 | `sekiban-dcb-g60-w158-d-mv` | no |
| Queue | `sekiban-dcb-g60-w158-d-outbox` | no |
| dead-letter Queue | `sekiban-dcb-g60-w158-d-outbox-dlq` | no |

Consequently there is no deployed version/source annotation, migration
receipt, fence fingerprint, secret publication, binding proof, ledger, writer
boundary table, or W158 cohort. W157's local direct-doorbell proof and all
earlier W130/W143/W155/W156 evidence remain preserved. The W157 repair itself
was not changed in this checkpoint.

## Acceptance comparison and disposition

No W158 latency sample exists, so no W158 `n`, percentile, over-5,000-ms
count, dominant hop, direct-apply idempotency proof, or platform-floor result
can be claimed. The historical comparison remains recorded for the next
authorized window: W95 p50 `2,959 ms` with `1/10` over; clean-main p50
`4,911 ms` with `5/10` over; queue-dependent W155 `5/10` over; and W156
`max_batch_size=1`/`max_batch_timeout=1` p50 `4,958 ms`, p95 `23,927 ms`,
`5/10` over. These are not W158 evidence.

The required next step is operator resolution of the stripped-environment
Cloudflare API code `10000`, followed by a fresh W158 window. No D1-`7403`
retry policy was invoked, because the observed error was code `10000`; no
alternate creation path or second classifier was attempted.

No product code, configuration, 5,000-ms contract, safe lane, ordering,
durability, fence, G53/G55/G58/G62 behavior, PR, or downstream unit was
changed. G56 remains held and G57 was not started.
