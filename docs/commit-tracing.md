# Commit tracing and current verification

SDT-G30 observes the existing serialized-commit path. It does not change a
request body, response body, header, Journal transition, bootstrap admission,
placement setting, or delivery behaviour. The commit-trace authority is
owned and verified in this repository: the normative documents, curated
reasons, generator, generated contracts, and checkers are listed in the
repository-owned bundle at `contracts/commit-trace-bundle.json`.

The human contract is [the commit-trace normative document](../contracts/commit-trace-normative.md).
The bootstrap contract is maintained separately in
[`contracts/bootstrap-import-normative.md`](../contracts/bootstrap-import-normative.md).

## Repository-owned authority and resealing

Commit A contains every final authority byte and the exact unsealed placeholder
at `contracts/commit-trace-pin.json`. After A is immutable, the generator's
seal command writes commit A and the bundle digest into the pin; commit S
changes only that pin. The verifier requires a full clone and checks the A/S
topology. After S, do not amend or rebase; merge the branch with a merge commit
so both seal commits remain in the history. The verifier rejects any later pin
change or authority drift. Any later authority change requires a new A followed
by a new S.

## What the runtime emits

The primary request emits `sdt.commit/v1` rows through the callback boundaries
named by `contracts/commit-trace-manifest.json`. Durable Object callback
boundaries emit the remote `S16` universe, allocator finalization emits `S09`,
and operator repair uses the separate `sdt.commit.repair/v1` root. The
repository exports a reconcile-root wrapper for the manifest's
`sdt.commit.reconcile/v1` schema, but the current Journal alarm handler only
clears alarms and does not emit reconcile rows. Cloudflare's active
async tracing context owns parentage; no parent identifier is put on an
internal request.

The trace verifier is observation-only. It checks row shape, typed attributes,
parent containment, clock domains, boundary sets, and the per-request caller
coverage union. A tracing/export failure cannot change a commit result or a
durable outcome.

`sdt.observe/v1` is a distinct structured Workers Logs event stream. It does
not add a span row or attribute to `sdt.commit/v1`. Worker events record the
isolate ID, the provider ingress CF-Ray, and the already-existing
post-admission correlation alongside activation/version/colo facts; Durable
Object events record constructor-to-handler, first-storage, actual subrequest
timings, their provider request ID, and the existing attempt correlation when
identity is available. Actual structured-log metadata carries provider request
identity but does not duplicate version/colo. The exporter therefore resolves
each observation to the same S00 root by its exact provider request and
correlation; it requires the root's version/colo facts, and checks the Worker
event's overlapping values against them, rather than inventing a second
propagation channel.
All events declare `storageWrites: 0`, `usedForControl: false`, and
`exposedInPublicResponse: false`; they are never persisted or used to choose a
commit branch.

Activation IDs are constructor-local observations. Idle evidence is collected
from the client ledger, schema-complete joined B trace cohort, and this raw observation
stream at exactly 2 s, 15 s, and 180 s. Each interval explicitly names both
the preceding and following request IDs. Overlapping `activationFirst`,
`scriptVersion`, and `colo` must exactly equal the joined S00 root. A human
declaration, elapsed time alone, or an unjoined log is not evidence.

## Current verification

The current sample configuration is the sole G30 configuration surface. Run
`npm run test:g30` to check its observability settings, trace sampling,
log persistence, and placement guard, together with the retained trace
mutation checks. The check is current-only: it does not require a historical
deployment, live endpoint, or external evidence bundle.

The commit-trace authority remains repository-owned and is checked with:

```sh
node scripts/commit-trace-contract.mjs --check
```

The verifier is observation-only. It checks row shape, typed attributes,
parent containment, clock domains, boundary sets, and caller coverage. A
tracing or export failure cannot change a commit result or durable outcome.
