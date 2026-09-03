# SDT-G54 — serialized V1 envelope and interop evidence

Issue: [#105](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/105)
Branch: `claude/sdt-g54-envelope-interop-w77`
Packet authority: `907bcee02784b81d8ab00e3208de173b28e6605c` (W78 amended AC5a),
with the W80 known-divergence amendment at `16197d151`

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

### PR #108 repair — retained pre-DO entry ordering

The existing `test/commit.spec.ts` bare-envelope assertion now requires the
same typed `400 malformed_commit_envelope` as the focused boundary suite, and
asserts that its reason names both `eventCandidates` and `consistencyTags`.
It keeps a distinct HTTP 200 assertion for explicit empty V1 arrays.

The consistency-entry validation once again invokes the 30-digit
`lastSortableUniqueId` validator unconditionally before membership, admission,
or any Durable Object lookup. An empty string therefore receives typed
`400 invalid_sortable_unique_id`, with the fake-namespace boundary fixture
proving zero `idFromName`, `get`, and `fetch` calls across every carried
namespace. The existing G32 fixture normalization omits an asserted-empty
consistency entry rather than sending an invalid empty head.

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
| R1 official V1 | **Known divergence, not a pass:** every candidate payload decodes and re-encodes byte-identically, while the explicit empty consistency head receives the retained typed `invalid_sortable_unique_id` rejection before any Durable Object call. |
| R2 positive | **Known divergence, not a pass:** the raw client model is rejected at runtime; the real adapter produces the expected V1 bytes without translation, and that source-preserved empty head receives the same typed rejection. |
| R2 loss/error | Integer-key ordering and numeric lexical loss receive distinct runner typed errors; duplicate raw key receives `client_payload_duplicate_key`. |
| R3 payload | BOM and invalid UTF-8 receive `invalid_payload_utf8`; non-JSON receives `invalid_payload_json`. |
| Tag validation | Empty tag reaches `validation_error`; the duplicate-consistency source carries an empty head and therefore first reaches the retained ordered `invalid_sortable_unique_id` rejection. |
| Response vocabulary | `projectorVersion` is a string and tag-state includes `lastSortedUniqueId`; commit response members remain present. |

### W80 — explicit SDT-G56 known divergence

The authoritative W80 amendment and the [design record on
Sekiban#1172](https://github.com/J-Tech-Japan/Sekiban/issues/1172#issuecomment-5518115881)
make the C# meaning of `lastSortableUniqueId: ""` explicit: it is assert-empty
on the shared V1 wire. This runtime intentionally does not implement that
behavior until SDT-G56. The four immutable positive witnesses are therefore
listed in `test/fixtures/g54-known-divergences.json` as
`known-divergence`, each with its original manifest outcome, expected V1
bytes, HTTP 400 `invalid_sortable_unique_id`, rejected member name, and
resolving unit `SDT-G56`.

| Input fixture | Expected V1 bytes | Current TS result | Resolution |
| --- | --- | --- | --- |
| `interop_official_v1_populated.json` | Its frozen V1 bytes | HTTP 400 `invalid_sortable_unique_id`, before any DO call | SDT-G56 |
| `interop_r2_canonical_positive_v1.json` | Its frozen V1 bytes | HTTP 400 `invalid_sortable_unique_id`, before any DO call | SDT-G56 |
| `interop_ts_client_model.json` | Byte-identical `interop_official_v1_populated.json` adapter output | HTTP 400 `invalid_sortable_unique_id`, before any DO call | SDT-G56 |
| `interop_r2_canonical_positive.json` | Byte-identical `interop_r2_canonical_positive_v1.json` adapter output | HTTP 400 `invalid_sortable_unique_id`, before any DO call | SDT-G56 |

This is not a reclassification as success. The dependency-free runner first
checks all fifteen original manifest outcomes, then emits each of these four as
`known-divergence` with its code and resolving unit. The focused Worker test
checks exact adapter bytes, candidate-part R1 byte identity, the typed HTTP
400, and zero calls to every fake Durable Object binding. Its companion
unexpected-acceptance mutant reports
`known-divergence-unexpected-acceptance-mutant-red`; if SDT-G56 starts
accepting one of these envelopes, that expectation must be deliberately
changed in the checked-in file. The frozen source bytes, SHA pins, and client
transport are untouched.

The remaining fixtures retain their manifest expectations: R2
lexical/numeric/duplicate-key failures remain typed client-side errors; R3
BOM/non-JSON/invalid-UTF-8 witnesses remain typed failures; empty-tag and
duplicate-consistency witnesses retain typed runtime rejections; and the
response vocabulary retains string `projectorVersion` and tag-state
`lastSortedUniqueId`.

The W79 repair records, rather than masks, the copied witnesses' explicit
empty consistency heads: the retained runtime contract rejects them before a
Durable Object call. No source fixture is altered and no second client dialect
is introduced. The old legacy compatibility labels in the copied upstream
manifest are recorded as upstream catalogue metadata, not a request to make
this V1-only runtime silently accept unversioned input.

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
