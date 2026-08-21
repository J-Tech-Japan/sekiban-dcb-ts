# SDT-G27 — canonical event identity + allocator OrderClock

Draft implementation for [issue #60](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/60).

## Contract coverage

- Canonical `eventPayloadName:decimalVersion` is assigned at commit admission; names containing `:` are typed rejects and historical definitions remain `:1`.
- Identity and provenance are carried losslessly across TagEvent, durable pending outbox, Queue/direct-doorbell envelope, StoredEvent, and ProjectionEvent. Post-G27 omissions fail closed; only explicit pre-G27 migration/queue lanes may use legacy interpretation.
- Dispatch is registry identity based, including same-name versioned events; payload sniffing is legacy-lane only.
- `OrderClock` is the single allocator clock seam with fixed 32-digit ordinals, watermark floor, transactional vector/watermark writes, fail-before-write, overflow, and rollback-warning oracles.
- Existing G13 HTTP response bytes remain unchanged; D1/Postgres/Cosmos identity fields are additive. G17/G18, G21/G22, and G26 suites remain in the validation graph.
- CI includes the G27 focused lane, forced-red reachability, and non-self-referential retained-candidate evidence gate.

## Oracle and evidence

- Oracle mapping: [`docs/SDT-G27-oracle-map.md`](./SDT-G27-oracle-map.md)
- Evidence: [`docs/SDT-G27-deploy-evidence.json`](./SDT-G27-deploy-evidence.json)
- Candidate protocol is non-self-referential: candidate C contains implementation, tests, config, oracle map, and placeholder evidence; bookkeeping R records C and its tree digests only.
- Local validation is required to stay green: `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:g27`, boundary/consumer suites, provider contracts, G20 gates, and topology preflight.
- Remote deployment evidence is explicitly marked not-run when no deployment credential is available; no secret or endpoint is included in this PR.
