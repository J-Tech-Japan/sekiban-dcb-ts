# SDT-G74 implementation evidence

Status: **QUESTION — AC10 is not satisfied by the available consumer records.**
No contract freeze, PR, hosted CI run, npm publication, release operation, or
merge is claimed from this checkpoint.

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

## AC10 — consumer consultation blocker

The required pre-freeze acknowledgement must be from a named owner and must
identify the exact surface hash
`ebc3da21f00d3a2bcbde5a55548b5226d93e4e6c6ea623142699f94e499e668a`, designated
version `executor-facade-v1`/carrying `0.2.0`, the compatibility policy and the
dated risks, with no interface blocker or a concrete objection. The available
records do not meet that contract:

| named consumer | available record | status for AC10 | missing fact |
| --- | --- | --- | --- |
| SekibanWasmRuntime [#283](https://github.com/J-Tech-Japan/SekibanWasmRuntime/issues/283) | facade/G57/G64 shape discussion | `missing-exact-acknowledgement` | named owner, exact hash/version, policy/risk acknowledgement |
| SekibanAsAService [#1914](https://github.com/J-Tech-Japan/SekibanAsAService/issues/1914) | AGREE to cloud/API shape | `missing-exact-acknowledgement` | named owner, exact hash/version, policy/risk acknowledgement |
| Sekiban [#1172](https://github.com/J-Tech-Japan/sekiban/issues/1172) | G57 facade no-objection comment | `missing-exact-acknowledgement` | named owner, exact hash/version, policy/risk acknowledgement |

These records are not relabelled as `received`, `no-objection`, `agreed`, or
`adopted`. No explicit design-waiver receipt listing the unanswered items is
present in the dispatch/issue material available to this seat. This is a
concrete design question, not a claim that any consumer objects; rollout
unreadiness would not itself block the freeze, but the required acknowledgement
or waiver is absent.

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

Because AC10 is unresolved, no PR was created, no `Closes #151` PR receipt or
worker `pr-created` completion exists, and no hosted exact-head CI was run.
The correct next step is design disposition: obtain the three exact
acknowledgements or authorize an explicit waiver listing each unanswered
item. After that disposition, a PR and ordinary exact-head CI can be created
without inventing agreement or hosted evidence.
