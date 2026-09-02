# SDT-G51 PR #102 foundation-timeout repair (W66)

## Scope and identity

- PR: [#102](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/102)
- Review / blocker: `5085759642` / `5504675380`
- Required starting head: `c88d0fe4f1bfd6939e686b1a0f0e311be53b81db`
- Repair source head: `3c521ccba38eb25cc746f6e48a0920a51bca74aa`
- Source validation run: [33595960822](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/33595960822), conclusion `success`

The review’s W65 component-rejection-before-tracing repair remains untouched. No deployment, measurement, observability query, or W64 P1 evidence/documentation change was made.

## Diagnosis

The three foundation timeouts shared a Durable Object request-stream lifecycle race. The native actor span wrappers decoded `request.clone()` for trace identity and then decoded the original request for application behavior. That tees a Worker request body; under concurrent workerd isolates its tracing-only reader can outlive the response boundary. The failing run emitted `jsg.TypeError: Can't read from request stream after response has been sent.`

`repair.spec.ts` exercises the Tag/allocator/bootstrap command paths and `tag.spec.ts` exercises the Tag path directly, so the same double-reader race could consume either the 15-second repair limit or either 5-second boundary limit. This was a resource/lifecycle defect, not an assertion or timeout defect.

## Narrow repair

Commit `3c521ccba38eb25cc746f6e48a0920a51bca74aa` changes only:

- `packages/dcb-runtime/src/allocator/AllocatorDurableObject.ts`
- `packages/dcb-runtime/src/bootstrap/BootstrapCoordinatorDurableObject.ts`
- `packages/dcb-runtime/src/tag/TagDurableObject.ts`

Each native actor wrapper now decodes the original body once while resolving its span identity and passes that same parsed value to the command handler. Invalid-JSON responses retain their prior status/code/message behavior. Span creation still occurs at the native actor boundary before the asynchronous identity resolver, so native tracing and the G51 row identity path remain active. There are no timeout changes, test skips, concurrency changes, configuration changes, or gate changes.

## Validation

- `npm run build:packages` passed.
- Focused `repair.spec.ts` + `tag.spec.ts` passed in eight fresh-process repetitions (19/19 each); a non-silent run had neither the reviewed timeouts nor the request-stream error.
- The command/repair/tag combination passed in five fresh-process repetitions (28/28 each).
- `npm run test:g51`, `npm run test:g38:prep`, `npm run test:g41`, and `npm run test:g43` passed locally. This preserves G30/G38/G41/G51 forced-red coverage and proves the W65 primary-path/rejection ordering remains closed.
- A full local `npm test -- --silent` was attempted. The reviewed three timeout paths and request-stream error did not recur; the run instead exposed the known unrelated G43 event-ID race plus a local AC7 timeout under host contention. Neither was modified in this repair.
- Remote CI run 33595960822 passed every required lane, including `ci-foundation`, `ci-g30-core`, `ci-g30-forced-red`, `ci-g38`, `ci-g41`, `ci-g43`, `ci-g32-parity`, and final `verify`.

## Preserved invariants

- Existing timeout limits remain exactly 15,000 ms and 5,000 ms where the review recorded them.
- Receiver, `undefined`, and unknown components still reject before any tracing call; the valid primary P1 route remains unchanged.
- The immutable W64 P1 0/10 evidence and its conclusion were not altered.
- No packages commit semantics, deployment configuration, or unrelated source path was changed.

