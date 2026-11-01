# @sekiban/dcb-core

Cloudflare-independent Serialized DCB definitions and domain algebra.

This package contains the portable core types used by the Serialized DCB V1
domain and client packages. It is published as an ESM package with the public
surface available from `@sekiban/dcb-core`.

It is not the earlier, unrelated `@sekiban/core` package line.

## Query contracts

The root export includes structural query contracts and nothing that runs them.
`QueryContract` and `ListQueryContract` carry a kind, an id, a version, and
bidirectional `encode` / `decode` codecs. `QueryPage` is the list result shape.
There is no handler, schema, or source view on these contracts. A later client
can accept a contract plus params and return the decoded result; this package
does not provide that call.

## License

Elastic License 2.0. See [LICENSE](./LICENSE).
