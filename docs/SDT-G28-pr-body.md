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

## PR #63 review closure (F1–F6)

- F1: eager and late replay share exact `(projector, tag)` eligibility, so a
  stored `order:a` event cannot enter the `order:b` cell.
- F2/F3: boundary gates now have independent CI invocations, selected-gate
  completion attestation, and per-gate forced-red proofs; session fixtures assert canonical tag values across all
  propagation points, stored v1→v2 tags, 2x2 replay, heads, sealing, and
  discard paths.
- F4: `toRuntimeDomain()` adapts authored commands to
  `committed|noop|rejected` and routes through a read-only conflict barrier,
  admission, allocator, commit, and same-candidate reconcile port with G27
  provenance.
- F5/F6: every parse boundary has an exact finding plus downstream-zero oracle,
  including WASM schema bypass and cross-boundary provenance;
  changing-clock retry and DecisionLog identity negatives are runtime and
  pinned-diagnostic compile fixtures.

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
npm run test:g28:boundary:source    PASS
npm run test:g28:boundary:negative  PASS
npm run test:g28:boundary:package   PASS
npm run test:g28                    PASS
npm test                             PASS (37 files / 274 tests)
git diff --check                     PASS
```

The full existing G13–G27 lanes remain in the workflow. The candidate protocol
is non-self-referential: FINAL C' contains implementation/configuration and an
evidence placeholder; bookkeeping R' records the C' SHA/digests and performs the
single retained-list append. No deployment credentials or secrets are part of
the evidence.
