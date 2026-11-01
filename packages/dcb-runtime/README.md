# @sekiban/dcb-runtime

Cloudflare Durable Object and HTTP runtime for Serialized DCB V1.

This package is the matched-set runtime companion to `@sekiban/dcb-core`,
`@sekiban/dcb-domain`, and `@sekiban/dcb-client`. Consumers such as the
meeting-room Cloudflare sample import public entry points (`@sekiban/dcb-runtime`,
`@sekiban/dcb-runtime/cloudflare`, `/d1`, `/d1-mv`, `/mv`, and the experimental `/cosmos`) and re-export
Durable Object classes from their Worker module graph as Cloudflare requires.

The experimental Cosmos provider is never selected by environment values. A
consumer must import `createCosmosStoreProvider` from `/cosmos` and pass it as
`createRuntimeWorker({ storeProvider })`.

## Query parameters

Metadata-only queries keep the existing parameter guard. A scalar query accepts
only a parsed empty object. A list query accepts only `PageNumber`, `PageSize`,
`NewestFirst`, and `consistency`. Any other parsed scalar value, and any
unknown list key, is HTTP 400 `query_params_unsupported` with the message
"The selected query does not support these parameters." That check runs after
JSON parsing and endpoint matching and before projector lookup or a store read.

An executable query compiled by the domain bridge runs on the server through
the same raw V1 routes. List controls are removed before domain params are
decoded. `RuntimeWorkerConfig.maxScanRows` bounds the raw scan. Omission uses
1000. Accepted values are positive safe integers from 1 through 10000. A
request body cannot raise that bound. Success envelopes stay
`{ resultJson }` for a scalar query and the existing list page fields for a
list query.

Public executable failures use fixed messages and do not echo params, rows,
handler text, or causes:

- 400 `query_params_invalid` — The query parameters are invalid.
- 422 `query_scan_limit_exceeded` — The query scan limit was exceeded.
- 500 `query_row_invalid` — The query projection contains an invalid row.
- 500 `query_result_invalid` — The query handler returned an invalid result.
- 500 `query_handler_failed` — The query handler failed.
- 503 `projection_unavailable` — The mapped query projection is unavailable

There is no typed client overload yet. Release hardening and the `0.3.0`
version bump are later changes.

## Configured bearer checks

`checkConfiguredBearer(request, binding, options?)` is exported from
`@sekiban/dcb-runtime` and `@sekiban/dcb-runtime/cloudflare`. `binding` is
`unknown`. The result is `"unconfigured" | "missing" | "invalid" | "authorized"`.
Callers choose the HTTP status. A binding is configured only when it is a
string containing a non-whitespace character. The default normalization keeps
the original bytes. `{ tokenNormalization: "trim" }` is the only other mode
and is reserved for incident maintenance, which already trimmed its token.

The helper hashes the complete expected `Bearer ` credential and the complete
supplied `Authorization` header with global WebCrypto SHA-256, then compares
every digest byte. It does not use Node crypto. Scheme spelling and case are
exact. Treat `unconfigured` as disabled on every exposed shared-secret route.
Do not compare a blank binding as if it were a credential.

## License

Elastic License 2.0. See [LICENSE](./LICENSE).
