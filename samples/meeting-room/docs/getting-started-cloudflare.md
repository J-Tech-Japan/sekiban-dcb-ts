# Getting started: Cloudflare meeting-room sample

This sample shows one way to consume **sekiban-dcb-ts**. It is not the only
application. Callers who already have a Worker mount Sekiban storage beside
their own routes with `@sekiban/dcb-cloudflare`, passing their own wrangler
config. That helper is published on npm as `@sekiban/dcb-cloudflare`, and this
sample links the workspace copy while developing in this repository.

Domain authoring lives in `src/domain.ts`. Durable Object classes are
re-exported from the Worker entry because Cloudflare requires them in the
Worker module graph.

## Three consume paths

| Path | What it installs | When |
|---|---|---|
| Workspace | this repo's `packages/` via npm workspaces | developing in this repository |
| Packed tip | `./scripts/deploy/npm-consumer-deploy.sh` (`npm pack` of the current commit) | tip Cloudflare speed/latency deploys |
| Registry | `@sekiban/dcb-{core,domain,client,runtime}@0.2.0` from registry.npmjs.org | `npm run test:sample:registry-consumer` dry-run. This does not deploy the live sample worker |

In-repo `npm ci` workspace-links the sample. Do not treat that as a registry install.

## Prerequisites

- Node.js 24+
- Logged-in Wrangler (`npx wrangler login`)
- Repo root: `npm install`

## 1. Create resources and configure IDs

From the repository root, create the two remote D1 databases used by the
Cloudflare-only sample:

```sh
npx wrangler d1 create sekiban-dcb-meeting-room-cloudflare-pipeline
npx wrangler d1 create sekiban-dcb-meeting-room-cloudflare-mv
```

Replace `REPLACE_WITH_CLOUDFLARE_ONLY_PIPELINE_D1_ID` and
`REPLACE_WITH_CLOUDFLARE_ONLY_MV_D1_ID` in
`samples/meeting-room/wrangler.cloudflare-only.jsonc` with the returned IDs
before migrating or deploying.

The alternative Postgres sample also needs a Hyperdrive config. Create one
with the connection string for the Postgres database and replace
`REPLACE_WITH_SAMPLE_HYPERDRIVE_ID` in `samples/meeting-room/wrangler.jsonc`
with the returned ID:

```sh
npx wrangler hyperdrive create sekiban-dcb-meeting-room --connection-string "<your PostgreSQL connection string>"
```

## 2. Apply both remote D1 migrations (mandatory)

Skipping migrations after a tip deploy causes `FirstAdmissionAttemptId` /
schema-drift failures on reserve.

From the **repository root**, after the helper is built (`npm run build -w @sekiban/dcb-cloudflare`):

```sh
./samples/meeting-room/scripts/migrate-remote.sh
```

That script calls `dcb-cloudflare migrate --config samples/meeting-room/wrangler.cloudflare-only.jsonc`. The config, database names, and Worker name stay in the sample. Another application passes its own wrangler file to the same CLI.

## 3. Deploy

```sh
./samples/meeting-room/scripts/deploy.sh
```

Add `--keep-vars` only when you intend to preserve existing vars. The helper does not add it unless you pass it. `scripts/deploy/cloudflare-only-deploy.sh` performs the Cloudflare-only migration and deployment workflow.

Note the printed `*.workers.dev` URL.

The packed-tip path remains:

```sh
./scripts/deploy/npm-consumer-deploy.sh
```

Dry-run packing/install only: `G99_DRY_RUN=1 ./scripts/deploy/npm-consumer-deploy.sh`.

## 4. Smoke (create → reserve → read)

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

### `partial_write` (first-touch registration)

Cold multi-tag reserve historically returned `kind: partial` /
`code: partial_write` with `writtenTags=[room:…]` and
`missingTags=[reservation:…]` when source-partition registration competed for
the shared 300 ms doorbell/admission budget.

First-append registration has its own
`G65_SOURCE_REGISTRATION_BUDGET_MS` (1500 ms) while doorbell/admission stay at
`G65_DERIVED_WRITE_BUDGET_MS = 300`. Sample mitigations remain useful under
load:

- Use a **new** `reservationId` (do not blind-retry the same attempt id).
- Prefer create-room success first, then reserve with fresh ids.

### Clean slate (C-0) + `SDT_SERVICE_ID`

To reuse short demo IDs after verify seed / conflicts:

1. Wipe / rotate the durable namespace as your operator C-0 procedure requires.
2. Change `vars.SDT_SERVICE_ID` in
   `wrangler.cloudflare-only.jsonc` (e.g. append `-rYYYYMMDD`) and deploy with
   the checked-in value. Add `--keep-vars` only for the reviewed exception of
   intentionally preserving other dashboard-only vars; otherwise the normal
   deployment removes dashboard-only vars before applying checked-in values.
3. **Hard-reload** the browser tab (or close it). In-memory `portableSnapshots`
   survive a server wipe until reload; the browser reconciles occupied snapshots
   against `/api/read` before create/reserve so a stale tab should not invent
   `reservation_exists`, but reload remains the safest reset.

## Package boundary

| Package | npm | Sample dependency |
|---------|-----|-------------------|
| `@sekiban/dcb-core` | `0.2.0` | workspace link while developing in this repo |
| `@sekiban/dcb-domain` | `0.2.0` | via domain authoring / client |
| `@sekiban/dcb-client` | `0.2.0` | workspace link while developing in this repo |
| `@sekiban/dcb-runtime` | `0.2.0` | workspace link while developing in this repo |
| `@sekiban/dcb-cloudflare` | `0.1.2` | workspace link while developing in this repo; composition helper, not the application |

The sample must not copy package `src` trees. Sample-local files are domain,
Worker composition, and UI only.
