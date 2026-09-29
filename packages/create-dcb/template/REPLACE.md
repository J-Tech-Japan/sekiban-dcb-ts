# Replace the booking demo

The files below are the complete removable demo boundary. Delete or replace
them together when introducing the application's domain; keep the Worker
shell and infrastructure listed afterwards.

## Delete or replace

- `src/booking-domain.ts` — room/reservation commands, events, projectors, and queries.
- `src/booking-transport.ts` — the command and query transport map.
- `src/booking-mv.ts` — the two demo materializers and Queue delivery views.
- `src/booking-routes.ts` — demo HTTP command/read routes.
- `public/index.html` — demo form markup.
- `public/app.js` — demo command/read client.
- `public/styles.css` — demo presentation.

If the replacement changes the public route shape, update only the application
route calls in `src/worker.ts`; the runtime composition and infrastructure
bindings do not need to change.

## Keep

- `src/worker.ts` — the Worker shell and Durable Object re-exports.
- `wrangler.jsonc` — Worker, D1, Queue, dead-letter queue, and Durable Object configuration.
- `migrations/d1/g32/` and `migrations/mv/` — the project-local migration SQL.
- `scripts/migrate.sh` and `scripts/deploy.sh` — helper-backed lifecycle commands.
- `package.json` — the published dependency versions and helper scripts.
- `cloudflare.config.ts` — deliberate cf CLI guard; do not edit or complete it.
- `public/.assetsignore` — keeps stray cf config files out of Worker assets.
- `AGENTS.md` — operational guidance for this starter.

The replacement domain must continue to provide the runtime domain/config
values consumed by `src/worker.ts`, or the Worker shell can be adjusted at
that single composition seam.
