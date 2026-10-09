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

## License

Elastic License 2.0. See [LICENSE](./LICENSE).
