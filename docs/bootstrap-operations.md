# Bootstrap operator lane

The operator endpoint is `/operator/bootstrap/{serviceId}/{plan|import|status|abort}`.
It is bearer-protected with the deployment's existing operator secret; the raw
serialized V1 endpoints remain unchanged. Missing credentials receive `404` and
wrong credentials receive `403`, without forwarding client headers to Durable
Objects. Use `scripts/g22-bootstrap-cli.mjs` with `SDT_G22_BEARER_FILE` pointing
to protected local operator storage. Never put a bearer value in source, config,
CI output, or an evidence document.

`plan` sends the canonical dump and explicit fresh-target evidence. `import`
sends the same dump plus its importId/leaseEpoch and performs store admission,
tag import, verification, then READY. `abort` preserves the failed plan for
audit; it never clears target durable state.
