# @sekiban/dcb-client

Typed Serialized DCB V1 client and claim-ledger executor.

`createSekibanExecutor` and the transport helpers provide the portable client
surface for executing a V1 command without importing the Cloudflare runtime.
The `0.2.2` package depends on the matched `@sekiban/dcb-core` and
`@sekiban/dcb-domain` `0.2.2` release set.

It is not the earlier, unrelated `@sekiban/core` package line.

`query_params_unsupported` is a known transport code. `query` and `listQuery`
surface it as a `ClientError` whose message is "The selected query does not
support these parameters." and whose `code` is `query_params_unsupported`.
The same raw V1 methods surface executable query failures as a fresh
`ClientError` with a fixed message. There is no typed client overload yet.

| Code | Status | Kind | Message |
| --- | --- | --- | --- |
| `query_params_invalid` | 400 | `invalid` | The query parameters are invalid. |
| `query_scan_limit_exceeded` | 422 | `rejected` | The query scan limit was exceeded. |
| `query_row_invalid` | 500 | `unavailable` | The query projection contains an invalid row. |
| `query_result_invalid` | 500 | `unavailable` | The query handler returned an invalid result. |
| `query_handler_failed` | 500 | `unavailable` | The query handler failed. |

`projection_unavailable` stays `unavailable`. The public `ClientError` fields
stay `code`, `status`, and `partial`.

## License

Elastic License 2.0. See [LICENSE](./LICENSE).
