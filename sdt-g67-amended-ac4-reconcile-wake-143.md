# SDT-G67 amended AC4 reconciliation — W143

## Disposition

- Issue: `J-Tech-Japan/sekiban-dcb-ts#129`
- Candidate: `246c4f21eb69c8f8f0f7c1a513e7f915ca7c6d51`
- Arm: `sekiban-dcb-g60-w155-c`
- Preserved source artifact: `.g67-w142/sdt-g67-ac4-event-drive-rerehearsal-wake-142.md`
- Exact candidate cohort: run `62a2b7b9-8d19-47cf-b180-b16689281919`
- Status: **blocked; production AC5 is not authorized**
- Cloudflare/Wrangler/deployment/reset operations in W143: none

The amended issue body was reread from GitHub on 2026-09-06. Its AC4 target
withdraws the absolute 60,000 ms comparison and requires, per sample,

```text
safe first visibility <= observed SafeWindow + 5,000 ms
```

with the SafeWindow defined as the clamped decaying high-water lag estimate
(20,000 ms floor, 120,000 ms ceiling). Delivery-to-applied pass latency must
be reported separately from the fence wait. AC5 remains conditional on the
arm proof and was not authorized after this arm result.

## Accepted preserved arm facts

The exact candidate pass receipt contains 109 rows:

| trigger/status | count |
|---|---:|
| Queue kick / completed | 46 |
| Queue kick / coalesced | 57 |
| cron / completed | 5 |
| cron / failed | 1 |

The 46 completed Queue kicks have owner-attributed event/attempt identities,
completed catch-up boundaries, outcomes, coverage/frontier fields, and safe-head
observations. From the raw pass receipt
`.artifacts/sdt-g67-ac4-event-drive-rerehearsal-candidate-safe-passes-command.txt`:

- delivery-to-applied proxy, defined by the persisted
  `catch_up_started_at -> catch_up_completed_at` interval: `n=46`, p50 `761 ms`,
  p95 `1242 ms`, maximum `1703 ms`;
- the 57 coalesced rows have no catch-up completion fields by design;
- the pass ledger has no deployed `delivery_suid` column, so it cannot provide
  a lossless one-to-one Queue-pass-to-cohort-SUID join. The raw cohort SUIDs and
  raw pass owner identities are retained separately; no join is inferred.

The matched cohort facts remain:

| arm | response p50/p95 | unsafe p50/p95 | unsafe over 5,000 ms | safe p50/p95 | safe under 180,000 ms |
|---|---:|---:|---:|---:|---:|
| parent `868f2fc` | 2,983 / 3,994 ms | 2,940 / 3,173 ms | 0/10 | 78,231 / 125,554 ms | 10/10 |
| candidate `246c4f2` | 2,837 / 3,411 ms | 2,735 / 2,961 ms | 0/10 | 54,262 / **119,133 ms** | 10/10 |

Candidate response p95 improved by 583 ms and unsafe p95 improved by 212 ms
relative to parent. All ten safe observations are below 180 seconds. These
facts are accepted and unchanged; the remaining AC4 decision is the amended
fence-relative p95 gate.

## Lossless per-sample SafeWindow/lag reconciliation

The cohort harness records a health read immediately after each commit, stores
its `safeWindowMs` as `safeWindowAtCommitMs`, and preserves the full health
snapshot including `lag.estimateMs`, `lag.observedAt`, and the read timestamp.
The table below joins each reservation to that exact next health read in the
preserved JSON sequence; it does not derive lag from final MV rows or authored
timestamps.

`postFenceMs` is arithmetic `safeMs - safeWindowMs`. It is reported as the
remaining observed interval beyond the recorded fence, not asserted to be a
single causal mechanism. The amended per-sample gate is `safeMs <= 25,000 ms`.

| # | cohort SUID | commit-time lag estimate | observed SafeWindow | delivery-to-safe | postFenceMs | amended gate |
|---:|---|---:|---:|---:|---:|---|
| 1 | `063924296320387000001576196309` | 7,540 ms | 20,000 ms | 119,133 ms | 99,133 ms | fail |
| 2 | `063924296333500000000595714550` | 12,839 ms | 20,000 ms | 106,047 ms | 86,047 ms | fail |
| 3 | `063924296346424000000658143972` | 11,907 ms | 20,000 ms | 93,096 ms | 73,096 ms | fail |
| 4 | `063924296359766000000485565899` | 12,740 ms | 20,000 ms | 79,683 ms | 59,683 ms | fail |
| 5 | `063924296372408000000151677861` | 6,195 ms | 20,000 ms | 67,148 ms | 47,148 ms | fail |
| 6 | `063924296385259000001514111607` | 12,152 ms | 20,000 ms | 54,262 ms | 34,262 ms | fail |
| 7 | `063924296398081000001328035006` | 5,727 ms | 20,000 ms | 41,409 ms | 21,409 ms | fail |
| 8 | `063924296411029000000016604801` | 12,714 ms | 20,000 ms | 38,159 ms | 18,159 ms | fail |
| 9 | `063924296423741000000800636923` | 12,440 ms | 20,000 ms | 49,394 ms | 29,394 ms | fail |
| 10 | `063924296436335000001248088044` | 11,904 ms | 20,000 ms | 36,769 ms | 16,769 ms | fail |

The raw health reads that supplied these values are preserved in
`.artifacts/sdt-g67-ac4-event-drive-rerehearsal-candidate-cohort.json`; the
harness assignment is visible in
`scripts/deploy/g58-safe-lane-e2e.mjs` where `healthAtCommit.lag.safeWindowMs`
is copied to the reservation. The raw pass receipt separately preserves the
46 completed Queue catch-up intervals above.

## Gate result and boundary

- Required per-sample SafeWindow and lag estimates: **recoverable**.
- Delivery-to-applied pass timing separate from fence-relative sample timing:
  **recoverable in aggregate** from the 46 completed kick rows.
- Candidate safe p95 under amended target: `119,133 ms <= 25,000 ms` — **false**.
- Candidate 10/10 under 180 seconds: **true**.
- Response and unsafe relative gates: **pass**.
- Production C-0 reset/deploy/cohort: **not run** because the arm amended AC4
  p95 gate failed.

This reconciliation does not reinterpret the old 60,000 ms target, does not
change SafeWindow/G44/G62 semantics, and does not infer a cause from the
delivery-to-applied duration. It records that the event-driven pass ran, while
the preserved arm still misses the amended fence-relative p95 target. A future
repair or design ruling is required before production AC5.
