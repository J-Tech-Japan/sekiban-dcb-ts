# {{PROJECT_NAME}}

This project is a named Cloudflare Worker starter with a deliberately visible
booking demo. It creates rooms, reserves them, cancels reservations, releases
rooms, and exposes both tag-state and list/query reads. The demo is a teaching
surface: see [REPLACE.md](./REPLACE.md) for the exact files to swap when the
application gets its own domain.

## Create and run locally

After `@sekiban/create-dcb` is published:

```sh
npx @sekiban/create-dcb {{PROJECT_NAME}}
cd {{PROJECT_NAME}}
npm install
```

While developing this repository before publish, use:

```sh
node packages/create-dcb/bin/create-dcb.mjs {{PROJECT_NAME}}
```

## Cloudflare setup

Create two D1 databases for this project, then replace the two
`database_id` placeholders in `wrangler.jsonc` with the IDs Cloudflare gives
you. The database names, queue name, and dead-letter queue name are already
derived from this project name. No live resources are created by the starter
or by its proof check.

```sh
npx wrangler d1 create {{PIPELINE_DB}}
npx wrangler d1 create {{MV_DB}}
```

After filling in both IDs and authenticating Wrangler, the project-local SQL
can be applied and the Worker deployed through the helper:

```sh
npm run migrate
npm run deploy
```

The same commands are available as `scripts/migrate.sh` and
`scripts/deploy.sh`. Both use only this project's `wrangler.jsonc`.

The Worker needs a non-secret `SDT_SERVICE_ID` (already present in the
generated config) and the normal Cloudflare Queue/D1/ Durable Object bindings.
Set any operator-only secrets with Wrangler secrets rather than committing
them to this file.
