# SDT-G71 evidence

This document records the published read-contract proof for issue #146. The
implementation branch was cut from `origin/main` at
`193cfa44563d08ffadef146c4eca769098044be1`. The full amended issue body was read
before source changes. The separate host execution-unit claim receipt was not
included in the child dispatch, and host claim state was deliberately not
queried because the issue contract forbids reading parent orchestration state;
the child GitHub-only issue claim receipt is recorded below.

## Contract result

`@sekiban/dcb-client` now has one validated `tag-latest-sortable` authority
read shared by `exists(tag)` and `readState`. The runtime computes the
authority boolean from the durable Tag record (`record !== undefined`), not
from the event head or projector payload. `readState` reads the authority
first, short-circuits an observed absence to the projector's initial state,
and requires the tag-state consumed frontier to cover the captured authority
head. It retries that pair once and returns typed `read_unavailable` rather
than combining observations that did not agree. HTTP status is classified
before tag-state payload normalization; a refusal cannot become a false
absence or an invalid snapshot.

Only `listQuery` accepts a consistency lane. The executor forwards
`{consistency: "safe" | "unsafe"}` into the existing serialized query-params
field, rejects malformed or conflicting embedded values, and rejects an
explicit lane on tag-state, `exists`, or generic `query`. The sample uses the
public executor API for its list route in both Worker compositions. A generic
query response remains headless.

## Representation matrix (AC10/AC11)

The six payload representations below are exercised by the focused test for
the HTTP transport, the sample V1 fetch transport, the in-process transport,
and the separately exported `SerializedDcbClient`. Every row is read with an
authoritative existing tag and an empty authority head; existence is therefore
true for every valid state representation.

| tag-state payload | encoding verdict | decoded/result behavior | authority result |
| --- | --- | --- | --- |
| empty string `""` | valid JSON string value at the client boundary | retained as the state value; not treated as the empty sentinel | existing, `head: null` |
| absent `payload` member | invalid response | `invalid_read_snapshot`; no snapshot is returned | existing authority is not suppressed |
| base64 of `{}` (`e30=`) | valid | retained as an existing empty-object state | existing, `head: null` |
| raw object `{}` | valid | retained as an existing empty-object state | existing, `head: null` |
| raw JSON text `{"status":"ignored"}` | valid compatibility representation | decoded and retained; ignored-event state remains existing | existing, `head: null` |
| base64 of `{"status":"empty"}` | valid sentinel representation | projector initial state is selected, but authority still says existing | existing, `head: null` |

The same focused suite also covers the other direction: an authority response
of `{exists:false,lastSortableUniqueId:""}` returns the projector initial
state and does not call tag-state. A later authority call can observe a
concurrent first append without changing the earlier linearized absence. A
durable runtime Tag-record fixture with `events: []` and an empty head returns
`exists: true`, proving that the server boolean is record existence rather
than head length.

The existing-empty-object, ignored-event, and sentinel cases exercise an
existing tag; the authority-absence case exercises a real empty/absent tag
observation. Authority failure is preserved as its typed HTTP error, a
transport without `readTagLatestSortable` returns typed
`unsupported_capability`, and both a recovering concurrent append and a
persistently stale/frozen older rebuild are covered. There is no claim here
that an absent `payload` is decoded: the client rejects it before decoding, as
required by the contract.

## W223 bounded runtime integration proof (F2)

The earlier representation matrix remains a response-shape/unit proof. W223
adds a separate bounded runtime fixture so it is not presented as deployment
evidence or as a synthetic replacement for the Tag authority. The fixture
constructs real `TagDurableObject` instances with durable storage, appends
valid `G71Accepted` and `G71Ignored` events through their append endpoint, and
uses a registered projector whose reducer ignores the latter. An actually
absent tag is read before any tag-state call and returns the projector initial
state; the appended ignored tag returns `exists: true`, its real head, and the
initial state; the appended accepted tag returns `exists: true`, its real head,
and the decoded accepted state.

Each of these cases is driven through all four required adapters: generic HTTP,
the meeting-room sample V1 transport, the in-process transport, and the
exported `SerializedDcbClient`. The representation matrix above continues to
assert every valid existing response representation through those same
adapters, including empty string, `{}`, raw JSON, and the explicit empty
sentinel; the missing-payload row remains an invalid-response control. The
runtime fixture records eight tag-state calls for the two existing tags across
four adapters and zero tag-state calls for each short-circuited absence.

The fixture's `TAG_STATE` binding is intentionally a local projection
substitution: it reads the real Tag record and applies the registered projector
contract, but it is not a deployed SQLite `TagStateDurableObject`. This is an
explicit evidence boundary, not a claim of a production deployment.

The same deployed-shaped `SerializedQueryWorker` path is exercised with a
held projection. A real source Tag is appended while its checkpoint is absent,
then a checkpoint containing one row is installed, then a second source Tag
event is appended without advancing that checkpoint. Sample, HTTP, in-process,
and exported-client list-query paths all observe the empty held page first,
the one-row checkpoint page next, and the same old row plus the checkpoint head
after the second source append. Both safe and unsafe requests are covered.

## W227 Cloudflare-only composition proof (review W224 F2)

The controlled checkpoint fixture above is the adapter-substitution proof. It
does not claim that the sample Worker, Queue consumer, Tag Durable Objects, or
SafeWindow were composed. W227 adds that separate composition proof in
`test/g71-composition.spec.ts`; the existing `test/g67-safe-lane.spec.ts` was
not edited because SDT-G80 requires its G67 AC3 body to remain byte-identical.

The proof uses one service and two real `SELF.fetch` serialized commits. Each
commit returns and records its event id and durable SUID. The corresponding two
Tag outbox deliveries are read from the real Tag Durable Objects and passed to
the sample's exported `worker.queue(batch, env, ctx)`, so the sample's
`deliveryViews` unsafe writer and its `afterStoredQueueDelivery` safe-lane kick
run. The first Queue call can report the expected G44 retry-to-DLQ disposition
until the first full coverage pass exists; the test still requires both
messages to be processed and then uses the same production safe-lane scheduler
with mocked `Date.now` for the logical-clock release. No wall-clock sleep or
timeout was added.

The held two-commit receipt from the focused W227 run was:

| observation | result |
| --- | --- |
| commit A | event `0000001e-8480-7c67-9f85-193220b91b79`, SUID `062135598800000000001341847942` |
| commit B command head | event `00000020-5940-7e8a-a3f5-44682b7ae298`, SUID `062135598920000000000896572346` |
| safe page 1 while B is held | A only, `readHead = 062135598800000000001341847942` |
| safe page 2 while B is held | empty, `readHead = 062135598800000000001341847942` |
| sample unsafe page 1 while B is held | A and B, `readHead = 062135598920000000000896572346` |
| sample unsafe page 2 while B is held | empty, `readHead = ""` (not SUID A) |
| safe page after logical-clock release | A and B, `readHead = 062135598920000000000896572346` |

Thus the non-empty old checkpoint is observed on both safe page 1 and the
empty safe page 2, while the unsafe empty page reports only what that page
reflected. After the release kick, the safe page converges to B and equals the
unsafe page. This is a real divergence proof, not a one-commit fresh-service
case where both heads could be empty.

The local composition references remain distinct from this deployed-shaped
proof: `test/g16-query.spec.ts` verifies that the meeting-room reservations and
room-query mapping sends `consistency: "unsafe"` to the internal runtime
list-query, while `test/g31-sample.spec.ts` verifies the sample's `waitFor`
forwarding. W227's sample route is the former path under real Queue/MV state;
the executor safe pages use the runtime list-query directly. The evidence is
therefore split between adapter substitutions (the W223 matrix and controlled
checkpoint) and composition coverage (the W227 real commit/Tag/Queue/MV/
SafeWindow scenario), rather than treating either as the other.

## Head and consistency meanings

| operation | head meaning | proof |
| --- | --- | --- |
| safe `listQuery` | active durable generation checkpoint, including an empty page | memory query reads the greatest matching projection checkpoint; the D1 page port returns its selected active-generation head |
| unsafe `listQuery` | maximum SUID reflected by that returned page only | page entries are reduced after paging; it is not a completeness or global-latest certificate |
| tag-state / `readState` | tag projector's consumed `lastSortedUniqueId` frontier | authority-first read plus bounded frontier coverage check |
| commit | existing committed head and per-tag heads | executor's existing commit response/head mapping is retained |
| generic `query` | no head | the response is only `{resultJson}`; no second read is fabricated |

The F1 atomic-page fixture has one checkpoint observation containing the page
row and head `g71-head-1`; a deliberately advancing second observation would
return `g71-head-2`, and a counter proves it is never performed. A separate
empty checkpoint with no rows still returns its observed `g71-empty-head`. The
existing two-entry/page-size-one proof remains as the operation-specific head
check: safe page 1 reports checkpoint head `g71-head-2`, while unsafe page 1
reports only reflected page head `g71-head-1`. The server's legacy
queryRows-only D1 fallback intentionally omits `readHead` because it has no
authoritative checkpoint API.

## Error classification map

| source condition | public read classification |
| --- | --- |
| HTTP 503/other non-2xx authority or tag-state response | preserve response `code` and status through `ClientError` |
| fetch abort / `AbortError` | `ClientError` code `aborted` |
| non-abort transport exception | `ClientError` code `transport` |
| existing tag-state frontier remains below captured authority after one retry | `ClientError` code `read_unavailable`, status 503 |
| transport has no authority method | `ClientError` code `unsupported_capability`, status 501 |

The cloud-specific runtime wrapper is owned by SDT-G78 and is no longer a
dcb-client export. G71's generic HTTP, in-process, sample V1, and exported
client paths above use the G71 read classification directly. This separation
prevents G71 from claiming downstream cloud runtime behavior while making the
generic published contract checkable.

## Product mutants (all required mutants red)

`node scripts/g71-read-contract-mutation-runner.mjs` applies each source
mutation to its declared source file, runs the named public semantic oracle,
and restores the original bytes. The runner first verifies all anchors are
unique and requires a passing healthy control. Results:

| mutant | intended finding | result |
| --- | --- | --- |
| `sentinel-only-existence` | payload sentinel must not replace the authority boolean | behavioral product mutant red |
| `authority-failure-as-absence` | an authority refusal must not become `{exists:false}` | behavioral product mutant red |
| `existing-empty-object-erased` | an existing decoded `{}` must remain an existing state | behavioral product mutant red |
| `mismatched-observation-heads` | stale tag-state must not be combined with a newer authority head | behavioral product mutant red |
| `list-consistency-dropped` | the public list lane must reach every serialized adapter | behavioral product mutant red |
| `abort-collapsed-to-transport` | an aborted read must remain distinct from transport failure | behavioral product mutant red |
| `composition-unsafe-option-dropped` | the sample held unsafe page must include B | behavioral product mutant red |
| `composition-safe-head-from-wrong-observation` | replace the safe checkpoint with `maxReflectedSuid(rows)`; the held empty safe page must reject `""` and retain A's checkpoint | behavioral product mutant red |

The lane-forwarding oracle is also asserted for every adapter: dropping the
public list consistency before transport makes that focused test fail. No
production timeout, retry, queue, SafeWindow, migration, or G77 issuance
behavior was changed.

W223 also hardens the mutation receipt itself. Each run uses Vitest's
structured JSON reporter and the exact named oracle, requires exactly one
failed assertion for that oracle, rejects missing/skipped or unrelated
assertions, and preserves process status, signal/error, report error, and the
failed-assertion messages. Setup/import failures, timeout text, process kills,
and green escapes are rejected rather than counted as semantic red. The
runner's self-test covers all of those rejection cases; its actual eight-mutant
run produced status 1 with the named assertion failure for every mutant,
including the two W227 composition mutants, and restored the source bytes after
each mutation.

## W231 F1 repair — page maximum is a real wrong observation

Review W229 identified that the prior composition head mutant used a constant
empty string. That was insufficient: an empty safe page also has an empty page
maximum, so the mutant could pass the required page-2 assertion. The repaired
`composition-safe-head-from-wrong-observation` target now replaces the safe
checkpoint branch with `readHead: maxReflectedSuid(rows)`, the unsafe-page
observation. In the required two-commit held scenario, safe page 2 has no rows,
so this mutation reports `""` instead of A's non-empty checkpoint SUID and the
named composition assertion fails. This is a semantic wrong-observation
mutant, not a constant-empty source-shape placeholder.

The W231 local mutation receipt is:

```text
composition-safe-head-from-wrong-observation
processStatus=1 signal=null
named oracle: SDT-G71 Cloudflare-only composition G71 composition: safe and unsafe pages diverge while SafeWindow holds
failed assertion: expected '' to be '062135598800000000000641477751'
location: test/g71-composition.spec.ts:313:38
```

All eight mutants remain in the same runner and are still restricted to their
declared G71 tests. The six W223 contract mutants and the W227 unsafe-option
mutant are unchanged. The runner's structured validator, healthy controls,
status-1/null-signal requirement, named assertion/location evidence, and
failure-class rejection self-tests are unchanged.

W231 focused validation on the repaired source completed with the existing
G71-only commands: the runner self-test passed, the full eight-mutant runner
returned `all-g71-behavioral-product-mutants-red`, and the page-maximum mutant
returned status 1 with `signal=null` and the named page-2 assertion above.
No G67 file or product source was modified by W231.

## 0.2.0 migration and release proof

The matched public set is now `@sekiban/dcb-core@0.2.0`,
`@sekiban/dcb-domain@0.2.0`, and `@sekiban/dcb-client@0.2.0`. The existing
release checks pass with `dcb-v0.2.0`; the packed-package consumer passes
Node16, bundler, and esbuild compile/runtime checks, and the raw V1 envelope
remains byte-identical. The packed consumer also reads one portable snapshot,
executes snapshot-only with a throwing/counting read transport, and proves
zero additional read calls; list-only safe/unsafe options compile positively
while raw tag-state/exists/query consistency options fail in both Node16 and
Bundler checks. The dry-run publication guard passes without publishing or
handling credentials. `docs/SDT-G71-migration.md` gives the consumer changes
and the 0.x/caret compatibility rationale. G78 owns the staged move of the
runtime `createSekibanCloudTransport` export to the designated
`@sekiban/cloud-client@0.2.0` contract target; this G71 evidence does not claim
that downstream runtime is implemented or published.

## Verification receipts

### Historical W212 receipts

The child GitHub-only lifecycle claim completed before source work:

```json
{"kind":"issue","repo":"J-Tech-Japan/sekiban-dcb-ts","number":146,"mode":"write","proceed":true,"applied":true,"add_labels":["intent-issue-in-progress"],"current_labels":["intent-target"],"errors":[],"warnings":[],"github_only":true}
```

Before the final PR head was created, the following checks passed in the
isolated child worktree (with the default root-owned npm cache bypassed using
`NPM_CONFIG_CACHE=/private/tmp/sdt-g71-npm-cache`):

- `npm run build:packages`.
- Focused `npm run test:g71` (11 contract tests; four required authority/head
  mutants plus lane-forwarding and abort-classification controls all red).
- Adjacent read/query/sample suites: 41 tests passed across 6 files
  (`g13-wire-invariance`, `g57-executor`, `meeting-room`, `query`, `read`, and
  the G71 contract suite).
- Full `npm run test:g64`: matched pack, clean consumer, release-set,
  publish-shape, and publish dry-run guards passed.
- `node scripts/dcb-domain-release-notes.mjs dcb-domain-v0.2.0 ...` and the
  matched release check: passed.
- `npm run lint` and `npm run typecheck`: passed on the final local head.

The historical receipts above describe the original W212 PR head. The W223
review-repair head (before W227's composition additions) had these focused
receipts:

- `npm run test:g71`: build passed, 15 tests passed, the validator self-test
  passed, and all six behavioral product mutants were red with structured
  named-oracle evidence.
- `npm run test:g64:consumer`: packed Node16, Bundler, and esbuild consumer
  compile/runtime receipts passed; the portable snapshot-only receipt passed
  with zero read calls; both unsupported-consistency compile-negative receipts
  failed as expected.
- `npm run lint` and `npm run typecheck`: passed.
- The affected read/query/sample suite passed 45/45 tests. Its existing
  `test/read.spec.ts` identity-conflict fixture emitted a teardown warning
  after the passing result; that out-of-scope test was unchanged.

W227's added composition proof was then run in the same isolated worktree:

- `npm run test:g71`: build passed, both G71 files passed (16/16 tests), the
  structured-validator self-test passed, and all eight behavioral product
  mutants were red. The two new composition mutants each produced status 1,
  exactly one failed named composition oracle, and an assertion mismatch;
  timeout, setup/import, signal/process, missing-oracle, skipped-oracle,
  unrelated-assertion, and green-escape cases remain rejected by the
  validator self-test.
- `npm run lint`, `npm run typecheck`, and `git diff --check`: passed.

The W227 local receipts above were collected before the W231 repair commit;
hosted CI is reported separately against the pushed exact W231 head.

No unchanged full suite was rerun merely for luck.

The historical W212 full local `npm test` observation completed with 5 failed, 812
passed, and 1 skipped test across 97 files. The failures were unchanged
foundation-suite timeout observations: `test/commit.spec.ts:556` at 3,000 ms,
`test/g67-safe-lane.spec.ts:731` at 10,000 ms, both `test/repair.spec.ts:410`
at 15,000 ms and `:481` at 5,000 ms, and `test/tag.spec.ts:401` at 3,000 ms.
That historical run is not re-attributed to W223. An earlier characterization
also observed a transient `commit.spec.ts:384`
timeout, which did not recur in this final run. Two meeting-room fixture
failures in the initial run were caused by the newly required authority call
and were corrected by adding authority responses; the focused meeting-room
suite then passed 8/8 and the final affected-suite run passed. No product
behavior or real timeout guard was weakened to hide the foundation timeouts;
hosted status for W223 is reported separately against its exact repair head.
