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
base64 payload members.
