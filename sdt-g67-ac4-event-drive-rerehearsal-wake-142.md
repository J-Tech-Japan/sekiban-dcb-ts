# SDT-G67 AC4 event-drive rerehearsal — W142

Task: `SDT-G67-AC4-EVENT-DRIVE-REREHEARSAL-WAKE-142`  
Issue: `J-Tech-Japan/sekiban-dcb-ts#129`  
Branch: `claude/sdt-g67-local-wake-w142`  
Source under test: `246c4f21eb69c8f8f0f7c1a513e7f915ca7c6d51`  
Status: **BLOCKED at the isolated W155-C AC4 safe-p95 gate**

## Decision

The true parent `868f2fc63bb02fb2c127e750c1d22516cc0fcff6` and the repaired
candidate `246c4f21eb69c8f8f0f7c1a513e7f915ca7c6d51` were deployed in that
order on the same existing W155-C arm. Each received one fresh cold-first,
10-commit, 10-second-paced cohort. The candidate passed the response and
unsafe relative gates and all 10 safe observations were below 180 seconds,
but candidate safe p95 was **119,133 ms**, above the AC4 arm target of
60,000 ms. The arm failed AC4; the conditional production reset/deploy/cohort
was therefore **not run**. The earlier `6d691275...` cohort remains preserved
as historical failed evidence and is excluded from every current gate.

## Deployment identity and unchanged resources

- Worker: `sekiban-dcb-g60-w155-c`
- URL: `https://sekiban-dcb-g60-w155-c.ttakaoka.workers.dev`
- Pipeline D1: `sekiban-dcb-g60-w155-c-pipeline`,
  `ac751211-fde8-4587-9d56-1e9fd8051bc3`
- MV D1: `sekiban-dcb-g60-w155-c-mv`,
  `2b60dbcf-0912-4bb2-93aa-77c26cd260e1`
- Queue: `sekiban-dcb-g60-w155-c-outbox`
- DLQ: `sekiban-dcb-g60-w155-c-outbox-dlq`
- Queue consumer: `5210df8e9d0540a3a6a5d35d54098003`, script
  `sekiban-dcb-g60-w155-c`, batch size 10, max retries 3, max wait 1000 ms,
  DLQ as above.

The parent deployment was version
`3dddae9f-5102-48c8-9a1b-ae93e3463a7e`, annotated with the exact parent SHA.
The candidate deployment was version
`49af94a4-ac7e-482a-9d81-63948605e0b6`, annotated with the exact candidate
SHA, and was 100% active. Both version views proved:

```text
DIRECT_DOORBELL=true
DIRECT_DOORBELL_RECEIVER_MODE=self
DIRECT_DOORBELL_SELF_BINDING_PROOF=true
DIRECT_DOORBELL_DEGRADATION=queued-degraded
DIRECT_DOORBELL_MAX_INVOCATIONS=32
DOWNSTREAM_DOORBELL=sekiban-dcb-g60-w155-c#MeetingRoomDownstreamDoorbell
D1=ac751211-fde8-4587-9d56-1e9fd8051bc3
D1_MV=2b60dbcf-0912-4bb2-93aa-77c26cd260e1
```

No Cloudflare resource was created or deleted. Every Wrangler invocation used
`env -u` for all five recognized credential variable names:

```text
CLOUDFLARE_API_TOKEN=UNSET
CF_API_TOKEN=UNSET
CLOUDFLARE_API_KEY=UNSET
CF_API_KEY=UNSET
WRANGLER_API_TOKEN=UNSET
```

The existing conformance credential was referenced only by path:
`/private/tmp/sdt-g65-wake141-token.pdPTFB/conformance-token`; its value was
never printed, logged, or committed.

## Migration and clean-reset evidence

Before the candidate migration, the existing pipeline reported only
`0012_g67_safe_lane_pass_ownership.sql` pending; `0011_g67_safe_lane_passes.sql`
was already applied from the earlier arm. The candidate applied `0012`
successfully, and the following migration list reported `No migrations to
apply`. Thus both G67 migrations were confirmed present without applying a
migration to the parent source.

For each cohort, C-0 reset the existing pipeline and MV operational rows. The
post-reset reads showed zero `dcb_events`, global receipts, source partitions,
admission/ring rows, MV rows, unsafe receipts, and unsafe rows. One scheduled
pass row appeared between the candidate reset and the clean-count read; it is
retained and separately classified as cron backstop activity, not attributed
to a commit.

## Matched cohort results

Harness run IDs: parent
`53f2a442-0754-498a-ae0a-4a82ba5ff1a5`; candidate
`62a2b7b9-8d19-47cf-b180-b16689281919`. Both used the same public paced
instrument, cold first sample, 10 accepted reservations, and at least 10,000
ms between commit responses. The harness recorded every sample incrementally.

| arm | response p50/p95 ms | unsafe p50/p95 ms | unsafe >5,000 ms | safe p50/p95 ms | safe <180,000 ms |
|---|---:|---:|---:|---:|---:|
| parent `868f2fc` | 2,983 / 3,994 | 2,940 / 3,173 | 0/10 | 78,231 / 125,554 | 10/10 |
| candidate `246c4f2` | 2,837 / 3,411 | 2,735 / 2,961 | 0/10 | 54,262 / **119,133** | 10/10 |

Gate arithmetic: candidate response p95 delta was `-583 ms` and unsafe p95
delta was `-212 ms`, both within parent plus 150 ms. All candidate unsafe
observations met the unchanged 5,000 ms observation bound. All candidate safe
observations met 180 seconds, but safe p95 missed the stricter 60,000 ms arm
gate by 59,133 ms. No production sample was authorized after that miss.

### Parent sample table

| # | reservation | SUID | response | unsafe | safe | safe head |
|---:|---|---|---:|---:|---:|---|
| 1 | `g58-reservation-53f2a442-075-1` | `063924295868608000000697632441` | 2635 | 3002 | 125554 | `063924295881425000001216302898` |
| 2 | `g58-reservation-53f2a442-075-2` | `063924295881425000001216302898` | 2865 | 2831 | 112687 | `063924295881425000001216302898` |
| 3 | `g58-reservation-53f2a442-075-3` | `063924295895370000000784976438` | 3994 | 2956 | 101200 | `063924295908151000000929962091` |
| 4 | `g58-reservation-53f2a442-075-4` | `063924295908151000000929962091` | 2593 | 3173 | 88607 | `063924295908151000000929962091` |
| 5 | `g58-reservation-53f2a442-075-5` | `063924295920651000000973654889` | 2983 | 2889 | 78231 | `063924295934692000001424222923` |
| 6 | `g58-reservation-53f2a442-075-6` | `063924295934692000001424222923` | 3743 | 3023 | 64486 | `063924295934692000001424222923` |
| 7 | `g58-reservation-53f2a442-075-7` | `063924295947381000000032218876` | 2724 | 2810 | 59102 | `063924295947381000000032218876` |
| 8 | `g58-reservation-53f2a442-075-8` | `063924295961236000002037397998` | 3769 | 3011 | 87347 | `063924295961236000002037397998` |
| 9 | `g58-reservation-53f2a442-075-9` | `063924295975134000000225997854` | 3873 | 2922 | 75842 | `063924295987652000001663699203` |
| 10 | `g58-reservation-53f2a442-075-10` | `063924295987652000001663699203` | 2625 | 2940 | 63214 | `063924295987652000001663699203` |

### Candidate sample table

| # | reservation | SUID | response | unsafe | safe | safe head |
|---:|---|---|---:|---:|---:|---|
| 1 | `g58-reservation-62a2b7b9-8d1-1` | `063924296320387000001576196309` | 3317 | 2641 | 119133 | `063924296398081000001328035006` |
| 2 | `g58-reservation-62a2b7b9-8d1-2` | `063924296333500000000595714550` | 2922 | 2756 | 106047 | `063924296398081000001328035006` |
| 3 | `g58-reservation-62a2b7b9-8d1-3` | `063924296346424000000658143972` | 2620 | 2672 | 93096 | `063924296398081000001328035006` |
| 4 | `g58-reservation-62a2b7b9-8d1-4` | `063924296359766000000485565899` | 3411 | 2741 | 79683 | `063924296398081000001328035006` |
| 5 | `g58-reservation-62a2b7b9-8d1-5` | `063924296372408000000151677861` | 2533 | 2582 | 67148 | `063924296398081000001328035006` |
| 6 | `g58-reservation-62a2b7b9-8d1-6` | `063924296385259000001514111607` | 2837 | 2735 | 54262 | `063924296398081000001328035006` |
| 7 | `g58-reservation-62a2b7b9-8d1-7` | `063924296398081000001328035006` | 2851 | 2627 | 41409 | `063924296398081000001328035006` |
| 8 | `g58-reservation-62a2b7b9-8d1-8` | `063924296411029000000016604801` | 2805 | 2961 | 38159 | `063924296411029000000016604801` |
| 9 | `g58-reservation-62a2b7b9-8d1-9` | `063924296423741000000800636923` | 2591 | 2805 | 49394 | `063924296436335000001248088044` |
| 10 | `g58-reservation-62a2b7b9-8d1-10` | `063924296436335000001248088044` | 2624 | 2743 | 36769 | `063924296436335000001248088044` |

## Durable event-driven pass proof

The parent pass read returned zero rows because the parent source predates the
G67 pass writer; its scheduled history is preserved separately. The candidate
pass query returned 109 rows for the arm window:

| trigger/status | rows |
|---|---:|
| `kick/completed` | 46 |
| `kick/coalesced` | 57 |
| `cron/completed` | 5 |
| `cron/failed` | 1 |

All 46 completed kick rows had a delivery event/attempt owner, a completed
`catch_up_outcome`, non-null catch-up start/end, and observed safe-head JSON.
There were 11 unique delivery event IDs and 11 unique attempt IDs (the setup
event plus the ten cohort commits), 46 completed kick rows with safe-head
observations, and nine whose before/after safe-head JSON changed. Completed
kick catch-up duration was p50 782 ms, p95 1,242 ms, maximum 1,703 ms. This
is direct durable proof that effective Queue-triggered passes ran; it is not a
cron-only cohort. The 57 coalesced rows retain owner identity but correctly
have no catch-up completion fields.

The six persisted coverage ticks were all `SETTLED`: the first had an empty
frontier, then frontiers
`063924296320387000001576196309`,
`063924296385259000001514111607`, and
`063924296436335000001248088044`, with the last frontier repeated twice. The
first cron row was a pre-cohort `CHECKPOINT_AHEAD` failure; five later cron
rows completed as backstop work. These facts are reported separately from the
kick lifecycle. The raw pass receipt contains every row, owner identity,
trigger, lifecycle, coverage/frontier, catch-up timing/outcome, and safe-head
before/after field.

## Read receipts and limitations

The first full pass-ledger read used a read-only D1 file query and returned
Cloudflare API code `10000`; it was not a cohort or deployment failure. The
exact receipt is `...candidate-safe-passes.txt`. Under the standing read-only
retry policy, attempt 1 after approximately five seconds succeeded at
`2026-09-06T13:02:28Z` but returned only the import summary. Attempt 2 after
approximately twenty seconds used the equivalent read-only SQL command at
`2026-09-06T13:03:21Z` and returned all 109 rows. No failed write was retried.
The initial history query's `reason` column typo is also retained; the
corrected `coverage_reason` query succeeded and is the authoritative history
receipt.

All raw deployment, version, binding, queue, migration, reset, clean-count,
cohort, pass-ledger, and history receipts are under
`.artifacts/sdt-g67-ac4-event-drive-rerehearsal-*`. The complete cohort JSON
files are preserved losslessly. No claim is made that the 119,133 ms safe
tail is caused by the 782–1,242 ms kick catch-up duration; the evidence proves
the effective kick and records the remaining safe-lane distribution without
inventing a further cause.

No production D1 reset, production deployment, or production cohort was run.
No PR/review/merge/closeout action was performed. The next decision requires
an in-scope AC4 repair or design ruling; no further cohort was run in this
window.
