# Cloudflare CLI guidance

Use `npm run migrate` for D1 migrations and `npm run deploy` for the Worker.
Wrangler remains this starter's build and deploy path.

Keep `deployment-topology.json`, `DEPLOYMENT.md`, `scripts/deploy-check.mjs`,
`wrangler.jsonc`, and both migration directories as deployment infrastructure
when replacing the booking application.

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
