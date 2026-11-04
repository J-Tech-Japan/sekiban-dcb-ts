# @sekiban/dcb-client

Typed Serialized DCB V1 client and claim-ledger executor.

`createSekibanExecutor` and the transport helpers provide the portable client
surface for executing a V1 command without importing the Cloudflare runtime.
The released `0.3.0` depends on the matched `@sekiban/dcb-core` and
`@sekiban/dcb-domain` `0.3.0` set. Those versions are available from npm.

It is not the earlier, unrelated `@sekiban/core` package line.

## Commit retries and unknown outcomes

`SekibanExecutor` defaults to one confirmed-conflict retry and does not cap an
explicit value. `ClaimLedgerExecutor` defaults to zero and caps a conflict
retry at one. Snapshot-only execution uses zero. Only a confirmed
`consistency_conflict` is retried. Timeout, `unknown_outcome`, unavailable,
partial, and transport results are never automatically replayed. After
dispatch, a network exception can surface as `transport` while the commit
outcome remains unknown.

A timeout, HTTP 504, or network or transport failure after commit dispatch
leaves the outcome unknown: the commit may or may not have been applied. Do
not blindly resend it. Reconcile fresh authoritative state before deciding
whether to issue a new operation. An original expected head does not make a
replacement safe after that outcome. Its reservation lasts 30 seconds, and a
replacement requires conclusive settlement of the original request or a
durable application or gateway single-flight claim acquired before the first
dispatch and retained through settlement and reconciliation.

The four caller-side patterns below are limits, not general exactly-once
execution. None of the four patterns provides general exactly-once execution
for V1. None is a general receipt replay for V1.

- Read fresh authoritative tag state and application facts before a new
  operation. `readTagLatestSortable` returns only existence and head, so a
  head alone cannot identify or verify the intended effect. A derived view may
  lag. An authoritative absence observation can race the original in-flight
  request or another writer. An expected head added only to a replacement
  does not fence an already in-flight unconditional request. An original
  expectation protects only while its 30-second reservation remains active,
  or once a write advances the checked head. If that reservation expires
  while the head is unchanged, the original may resume and append. For a
  multi-tag commit, reconcile every affected authoritative tag.
- Assert-empty (`lastSortableUniqueId: ""`) or an expected head is optimistic
  concurrency. Once a write advances the checked head, a later attempt can
  fail with HTTP 400 `consistency_conflict`. That conflict is not proof the
  first request succeeded. The protection holds only while the original
  reservation is active or once a write has advanced the checked head. It
  cannot alone authorize a replacement after an unknown outcome, and it does
  not by itself reconcile a partial multi-tag result.
- Carry an application operation id in the event payload and check
  authoritative application state for it. V1 does not enforce uniqueness of
  that field. Concurrent attempts still need conclusive settlement before
  replacement, or an application single-flight claim acquired before first
  dispatch and retained through settlement and reconciliation. On a partial
  multi-tag result, reconcile the subset present on every affected
  authoritative tag before emitting again.
- Deduplicate at a gateway with durable state scoped to the authenticated
  caller and endpoint, and bind the key to a request fingerprint. A response
  cache alone is not enough: the commit can be accepted before the response
  is cached. Acquire the single-flight claim before first dispatch, retain it
  through settlement and reconciliation, and do not expire or release it
  while the result is pending or unknown. After expiry the gateway cannot
  recognize a resend. Its policy must reject that request unless the prior
  operation is conclusively settled, and must not treat an already-unknown
  request as a new operation based solely on observed absence or an original
  or fresh expected head. A later new operation requires conclusive
  settlement or a new durable claim acquired before its own first dispatch
  and retained through settlement and reconciliation. Reconcile every
  affected authoritative tag after an unknown or partial multi-tag result.

The full limits are in [Commit reconciliation and safe retry](../../docs/executor-facade.md#commit-reconciliation-and-safe-retry).

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
unchanged; fix the parameters the selected query accepts. The typed client calls
are part of the released `0.3.0` and are available from npm.

## Conditional commit v1

Prepare once, hold the prepared value, and dispatch that same object. Branch on the result. Resend only that held value after a retryable in-doubt result. There is no automatic retry and no fallback to V1 commit. The route is one event and one tag, scoped by `(serviceId, tag, normalizedKey)`. The same key on another tag is independent. Use a high-entropy key because HTTP 200 and 409 reveal whether the key exists. Call it only from a trusted service or gateway. Fixed D1 and omitted-provider PostgreSQL support it. Cosmos and a custom provider return Unsupported. An existing receipt for the key is resolved first: the same operation returns 200 with the stored result; a different operation returns 409; a receipt contradiction returns 500 and is fixed with compensating events. A Tag with an import marker and no receipt returns 501 Unsupported. Only when there is no receipt and no import marker is the bootstrap coordinator consulted: `PLANNED`, `IMPORTING`, and `VERIFYING` return retryable 503 (resend the same held prepared value); `READY`, `FAILED`, or other unsupported states return 501. A detectable durable contradiction returns HTTP 500 and is corrected by an ordinary compensating event. The V1 warning above remains in force for `execute`, `executeCommand`, and `transport.commit`.

```ts
const prepared = executor.prepareConditionalCommit({
  idempotencyKey: operationKey,
  event: roomOpened,
  payload: { roomId: "room-1" },
  tag: "room:room-1",
});
const result = await executor.commitPreparedConditionally(prepared, { signal });
if (result.outcome === "Appended" || result.outcome === "AlreadyCommittedSameOperation") {
  // keep result.receipt; do not submit a replacement
} else if (result.outcome === "KeyReuseConflict") {
  // stop; do not reuse this key with a different payload
} else {
  // Unsupported: select a supported deployment; never fall back to V1
}
```

| Result | Action |
| --- | --- |
| Appended 201 | Keep the receipt. Do not submit a replacement. |
| AlreadyCommittedSameOperation 200 | Treat the original operation as complete. |
| KeyReuseConflict 409 | Stop. Do not reuse that key with a different payload. |
| Unsupported 501 | Stop, or select a supported deployment. Never fall back to V1. |
| conditional_commit_in_doubt 503 | Resend only the same held prepared value. |
| conditional_commit_committed_state_corrupt 500 | Stop writes, investigate, and append a new ordinary compensating event. |

## License

Elastic License 2.0. See [LICENSE](./LICENSE).
