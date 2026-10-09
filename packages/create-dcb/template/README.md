# {{PROJECT_NAME}}

This project is a named Cloudflare Worker starter with a deliberately visible
booking demo. It creates rooms, reserves them, cancels reservations, releases
rooms, and exposes both tag-state and list/query reads. The demo is a teaching
surface: see [REPLACE.md](./REPLACE.md) for the exact files to swap when the
application gets its own domain.

## Create and run locally

```sh
npx @sekiban/create-dcb {{PROJECT_NAME}}
cd {{PROJECT_NAME}}
npm install
```

From a checkout of the sekiban-dcb-ts repository, the same starter can be generated with:

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

For incident maintenance, configure the bearer secret with:

```sh
npx wrangler secret put INCIDENT_MAINTAINER_TOKEN
```

Never place the value of `INCIDENT_MAINTAINER_TOKEN` in `wrangler.jsonc`
`vars`. The runtime redacts bearer values and does not return or persist them.

## cf CLI (beta)

Use `npm run migrate` for D1 migrations and `npm run deploy` for the Worker.
Wrangler remains this starter's build and deploy path.

The deliberate `cloudflare.config.ts` guard refuses cf commands run from the
project root when they load this project's config. It does not cover
subdirectories, so never run cf from a subdirectory, especially `public/`, and
never use `cf init <subdir>`.

Do not use `cf deploy` in any form, including `cf deploy --prebuilt`, or use
`cf build`, `cf dev`, `cf init`, or `cf migrate`. Create D1 databases with
`npx wrangler d1 create ...`, or run cf resource commands from outside the
project directory. If cf suggests upgrading Wrangler, that hint is safe to
follow and does not change `npm run deploy`.

`npm run migrate -- --cli cf` is an optional remote-D1 path. It needs real D1
database IDs, and this repository has not run it against a real remote D1.
The `cf migrate` conversion is intentionally deferred: a future conversion
would require a reviewed `migrations_dir`, review of every Durable Object
binding, and replacement of Durable Object migrations with an `exports`
lifecycle. cf is beta; Wrangler remains supported for 18 months after the beta
ends.
