# Deployment guide

This guide is written for this generated project. It describes the future
Cloudflare steps; generating the project and running its offline check create
no remote resources and perform no live deployment.

## 1. Safety boundary and prerequisites

Use Node.js 20 or newer, npm, and the project-local Wrangler installed by
`npm install`. Keep database IDs and credentials out of committed files.
Database IDs belong only in the two configured `database_id` fields below;
secrets belong in Wrangler's secret facility, never in `vars`.

The offline check removes Cloudflare credential variables, checks this guide
against `deployment-topology.json` and `wrangler.jsonc`, and then performs a
project-local Wrangler deploy dry-run. It does not log in, create resources,
apply remote migrations, deploy, call smoke endpoints, or tear anything down.

## 2. Declared deployment topology

`deployment-topology.json` is the data authority. This table is a checked view
of that authority, and `wrangler.jsonc` is its deployed configuration form.

<!-- deployment-topology:begin -->
| Kind | Binding or key | Declared value |
| --- | --- | --- |
| worker | {{WORKER_NAME}} | src/worker.ts |
| d1 | D1 | {{PIPELINE_DB}};migrations/d1/g32 |
| d1 | D1_MV | {{MV_DB}};migrations/mv |
| queue-producer | DOWNSTREAM_QUEUE | {{QUEUE_NAME}} |
| queue-consumer | {{QUEUE_NAME}} | 1;3;{{DLQ_NAME}} |
| durable-object | ALLOCATOR | AllocatorDurableObject |
| durable-object | BOOTSTRAP | BootstrapCoordinatorDurableObject |
| durable-object | JOURNAL | JournalDurableObject |
| durable-object | TAG | TagDurableObject |
| durable-object | TAG_STATE | TagStateDurableObject |
| durable-migration | v1 | AllocatorDurableObject,JournalDurableObject,TagDurableObject |
| durable-migration | v2 | BootstrapCoordinatorDurableObject |
| durable-migration | v3 | TagStateDurableObject |
| assets | directory | public |
| cron | * * * * * |  |
| var | DOMAIN_DELIVERY_CLASS | immediate-preferred |
| var | SDT_SERVICE_ID | {{SERVICE_ID}} |
<!-- deployment-topology:end -->

Assets are served from the `public` directory, so the optional `ASSETS` runtime
property is unused and is not a Wrangler binding. The optional incident-
maintenance secret is runtime-owned and is listed by name
in the authority; its value is never part of this project configuration.

## 3. Install and run the offline check

From this project directory:

```sh
npm install
npm run deploy:check
```

A fresh project reports both expected placeholders before the dry-run:

```text
D1 at d1_databases[binding=D1].database_id: {{PIPELINE_DB}}
D1_MV at d1_databases[binding=D1_MV].database_id: {{MV_DB}}
```

The JSON receipt contains the two placeholder locations, migration file
counts, topology keys, booking bundle markers, and the credential names
removed from the child process. It never prints a configured database ID.

## 4. Future live resource creation

After a maintainer has approved a live setup, run these four commands from this
directory and keep each returned resource name and ID for the matching fields:

```sh
npx wrangler d1 create {{PIPELINE_DB}}
npx wrangler d1 create {{MV_DB}}
npx wrangler queues create {{QUEUE_NAME}}
npx wrangler queues create {{DLQ_NAME}}
```

The ID returned by the first D1 command replaces
`d1_databases[binding=D1].database_id`. The ID returned by the second replaces
`d1_databases[binding=D1_MV].database_id`. Queue names are already rendered in
the producer, consumer, and dead-letter target declarations.

## 5. Replace IDs and run the configured gate

Edit only the two `database_id` values in `wrangler.jsonc`, then run:

```sh
npm run deploy:check -- --require-configured
```

The configured check still removes credentials and performs only the offline
project-local Wrangler dry-run. It rejects either placeholder and malformed
IDs before Wrangler starts.

## 6. Apply both remote D1 migration domains

Run both checked-in migration domains with the helper before the first upload:

```sh
npm run migrate
```

The helper applies `migrations/d1/g32` to `D1` and `migrations/mv` to `D1_MV`.
It re-checks and applies both domains before upload when the deployment helper
is used.

## 7. Deploy with checked-in vars authoritative

After the configured gate and both migration domains succeed, the normal
deployment command is:

```sh
npm run deploy
```

There is intentionally no `--keep-vars` in the normal command. The checked-in
`DOMAIN_DELIVERY_CLASS` and `SDT_SERVICE_ID` values are authoritative, so a
normal deployment removes dashboard-only vars before setting these values.
Wrangler does not delete secrets. Put secrets in Wrangler's secret facility;
preserving dashboard-only vars with `--keep-vars` is an exceptional, reviewed
choice outside this runbook.

## 8. Future smoke flow

Against the URL of a future deployed Worker, create a fresh room with a fresh
room ID, reserve it with a fresh reservation ID, then read both resources:

```sh
curl -fsS -X POST "$BASE_URL/api/commands/create-room" \
  -H 'content-type: application/json' \
  -d '{"roomId":"room-smoke-<fresh>","name":"Smoke room"}'
curl -fsS -X POST "$BASE_URL/api/commands/reserve-room" \
  -H 'content-type: application/json' \
  -d '{"roomId":"room-smoke-<fresh>","reservationId":"reservation-smoke-<fresh>"}'
curl -fsS "$BASE_URL/api/read/room?roomId=room-smoke-<fresh>"
curl -fsS "$BASE_URL/api/read/reservation?reservationId=reservation-smoke-<fresh>"
```

Require successful HTTP responses. Compare the returned room and reservation
IDs, the committed command outcome, and the visible room/reservation fields
after materialized-view catch-up. The command routes take the input object
directly; the alternative `{ "input": { ... } }` envelope is also accepted by
the generated Worker. Do not replace `$BASE_URL` with a hosted domain in this
document.

## 9. Optional incident-maintenance secret

Only if incident maintenance is intentionally enabled, set the secret through
Wrangler:

```sh
npx wrangler secret put INCIDENT_MAINTAINER_TOKEN
```

Do not add the secret name or value to `vars`, and do not commit its value.

## 10. Retention and reverse-order teardown

Before teardown, retain or export anything that must be kept. If deletion is
chosen, remove resources in this order:

```sh
npx wrangler delete --name {{WORKER_NAME}}
npx wrangler queues delete {{QUEUE_NAME}}
npx wrangler queues delete {{DLQ_NAME}}
npx wrangler d1 delete {{PIPELINE_DB}}
npx wrangler d1 delete {{MV_DB}}
```

These commands are future-only and must be run in the same order: Worker,
work Queue, dead-letter Queue, pipeline D1, then materialized-view D1.

Deleting the Worker removes its assets, triggers, secrets, and owned Durable
Object namespaces and data. Resource deletion is irreversible. Decide on
retention before beginning this sequence.

## Future witnessed execution

A maintainer may later record the configured dry-run, both migration results,
deployment result, create/reserve/read result, declared-versus-live topology
comparison, and the chosen retention or teardown outcome. This PR records none
of those live facts.
