# D1 PipelineStore

The D1 adapter is an explicit opt-in `@sekiban/dcb-runtime/d1` provider. The
default runtime composition remains Postgres and does not require a D1 binding.
The binding is a single database; database splitting or a SUID-range manifest
is intentionally a future phase and is not fixed by this slice.

## Durable schema and atomic writes

`migrations/d1/0001_pipeline_store.sql` is the schema authority. Deployments
apply it with Wrangler's versioned migration workflow; `D1EventStore.initialize`
only verifies the binding and never executes DDL at request time.

D1 `batch()` is a predeclared atomic statement list, not an interactive
transaction. Delivery and pending-path writes therefore use guarded SQL in one
batch. Lineage binding, SUID collision incidents, event identity checks,
arrivals, lag estimates, and pending path unions are all guarded by the same
service/EventId/SUID identity facts. A contradictory identity produces a typed
`D1IdentityConflictError` and the guarded statements leave the durable tables
unchanged. Checkpoint advancement is one conditional statement whose
`meta.changes` result is the CAS decision.

Every persisted SUID column and ordering index declares `COLLATE BINARY`.
SUIDs are opaque bytewise ordinals; they are never parsed as numbers.

## Platform limits

The Cloudflare D1 platform limit is 10 GB per database on paid Workers (500 MB
on the free plan). D1 is single-threaded per database, so the adapter uses one
database and bounded prepared batches rather than attempting cross-database
transactions. Cloudflare documents a 30-second query timeout and a 1,000
statement batch limit on the free tier (10,000 on paid plans); the adapter's
PipelineStore batches are small and fixed, while large operational work must be
chunked by the caller.

Read replication is out of scope. The provider uses the primary binding for
read-after-write consistency, and no public V1 wire or request-header namespace
override is introduced.

## Verification

The required Miniflare lane runs the same shared PipelineStore contract used by
Postgres/Cosmos plus D1-specific fault, collision, lineage, pending-union,
checkpoint-CAS, migration, and BINARY-ordering assertions. It is wired into the
normal CI verify job and fails when the D1 binding or migration is unavailable;
there is no silent skip.
