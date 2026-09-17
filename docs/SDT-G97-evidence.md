# SDT-G97 evidence

Canonical Cloudflare getting-started for `samples/meeting-room`.

## AC1 / AC2 — docs + mandatory migrate

- Added `samples/meeting-room/docs/getting-started-cloudflare.md`
- Linked from `samples/meeting-room/README.md` and repo `README.md`
- Helper: `samples/meeting-room/scripts/migrate-remote.sh`

Remote migrate (2026-09-17):

```
Applying pipeline D1 migrations (remote)… ✅ No migrations to apply!
Applying MV D1 migrations (remote)… ✅ No migrations to apply!
Both remote D1 migrations applied.
```

Deploy (`wrangler.cloudflare-only.jsonc --keep-vars`):

```
https://sekiban-dcb-meeting-room-cloudflare-only.ttakaoka.workers.dev
Current Version ID: 3cf86886-8dfa-43fe-9b0b-8ca3cdebc50c
Uploaded static assets: /ui-model.js /app.js
```

## AC3 — stale portable snapshot fix

UI reconciles occupied in-memory snapshots against `/api/read` before
`create-room` / `reserve-room` (and again after conflict/partial). Pure logic
in `samples/meeting-room/public/ui-model.js`.

### Unit oracle

```
npx vitest run --config vitest.config.ts test/g97-portable-snapshots.spec.ts
Test Files  1 passed (1)
Tests  4 passed (4)
```

### Live before / after (server empty reservation id)

**BEFORE** — client sends `exists:true` reserved snapshot while server is empty → `reservation_exists`:

```json
{"error":"reservation already exists","code":"reservation_exists","kind":"rejected","attempts":1,"rejectKind":"conflict","details":"reservation_exists"}
```

**AFTER** — same id with empty reservation snapshot (reconcile outcome) + refreshed room head → `committed`:

```json
{"kind":"committed","attempts":1,"status":200,...,"value":{"roomId":"g97r20260917061735","reservationId":"stale-exists-demo3"}}
```

## AC4 — smoke create → reserve → read

IDs: `room=g97r20260917061735`, `reservation=g97x20260917061735`

| Step | Result |
|------|--------|
| create-room | `kind: committed` |
| reserve-room | `kind: committed` |
| read room | `status: created`, head present |
| read reservation | `status: reserved`, head present |

## AC5 — scope fence

- No second sample tree
- No npm publish of `@sekiban/dcb-runtime` / `@sekiban/cloud-client`
- No G65 / SafeWindow / G67 budget edits

## npm package status (operator note)

| Package | Registry |
|---------|----------|
| `@sekiban/dcb-core` | `0.2.0` |
| `@sekiban/dcb-domain` | `0.2.0` |
| `@sekiban/dcb-client` | `0.2.0` |
| `@sekiban/dcb-runtime` | **private** (workspace `file:` — DO re-export) |

Sample domain/UI/Worker composition only; does not vendor package `src`.
