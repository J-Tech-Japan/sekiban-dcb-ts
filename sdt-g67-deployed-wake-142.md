# SDT-G67 deployed W142 — blocked arm checkpoint

Status: **BLOCKED** at the isolated W155-C arm gate. No production sample was
run because the candidate failed the arm response-p95 and safe-p95 criteria.

## Exact sources and deployment identities

- Pre-change baseline: `868f2fc63bb02fb2c127e750c1d22516cc0fcff6`, the
  full-range parent of the G67 change (`git merge-base` with `origin/main`).
- G67 feature commit: `f5b2212ad90cdf5c760ff4f43b8a3ef8f7a8954f`. This is
  **not** the baseline; it is the immediate parent of the evidence checkpoint.
- Candidate: `8e8f13d9cb14d547193dc642d9038e5b80d7444a`.
- Correct parent version/deployment: `5961d52f-4627-4498-978a-687ad13b3f5f` /
  `3b114dd3-65b9-41d8-a271-c4641296a61f`.
- Candidate version/deployment: `9d2f26f2-77f1-403a-a90e-7b0808b72640` /
  `643ef61d-3955-421b-883b-305330f35568`.

Both valid version views were 100% active and proved the normal W155-C
configuration: `DIRECT_DOORBELL=true`, self receiver mode/proof,
`DOWNSTREAM_DOORBELL=sekiban-dcb-g60-w155-c:MeetingRoomDownstreamDoorbell`,
pipeline D1 `ac751211-fde8-4587-9d56-1e9fd8051bc3`, MV D1
`2b60dbcf-0912-4bb2-93aa-77c26cd260e1`, Queue
`sekiban-dcb-g60-w155-c-outbox`, and DLQ
`sekiban-dcb-g60-w155-c-outbox-dlq`.

An initial deployment of `f5b2212` was made before the baseline correction and
was discarded without reset or cohort use. Its identity-only receipt is
retained: version `2ac59226-1c50-425e-9a7f-122c2cc330fa`, deployment
`aea63906-cd3c-488c-9e18-3743147eb7dd`. It is not included in any metric.

All five Wrangler credential variable names were unset for remote operations;
the conformance credential was passed only by the existing path
`/private/tmp/sdt-g65-wake141-token.pdPTFB/conformance-token`. No resource was
created or deleted.

## Fresh arm protocol and results

The parent run was `7de42032-6a7e-4e87-8db9-054c141b6cfa`; the candidate run
was `3147d381-f03e-4596-8a01-874b14544f43`. Both were cold-first, paced at
least 10 seconds after each preceding response, with 10 accepted reservations.
The pipeline and MV rows were reset before each cohort; corrected count
receipts show zero operational event/ledger/MV rows while retaining the two MV
instances and generations.

| arm | response p50/p95 | unsafe p50/p95 | unsafe over 5,000 ms | safe p50/p95 | safe under 180,000 ms |
|---|---:|---:|---:|---:|---:|
| parent `868f2fc` | 2,606 / 2,866 ms | 2,806 / 2,949 ms | 0/10 | 79,085 / 117,404 ms | 10/10 |
| candidate `8e8f13d` | 2,585 / 3,072 ms | 2,783 / 2,944 ms | 0/10 | 67,269 / 117,661 ms | 10/10 |

The candidate response p95 increased by **206 ms** (`3,072 - 2,866`), exceeding
the allowed +150 ms. Candidate safe p95 was **117,661 ms**, above the 60,000 ms
arm target, although all ten samples were safe within 180,000 ms. Candidate
unsafe p95 improved by 5 ms and all ten were within the unchanged 5,000 ms
contract. The arm gate therefore failed and production was correctly not
touched.

Per-commit observed tables, exact SUID/event identities, Queue boundaries,
direct ring/apply rows, safe history, MV receipts/rows, and health snapshots
are in `docs/SDT-G67-evidence.md` and the raw files listed below. In both
cohorts all ten reservation ring rows were `rung` and all ten direct apply
rows were `applied`. Later Queue replay ended in `duplicate-race`; the MV
receipt/row read showed 11 unsafe receipts (room plus ten reservations), zero
unsafe rows, and 11 MV rows. This proves the observed idempotent replay/no
regression behavior without converting the failed arm latency gates into a
pass.

## Safe-pass trigger provenance

The candidate source schedules the event-driven safe-lane kick after stored
Queue delivery; the parent predates that hook and uses the cron backstop. The
deployed health/history contract, however, persists only `tick_id=scheduled:*`
coverage rows and has no durable per-pass trigger field. Accordingly, each
candidate row is recorded as **kick requested; winning trigger not persisted**
and each parent row as **cron/backstop**. The persisted tick rows are all
`SETTLED` with null reason/partition tag; parent retained six scheduled rows,
candidate retained four. Their exact tick IDs/frontiers are in the committed
evidence doc and raw cohort/history receipts. No trigger was inferred from a
materialized-view head.

## Receipts and boundary

Raw receipts are retained under `.artifacts/sdt-g67-w142-arm-*`, including
both deployment/version views, reset/count receipts, cohort JSON/logs, the
seven-hop and sub-hop ledger reads, unsafe-writer rows, safe history/health,
and MV reads. Three initial read-only MV-table queries were pointed at the
pipeline D1 and returned local SQLite `7500 no such table`; they changed no
state. The corrected same-table reads against the MV D1 succeeded and are
retained with `-mv` filenames. This was not a Cloudflare authorization
failure and no write was retried.

W142 stops here. AC4/AC5 production proof, PR work, and downstream units remain
unstarted. No source/configuration change was made by this deployed
measurement continuation; only the deployed evidence document and receipts
were added.
