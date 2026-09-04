# SDT-G60 post-repair deployed measurement (W151)

Task: `SDT-G60-POST-REPAIR-DEPLOYED-W151`
Issue: SDT-G60 / #113
Branch: `claude/sdt-g60-clean-preg53-ab-w124`
Checkpoint head: `4bb3d4b` (`4bb3d4ba6eefad063a2b5b0a22d90fe0cac24f0d`)
Requested main integration: `16ac4f571e8cba1bd1d6469789cc38b93859336f`
Status: **blocked before deployment**

The full checkpoint hash above is the exact pushed head returned by `git
rev-parse HEAD` at the end of the local checkpoint. The product repair remains
the W144 commit `9eabe0458c59b89a96af56738063a94c6934a0ee`; the only additional
change in W151 was a test-only G62 mutation-anchor indentation fix required by
the W144 instrumentation wrapper. No product behavior was changed in W151.

## Local verification before the remote window

The integrated branch was merged with `origin/main` at the requested commit in
merge commit `bcbfb252034cdea4f6e2fbaa90a37452c06c4abe`, then pushed together
with the test-only G62 guard-anchor fix as `4bb3d4b`.

The following completed successfully before the remote reset attempt:

| command | result |
|---|---|
| `npm run test:g60:queue` | pass; current handoff green, omission and old-waitUntil mutants red |
| `node scripts/g60-durable-hop-guard.mjs --self-test` and normal run | pass; seven-hop correlation green, identity mutant red |
| `node scripts/g60-post-admission-guard.mjs --self-test` and normal run | pass; omission and reorder mutants red |
| `npm run test:g41` | pass |
| `npm run test:g44` | pass; unchanged fence and production mutants red |
| `npm run test:g49` | pass; binding/migration/lineage mutants red |
| `npm run test:g51` | pass |
| `npm run test:g52` | pass; omission mutants red |
| `npm run test:g53` | pass; control/downstream mutants red |
| `npm run test:g54` | pass; accepted-positive and production mutants red |
| `npm run test:g55` | pass; read-visibility guard green |
| `npm run test:g58` | pass; existing G58 guards/mutants green |
| `npm run test:g62` | pass; cursor-aware AC1–AC3 guard green and all three mutants red |
| `npm run test:g61` | pass; retained-frontier guard green and mutant red |
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `git diff --check` | pass |

The first post-merge G62 self-test exposed only a formatting-specific
mutation anchor mismatch in `scripts/g62-local-guard.mjs`; updating that test
anchor to match the instrumented continuation restored the exact existing
cursor mutation and did not alter the reconciler or admission path.

## Wrangler hygiene

Before the first Wrangler invocation, the required five names were reported as
follows. Values, prefixes, and lengths were not inspected or emitted:

| name | status |
|---|---|
| `CLOUDFLARE_API_TOKEN` | `UNSET` |
| `CF_API_TOKEN` | `UNSET` |
| `CLOUDFLARE_API_KEY` | `UNSET` |
| `CF_API_KEY` | `UNSET` |
| `WRANGLER_API_TOKEN` | `UNSET` |

The stripped binary reported Wrangler `4.125.0`. The existing normal config
was used; no `--keep-vars` was used. No conformance or observability token was
read or supplied.

## Existing-resource reset attempt

The only remote action attempted was the C-0/C-13 operational reset
precondition against the existing production-shaped resources:

| resource | target |
|---|---|
| Worker | `sekiban-dcb-meeting-room-cloudflare-only` |
| normal config | `samples/meeting-room/wrangler.cloudflare-only.jsonc` |
| pipeline D1 | `f26d1299-82d9-4a64-8647-bc2ec86326ac` (`D1`) |
| MV D1 | `b416b212-4d09-413c-9b8d-7660e475772f` (`D1_MV`) |
| Queue/DLQ | existing config bindings; not touched |

The exact wrapper command was:

```text
env -u CLOUDFLARE_API_TOKEN -u CF_API_TOKEN -u CLOUDFLARE_API_KEY -u CF_API_KEY -u WRANGLER_API_TOKEN node .artifacts/sdt-g60-w124-reset.mjs --variant W151-existing-production --config /Users/tomohisa/dev/GitHub/SekibanDcbTsImplementation/.g60-w124/samples/meeting-room/wrangler.cloudflare-only.jsonc --wrangler /Users/tomohisa/dev/GitHub/SekibanDcbTsImplementation/node_modules/.bin/wrangler --report /Users/tomohisa/dev/GitHub/SekibanDcbTsImplementation/.g60-w124/.artifacts/sdt-g60-w151-reset.json
```

The wrapper persisted the complete raw receipt at
[`.artifacts/sdt-g60-w151-reset.json`](.artifacts/sdt-g60-w151-reset.json).
Its first and only command was the read-only query:

```text
env -u CLOUDFLARE_API_TOKEN -u CF_API_TOKEN -u CLOUDFLARE_API_KEY -u CF_API_KEY -u WRANGLER_API_TOKEN /Users/tomohisa/dev/GitHub/SekibanDcbTsImplementation/node_modules/.bin/wrangler d1 execute D1 --remote --json --yes --config /Users/tomohisa/dev/GitHub/SekibanDcbTsImplementation/.g60-w124/samples/meeting-room/wrangler.cloudflare-only.jsonc --command "SELECT 'serialized_dcb_global_receipts' AS table_name, COUNT(*) AS row_count FROM serialized_dcb_global_receipts"
```

It returned exit code `1` at `2026-09-04T11:58:28.227Z` with Cloudflare API
code `7403`:

```text
A request to the Cloudflare API (/accounts/3ede2188f4cf39a28e0aa3722d3d02c5/d1/database/f26d1299-82d9-4a64-8647-bc2ec86326ac/query) failed.
The given account is not valid or is not authorized to access this service [code: 7403]
```

No DELETE was issued, so the operational data was not reset. Because this was
the required read-only precondition and no write authorization failure
occurred, no same-family classifier was run and no alternate or retry write
path was attempted. The existing Worker, D1s, Queue, and DLQ were not
deployed to or otherwise modified by this checkpoint.

## Deployment/cohort disposition

The reset prerequisite failed before deployment. Therefore this checkpoint has
no W151 Worker version, deployment ID, source annotation, clean-row proof,
cohort receipt, durable ledger query, per-hop timing, or AC3 result. No public
reservation was created and no cohort was run. It would be incorrect to claim
that the repaired source met the strict `<= 5,000 ms` requirement.

The W144 measurement remains the latest deployed evidence: its four strict
over-bound samples were dominated by Queue-send-returned to consumer-start
latency, while completed W127 post-admission spans were at most `495 ms`; the
cold first sample was censored. W130/W143 evidence is retained. The pre-G53
A/B comparison remains deferred/open under Authority B. The 5,000 ms
constant, SafeWindow, durability/order/fence protocol, outbox/Queue/global-D1
admission behavior, G53/G55/G58/G61 boundaries, and G56 hold remain unchanged.

## Incidental generated drift

The four pre-existing dirty generated G58 receipts were preserved and not
staged:

- `.artifacts/sdt-g58-w111-green-guard.json`
- `.artifacts/sdt-g58-w112-green-guard.json`
- `.artifacts/sdt-g58-w97-green-guard.json`
- `.artifacts/sdt-g58-w98-lag-red-guard.json`

The local G61/G62 guard runs also refreshed their tracked fixture receipts;
those generated changes and the older untracked W126–W143 evidence/scripts
were preserved and excluded from the W151 evidence commit. The new reset
receipt is included with this blocked checkpoint so the 7403 result remains
durable.

## Next boundary

Operator resolution is required for the existing-account D1 query authorization
failure. After that resolution, a fresh authorized W151 continuation must
explicitly repeat the one clean reset/deploy/cohort contract; this checkpoint
does not authorize a retry or a second deployment/cohort. No PR or worker
completion transition was attempted.
