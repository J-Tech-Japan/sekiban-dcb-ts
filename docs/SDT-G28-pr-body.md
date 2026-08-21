# SDT-G28: `@sekiban/dcb-domain` authoring layer

Closes #62

## Summary

This draft PR adds the runtime-free, schema-first DCB domain authoring layer:

- `event()` / `eventUnion()` with mandatory Zod schemas, explicit tag derivation,
  branded `EventOf`, and canonical `name:version` identity.
- Zod discriminated state unions, pure validate/evolve helpers, projector
  handler/source registration, compile-time tag-family binding, and runtime
  domain identity checks.
- `command()` with declared read sets and the narrow async context
  (`state`, `exists`, `now`, `append`). `append` owns tag derivation and advances
  eligible in-session cells.
- `Session` lifecycle and portable contracts: coherent per-tag snapshots,
  staged-log replay, fixed executor-captured now, fresh conflict retry, atomic
  done envelope, and discard-on-none/reject/throw.
- `toRuntimeDomain()` bridge for the existing runtime, preserving the V1 wire
  and canonical registry behavior; no old API removal.
- Five fail-closed parse boundaries, WASM restore decoder, and the pure
  `@sekiban/dcb-domain/testing` given/when/then and evolve-table kit.
- Dedicated package dependency/import/global/npm-pack gates and compile-fail
  fixtures, all wired into CI with forced-red reachability checks.

## Verification

The candidate evidence and oracle map are in:

- `docs/SDT-G28-oracle-map.md`
- `docs/SDT-G28-deploy-evidence.json`
- `packages/dcb-domain/README.md`

Local validation before candidate bookkeeping:

```text
npm run lint                         PASS
npm run typecheck                    PASS
npm run test:g28:compile-fail       PASS
npm run test:g28:boundaries         PASS
npm run test:g28                    PASS
npm test                             PASS
git diff --check                     PASS
```

The full existing G13–G27 lanes remain in the workflow. The candidate protocol
is non-self-referential: FINAL C contains implementation/configuration and an
evidence placeholder; bookkeeping R records C's SHA/digests and performs the
single retained-list append. No deployment credentials or secrets are part of
the evidence.
