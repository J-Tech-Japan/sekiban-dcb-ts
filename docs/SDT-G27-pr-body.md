# SDT-G27 — canonical event identity + allocator OrderClock

Draft implementation for [issue #60](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/60).

Closes #60

## Contract coverage

- Canonical `eventPayloadName:decimalVersion` is assigned at commit admission from the registered domain event definition; the public V1 candidate cannot select a version. Names containing `:` and a caller-supplied `eventPayloadVersion` are typed rejects, while historical definitions remain `:1`.
- The rereview oracle carries mutually distinct canonical key, parseable EventId (`DifferentIdentity:1`), and SUID values through the resolver, DeliveryCore admission, and StoredEvent callback; deriving the canonical key from EventId or SUID fails the focused lane.
- Identity and provenance are carried losslessly across TagEvent, durable pending outbox, Queue/direct-doorbell envelope, StoredEvent, and ProjectionEvent. Post-G27 omissions fail closed; Tag `/append` accepts an identity-less row only with an explicit immutable pre-G27 migration marker, and queue/import legacy lanes remain provenance-proven.
- Dispatch is registry identity based, including same-name versioned events; payload sniffing is legacy-lane only.
- The real `composeRuntime` path selects the `Order:2` handler for an identity-bearing event even when the payload discriminator says `Order:1`; a sniff-first mutation is forced red.
- `OrderClock` is the single allocator clock seam with fixed 32-digit ordinals, watermark floor, transactional vector/watermark writes, fail-before-write, overflow, stable-window rollback warning rate limiting, and warning-transport-failure oracles through the real allocator DO.
- The real allocator DO seed oracle uses watermark 100 with injected tick 6 and requires SUID 101, so dropping `seedAfter`'s watermark is attributable and red.
- Existing G13 HTTP response bytes remain unchanged; actual Tag pending-outbox bytes compare against committed `test/fixtures/g13-pre-g27-outbox.json` bytes with only `eventType`/`provenance` allowed, and real D1 schema is checked against the immutable pre-G27 migration. D1/Postgres/Cosmos direct canonical-key-only divergence raises the common typed fail-before-write error with zero side effect; the D1 direct fixture also spies on `beforeBatch` and requires zero batch start, and G17/G18, G21/G22, and G26 suites remain in the validation graph.
- CI includes the G27 focused lane, forced-red reachability, and non-self-referential retained-candidate evidence gate.

## Oracle and evidence

- Oracle mapping: [`docs/SDT-G27-oracle-map.md`](./SDT-G27-oracle-map.md)
- Evidence: [`docs/SDT-G27-deploy-evidence.json`](./SDT-G27-deploy-evidence.json)
- Candidate protocol is non-self-referential: candidate C''' contains implementation, tests, config, oracle map, and placeholder evidence; bookkeeping R''' records C''' and its tree digests only.
- Local validation is required to stay green: `npm run lint`, `npm run typecheck`, `npm test` (36 files / 255 tests), `npm run test:g27` (17 tests), `npm run test:d1`, `npm run test:g22` (7 tests), boundary/consumer suites, provider contracts, G20 gates, and topology preflight. The F1 EventId-derivation and F6 D1 guard-bypass mutations are both expected-red.
- Remote deployment evidence is explicitly marked not-run when no deployment credential is available; no secret or endpoint is included in this PR.
