# Bootstrap operator lane

The bootstrap routes are `/operator/bootstrap/{serviceId}/{plan|import|status|abort|export}`.
They share `REPAIR_OPERATOR_TOKEN` with `POST /operator/repair`. The binding is
configured only when it contains a non-whitespace character. Exact bytes are
kept, including whitespace around a substantive value. An absent, empty, or
whitespace-only binding returns the generic `404`. A configured request with
no `Authorization` header also returns `404`. A wrong credential returns `403`.
`POST /operator/repair` returns `404` when that binding is unconfigured and
`401` for a missing or wrong configured credential. Any non-POST repair request
returns `404` regardless of the binding. Neither route forwards client headers
or the credential to Durable Objects.

Store the value in a protected file and pass that path to the deployment
wrappers. Do not put the value in source, a Wrangler var, config, CI output,
or an evidence document. `scripts/g22-bootstrap-cli.mjs` reads
`SDT_G22_BEARER_FILE` from that same kind of protected local file.

`plan` sends the canonical dump and explicit fresh-target evidence. `import`
sends the same dump plus its importId/leaseEpoch and performs store admission,
tag import, verification, then READY. `abort` preserves the failed plan for
audit; it never clears target durable state. `export` pages events using the
target allocator's durable lineage and rejects a caller-supplied lineage.
