# SDT-G11 deploy verification

This runbook deploys the complete Serialized DCB V1 Worker to the prepared
Cloudflare account and runs the portable HTTP conformance suite against the
deployed URL. It is intentionally secret-free: the Hyperdrive binding holds
the PostgreSQL connection credential, and the operator token is supplied only
through Wrangler's protected secret store or a protected local file.

## Deployment facts

- Worker: `serialized-dcb-v1-runtime`
- Cloudflare account: `3ede2188f4cf39a28e0aa3722d3d02c5`
- Queue: `serialized-dcb-v1-outbox`
- Hyperdrive binding: `HYPERDRIVE`
- Hyperdrive config: `c236b7b51ed24bf4b312bc370c61a231`
- `SDT_SERVICE_ID`: a non-secret Wrangler deployment variable. Local Miniflare
  defaults to `serialized-dcb-v1`; each deployed Worker receives a fresh,
  environment-specific value.
- SafeWindow estimate: dynamic and decaying; published floor `20_000 ms`, ceiling `120_000 ms`

The sample app layer and its scheduled projection poll use the server-side
`SDT_SERVICE_ID` value; public clients cannot select it because app routes do
not read or forward namespace headers. The authenticated conformance and
measurement harnesses separately use a fresh `g11-*` serviceId on every
execution and send it in the deployment-verification header. This is
service-scoped isolation on the shared database, not cleanup or a fabricated
result. Durable Object namespaces are immutable: if one is recreated, deploy a
new serviceId rather than trying to reattach the old identity.
Lag is a current estimate rather than a monotonic high-water mark. It decays
toward the 20-second floor. Recovery/outage backlog is reported as behind-head
state and is excluded from the reordering estimator. If the current estimate
exceeds 120 seconds, tag reads fail closed with Section 6 `internal_error` and
a waiting query returns Section 6 `timeout` HTTP 504.

Hyperdrive query caching is disabled before every conformance or measurement
run. This is required because cached PostgreSQL reads would hide catch-up and
SafeWindow behavior. Confirm the non-secret setting with:

```sh
./node_modules/.bin/wrangler hyperdrive get c236b7b51ed24bf4b312bc370c61a231
```

The result must contain `"caching": { "disabled": true }`.

## First deployment

Wrangler is expected to be authenticated already. Do not run `wrangler login`.
From the repository root:

```sh
npm install
./node_modules/.bin/wrangler whoami
G14_SERVICE_ID="g11-g16-$(uuidgen | tr '[:upper:]' '[:lower:]' | tr -d '-')" npm run deploy:g14
```

The deploy script reasserts disabled Hyperdrive caching and deploys with
`--keep-vars --strict --var SDT_SERVICE_ID:<fresh-value>`. If the protected
operator token has not yet been attached to this Worker, set it interactively
after the first deployment; Wrangler does not echo the value:

```sh
./node_modules/.bin/wrangler secret put REPAIR_OPERATOR_TOKEN \
  --name serialized-dcb-v1-runtime
```

An operator may instead set `G11_OPERATOR_TOKEN_FILE` to a protected local file
when invoking `npm run deploy:g11`; the file is read through stdin and is never
committed or printed. Never put a connection string, password, or token in
`wrangler.jsonc`, source, logs, test output, or PR text. `SDT_SERVICE_ID` is an
identity rather than a secret, but record it only in redacted deployment
metadata where needed.

Record the `workers.dev` URL printed by deploy. The five V1 HTTP endpoints are
the only public conformance surface; Durable Objects, Queue, and Hyperdrive
are configured by `wrangler.jsonc`.

## Conformance and measurement lifecycle

Stage the pinned portable suite at `SekibanWasmRuntime` ref `1b141ed` and run
the two phases against the deployed URL. Reports are JSON and contain request
and response bodies but no credentials:

```sh
mkdir -p .artifacts/sdt-g11
npm run conformance:g11 -- \
  https://<worker>.workers.dev before-restart \
  .artifacts/sdt-g11/conformance-state.json \
  .artifacts/sdt-g11/conformance-before.json

# Deploy the same reviewed revision again to exercise Durable Object restart.
npm run deploy:g11

npm run conformance:g11 -- \
  https://<worker>.workers.dev after-restart \
  .artifacts/sdt-g11/conformance-state.json \
  .artifacts/sdt-g11/conformance-after.json
```

The command must exit zero for both phases. A non-zero result is a failed
deployment verification, not a reason to weaken the fixture or skip scenarios.

Run the load probe after conformance:

```sh
npm run measure:g11 -- \
  --base-url https://<worker>.workers.dev \
  --tags 16 \
  --output .artifacts/sdt-g11/measurements.json
```

The probe records its fresh serviceId, commit latency, tag-state convergence
latency against the dynamic SafeWindow (20-second floor/120-second ceiling),
serialized tag-state payload bytes for each known tag, and the exact probe
event/SUID list. The payload-byte value is a lower bound,
not a claim about SQLite storage overhead.

## Cloudflare metrics capture

The deployment enables Worker observability. Capture the dashboard/GraphQL
window covering the conformance and probe UTC timestamps for:

- `durableObjectsStorageGroups.max.storedBytes` for the Tag namespace;
- `workersInvocationsAdaptive.quantiles.memoryUsageBytesP50` and `memoryUsageBytesP99`
  while the probe has many active tag objects;
- invocation count, duration, and CPU/wall time for the Worker and DOs.

Use a separately protected Cloudflare API token with analytics read scope, and
pass it through `CLOUDFLARE_API_TOKEN` to the measurement operator tooling. Do
not print the token. The committed report records only aggregate numbers,
timestamps, query dataset names, and the redacted probe identifier.

The probe's request count, event rows, and elapsed durations provide the cost
snapshot inputs. Monetary pricing is deliberately not hard-coded; attach the
account billing export or dashboard snapshot to the operator evidence.

## Rollback and teardown

Before any rollback, record the deployed version ID:

```sh
./node_modules/.bin/wrangler deployments list --name serialized-dcb-v1-runtime
./node_modules/.bin/wrangler rollback <version-id>
```

Teardown is an operator action and is not part of conformance. If the whole
temporary Worker is to be removed, use the explicit Worker and queue names:

```sh
./node_modules/.bin/wrangler delete serialized-dcb-v1-runtime
./node_modules/.bin/wrangler queues delete serialized-dcb-v1-outbox
```

Do not delete the prepared Hyperdrive config or the Azure PostgreSQL database;
they are shared prerequisites and remain outside the child implementation
scope.
