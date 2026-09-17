# Getting started: Cloudflare meeting-room sample

This is the canonical Cloudflare Workers sample for **sekiban-dcb-ts**.

It consumes workspace packages (`@sekiban/dcb-core`, `@sekiban/dcb-domain`,
`@sekiban/dcb-client`, and private `@sekiban/dcb-runtime`). Domain authoring
lives in `src/domain.ts`; Durable Object classes are re-exported from the
Worker entry because Cloudflare requires DO classes in the Worker module graph.

Public npm today: `@sekiban/dcb-{core,domain,client}@0.2.0`.
`@sekiban/dcb-runtime` stays private / workspace-linked (required for DO export).

## Prerequisites

- Node.js 24+
- Logged-in Wrangler (`npx wrangler login`)
- Repo root: `npm install`

## 1. Apply both remote D1 migrations (mandatory)

Skipping migrations after a tip deploy causes `FirstAdmissionAttemptId` /
schema-drift failures on reserve.

From the **repository root**:

```sh
CI=true npx wrangler d1 migrations apply sekiban-dcb-meeting-room-cloudflare-pipeline \
  --config samples/meeting-room/wrangler.cloudflare-only.jsonc --remote

CI=true npx wrangler d1 migrations apply sekiban-dcb-meeting-room-cloudflare-mv \
  --config samples/meeting-room/wrangler.cloudflare-only.jsonc --remote
```

Or:

```sh
./samples/meeting-room/scripts/migrate-remote.sh
```

## 2. Deploy

```sh
npx wrangler deploy --config samples/meeting-room/wrangler.cloudflare-only.jsonc --keep-vars
```

Note the printed `*.workers.dev` URL.

## 3. Smoke (create → reserve → read)

Use fresh IDs (or reset first — see below):

```sh
BASE=https://sekiban-dcb-meeting-room-cloudflare-only.<your-subdomain>.workers.dev
ROOM=demo-room-001
RES=demo-res-001

curl -sS -X POST "$BASE/api/commands/create-room" \
  -H 'content-type: application/json' -H 'accept: application/json' \
  -d "{\"input\":{\"roomId\":\"$ROOM\",\"name\":\"Demo\"},\"executor\":{\"snapshots\":[],\"readMode\":\"read-through\"}}"

curl -sS -X POST "$BASE/api/commands/reserve-room" \
  -H 'content-type: application/json' -H 'accept: application/json' \
  -d "{\"input\":{\"roomId\":\"$ROOM\",\"reservationId\":\"$RES\",\"userId\":\"u1\"},\"executor\":{\"snapshots\":[],\"readMode\":\"read-through\"}}"

curl -sS "$BASE/api/read/room?roomId=$ROOM"
curl -sS "$BASE/api/read/reservation?reservationId=$RES"
```

Open `$BASE/` for the HTML UI. Prefer new IDs after any server wipe; a hard
reload also clears in-tab portable snapshots.

## Operator notes (live lessons)

### Migrations

Always migrate **both** `D1` (pipeline) and `D1_MV` before trusting a new tip.
Symptom of skip: missing columns such as `FirstAdmissionAttemptId`, flaky
multi-tag reserves.

### G65 `partial_write` (first-touch registration)

Cold multi-tag reserve historically returned `kind: partial` /
`code: partial_write` with `writtenTags=[room:…]` and
`missingTags=[reservation:…]` when source-partition registration competed for
the shared 300 ms doorbell/admission budget.

SDT-G98 gives first-append registration its own
`G65_SOURCE_REGISTRATION_BUDGET_MS` (1500 ms) while doorbell/admission stay at
`G65_DERIVED_WRITE_BUDGET_MS = 300`. Sample mitigations remain useful under
load:

- Use a **new** `reservationId` (do not blind-retry the same attempt id).
- Prefer create-room success first, then reserve with fresh ids.

### Clean slate (C-0) + `SDT_SERVICE_ID`

To reuse short demo IDs after verify seed / conflicts:

1. Wipe / rotate the durable namespace as your operator C-0 procedure requires.
2. Change the non-secret Wrangler var `SDT_SERVICE_ID` (e.g. append `-rYYYYMMDD`)
   and redeploy with `--keep-vars` only if you intentionally preserve other vars;
   otherwise set the new service id in the dashboard / vars and deploy.
3. **Hard-reload** the browser tab (or close it). In-memory `portableSnapshots`
   survive a server wipe until reload; SDT-G97 reconciles occupied snapshots
   against `/api/read` before create/reserve so a stale tab should not invent
   `reservation_exists`, but reload remains the safest reset.

## Package boundary

| Package | npm | Sample dependency |
|---------|-----|-------------------|
| `@sekiban/dcb-core` | `0.2.0` | workspace `file:` (same version) |
| `@sekiban/dcb-domain` | `0.2.0` | via domain authoring / client |
| `@sekiban/dcb-client` | `0.2.0` | workspace `file:` |
| `@sekiban/dcb-runtime` | **private** | workspace `file:` (DO re-export) |

The sample must not copy package `src` trees. Sample-local files are domain,
Worker composition, and UI only.
