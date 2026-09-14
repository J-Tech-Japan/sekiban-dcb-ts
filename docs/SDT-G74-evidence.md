# SDT-G74 implementation evidence

Status: **AC10 gate satisfied by explicit design waivers — ready for PR.**
All three consumers were silent through the design-set review window and raised
no interface contradiction; no consumer agreement is claimed. No merge, npm
publication or release operation is claimed from this checkpoint.

## Provenance and scope

- Delegation: `HOST-LOOP-WAKE-244-IMPLEMENTATION-W281`; the recorded dispatch
  is `reports/host-loop-wake-244.md`. The host record says the G74 claim was
  acquired and verified owned before this implementation delegation.
- Issue: [#151](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/151),
  target `J-Tech-Japan/sekiban-dcb-ts`.
- Branch: `claude/sdt-g74-implementation-w281`, branched from current
  `origin/main` at `a0d6add00fe940dced471fdd5ff14a389c0545df`.
- Prerequisites: G71 merge
  `102d65f545292634cc43022ad4ebb3e0f2adc877`; G78 merge
  `a0d6add00fe940dced471fdd5ff14a389c0545df`, with source head
  `8fd8598dfec0b820d1d44669bc2bb5a2e1cd8940`.
- Scope is declaration/contract freeze only. No runtime or wire behavior,
  SafeWindow, retry, deployment, G77, G80, G81, G82, G83, G84, G85, npm
  publication, release preparation, or Full CI work was performed.

The only source changes are the mechanical Node16 declaration-resolution
imports in `packages/dcb-core/src/materializedView.ts` and
`packages/dcb-client/src/executor.ts`, plus the explicit dcb-client barrel.
The barrel retains the prior executor value/type names and signatures; it does
not remove an export. All other G74 work is scripts, generated model, and
documentation.

## AC1/AC2 — release-shaped public surface

`NPM_CONFIG_CACHE=/private/tmp/g74-w281-npm-cache npm run build:packages` was
used before extraction. `scripts/g74-release-surface.mjs` then runs `npm pack`
for each release package, including domain `prepack`, extracts each tarball,
resolves every `exports` entry with TypeScript `5.9.3` using Node16
module/module-resolution and target ES2022, and creates a strict declaration
program with `skipLibCheck:false`. Runtime namespaces are imported from the
packed tarballs, not from monorepo source aliases.

The reviewed machine model is
`docs/SDT-G74-surface-baseline.json`:

| item | result |
| --- | --- |
| packages | `@sekiban/dcb-core@0.2.0`, `@sekiban/dcb-domain@0.2.0`, `@sekiban/dcb-client@0.2.0` |
| public entry points | core `.`, domain `.`, domain `./testing`, client `.` |
| exported symbols | 277 across four entry points |
| declaration nodes | 281 |
| runtime namespace names | core 19, domain root 61, domain testing 3, client 10 |
| public surface hash | `ebc3da21f00d3a2bcbde5a55548b5226d93e4e6c6ea623142699f94e499e668a` |
| private exclusion | `@sekiban/dcb-runtime` is private, not published, and absent from the release workflow |

The readable companion `docs/SDT-G74-contract.md` has one row for every
exported name. The machine model retains declaration text/file/kind, value/type
namespace and aliases, reachable type text, overload order, generic
constraints/defaults/const, parameter optional/rest/type, return type,
construct signatures, member required/optional/readonly/type, unions,
intersections, tuples, index/conditional/mapped forms, `unknown`/`any`/`never`,
brands/unique symbols, package dependencies, exports-map entries, and module
floor. No assignability-only shortcut is used.

The source-derived executor classification is in
`docs/SDT-G74-export-classification.json`: all 14 executor-module exports are
explicitly classified `public`. The explicit dcb-client barrel is supplemented
by the release-shaped model, so a module-private export cannot silently become
root API.

## AC3 — operation and option matrix

The full readable matrix is in `docs/SDT-G74-contract.md`. The fixed points
are:

| operation | capability/meaning |
| --- | --- |
| `readTagState` | validated tag-state response or typed HTTP/refusal; optional signal; malformed success body is invalid-read-snapshot |
| optional `readTagLatestSortable` | authority existence response when supplied; absent capability is a typed unsupported outcome, never a fabricated boolean |
| `commit` | existing committed/conflict/partial/unknown/refusal mapping; no blind retry change |
| `query` | serialized result only; no generic-query head is fabricated |
| `listQuery` | the only safe/unsafe consistency lane; safe uses the G71 authority/certificate decision and durable head, unsafe reports returned-page reflection |

The matrix also maps `ExecuteCommandOptions`, `ReadOptions`, and
`ListQueryOptions` to their implementation and prerequisite behavioural tests.
The transport promise is adapter-level operations, parameter/return shapes,
signals, service scope, success/refusal/abort/unknown semantics and optional
capability behavior. Identity, extra properties, pooling, fetch internals and
scheduling are not promised.

## AC4/AC5 — drift, root exports, and consumer proof

`node scripts/g74-surface-guard.mjs --self-test` and
`node scripts/g74-drift-mutation-runner.mjs` exercise these red proofs against
the committed untouched baseline: remove export, rename export, parameter
type/position change, return type change, type widening, type narrowing,
public-root export addition, and newly unclassified executor-module export.
The last two are deliberately separate: the classification ledger catches an
unreviewed module export, while a deliberate public-root addition must change
the public model.

`node scripts/g74-packed-consumer-check.mjs` uses clean packed tarballs and a
separate TypeScript `5.9.3` consumer. It compiles the positive core/domain/
client/testing/runtime-adapter/inference fixture under Node16 and Bundler,
checks strict declaration resolution with `skipLibCheck:false`, checks runtime
names from the packed namespaces, and retains two compile-negative receipts:

1. `consistency` is accepted only on `listQuery`; the same option on
   `readState`, `exists`, and `query` is rejected.
2. A package-internal client deep import is rejected through the exports map.

Publication was not performed. The checked candidate is not evidence that a
remote package exists or that a downstream cloud runtime has been implemented.

## AC6 — bounded compatibility policy

The policy is in `docs/SDT-G74-contract.md`. Additive exports/optional fields
and non-breaking overloads require structural, namespace, inference and
exports-map review. Removal/rename, parameter or overload/generic changes,
input narrowing, result-discriminant widening, return/member/brand changes,
required adapter operations, or module/export-resolution changes are breaking;
they require an explicit reviewed baseline and migration note.

Bounded exclusions cover backend choice, pooling/fetch internals, scheduling,
sample/UI/deployment resources, private runtime APIs, undocumented topology,
opaque internal SUID arithmetic, allocator lineage/attempt encoding, and
latency percentiles. They do not waive exposed head round trips, empty/null
meaning, validation/refusal, service isolation, secret non-disclosure, caller
budget/cancellation/wait semantics, or shipped HTTP interoperability.

## AC7/AC8 — dated risks and prerequisite facts

| risk/fact | evidence and disposition |
| --- | --- |
| allocator-to-source ordering | `docs/SDT-G69-evidence.md` W169/W168 history, recorded 2026-09-08: first-arrival fence is not implemented and G69 AC4/AC5 remain open; no ordering guarantee is added here |
| safe-lane latency | `docs/SDT-G66-evidence.md` W164 corrected production window: source `8042cfcbc7cd5ea207473e62d12aa478b2afc990`, 100% traffic, paced 10,000 ms, actual spacings 11,965–12,959 ms, safe response-relative p50/p95 `45,355/55,942 ms`, 10/10 within 180,000 ms; this is dated observed context, not an SLA |
| prerequisites | exact G71/G78 commits above were landed before extraction; their read/cloud semantics are enumerated, not modified |
| registry comparison | packet’s 2026-09-10 receipt records installable matched `0.1.0` packages, no published `0.1.1`, and private runtime; current packed candidate is `0.2.0`; no publication is claimed |

## AC9 — version facts kept separate

The candidate package graph is `0.2.0`; the installable comparison graph is
the matched published `0.1.0` set. Repository `0.1.1` was never published and
is not a migration target. The contract designation is
`executor-facade-v1`, with operator-selected carrying version `0.2.0`. This is
the selected contract version, not an observed npm publication; no package was
published by this task.

## AC10 — consumer consultation and explicit design waivers

The required pre-freeze acknowledgement must be from a named owner and must
identify the exact surface hash
`ebc3da21f00d3a2bcbde5a55548b5226d93e4e6c6ea623142699f94e499e668a`, designated
version `executor-facade-v1`/carrying `0.2.0`, the compatibility policy and the
dated risks, with no interface blocker or a concrete objection.

### Reading after the review window

The design-set review window closed at `2026-09-14T08:11:06Z`, 24 hours after
the consultations were posted. Following the operating rule of not reclassifying
before the deadline, the three threads were read after it, at
`2026-09-14T08:12:14Z`:

| named consumer | consultation comment | posted | comments after consultation | reactions on consultation |
| --- | --- | --- | --- | --- |
| SekibanWasmRuntime [#283](https://github.com/J-Tech-Japan/SekibanWasmRuntime/issues/283) | [5652138647](https://github.com/J-Tech-Japan/SekibanWasmRuntime/issues/283#issuecomment-5652138647) | 2026-09-13T08:11:05Z | 0 | 0 |
| SekibanAsAService [#1914](https://github.com/J-Tech-Japan/SekibanAsAService/issues/1914) | [5652138706](https://github.com/J-Tech-Japan/SekibanAsAService/issues/1914#issuecomment-5652138706) | 2026-09-13T08:11:06Z | 0 | 0 |
| Sekiban [#1172](https://github.com/J-Tech-Japan/sekiban/issues/1172) | [5652138750](https://github.com/J-Tech-Japan/sekiban/issues/1172#issuecomment-5652138750) | 2026-09-13T08:11:06Z | 0 | 0 |

### Disposition

No named owner raised a concrete interface contradiction, so the freeze is not
blocked.

**Silence is not translated into agreement.** The four statuses are kept
separate and none is recorded for any of the three consumers:

| named consumer | `received` | `no-objection` | `agreed` | `adopted` | AC10 disposition |
| --- | --- | --- | --- | --- | --- |
| SekibanWasmRuntime #283 | not recorded | not recorded | not recorded | not recorded | explicit design waiver |
| SekibanAsAService #1914 | not recorded | not recorded | not recorded | not recorded | explicit design waiver |
| Sekiban #1172 | not recorded | not recorded | not recorded | not recorded | explicit design waiver |

### Explicit design waivers (recorded 2026-09-14)

Each of the three consumers carries its own explicit design waiver. Each waiver
names the consumer and lists every unanswered item:

1. a named-owner acknowledgement of receipt;
2. the contract label `executor-facade-v1`;
3. the carrying version `0.2.0`;
4. the public-surface hash
   `ebc3da21f00d3a2bcbde5a55548b5226d93e4e6c6ea623142699f94e499e668a`;
5. the bounded compatibility policy (`docs/SDT-G74-contract.md`, "Compatibility
   policy");
6. the dated risks (`docs/SDT-G74-contract.md`, "Dated risks and prerequisite
   status");
7. a statement of either no interface-level blocker or a specific objection.

The waivers exist so that the freeze does not wait indefinitely, as AC10
requires; they are not a substitute for agreement. The design ruling is recorded
in the host durable history
(`intents/sekiban-dcb-ts/execution/10-post-g41-candidates.md`, ruling of
2026-09-14 08:15 UTC).

The AC10 text lives in string literals of `scripts/g74-contract-document.mjs`,
not in the machine model `docs/SDT-G74-surface-baseline.json`. Updating it
therefore leaves the public-surface hash unchanged at
`ebc3da21f00d3a2bcbde5a55548b5226d93e4e6c6ea623142699f94e499e668a`, which is
the hash the consultations quoted.

### After landing (still owed)

All three consumers are notified with the immutable enumeration, the package
and release status, the migration instructions and the risks. The notification
locations are then recorded here, and `received`, `no-objection`, `agreed` and
`adopted` are recorded separately as each actually arrives. **No notification
has been sent yet**; this unit has not landed.

## AC11 — process and verification disposition

The issue claim preceded source edits and the dedicated branch was based on
current main. Focused commands and their final results are recorded below:

| command | result |
| --- | --- |
| `NPM_CONFIG_CACHE=/private/tmp/g74-w281-npm-cache npm run test:g74:surface` | PASS: release-shaped model hash `ebc3da21f00d3a2bcbde5a55548b5226d93e4e6c6ea623142699f94e499e668a`; 3 packages/4 entry points; surface guard PASS; all eight drift/export proofs `RED_DETECTED` |
| `NPM_CONFIG_CACHE=/private/tmp/g74-w281-npm-cache npm run test:g74:consumer` | PASS: Node16 and Bundler compile status 0; strict declaration resolution status 0 with `skipLibCheck:false`; packed runtime namespaces PASS; unsupported-consistency and exports-map deep-import negatives exited 2 as expected; publication not performed |
| `node scripts/g74-contract-document.mjs --check` | PASS: readable contract matches the machine model and classification ledger |
| `npm run lint` | PASS (`eslint . --max-warnings=0`) |
| `npm run typecheck` | PASS: all package builds and root `tsc --noEmit` |
| `git diff --check` | PASS |

### CI lane wiring (design ruling of 2026-09-14 08:40 UTC)

The branch previously added `test:g74` to `package.json` but no CI lane ran it,
so a later pull request could change the executor surface without any CI
failure. `ci/lanes.json` now carries one foundation entry after
`foundation-g78`:

```
{"id": "foundation-g74", "command": "npm run test:g74"}
```

This is a deliberate addition beyond the packet's explicit criteria, recorded as
such rather than made silently. It adds five G40 step-inventory entries and
removes none; `missingHistoricalWorkflow` stays at 86 and `addedWorkflowSteps`
is unchanged:

| type | added entry |
| --- | --- |
| manifest-command | `npm run test:g74` |
| npm-script | `npm run test:g74:surface && npm run test:g74:consumer && npm run test:g74:contract` |
| npm-script | `npm run build:packages && node scripts/g74-surface-guard.mjs && node scripts/g74-drift-mutation-runner.mjs` |
| npm-script | `npm run build:packages && node scripts/g74-packed-consumer-check.mjs` |
| npm-script | `node scripts/g74-contract-document.mjs --check` |

`docs/evidence/SDT-G40-ci-step-inventory-allowlist.json` changes only in the two
sections the new lane determines, using the exact values the G40 checker
computed:

| section | field | before | after |
| --- | --- | --- | --- |
| `addedManifestCommands` | `count` | 133 | 134 |
| `addedManifestCommands` | `entrySetSha256` | `743813fbed1570719108ea424cac04e11f380a58d450a508791d90e640ee5ec7` | `de3f1d92629c8cc7717832124864bbde1746cd6771359d28ef1f0f00e1d38250` |
| `addedManifestCommands` | `idSetSha256` | `b539371b373ebe29feb972c32ef60a8d4be07586f5a81bc731277154b1910e2c` | `408104385bd7e6fb1f4f4263544ed48a17ff7cbc8ea08511d1bc574cb53674f3` |
| `addedManifestClosure` | `count` | 56 | 60 |
| `addedManifestClosure` | `entrySetSha256` | `46218b54cb6a043c79c0e27a33e655f72d94cf9688ece3578181779829d42d24` | `a9c0ff5858ccba457e2eadc461d91271427e3a741997ef07691b38976b135db7` |
| `addedManifestClosure` | `idSetSha256` | `38df9766c15d18982110140bc8abef1a506ee706079e6a91917179b8e794edea` | `e526d1c7e97da3545ec115468f860bd6e88cdba12a0f5b2261a77517d3b94597` |

No other section, count, digest, guard or `reason` text changed. This is not a
general rebaseline.

Local verification after the change, all exit 0:

| command | result |
| --- | --- |
| `npm run test:g40:tiers` | PASS: coverage self-test, coverage check, mutation-proof self-test, mutation proof, ignored-paths check |
| `npm run test:g74` | PASS: surface hash `ebc3da21f00d3a2bcbde5a55548b5226d93e4e6c6ea623142699f94e499e668a` unchanged; all eight drift/export proofs `RED_DETECTED` |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `git diff --check` | PASS |

With the AC10 gate satisfied by the explicit design waivers above, the branch
is packaged into a pull request that closes #151. `intent-cli worker complete
--outcome pr-created` is emitted immediately after the pull request is created,
followed by one ordinary exact-head PR CI run and an independent review. No
merge is claimed before approval. No Full CI run, manual rerun, npm publication
or release operation is part of this unit.
