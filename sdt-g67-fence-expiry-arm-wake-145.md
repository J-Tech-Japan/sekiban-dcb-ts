# SDT-G67 fence-expiry arm proof — W145

Status: **BLOCKED at the W155-C arm AC4 gate.** The candidate exercised the
fence-expiry path and produced complete durable pass rows, but its safe-read
p95 is above the amended fence-relative bound. Production was not reset,
deployed, or sampled.

## Scope and source identity

- Branch: `claude/sdt-g67-local-wake-w142`
- Source under test: candidate `d596192f3b0ddb0ab6b70d10ed8b8c04cd5489ae`
- Exact pre-G67 parent: `91c36df5434895cccbbe03beeb5d7f8b5639857f`
- Evidence checkpoint: the commit containing this artifact (the source SHA
  above is unchanged by evidence-only commits).
- Arm: existing throwaway `sekiban-dcb-g60-w155-c` only.
- Pipeline D1: `ac751211-fde8-4587-9d56-1e9fd8051bc3`
- MV D1: `2b60dbcf-0912-4bb2-93aa-77c26cd260e1`
- Queue: `sekiban-dcb-g60-w155-c-outbox`
- DLQ: `sekiban-dcb-g60-w155-c-outbox-dlq`
- Queue consumer receipt: consumer `5210df8e9d0540a3a6a5d35d54098003`,
  script W155-C, batch size 10, max retries 3, max wait 1000 ms, DLQ
  `sekiban-dcb-g60-w155-c-outbox-dlq`.
- Deployed parent version: `cfa7ffd4-b6bf-4c63-beb4-82076431b89d`, annotation
  `SDT-G67 W145 arm parent exact 91c36df5434895cccbbe03beeb5d7f8b5639857f W155-C self`.
- Deployed candidate version: `e567d546-8e56-4ace-9680-17c1443da315`, annotation
  `SDT-G67 W145 arm candidate exact d596192f3b0ddb0ab6b70d10ed8b8c04cd5489ae W155-C self`.
- Both version views and deployment listings prove 100% traffic, self receiver
  mode, `DIRECT_DOORBELL=true`, self-binding proof, the W155-C receiver
  service/entrypoint, and the D1/Queue/DLQ bindings above.
- Every Wrangler command recorded
  `CLOUDFLARE_API_TOKEN=UNSET`, `CF_API_TOKEN=UNSET`,
  `CLOUDFLARE_API_KEY=UNSET`, `CF_API_KEY=UNSET`,
  `WRANGLER_API_TOKEN=UNSET`; no credential value was printed or persisted in
  the evidence.
- No Cloudflare resource was created or deleted. The production worker and
  production resources were untouched.

The parent deployment initially hit a local bundle-resolution error before any
Cloudflare publish. The corrected retry succeeded after the temporary detached
worktree used an absolute `node_modules` link. Both receipts are retained; the
retry, not the failed local bundle attempt, is the parent deployment evidence.

## Window and migrations

The parent cohort ran cold-first from `2026-09-06T14:51:04.467Z` through
`14:54:18.388Z` with run ID
`55f96e76-6155-498b-bd76-c54b0559e960`. The candidate cohort ran cold-first
from `2026-09-06T14:56:25.220Z` through `14:59:42.205Z` with run ID
`baaf9acd-3b12-4fc3-a3f2-eedf05e09799`. Each cohort has 10 accepted
reservations, a cold first sample, and at least 10 seconds from the preceding
commit response.

The parent had migration `0013` applied. The candidate was verified with
`0014_g67_safe_lane_fence_expiry.sql` pending, then migration `0014` was
applied and the post-apply listing was empty. The candidate reset receipts are
for this arm only. A first post-reset count observed one cron row arriving
after the reset; the arm was reset again immediately before the public cohort,
and the final cohort receipts are the authoritative sample boundary.

## Cohort result

Percentiles use the instrument's nearest-rank convention. Times are observed
commit-response/read clocks from the raw public receipts, not authored event
timestamps.

| cohort | n | response p50/p95 | unsafe p50/p95 | unsafe >5000 ms | safe p50/p95 | safe <180000 ms |
|---|---:|---:|---:|---:|---:|---:|
| parent `91c36df5` | 10 | 2979 / 4359 ms | 2947 / 3206 ms | 0/10 | 71304 / 123906 ms | 10/10 |
| candidate `d596192f` | 10 | 2829 / 3535 ms | 2878 / 3062 ms | 0/10 | 69065 / 120301 ms | 10/10 |

The candidate response p95 gate passes: `3535 <= 4359 + 150 = 4509 ms`.
The unsafe p95 gate passes: `3062 <= 3206 + 150 = 3356 ms`, with no unsafe
sample over 5000 ms. The amended fence-relative safe target does not pass:
all candidate samples report `SafeWindow=20000 ms`, so the permitted p95 is
`20000 + 10000 = 30000 ms`; candidate safe p95 is `120301 ms`, a miss of
`90301 ms`. All candidate safe observations are nevertheless below 180000 ms.
This is a blocked arm result, not a production authorization; no production
cohort was run.

### Candidate per-sample observed clocks

`fence deadline-from-commit` is the exact selected ledger row's
`stop_deadline_at - commit.receivedAtMs`; `residual scheduling` is
`started_at - scheduled_at`; `pass` is `completed_at - started_at`; and
`catch-up` is `catch_up_completed_at - catch_up_started_at`. For each SUID,
the table selects the last completed row keyed by that exact `delivery_suid`,
preferring a completed `fence-expiry` row. A SUID can occur in multiple
delivery/coalesced rows because the ledger is batch-scoped; this selection is
reported as a durable row join, not asserted as the sole causal explanation
for the public safe-read timestamp. The complete raw ledger remains preserved.

| # | exact SUID | response | unsafe | safe | SafeWindow | safe−SafeWindow | trigger | fence deadline-from-commit | residual scheduling | pass | catch-up | stop reason |
|---:|---|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---|
| 1 | `063924303401363000000733478993` | 3433 | 2809 | 120301 | 20000 | 100301 | fence-expiry | 46086 | 331 | 14701 | 4638 | safe_window_fence |
| 2 | `063924303414009000001717756093` | 2536 | 2855 | 107763 | 20000 | 87763 | fence-expiry | 42951 | 317 | 15653 | 4163 | safe_window_fence |
| 3 | `063924303426861000000188920526` | 2814 | 2878 | 94947 | 20000 | 74947 | fence-expiry | 52990 | 293 | 19584 | 4648 | safe_window_fence |
| 4 | `063924303439546000001231320882` | 2781 | 2947 | 82165 | 20000 | 62165 | fence-expiry | 57873 | 301 | 21730 | 5711 | safe_window_fence |
| 5 | `063924303452535000001508669489` | 3098 | 2952 | 69065 | 20000 | 49065 | delivery | 27108 | 936 | 5764 | 1513 | safe_window_fence |
| 6 | `063924303466085000000150351593` | 3016 | 2747 | 55576 | 20000 | 35576 | fence-expiry | 50735 | 324 | 18545 | 4328 | safe_window_fence |
| 7 | `063924303479017000000317492971` | 2829 | 2878 | 45196 | 20000 | 25196 | delivery | 18453 | 113 | 4083 | 864 | safe_window_fence |
| 8 | `063924303491771000001694545127` | 2782 | 2991 | 49888 | 20000 | 29888 | fence-expiry | 48643 | 274 | 20605 | 4541 | safe_window_fence |
| 9 | `063924303504592000002074552862` | 3535 | 3062 | 74240 | 20000 | 54240 | fence-expiry | 50154 | 263 | 19789 | 4806 | safe_window_fence |
| 10 | `063924303518086000000966797386` | 2863 | 2954 | 61375 | 20000 | 41375 | fence-expiry | — | 277 | 27598 | 10482 | advanced_or_caught_up |

The public safe read times and safe heads are retained in the candidate cohort
JSON; the last sample's safe head is the final cohort SUID. The table above
does not substitute a derived timestamp for the missing deadline on the final
already-caught-up row.

## Durable safe-pass proof

The preserved candidate ledger query selected every row from
`serialized_dcb_safe_lane_passes` for the W155-C service, including trigger,
status, scheduled/started/completed timestamps, coverage kind/reason/partition,
settled frontier, before/after heads, delivery event/SUID/attempt/partition/
obligation identity, catch-up timestamps/outcome/result, stop deadline/reason,
and errors. At the captured final receipt it contains 122 rows:

| trigger kind | rows | status details |
|---|---:|---|
| delivery | 105 | completed and coalesced delivery-owned attempts |
| fence-expiry | 9 | 9 completed; exact deadline/SUID rows present |
| coverage-retry | 3 | 1 completed, 2 failed `CHECKPOINT_AHEAD` retries |
| cron | 5 | 4 completed, 1 still `running` at the receipt snapshot |

Overall status at that receipt was 58 completed, 61 coalesced, 2 failed, and 1
running. The 9 completed `fence-expiry` rows are direct proof that the new
deadline trigger was deployed and executed; this was not an all-Queue cohort.
The rows contain non-null exact delivery SUIDs and, where applicable, delivery
event/attempt/obligation identities, `stop_deadline_at`, `stop_reason`, and
`catch_up_result_json`. The result JSON records the observed dynamic lag bound,
SafeWindow, deferred event SUID/deadline when present, stop reason, and
materialized-view heads before/after. The final fence-expiry row for
`063924303518086000000966797386` completed catch-up and advanced both views;
its stop reason was `advanced_or_caught_up` and its deadline was null because
the frontier was already caught up.

The corrected coverage-history receipt has five `SETTLED` rows. It reached the
candidate final frontier
`063924303518086000000966797386`. The lag-estimate receipt records
`estimate_ms=19271`; the public cohort snapshots report `SafeWindow=20000 ms`.
The final health receipt reports `SETTLED` and the same final frontier. These
are the source facts used for the fence-relative calculation; no SafeWindow or
frontier semantics were changed.

The first safe-pass query shape also attempted to select a nonexistent
`safe_heads_json` column and received SQLite error code 7500. That raw failure
is retained. The corrected schema query above succeeded and is the authoritative
ledger receipt; the error is a query-shape exception, not a Cloudflare auth
failure.

## Receipts and disposition

The raw evidence is retained under
`.g67-w142/.artifacts/sdt-g67-fence-expiry-arm-wake-145-*`, including:

- preflight version, Queue/DLQ, and migration receipts;
- parent deploy retry, version/binding, 100% deployment, migration, reset and
  public cohort receipts;
- candidate migration, deploy, version/binding, 100% deployment, Queue/DLQ,
  reset and public cohort receipts;
- candidate durable pass-ledger, corrected coverage history, lag estimate and
  final health receipts; and
- the initial local bundle-resolution failure and corrected parent deploy.

The arm proof is **blocked** solely because candidate safe p95 is `120301 ms`
against the observed-fence bound of `30000 ms`. Response and unsafe relative
gates, unsafe 5000 ms, all-10-under-180000 ms, self binding, Queue/DLQ
attachment, and fence-expiry ledger presence are evidenced. No production
deployment/reset/cohort was authorized after this miss, and no resource
cleanup was performed. The next decision must address the measured residual
safe-read delay; this receipt does not select or implement a repair.
