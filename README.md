# Serialized DCB V1 5-endpoint runtime

This repository is the Cloudflare Workers implementation of the Serialized DCB
V1 runtime. The first delivery establishes the TypeScript project and the
per-commit-attempt Journal Durable Object that makes commit coordination
durable.

## Current scope

The Journal is an internal control component, not one of the five public V1
HTTP endpoints. It owns one durable record per commit attempt and provides:

- all-or-nothing admission of candidates, consistency tags, event tags, owner
  epoch `0`, initial state/version, and its first alarm;
- compare-and-swap state transitions, with terminal outcomes immutable and
  their response reconstructed from the durable Journal record;
- owner-epoch handoff before tag seals, plus the seal-and-full-requery absence
  barrier required before terminal failure or partial outcomes;
- a tested reconciliation table for allocator-vector and durable-record
  evidence; and
- alarm rearming with capped exponential backoff before reconciliation, so
  transient failures do not exhaust the platform retry budget.

Allocator, tag Durable Objects, public HTTP endpoints, fencing, repair, and
retention/GC are deliberately outside this first slice.

## Local development

Use Node.js 24 or newer.

```sh
npm install
npm run check
npm run build
```

`npm test` runs Vitest inside the Cloudflare Workers runtime using the
Workers Vitest integration and Miniflare. The suite exercises the Journal
against actual Durable Object storage, including concurrency, takeover, and
alarm behavior. `wrangler.jsonc` declares the Journal binding and SQLite
Durable Object migration; the GitHub Actions workflow runs lint, typecheck,
tests, and a Wrangler dry-run build.

## License

This project is licensed under the Elastic License 2.0 (ELv2). See
[LICENSE](LICENSE) and [NOTICE](NOTICE).
