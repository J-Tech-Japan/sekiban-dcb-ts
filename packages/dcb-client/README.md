# @sekiban/dcb-client

Typed Serialized DCB V1 client and claim-ledger executor.

`createSekibanExecutor` and the transport helpers provide the portable client
surface for executing a V1 command without importing the Cloudflare runtime.
The `0.2.1` package depends on the matched `@sekiban/dcb-core` and
`@sekiban/dcb-domain` `0.2.1` release set.

It is not the earlier, unrelated `@sekiban/core` package line.

`query_params_unsupported` is a known transport code. `query` and `listQuery`
surface it as a `ClientError` whose message is "The selected query does not
support these parameters." and whose `code` is `query_params_unsupported`.
The public `ClientError` fields stay `code`, `status`, and `partial`.

## License

Elastic License 2.0. See [LICENSE](./LICENSE).
