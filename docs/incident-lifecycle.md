# Completeness incident lifecycle

This maintenance surface tracks human follow-up for rows in
`serialized_dcb_completeness_findings`. The finding remains the scanner's
observation authority. Lifecycle actions do not replay work, apply a repair,
change completeness health, or change the original command result.

## State graph

```text
OPEN --------ACKNOWLEDGE--------> ACKNOWLEDGED
REOPENED ----ACKNOWLEDGE--------> ACKNOWLEDGED
ACKNOWLEDGED--RECORD_CORRECTION-> CORRECTION_RECORDED
ACKNOWLEDGED--CLOSE accepted----> CLOSED
CORRECTION_RECORDED--CLOSE------> CLOSED
CLOSED-------REOPEN-------------> REOPENED

UPDATE_ASSIGNMENT: ACKNOWLEDGED -> ACKNOWLEDGED
                   CORRECTION_RECORDED -> CORRECTION_RECORDED
```

Rows created before lifecycle support are read as implicit `OPEN`, version 0,
with no owner or deadline. Acknowledge and reopen require a non-empty owner
and a deadline in the future. Every action requires a reason. Correction
evidence must be an exact `{kind, reference, digest}` object where `kind` is
`event` or `receipt`, and `digest` is lowercase `sha256:` followed by 64 hex
characters. A receipt is evidence only; it is not opened or validated here.

Closure requires an owner and deadline plus exactly one resolution. `CORRECTED`
is available after correction evidence. `ACCEPTED_AS_IS` is available directly
from `ACKNOWLEDGED` and requires its own explanation. Reopen retains every
audit row, clears correction and close data in the current projection, and
requires a new acknowledgement before correction or closure.

## Authentication and requests

The direct runtime routes are:

```text
GET  /maintenance/incidents
GET  /maintenance/incidents/{encodeURIComponent(incidentIdentity)}
POST /maintenance/incidents/transitions
```

The generated starter mounts the same routes below
`/internal/sekiban`. Configure the bearer secret with:

```sh
npx wrangler secret put INCIDENT_MAINTAINER_TOKEN
```

Never put that value in `wrangler.jsonc` `vars`. Authentication is checked
before service identity resolution, storage access, query parsing, or body
parsing. The bearer is never stored, returned, or logged. Writes also require
the bounded `x-sdt-maintainer` header; this stable actor identity is stored in
the audit row and is part of the request digest.

Example list request:

```sh
curl -H 'Authorization: Bearer <token>' \
  'https://example.invalid/maintenance/incidents?unowned=true&overdue=true'
```

Example response:

```json
{"items":[],"summary":{"total":0,"byState":{"OPEN":0,"ACKNOWLEDGED":0,"CORRECTION_RECORDED":0,"CLOSED":0,"REOPENED":0},"unowned":0,"overdue":0,"observedAfterClose":0}}
```

Example accepted-as-is transition:

```sh
curl -X POST \
  -H 'Authorization: Bearer <token>' \
  -H 'x-sdt-maintainer: maintainer-a' \
  -H 'content-type: application/json' \
  --data '{"action":"CLOSE","incidentIdentity":"<identity>","transitionKey":"close-1","expectedVersion":1,"reason":"Reviewed source evidence","resolution":{"kind":"ACCEPTED_AS_IS","explanation":"The source is intentionally unavailable."}}' \
  https://example.invalid/maintenance/incidents/transitions
```

An event correction can use
`{"kind":"event","reference":"event:<id>","digest":"sha256:<64 lowercase hex characters>"}`.
A provider receipt can use
`{"kind":"receipt","reference":"contracts/postgres-tag-rebuild.json:<receipt-id>","digest":"sha256:<64 lowercase hex characters>"}`.

## Filters and audit behavior

List filters are `state`, `owner`, `unowned=true`, `overdue=true`, and
`observedAfterClose=true`. Filters run before summary counts are calculated.
Overdue applies only to active states and means the deadline is earlier than
the server time. Results are deterministic, with overdue and unowned work
first. `observedAfterClose` means `last_observed_at` is strictly later than the
close transition time. A rediscovery in the same millisecond cannot be
distinguished by these timestamps and therefore is not flagged.

Every transition is retained in sequence order. A transition key, normalized
action, and normalized actor form the canonical digest; the bearer does not.
The same key, content, and actor returns the original result without another
audit row. A changed actor or payload returns `incident_idempotency_conflict`.
A new key with an old version returns `incident_version_conflict`.

Closing a lifecycle row neither repairs source data nor changes scanner health,
source obligations, tag membership, a partial response, or a `partial_write`
fence. Scanner rediscovery updates only the finding observation and never
reopens lifecycle state automatically.
