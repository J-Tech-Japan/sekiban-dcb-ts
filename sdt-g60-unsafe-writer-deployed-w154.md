# SDT-G60 unsafe-writer deployed proof — W154

## Result

**Status: blocked.** The only actual W154 Cloudflare write, applying the already
committed `0008_g60_unsafe_writer_boundaries.sql` migration to the existing
pipeline D1, returned Cloudflare API code `7403`. I ran exactly one same-family
D1 read-only classifier, which succeeded, and stopped as required. No reset,
deployment, cohort, or second write was attempted.

This is an authorization/service-boundary checkpoint, not a product result.
W154 therefore cannot claim the `<= 5,000 ms` contract, independent unsafe
application under `BLOCK`, or a deployed dominant hop.

## Checkpoint and target

- Task: `SDT-G60-UNSAFE-WRITER-DEPLOYED-W154` / issue #113
- Branch: `claude/sdt-g60-clean-preg53-ab-w124`
- Requested exact source: `31ca80dbbde5b7537ebb804e62cd14c30bfe5bcf`
- Branch tip before this evidence checkpoint: `19f996bc4e6a1e8f800e5dcadd3ed31fcda2d938`
- The product tree at that tip matches the requested repair source; the
  difference from `31ca80d` was the W153 report-only history.
- Wrangler config: `samples/meeting-room/wrangler.cloudflare-only.jsonc`
- Existing Worker: `sekiban-dcb-meeting-room-cloudflare-only`
- Existing pipeline binding: `D1`
- Existing materialized-view binding: `D1_MV`
- Existing resources only were targeted; no resource-create command was run.

## Wrangler hygiene

Before the remote window, the required five environment variable names were
recorded as follows (names and state only):

```text
CLOUDFLARE_API_TOKEN UNSET
CF_API_TOKEN UNSET
CLOUDFLARE_API_KEY UNSET
CF_API_KEY UNSET
WRANGLER_API_TOKEN UNSET
```

Wrangler was `4.125.0`. The outer helper invocation and every spawned Wrangler
child removed all five names with `env -u`; no `--keep-vars` was used. No
secret, conformance credential, or observability credential was read or
printed.

## Write and classifier receipts

The helper preserved the exact config, binding, table inventory, command
arguments, timestamps, exit codes, stdout, stderr, and stop state. The first
helper invocation failed locally during Wrangler argument validation because
this installed Wrangler does not accept `--yes` for `d1 migrations apply`; it
did not reach the Cloudflare API. That was the single plainly local syntax
correction. Its exact receipt is:

```text
.artifacts/sdt-g60-w154-migration-reset.json
sha256 9b964bd4c7012c216dde3aad75a9537a0dedf2f7cd0c73d21b2ae15a4186745e
```

The corrected migration write was run once, at `2026-09-04T13:33:14.396Z`:

```text
wrangler d1 migrations apply D1 --remote --config \
  /Users/tomohisa/dev/GitHub/SekibanDcbTsImplementation/.g60-w124/samples/meeting-room/wrangler.cloudflare-only.jsonc
```

It exited `1`. Cloudflare addressed the request to the existing account and
pipeline database, and returned:

```text
A request to the Cloudflare API (/accounts/3ede2188f4cf39a28e0aa3722d3d02c5/d1/database/f26d1299-82d9-4a64-8647-bc2ec86326ac/query) failed.
The given account is not valid or is not authorized to access this service [code: 7403]
```

The complete write stdout/stderr and exact resource/config target are in:

```text
.artifacts/sdt-g60-w154-migration-reset-retry.json
sha256 bec1278359c9d4a0bbff2dbc100c4765627fa97a6cf5f34636f1282b078e7bf9
```

After that authorization failure, the one and only classifier was this
same-family D1 read-only query against the same `D1` binding and config:

```text
wrangler d1 execute D1 --remote --json --yes --config \
  /Users/tomohisa/dev/GitHub/SekibanDcbTsImplementation/.g60-w124/samples/meeting-room/wrangler.cloudflare-only.jsonc \
  --command "SELECT 1 AS authorization_probe"
```

It exited `0` with empty stderr and this result:

```json
[
  {
    "results": [{"authorization_probe": 1}],
    "success": true,
    "meta": {
      "served_by": "v3-prod",
      "served_by_region": "WNAM",
      "served_by_colo": "SJC",
      "served_by_primary": true,
      "timings": {"sql_duration_ms": 0.1915},
      "duration": 0.1915,
      "changes": 0,
      "last_row_id": 72,
      "changed_db": false,
      "size_after": 499712,
      "rows_read": 0,
      "rows_written": 0,
      "total_attempts": 1
    }
  }
]
```

The classifier is preserved verbatim in the retry receipt, including its
empty stderr and `changes: 0`/`rows_written: 0` metadata. It was a generic
same-family read-only D1 execute classifier, not `d1 migrations list`; no
second probe is permitted or claimed. Its success shows that this read-only
query path was available, but does not establish that the migrations service
write is authorized.

The helper and its command receipts are also preserved in:

```text
.artifacts/sdt-g60-w154-migration-reset.mjs
sha256 4a24d8e52eed4a136b770ab258b9d5dcc37ca3b0498f587fea8159dc67a2ba73
```

## State and evidence boundary

Because migration application stopped before any reset step:

- `0008_g60_unsafe_writer_boundaries.sql` was not confirmed applied.
- No operational row was deleted and no clean pre-run count exists for W154.
- No schema, migration history, Worker version, traffic allocation, Queue, or
  DLQ state was changed by W154.
- No public reservation was created and no cohort receipt exists.
- No seven-hop, post-admission, unsafe-writer-boundary, MV unsafe receipt/row,
  or first-public-read query was run.
- No W154 deployed source/version annotation exists.

The failed migration request is preserved as an unsuccessful attempt; there is
no known successful production mutation. W153's pushed local unsafe-writer
repair, its red/green guard receipts, and all prior W124–W153 raw evidence
remain preserved and were not discarded.

The exact migration-reset helper recorded the full intended pipeline and MV
table inventories, including `serialized_dcb_unsafe_writer_boundaries`, and
would have deleted rows without dropping schema, queues, or DLQ. It did not
reach those reset commands after the migration failure.

## Disposition

W154 is blocked on operator resolution of the existing-account D1 migration
write authorization/service condition. Per the single-classifier rule, no
further Wrangler write, read probe, deployment, reset, or cohort will be made
in this continuation. The next continuation may resume only after that
condition is resolved and must independently prove the new table, clean
counts, exact `31ca80d` deployment identity, independent unsafe apply during
`BLOCK`, safe-lane fence preservation, and the unchanged `<= 5,000 ms`
contract. Final SDT-G60 evidence consolidation and PR work remain undone.
