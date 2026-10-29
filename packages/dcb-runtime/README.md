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

A scalar query accepts only a parsed empty object. A list query accepts only
`PageNumber`, `PageSize`, `NewestFirst`, and `consistency`. Any other parsed
scalar value, and any unknown list key, is HTTP 400 `query_params_unsupported`
with the message "The selected query does not support these parameters." The
check runs after JSON parsing and endpoint matching and before projector
lookup or a store read, on every backing. The V1 response envelope is
unchanged. Typed query handlers are planned for `0.3.0`; their API is not
defined here.

## License

Elastic License 2.0. See [LICENSE](./LICENSE).
