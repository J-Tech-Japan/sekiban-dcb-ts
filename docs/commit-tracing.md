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

Activation IDs are constructor-local observations. They are never stored in a
Durable Object, used as a control input, or returned through a public route.
Idle evidence is collected from an external complete-trace ledger at exactly
2 s, 15 s, and 180 s; elapsed time alone never assigns a reactivation cause.
Each idle observation names a B request that exists in both the client ledger
and exported trace cohort. Its `activationFirst`, `scriptVersion`, and `colo`
must exactly equal the matching S00 root attributes; a declaration alone is
not evidence.

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
3. Prepare file-fed inputs for the live run: an observability query payload,
   an observability API-token file, an activation/idle proof, and four
   independently evidenced outlier records. Keep all credentials out of
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
   after each primary deployment and `g30-deployment-witness.mjs` requires one
   exact immutable Worker Version message containing the source candidate and
   configuration digest, while the witness records the service and placement
   observation. No G30 route,
   header, body field, or runtime variable is added for this purpose.
6. The trace exporter joins B's complete traces to the independent client
   ledger by the S00 ray/request identifier. It rejects missing traces,
   replacements, incomplete schema rows, an export after the 10-minute
   deadline, or any accepted request whose caller-union unattributed ratio is
   above 5%. It also retains only safe provider span names per B trace, so
   refresh exclusion is calculated from the exported trace cohort rather than
   an operator-supplied boolean.

The live run writes only raw evidence artifacts and the summary evidence.
After it succeeds, make bookkeeping commit R with exactly the evidence files
under `docs/SDT-G30-*evidence*.{json,md}` and one retained-C append in
`.github/workflows/ci.yml`. Any other post-C change needs a new final
candidate and a new B0 acquisition.

## Evidence required for the former 21.5-second class

The B0 validator requires one independently attributable or excluded record
for each hypothesis: Worker-isolate first invocation, Durable Object wake,
token rotation, and queue/doorbell backpressure. Every raw record cites a B
request present in both the ledger and trace cohort. Worker-isolate values are
cross-checked against the cited root's version and colo. Token rotation is
excluded only when the exporter finds no refresh span on any B trace; an
operator cannot supply `refreshSpanPresent`. Queue/doorbell remains a
fault-barrier exclusion probe and its bound is calculated from the cited
ledger/root timings, never from an operator-supplied `withinBound` flag. The
runbook validates these joins before it copies any supplied raw evidence under
`docs/`.
