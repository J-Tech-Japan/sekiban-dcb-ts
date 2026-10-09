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

For incident maintenance, configure the bearer secret with:

```sh
npx wrangler secret put INCIDENT_MAINTAINER_TOKEN
```

Never place the value of `INCIDENT_MAINTAINER_TOKEN` in `wrangler.jsonc`
`vars`. The runtime redacts bearer values and does not return or persist them.

## Experimental Cosmos descriptor

This starter includes `cosmos.experimental.json`, a generated read-only
descriptor of the experimental Cosmos layout and symbolic bindings. Its
`active` value is `false`; the descriptor does not activate Cosmos. The active
worker and `wrangler.jsonc` continue to use D1. To adopt Cosmos, change the
Worker source explicitly, import the public `/cosmos` factory, and configure
`COSMOS_ENDPOINT` and `COSMOS_DATABASE` as deployment values plus
`COSMOS_KEY` with `wrangler secret put COSMOS_KEY`.
