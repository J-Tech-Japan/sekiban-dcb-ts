# Commit tracing and the SDT-G30 B0 runbook

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
   Before B's warmups begin, it waits until 120 seconds after B's immutable
   Worker Version `createdOn` timestamp. The B ledger records that version,
   the derived deadline, settlement completion, and first measurement time;
   the evidence validator rejects a cohort that began earlier. This is a
   post-deploy Durable Object trace-sampling convergence precondition, not a
   phase-specific Worker setting or a delivery-loss exception.
   If the authenticated fixed-tag point read is not HTTP 200, the measuring
   helper writes a local failure artifact containing the complete conformance
   response body, raw response text, CF-Ray, and the provider-response
   timestamp before exiting fail-closed. It never retains the request tag or
   either credential; do not retry after the temporary conformance token has
   been removed by the run trap.
   A timeout or other non-200 **commit** inside the eligible phase window is
   different: it is an AC7 window-reset event, not an invitation to resend the
   same attempt. The helper retains its redacted response/transport evidence,
   rereads the durable fixed-tag head, moves every provisional successful row
   to `rawAttempts`, and starts a new 100-request window with a new attempt.
   Missing/regressing rereads fail closed; a sixth reset stops with the full
   reset distribution. The resulting evidence never claims whether the
   indeterminate request itself landed merely because the durable head advanced.
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
6. The exporter materializes bounded cohort queries from B's immutable,
   100-request client ledger. It discovers S00 first by provider CF-Ray and,
   when a custom root omits that field, only through the existing
   `worker.invocation` post-admission correlation and an exact
   `correlation.id` → one-traceId query. It then performs each full-trace
   expansion through exactly one traceId (while discovery and observation
   queries remain bounded at ten identities): a four-trace live query reached
   the provider's 2,000-result ceiling although every individual trace was
   below it. It never joins by time proximity or
   assumes a structured console log has a platform trace ID.
   `schemaCompleteCount >= 85` is the frozen operator-authorized delivery budget:
   sixteen losses fail,
   while every permitted loss is enumerated as either `root-absent` or
   `schema-incomplete` UNKNOWN. The exact rank-1..5 tail, sorted by client
   latency descending then request ID ascending, must all be schema-complete.
   Client p50/p95/p99 use the sealed nearest-rank estimator over all 100
   client rows, never the joined subset. Joined per-hop p50/p95 metrics are
   joined-cohort conditional descriptive estimates and retain a missing-stage
   sensitivity envelope. A saturated
   subquery, replacement, unknown/mismatched observation, export after the
   ten-minute deadline, a tail loss, or a schema-complete joined request whose
   caller-union unattributed ratio exceeds 5% fails the run. It retains safe provider span
   names for refresh exclusion, while queue/doorbell lifecycle, idle, and
   activation facts come from the joined observation stream—not an
   operator-supplied boolean or declaration.
   The same Worker observation carries the set of local native span callbacks
   actually entered through S15. The exporter retains a per-request emitted /
   ingested / diff sidecar solely to classify a missing Worker row as emission
   or ingestion. It is never an input to schema completeness, the 85/100
   floor, the tail set, the deadline, or an otherwise successful result.

The live run writes only raw evidence artifacts and the summary evidence.
After it succeeds, make bookkeeping commit R with exactly the evidence files
under `docs/SDT-G30-*evidence*.{json,md}` and one retained-C append in
`.github/workflows/ci.yml`. Any other post-C change needs a new final
candidate and a new B0 acquisition.

## Evidence required for the former 21.5-second class

The B0 validator derives one attributable or excluded result for each
hypothesis: Worker-isolate first invocation, Durable Object wake, token
rotation, and queue/doorbell backpressure. Every raw observation cites a B
request present in both the client ledger and schema-complete joined trace cohort. Worker
facts are cross-checked against the cited root's version and colo. Token
rotation is excluded only when the exporter finds no refresh span on the
joined trace. When a 21.5-second target is observed, the queue/doorbell path
requires bounded `started` → `ended` → `drained` observation events; a
no-target run does not invent a fault claim. No external proof file is copied
or accepted.
