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

Follow [DEPLOYMENT.md](./DEPLOYMENT.md) for the complete standalone topology,
the offline `npm run deploy:check` gate, future resource creation, migrations,
deployment, smoke, and teardown. The gate and the starter create no live
resources.

```sh
npx wrangler d1 create {{PIPELINE_DB}}
npx wrangler d1 create {{MV_DB}}
npm run migrate
npm run deploy
```

The optional incident-maintenance secret setup is documented in the
[DEPLOYMENT.md secret section](./DEPLOYMENT.md#9-optional-incident-maintenance-secret).

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

## Experimental Cosmos descriptor

This starter includes `cosmos.experimental.json`, a generated read-only
descriptor of the experimental Cosmos layout and symbolic bindings. Its
`active` value is `false`; the descriptor does not activate Cosmos. The active
worker and `wrangler.jsonc` continue to use D1. To adopt Cosmos, change the
Worker source explicitly, import the public `/cosmos` factory, and configure
`COSMOS_ENDPOINT` and `COSMOS_DATABASE` as deployment values plus
`COSMOS_KEY` with `wrangler secret put COSMOS_KEY`.
