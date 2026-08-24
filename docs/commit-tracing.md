# Commit tracing and the SDT-G30 B0 runbook

SDT-G30 observes the existing serialized-commit path. It does not change a
request body, response body, header, Journal transition, bootstrap admission,
placement setting, or delivery behaviour. The committed host bundle in
`contracts/commit-trace-bundle.json` is the schema authority; target code only
validates its mirrored bytes.

## What the runtime emits

The primary request emits `sdt.commit/v1` rows through the callback boundaries
named by `contracts/commit-trace-manifest.json`. Durable Object callback
boundaries emit the remote `S16` universe, allocator finalization emits `S09`,
and Journal alarms and operator repair use their separate
`sdt.commit.reconcile/v1` and `sdt.commit.repair/v1` roots. Cloudflare's active
async tracing context owns parentage; no parent identifier is put on an
internal request.

The trace verifier is observation-only. It checks row shape, typed attributes,
parent containment, clock domains, boundary sets, and the per-request caller
coverage union. A tracing/export failure cannot change a commit result or a
durable outcome.

`sdt.observe/v1` is a distinct structured Workers Logs event stream. It does
not add a span row or attribute to `sdt.commit/v1`. Worker events record the
isolate ID and overlapping activation/version/colo facts; Durable Object
events record constructor-to-handler, first-storage, and actual subrequest
timings. The exporter reads the DO event's provider-owned version/colo metadata
and checks it against S00, rather than adding an internal propagation header.
All events declare `storageWrites: 0`, `usedForControl: false`, and
`exposedInPublicResponse: false`; they are never persisted or used to choose a
commit branch.

Activation IDs are constructor-local observations. Idle evidence is collected
from the client ledger, complete B trace cohort, and this raw observation
stream at exactly 2 s, 15 s, and 180 s. Each interval explicitly names both
the preceding and following request IDs. Overlapping `activationFirst`,
`scriptVersion`, and `colo` must exactly equal the joined S00 root. A human
declaration, elapsed time alone, or an unjoined log is not evidence.

## Repeating B0

Use B0 only to attribute time. It is not a G37 optimization denominator and
does not assert a performance pass/fail.

1. Finish every runtime, configuration, test, documentation, tool, and
   manifest change. Run `npm run test:g30` and the project CI suite. Do not
   seal a candidate while a material change remains.
2. Seal final candidate C once. Check it out cleanly and set
   `G30_SOURCE_COMMIT` to C. The dry run is:

   ```sh
   npm run deploy:g30:b0
   ```

   It verifies the target bundle, candidate material coverage, trace and B0
   mutation lanes, both Worker dry deployments, and remote D1 migration
   emptiness before any live change.
3. Prepare the file-fed conformance and observability API-token files. The
   checked-in query template is materialized from the actual B ledger; do not
   supply activation/idle/outlier assertion files. Keep all credentials out of
   command arguments, logs, and evidence.
4. Run with `G30_B0_LIVE=1` and the required file paths. The runbook rotates
   only the conformance token through a temporary file, deploys receiver once,
   then performs primary A(off), B(on), and A-prime(off) on the existing G32
   service ID. It retains a 100-request, fixed-payload, fixed-tag,
   single-client-region, single-concurrency ledger per phase at a 2-second
   cadence.
5. The phase is an external runbook/evidence label. It is never sent through
   deployed Worker variables. The only phase configuration difference is the
   selected `observability.traces.head_sampling_rate` (0, 1, 0) and the
   resulting deployment identity. `wrangler versions list --json` is captured
   immediately before and after each primary deployment;
   `g30-deployment-witness.mjs` requires exactly one matching immutable Worker
   Version absent from the pre-deploy snapshot. This makes a same-C rerun bind
   its newly deployed version rather than a stale identical message, while the
   witness records the source candidate, configuration digest, service, and
   placement observation. No G30 route,
   header, body field, or runtime variable is added for this purpose.
6. The exporter materializes a bounded raw-events query from B's client
   ledger, paginates it, and joins complete traces plus `sdt.observe/v1` logs
   by the platform S00 ray/request identity. It rejects missing traces,
   replacements, incomplete schema rows, unknown/mismatched observations, an
   export after the 10-minute deadline, or any accepted request whose
   caller-union unattributed ratio is above 5%. It retains safe provider span
   names for refresh exclusion, while queue/doorbell lifecycle, idle, and
   activation facts come from the joined observation stream—not an
   operator-supplied boolean or declaration.

The live run writes only raw evidence artifacts and the summary evidence.
After it succeeds, make bookkeeping commit R with exactly the evidence files
under `docs/SDT-G30-*evidence*.{json,md}` and one retained-C append in
`.github/workflows/ci.yml`. Any other post-C change needs a new final
candidate and a new B0 acquisition.

## Evidence required for the former 21.5-second class

The B0 validator derives one attributable or excluded result for each
hypothesis: Worker-isolate first invocation, Durable Object wake, token
rotation, and queue/doorbell backpressure. Every raw observation cites a B
request present in both the client ledger and complete trace cohort. Worker
facts are cross-checked against the cited root's version and colo. Token
rotation is excluded only when the exporter finds no refresh span on the
joined trace. When a 21.5-second target is observed, the queue/doorbell path
requires bounded `started` → `ended` → `drained` observation events; a
no-target run does not invent a fault claim. No external proof file is copied
or accepted.
