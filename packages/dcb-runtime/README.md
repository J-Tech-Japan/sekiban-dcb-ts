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
