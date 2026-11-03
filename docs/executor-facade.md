# Executor facade

`@sekiban/dcb-client` exposes one `SekibanExecutor` interface for application
commands. The application supplies a transport; command authoring, snapshot
claims, and the V1 commit envelope remain the same.

## In-process

Worker code can use the runtime binding without adding a public HTTP hop:

```ts
const transport = createInProcessTransport(env, { serviceId });
const executor = createSekibanExecutor(transport, { serviceId });
const result = await executor.execute(createRoomCommand, { roomId, name });
```

## HTTP and cloud-shaped transports

Development hosts can use `createHttpTransport({ baseUrl, headers, fetch })`.
The cloud-shaped adapter accepts exactly `BaseUrl`, `ServiceId`,
`CredentialId`, and `CredentialSecret`, and sends the three `X-Sekiban-*`
headers. HTTP 401/403 is returned as typed `credential.rejected`; the secret
is not copied into an error or result.

## Portable snapshots

When a caller has a coherent tag snapshot, it can commit without a tag-state
read:

```ts
const snapshot = await executor.readState(roomProjector, roomTag(roomId));
const result = await executor.execute(createRoomCommand, { roomId, name }, {
  snapshots: [snapshot],
  readMode: "snapshot-only",
});
```

`read-through` is the default and reads uncovered claims. `snapshot-only`
fails closed with `kind: "invalid"` and
`code: "executor.snapshot_missing"` when a required claim is absent. A
committed result carries `head` and per-tag `heads`; those portable snapshots
can be carried into the next command. The assert-empty snapshot uses the
empty string consistency head, while an unclaimed tag remains omitted.

The caller action for every typed outcome is defined in the [result and repair
matrix](architecture.md#result-and-repair-matrix). The transport still emits
only the official V1 `version`, `eventCandidates`, `consistencyTags`, and
base64 payload members. The runtime request boundary is
[V1 request identity and resend boundary](write-path.md#v1-request-identity-and-resend-boundary).

## Conditional commit v1

`SekibanExecutor` exposes two methods:

```ts
prepareConditionalCommit<T extends JsonValue>(
  input: ConditionalCommitInput<T>,
): PreparedConditionalCommit;

commitPreparedConditionally(
  request: PreparedConditionalCommit,
  options?: ConditionalCommitOptions,
): Promise<ConditionalCommitResult>;
```

Prepare once, hold the returned value, and pass that same object to dispatch. `options.signal` is forwarded to the transport. A scope mismatch throws `ClientError` with code `scope.mismatch` and performs no call. There is no automatic retry and no fallback to V1 `transport.commit`.

```ts
const prepared = executor.prepareConditionalCommit({
  idempotencyKey: operationKey,
  event: roomOpened,
  payload: { roomId: "room-1" },
  tag: "room:room-1",
});
const result = await executor.commitPreparedConditionally(prepared, { signal });
```

Built-in `SerializedDcbClient`, `createHttpTransport`, and `createInProcessTransport` send one JSON POST to `POST /api/sekiban/serialized/conditional-commit`. An old runtime that answers 404 on that exact path becomes Unsupported. A custom transport's 404 stays a transport failure. The route admits one event and one tag. The key scope is `(serviceId, tag, normalizedKey)`. The same key on another tag is independent. Call it only from a trusted service or gateway. HTTP 200 and 409 are a key-existence oracle, so use a high-entropy key. Fixed D1 and omitted-provider PostgreSQL support it. Cosmos, a custom provider, and bootstrap or import states return Unsupported. External side effects and multi-tag atomicity are not promised.

| Result | Action |
| --- | --- |
| Appended 201 | Keep the receipt. Do not submit a replacement. |
| AlreadyCommittedSameOperation 200 | Treat the original operation as complete. |
| KeyReuseConflict 409 | Stop. Do not reuse that key with a different payload. |
| Unsupported 501 | Stop, or select a supported deployment. Never fall back to V1. |
| conditional_commit_in_doubt 503 | Resend only the same held prepared value. |
| conditional_commit_committed_state_corrupt 500 | Stop writes, investigate, and append a new ordinary compensating event. |

A detectable durable contradiction returns HTTP 500 `conditional_commit_committed_state_corrupt`. Correct it with an ordinary compensating event:

1. Stop replaying the conditional request.
2. Capture the receipt, event, membership, outbox, and downstream discrepancy without exposing the key or payload.
3. Determine the intended business state.
4. Append a new ordinary compensating event with an explicit causal link.
5. Allow the normal outbox and projection paths to converge.
6. Verify both Tag and global views before closing the incident.

## Commit reconciliation and safe retry

Serialized DCB V1 does not identify one commit across HTTP requests. Sending
the same JSON again starts a new operation. The runtime creates event ids and
captures a write timestamp for each request. An empty `eventCandidates` array
appends nothing and does not receive those ids or that timestamp. V1 has no
server-side idempotency key for the serialized commit. With no consistency
expectations, the commit is unconditional. When expectations are supplied,
only listed tag heads are checked, and every supplied reservation must succeed
before any Tag append.
Omitted tags are not head-checked. A reservation conflict aborts the whole
commit before an accepted Tag append.

A timeout, HTTP 504, or network or transport failure after commit dispatch
leaves the outcome unknown: the commit may or may not have been applied. Do
not blindly resend it. Reconcile fresh authoritative state before deciding
whether to issue a new operation. Before dispatch, a timeout or network error
means no commit request was sent. After dispatch, the same signals cannot
prove whether the commit applied.

`SekibanExecutor` defaults to one confirmed-conflict retry and does not cap an
explicit value. `ClaimLedgerExecutor` defaults to zero and caps a conflict
retry at one. Snapshot-only execution uses zero. Only a confirmed
`consistency_conflict` is retried. Timeout, `unknown_outcome`, unavailable,
partial, and transport results are never automatically replayed. After
dispatch, a network exception can surface as `transport` while the commit
outcome remains unknown. That public classification is not proof the write
failed.

`lastSortableUniqueId: ""` asserts an empty tag. A non-empty value is an
expected head. If the first request or another writer advances that tag, a
later request that still sends the old expectation returns HTTP 400
`consistency_conflict`. That conflict does not identify which operation
advanced the head, and it does not prove that the caller's first attempt
succeeded. Every supplied reservation must succeed before any Tag append.
After allocation, V1 multi-tag appends remain best effort and can produce a
partial write. Reconcile every affected authoritative tag after an unknown or
partial multi-tag result.

An original assert-empty or expected-head condition protects only while its
reservation remains active for 30 seconds
(`packages/dcb-runtime/src/tag/types.ts:1`), or once a write advances the
checked head. Reservation expiry is non-terminal, and recovery may follow. The
condition cannot alone authorize a replacement after an unknown outcome.
Require conclusive settlement of the original request, or a durable
application or gateway single-flight claim acquired before the first dispatch
and retained through settlement and reconciliation. Do not authorize a new
operation based solely on observed absence plus an original or fresh expected
head.

### Fresh authoritative state

Use `readState` and its application state and returned head to check whether
the intended effect is present. `readTagLatestSortable` returns only existence
and head. A head alone cannot identify or verify the intended effect. A derived
projection or materialized view may lag and is not immediate proof. Even an
authoritative absence observation has a read/submit race with the original
in-flight request or another writer. An expected head added only to a
replacement does not fence an already in-flight unconditional request. This
ordering is permitted:

1. The original has no consistency entries and therefore acquires no
   reservation (`packages/dcb-runtime/src/commit/CommitWorker.ts:961`).
2. The original remains delayed before allocation
   (`packages/dcb-runtime/src/commit/CommitWorker.ts:678`).
3. The replacement reads the old head, reserves it, allocates, and appends.
4. The replacement's successful append removes its reservation
   (`packages/dcb-runtime/src/tag/TagDurableObject.ts:2420`).
5. The original resumes, receives a later sortable id, and can append. The
   append path reads the active reservation
   (`packages/dcb-runtime/src/tag/TagDurableObject.ts:2307`). The expected head
   is compared only when that reservation still matches the attempt
   (`packages/dcb-runtime/src/tag/TagDurableObject.ts:2340`,
   `packages/dcb-runtime/src/tag/TagDurableObject.ts:2351`). A sortable id
   that is not later than the current head is rejected
   (`packages/dcb-runtime/src/tag/TagDurableObject.ts:2378`). With no active
   reservation, the original expected head is not enforced. Epoch, fence, and
   event-identity checks still run.

An expectation on the original request changes this ordering only while its
reservation remains active. The reservation window is 30 seconds
(`packages/dcb-runtime/src/tag/types.ts:1`). If the request remains in flight,
the checked head is still current, and the reservation expires, another
acquire deletes the expired reservation
(`packages/dcb-runtime/src/tag/TagDurableObject.ts:2470`) and can then reserve
the still-current head. The replacement can append and remove its reservation
at `packages/dcb-runtime/src/tag/TagDurableObject.ts:2420`. The original can
then resume with a later sortable id and append, because its reservation is no
longer active and the expected head is enforced only for a currently matching
reservation. An original assert-empty or expected head therefore protects only
while its reservation remains active or once a write has advanced the checked
head. It is not a durable fence for an indefinitely in-flight request, and it
cannot alone authorize a replacement after an unknown outcome.

Require conclusive settlement of the original request before replacement, or a
durable application or gateway single-flight claim acquired before the first
dispatch and retained through settlement and reconciliation. Do not authorize
a new operation based solely on observed absence plus an original or fresh
expected head. For a multi-tag commit, reconcile every affected authoritative
tag rather than inspecting only one tag.

### Consistency expectation

Use assert-empty or the observed head when the business operation can be
expressed against that state. A stale retry fails rather than appending, but
the failure is concurrency control, not response replay. This protects the
operation only while the original reservation is active for 30 seconds or
once a write has advanced the checked head. If the reservation expires first
while the head is unchanged, the original can resume after a replacement
appends. Adding an expectation after an attempt becomes unknown does not fence
that attempt, and even an original expectation cannot alone authorize a
replacement after an unknown outcome. Wait for conclusive settlement, or use a
durable application or gateway single-flight claim acquired before first
dispatch and retained through settlement and reconciliation. An expectation
cannot distinguish the first request from another writer, and it does not by
itself reconcile a partial multi-tag result.

### Application operation id

Carry a durable application operation id in the event payload and check the
authoritative application state before emitting again. The runtime does not
enforce uniqueness of this payload field. Concurrent attempts still need
conclusive settlement before replacement, or an application-owned durable
single-flight claim acquired before first dispatch and retained through
settlement and reconciliation. An original consistency expectation has only
the same 30-second active-reservation or advanced-head protection. It is not
a substitute for either requirement after an unknown outcome. For a multi-tag
operation, the id does not make Tag appends atomic. After an unknown or
partial result, reconcile the subset present across every affected
authoritative tag before emitting again.

### Gateway deduplication

Use a durable ledger scoped to the authenticated caller and endpoint, and bind
the key to a request fingerprint. A response cache alone is insufficient,
because a crash can occur after the commit is accepted and before the response
is cached. Acquire the gateway single-flight claim before first dispatch.
Pending entries need reconciliation. A gateway claim does not make V1
multi-tag writes atomic, so reconcile the written subset across every affected
authoritative tag after an unknown or partial result. Define the retention and
expiry policy, and retain the claim through settlement and reconciliation. Do
not expire or release it while the result is pending or unknown. After expiry
the gateway cannot recognize a resend. Its documented policy must reject the
request unless the prior operation is conclusively settled. It must not treat
an already-unknown request as a new operation based solely on observed absence
or an original or fresh expected head. An original expectation may already
have lost its 30-second reservation. Any later new operation requires
conclusive settlement, or a new durable claim acquired before its own first
dispatch and retained through settlement and reconciliation. Do not promise
atomicity with the runtime unless the gateway actually provides it.

None of the four patterns provides general exactly-once execution for V1. None
is a general receipt replay for V1.
