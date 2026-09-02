# SDT-G54 — serialized V1 envelope and interop evidence

Issue: [#105](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/105)
Branch: `claude/sdt-g54-envelope-interop-w77`
Packet authority: `907bcee02784b81d8ab00e3208de173b28e6605c` (W78 amended AC5a)

## Scope and source authority

This change closes the parsed-envelope fail-open at the runtime boundary. It
does not add a second client dialect, change the valid V1 transport adapter,
alter commit ordering/reservation/fence/response semantics, alter the frozen
trace schema, change configuration, or deploy.

The frozen source copy is from
`J-Tech-Japan/Sekiban@23589cf2b0616dad8532a9119e6f18d207c3be63`, at
`dcb/tests/Sekiban.Dcb.WithResult.Tests/SerializedCommitWire/goldens/`.
`test/fixtures/g54-sekiban-interop/` contains exactly the fifteen
`interop_*.json` witnesses plus `interop_manifest.json` and `PROVENANCE.md`.
`SHA256SUMS` records all seventeen copied-source SHA-256 values. The
dependency-free runner verifies both that pin set and each manifest length and
hash before evaluating a fixture.

The copied manifest and provenance intentionally retain their upstream
embedded `f53ffdc…` dataset provenance; the W78 retrieval/copy authority is
the amended `23589cf…` tree that actually contains the complete catalogue.
They are copied byte-for-byte, including no-final-newline JSON files.

## AC1 / AC2 — fail closed before a Durable Object

Pre-fix, the focused C-12 test was added while `origin/main` behavior was
still intact and was red: the aliases shape and bare V1 shape both received
HTTP 200 where the test required 400 (`expected 400, received 200`). The
accepted current-main result for each was:

```json
{"writtenEvents":[],"tagWriteResults":[],"duration":"PT0S"}
```

The exact pre-fix requests were:

```json
{"version":1,"candidates":[{"eventId":"11111111-1111-1111-1111-111111111111","eventPayloadName":"OrderPlaced","payload":{"amount":1},"tags":["Order:42"]}],"consistency":[]}
```

```json
{"version":1}
```

After the fix, the first request receives HTTP 400:

```json
{"error":"Missing required V1 member(s): eventCandidates, consistencyTags. Client-model member(s) candidates, consistency require the transport adapter; use eventCandidates and consistencyTags on the V1 wire.","code":"malformed_commit_envelope"}
```

The bare V1 request receives HTTP 400:

```json
{"error":"Missing required V1 member(s): eventCandidates, consistencyTags.","code":"malformed_commit_envelope"}
```

The fixture also covers each non-array member individually. Every rejected
shape counts `idFromName`, `get`, and `fetch` as zero for fake `ALLOCATOR`,
`BOOTSTRAP`, `TAG`, and a carried `TAG_STATE` namespace. Explicit
`{"version":1,"eventCandidates":[],"consistencyTags":[]}` remains accepted
with the unchanged empty-commit response above.

`scripts/g54-envelope-mutation-runner.mjs` replaces only the required-member
and present-but-undefined guard branches with `if (false)` against the shipped
`CommitWorker`, rebuilds it, and requires the zero-DO-call fixture to fail.
Its completed output is
`production-omission-mutant-red`. The complete G54 lane is wired into the
existing `ci-g21-g25` conformance job, followed by an independent forced-red
reachability proof.

## AC3 — client model and unchanged adapter

`ReadonlyTagStateResponse.projectorVersion` is now a string, matching the
runtime tag-state response. `test/g54-interop.spec.ts` contains a compile-time
equality assertion and a runtime DTO-surface witness for string
`projectorVersion` and string `lastSortedUniqueId`.

`samples/meeting-room/src/transport.ts` was not changed. Its real
`createV1Transport` adapter receives the copied `interop_ts_client_model.json`
and emits byte-identical `interop_official_v1_populated.json`; it also emits
the paired canonical R2 V1 output exactly. The raw client model itself is
rejected at the runtime with the named adapter/mis-dialect 400, including when
the source fixture omits `version`.

## AC5a — copied golden results

`node scripts/g54-interop-runner.mjs` uses Node built-ins only. Its successful
result reports all seventeen source pins and all fifteen manifest fixtures.

| Witness group | Result |
| --- | --- |
| Legacy upstream catalogues | Pinned and classified as typed unversioned rejects by this V1-only runtime; no client-dialect translation is introduced. |
| R1 official V1 | Accepted by `validateCommitEnvelope`; every base64 payload decodes and re-encodes byte-identically. |
| R2 positive | Raw client model rejected at runtime; real adapter produces the expected official V1 bytes. |
| R2 loss/error | Integer-key ordering and numeric lexical loss receive distinct runner typed errors; duplicate raw key receives `client_payload_duplicate_key`. |
| R3 payload | BOM and invalid UTF-8 receive `invalid_payload_utf8`; non-JSON receives `invalid_payload_json`. |
| Tag validation | Empty tag and duplicate consistency adapters reach the runtime's existing typed `validation_error` paths. |
| Response vocabulary | `projectorVersion` is a string and tag-state includes `lastSortedUniqueId`; commit response members remain present. |

No amended-AC5a comparison mismatch was found, so no interop finding was
filed against Sekiban#1172. The old legacy compatibility labels in the copied
upstream manifest are recorded as upstream catalogue metadata, not a request
to make this V1-only runtime silently accept unversioned input.

TypeScript receives a parsed `Request.json()` object, so duplicate raw JSON
members are inherently undetectable at the runtime boundary. The frozen
runner detects the duplicate-key witness before creating a client model and
reports its typed client-side result; it deliberately does not add a runtime
raw-JSON scanner. The C# raw-shape gate remains the cross-language control for
that class.

## AC4 / preserved gates and checks

The following checks were run after the change:

- `npm run test:g54` — passed: package build, SHA-pinned dependency-free
  runner, twelve focused runtime/client tests, and the production omission mutant.
- `npm run typecheck --silent` — passed.
- `npm run test:g49` — passed, including all binding/migration parity mutants.
- `vitest run --config vitest.config.ts --maxWorkers=1 test/g41-journal-removal.spec.ts`
  plus `g41-journal-contract-check --self-test` — passed (eight focused
  tests). No G41 source was modified.
- The G51 focused trace tests and regression/bisect checks passed before the
  pre-existing mutation helper stopped because this linked worktree has no
  local `node_modules/vitest/vitest.mjs` path. The same helper is unchanged;
  CI runs `npm ci` and supplies that path. No G51 source or guard was modified.

No deployment was required or performed.
