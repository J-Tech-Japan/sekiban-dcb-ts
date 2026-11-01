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
`ClientError` with a fixed message.

`SekibanExecutor.query` and `listQuery` also accept a structural
`QueryContract` or `ListQueryContract` from `@sekiban/dcb-core`. The typed
call encodes domain parameters with `contract.params.encode`, sends
`queryType` as `contract.id`, and decodes the normalized raw envelope with
the result or item codec. `QueryCallOptions` carries only
`waitForSortableUniqueId` and `signal`. List paging, direction, and
consistency stay on `ListQueryControls` and are copied onto the raw parameter
object as `PageNumber`, `PageSize`, `NewestFirst`, and `consistency`. A raw
request is still selected when `queryType` and `queryParamsJson` are strings,
even if another property is present. `SerializedDcbTransport`,
`SerializedDcbClient`, `createHttpTransport`, and `createInProcessTransport`
stay raw. The typed layer does not import Zod.

A local encode or decode failure is a fresh `ClientError` with no status and
no cause. Recognized server codes keep their existing code, status, message,
and kind. `projection_ordering_quarantined` is not classified as a query
result: it remains `transport`, status 503, and message
"Transport request failed", and the result codecs are not called.

| Code | Status | Kind | Message |
| --- | --- | --- | --- |
| `query_params_encode_failed` | none | `invalid` | The query parameters could not be encoded. |
| `query_params_invalid` | 400 | `invalid` | The query parameters are invalid. |
| `query_scan_limit_exceeded` | 422 | `rejected` | The query scan limit was exceeded. |
| `query_row_invalid` | 500 | `unavailable` | The query projection contains an invalid row. |
| `query_result_decode_failed` | none | `unavailable` | The query response could not be decoded. |
| `query_result_invalid` | 500 | `unavailable` | The query handler returned an invalid result. |
| `query_handler_failed` | 500 | `unavailable` | The query handler failed. |

`projection_unavailable` stays `unavailable`. The public `ClientError` fields
stay `code`, `status`, and `partial`. Do not retry `query_params_unsupported`
unchanged; fix the parameters the selected query accepts. The typed client is
in this repository and is not part of the published `0.2.2` packages. The
`0.3.0` release is later.

## License

Elastic License 2.0. See [LICENSE](./LICENSE).
