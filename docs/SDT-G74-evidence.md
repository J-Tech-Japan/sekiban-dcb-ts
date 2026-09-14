# SDT-G74 implementation evidence

Status: **blocked on prerequisite units; AC10 open.** A second independent
review (head `0de5b2d1787ea275d519b85a9caca5feabc510a2`) and an audit of every
option in the three packages found declared options that nothing implements and
behaviour defects. By design ruling (host history, 2026-09-14 12:40 UTC) they are
fixed by SDT-G88, SDT-G86, SDT-G87 and SDT-G89 before this unit freezes the
surface. The surface hash will change when those land; the consumers are
consulted only on the final hash. Sections below describe the extractor and
proofs at this head; the option matrix, the 0.1.0 comparison and the hash are
rewritten after the prerequisites land. No merge, npm publication or release
operation is claimed.

## Provenance and scope

- Delegation: `HOST-LOOP-WAKE-244-IMPLEMENTATION-W281`; the recorded dispatch
  is `reports/host-loop-wake-244.md`. The host record says the G74 claim was
  acquired and verified owned before this implementation delegation.
- Continuation: from 2026-09-14 the operator directed the design seat to carry
  the remaining G74 work in one thread, with independent review by a separate
  agent. The review of head `f008fedbcfd00d3ab61030a45c732f9ff3112a7a` returned
  REQUEST-UPDATE with seven blocking findings (B1–B7) and nine non-blocking ones
  (N1–N9); the design ruling that accepted them is recorded in the host history
  (`intents/sekiban-dcb-ts/execution/10-post-g41-candidates.md`, 2026-09-14
  09:15 UTC).
- Issue: [#151](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/151),
  target `J-Tech-Japan/sekiban-dcb-ts`; pull request
  [#176](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/176).
- Branch: `claude/sdt-g74-implementation-w281`, branched from `origin/main` at
  `a0d6add00fe940dced471fdd5ff14a389c0545df`; `origin/main` had not moved when
  this update was made.
- Prerequisites: G71 merge `102d65f545292634cc43022ad4ebb3e0f2adc877`; G78
  merge `a0d6add00fe940dced471fdd5ff14a389c0545df`, with source head
  `8fd8598dfec0b820d1d44669bc2bb5a2e1cd8940`.
- Scope is declaration/contract freeze only. No runtime or wire behavior,
  SafeWindow, retry, deployment, G77, G80–G85, npm publication, release
  preparation, or Full CI work was performed.

The only package source changes are the mechanical Node16 declaration-resolution
imports in `packages/dcb-core/src/materializedView.ts` and
`packages/dcb-client/src/executor.ts`, plus the explicit dcb-client barrel. All
other G74 work is scripts, the generated model, documentation, and one CI lane.

## Review findings and their disposition

| finding | disposition in this update |
| --- | --- |
| B1 reachable non-exported types and package facts missing | the extractor records every declaration reachable from a public signature inside the packed packages (type references, heritage clauses, type queries, import types, computed member names), and the module type, Node floor and every export condition |
| B2 drift proofs never touched the artifact; missing proofs | thirteen mutants edit the extracted release artifact and re-run the real extractor; adapter-required-member, public-root addition, reachable-type and brand mutants included; labelled exhaustiveness and inference compile tests with five declaration mutants |
| B3 no comparison with 0.1.0, no registry recheck | difference table with migration instructions below, produced by extracting tag `dcb-v0.1.0`; registry rechecked at 2026-09-14T09:23:55Z |
| B4 no stronger 0.x policy or break signal | contract identity and 0.x carrier policy in the contract's "Compatibility policy" |
| B5 G71 capability recorded wrongly; incomplete matrix | capability requirement corrected; every declared option has a row with test paths or an explicit "no test" |
| B6 stale ordering-gap status; undated latency | corrected with issue links and dates; latency dated to its run window |
| B7 extractor overwrote the Node binary without `--output` | fixed; a missing flag means stdout, a flag without a path exits 2 |
| N1 hash changed for non-API reasons | normalized in one shared function (see AC1/AC2) |
| N2 loose consistency negative | one labelled rejection per call |
| N3 guard left temp directories in the repository | temp directories now live under the OS temp directory with `finally` cleanup; the stray `.g74-surface-guard-jeiZSr` (2026-09-13) was removed |
| N4 AC10 loose ends | reconciled under AC10 below |
| N5 label and version blurred | the label, the carrying version and a publication are named separately throughout |
| N6 AC5 proof not recorded | recorded under AC5 below |
| N7 ledger approved by its author | the ledger now records a proposal and names the pull-request review as the approval |
| N8 host review-context numbering drift | host packet issue, not changed here; the packet ACs were walked directly |
| N9 foundation lane installs `typescript@5.9.3` from the registry | unchanged; G78 already does the same |

## AC1/AC2 — release-shaped public surface

`scripts/g74-release-surface.mjs` runs `npm pack` for each release package,
including domain `prepack`, extracts each tarball, resolves every `exports`
entry with TypeScript `5.9.3` using Node16 module/module-resolution and target
ES2022, and creates a strict declaration program with `skipLibCheck:false`.
Runtime namespaces are imported from the packed tarballs, not from monorepo
source aliases. Without `--output` it prints the model to stdout and writes no
file.

The reviewed machine model is `docs/SDT-G74-surface-baseline.json`, schema
`sdt-g74-surface/v2`:

| item | result |
| --- | --- |
| packages | `@sekiban/dcb-core@0.2.0`, `@sekiban/dcb-domain@0.2.0`, `@sekiban/dcb-client@0.2.0` |
| package facts | all three `"type": "module"`, Node `>=20`, export conditions `import` and `types` on every entry |
| public entry points | core `.`, domain `.`, domain `./testing`, client `.` |
| exported symbols | 277 across four entry points |
| declaration nodes | 281 |
| reachable non-exported declarations | 8 named (`CommandLike`, `LegacyDomainDefinition`, `LegacyEventDefinition`, and five `unique symbol` brand constants) plus 171 type parameters |
| runtime namespace names | core 19, domain root 61, domain testing 3, client 10 |
| public surface hash | `0c87402de0a3e8a3c894fe73d33506f44789fac6e027728dc90e2c69a573ffce` |
| private exclusion | `@sekiban/dcb-runtime` is private, not published, and absent from the release workflow |

**Hash normalization.** `scripts/g74-surface-hash.mjs` is the one function the
extractor and the guard share. It removes package and entry-point `version`,
the `alias` flag of re-exported symbols, and the numeric suffix of TypeScript's
internal symbol names (`__@tagFamilyBrand@40872` → `__@tagFamilyBrand`), and it
replaces the intra-scope `@sekiban` dependency ranges with one marker. Everything
else participates. The hash was stable across repeated extractions.

**Hash history.** The first consultation quoted
`ebc3da21f00d3a2bcbde5a55548b5226d93e4e6c6ea623142699f94e499e668a`, a hash of the
entry points only. After B1 and N1 the hash became
`03d2134a8b5777ddb6719f93e3e7f49c2ec39f92a4112d405276760a1f6910c5`. Covering
computed member names then added exactly the five brand constants to the
reachable declarations, with no other model change, giving the current
`0c87402de0a3e8a3c894fe73d33506f44789fac6e027728dc90e2c69a573ffce`. Only the
current hash is consulted on.

The readable companion `docs/SDT-G74-contract.md` has one row for every
exported name and one for every named reachable declaration. No
assignability-only shortcut is used.

## AC3 — operation and option matrix

The full matrix is in `docs/SDT-G74-contract.md`. The corrected capability
statement: `readTagLatestSortable` is optional in the type, but `readState`,
`exists`, and a read-through `execute` that has to read a tag its supplied
snapshots do not cover all fail with `ClientError` `unsupported_capability`,
status `501`, without it (`packages/dcb-client/src/executor.ts` `readAuthority`;
asserted at `test/g71-read-contract.spec.ts:383`). `query`, `listQuery`,
`commit` and a snapshot-only `execute` do not use it.

Two defects were found while completing the matrix. G74 does not change runtime
behaviour, so by design ruling SDT-G86 fixes them before the freeze:

- `ExecuteCommandOptions.totalBudgetMs` is declared but not read by
  `SekibanExecutor.execute`, exactly as in 0.1.0; only `ClaimLedgerExecutor`
  enforces a total budget.
- `ExecuteCommandOptions.signal` reaches `transport.commit` only; the reads a
  read-through `execute` makes do not receive it.

Rows without a dedicated test say so: `ExecuteCommandOptions.signal`,
`ExecuteCommandOptions.totalBudgetMs` on the executor, `ListQueryOptions.signal`,
the value of `options.clock`, and the lower-case `runtime` binding form.

## AC4 — drift proofs against the release artifact

`node scripts/g74-drift-mutation-runner.mjs` packs once, proves an unmutated
extraction reproduces the baseline hash (`REPRODUCES_BASELINE`), then edits the
extracted artifact for each mutant with an exact expected match count and
re-runs the real extractor. Result of the final local run: 13 of 13 `RED`,
none `MISSED` or `INVALID`.

| mutant | category |
| --- | --- |
| `removed-export` | removal |
| `renamed-export` | rename |
| `parameter-change` | parameter |
| `return-change` | return |
| `type-widening` | type |
| `type-narrowing` | type |
| `public-root-export-addition` | export addition through the public root |
| `adapter-optional-member-required` | adapter contract |
| `reachable-nonexported-optional-to-required` | reachable type (the reviewer's first passing probe) |
| `reachable-nonexported-parameter-widening` | reachable type (the reviewer's second passing probe) |
| `brand-identity-collapse` | brand |
| `engine-floor-change` | package fact |
| `export-condition-addition` | package fact |

A module-type flip is not a resolvable artifact (TS1479), so the runner proves
on the model that flipping it moves the hash (`package-module-type-participates`,
`HOLDS`) and that changing every version number does not
(`version-number-excluded`, `HOLDS`). The source classification check requires
a newly unclassified executor-module export to be `RED_DETECTED`. The guard's
in-memory JSON cases are reported as `comparatorTests` and are not counted as
drift proofs.

## AC5 — explicit barrel, with proof

The dcb-client root re-exports the executor module by name, separating runtime
exports from type-only ones. To prove the conversion is mechanical, the barrel
was temporarily reverted to `export * from "./executor.js"`, the packages were
rebuilt, and the surface was extracted:

| comparison | result |
| --- | --- |
| complete model, wildcard barrel against explicit barrel | 14 differences, all `entryPoints[].symbols[].namespace.alias` on the 14 executor exports (`false` → `true`) |
| names, signatures, members, reachable declarations, runtime names, package facts | identical |
| normalized surface hash | identical: `03d2134a8b5777ddb6719f93e3e7f49c2ec39f92a4112d405276760a1f6910c5` on both (measured before the brand coverage was added; that addition does not touch the barrel) |

The source file was restored afterwards and the packages rebuilt. All 14
executor exports are classified `public` in
`docs/SDT-G74-export-classification.json`. That file records a proposal by the
implementation; the classification is accepted only through the independent
review of pull request #176.

## Packed consumer proof

`node scripts/g74-packed-consumer-check.mjs` installs clean packed tarballs into
a separate directory with TypeScript `5.9.3`:

- the positive core/domain/client/testing/adapter/inference fixture compiles
  under Node16 and Bundler, and strict declaration resolution passes with
  `skipLibCheck:false`;
- runtime names are checked from the packed namespaces;
- `src/expected-errors.ts` compiles as written in all three configurations while
  carrying eleven labelled `@ts-expect-error` rejections, and the same file with
  the directives blanked fails on exactly those eleven lines with the named
  diagnostic:

| label | diagnostic required |
| --- | --- |
| `readState-rejects-consistency` | TS2353, `consistency` not in `ReadOptions` |
| `exists-rejects-consistency` | TS2353, `consistency` not in `ReadOptions` |
| `query-rejects-consistency` | TS2353, `consistency` not in `ReadOptions` |
| `facade-kind-is-not-bare-string` | TS2322 on the identity assertion |
| `executor-result-kind-is-not-bare-string` | TS2322 on the identity assertion |
| `facade-switch-missing-invalid-is-not-exhaustive` | TS2322, `ExecuteInvalid` not assignable to `never` |
| `executor-result-switch-missing-partial-is-not-exhaustive` | TS2322, `ExecutePartial` not assignable to `never` |
| `tagFamily-does-not-widen-family` | TS2322 on the identity assertion |
| `tag-does-not-widen-family` | TS2322 on the identity assertion |
| `event-does-not-widen-name` | TS2322 on the identity assertion |
| `tag-families-do-not-mix` | TS2322, `Tag<"room">` not assignable to `Tag<"user">` |

- five declaration mutants applied to the installed packages each turn that
  fixture red inside the fixture, and restoring the files compiles it again:
  `consistency-added-to-read-options`, `result-variant-added`,
  `result-discriminant-widened-to-string`, `tagFamily-literal-inference-lost`,
  `event-name-literal-inference-lost`;
- a control file proves an unused `@ts-expect-error` is TS2578 under this
  toolchain;
- a package-internal client deep import is rejected through the exports map.

The identity assertions use `(<T>() => T extends A ? 1 : 2) extends (<T>() => T
extends B ? 1 : 2)`, which distinguishes `any`, unions and variance where
mutual assignability would not. Publication was not performed.

## AC6 — bounded compatibility policy

The policy is in `docs/SDT-G74-contract.md`. It now states the contract identity
(label plus surface hash) and a 0.x carrier policy independent of the number:
`0.2.x` patches keep the label and the hash; any reviewed surface change moves
to a new minor; a breaking change moves the label to `executor-facade-v2`, the
version to a new minor while on 0.x, records the new hash and ships a migration
note. Bounded exclusions are unchanged and do not waive exposed head round
trips, empty/null meaning, validation/refusal, service isolation, secret
non-disclosure, caller budget/cancellation/wait semantics, or shipped HTTP
interoperability.

## AC7/AC8 — dated risks and prerequisite facts

| risk/fact | evidence and disposition |
| --- | --- |
| allocator-to-source ordering | G69 [#133](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/133) closed `not_planned` 2026-09-10T09:22:54Z after the 2026-09-10T00:36:57Z design ruling (AC1 negative; AC4/AC5 ruled out); G70 [#137](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/137) closed `not_planned` 2026-09-09T09:27:56Z; the gap is carried by G77 [#154](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/154), open at 2026-09-14T09:23:55Z. No ordering guarantee is added. The first consultation carried the earlier, wrong wording |
| safe-lane latency | run `sdtg66w164-8042cfc`, 2026-09-07T19:17:49.862Z–19:20:30.920Z, source `8042cfcbc7cd5ea207473e62d12aa478b2afc990`, receipt `.artifacts/sdt-g66-w164-production-corrected.json` (`docs/SDT-G66-evidence.md`, published by #135): safe response-relative p50/p95 `45,355/55,942 ms`, 10/10 within 180,000 ms. Not re-measured at this candidate; not an SLA |
| cloud transport target | `@sekiban/cloud-client` E404 at 2026-09-14T09:23:55Z |
| prerequisites | exact G71/G78 commits above were landed before extraction; their read/cloud semantics are enumerated, not modified |
| registry | at 2026-09-14T09:23:55Z `npm view <name> versions` listed only `0.1.0` for core, domain and client; `@sekiban/dcb-runtime` E404 |

## AC9 — version comparison against 0.1.0

The contract label is `executor-facade-v1`; the carrying package version
selected for it is `0.2.0`; no publication has been observed or performed.
Repository `0.1.1` was never published and is not a migration target.

**Method.** A detached worktree at tag `dcb-v0.1.0`
(`7353b987e94a999d60ec6b41b1df2387efb11ac5`, the commit `docs/SDT-G64-evidence.md`
records the matched 0.1.0 release as published from) was installed with
`npm ci`, built, and extracted with the current extractor and normalization.
0.1.0 fails strict Node16 declaration resolution (TS2835, two errors), so for
this comparison only a scratch copy of the extractor reported those errors
instead of stopping. The published tarballs were not downloaded, so the
comparison is against the tag's build, not the registry bytes. A separate probe
built from the same tag showed that under Node16 with `skipLibCheck`,
`ExecuteCommandResult` and the `listQuery` request parameter are `any`, and under
Bundler both are fully typed.

| difference | 0.1.0 | 0.2.0 candidate | migration instruction |
| --- | --- | --- | --- |
| cloud transport factory | `createSekibanCloudTransport(options: SekibanCloudTransportOptions): SerializedDcbTransport` exported from `@sekiban/dcb-client` | removed from the root and the runtime namespace; the `SekibanCloudTransportOptions` type remains, same shape | import `createSekibanCloudTransport` from `@sekiban/cloud-client@0.2.0` (G78 ruling, 2026-09-12); that package is not yet published |
| read consistency | `ReadOptions.consistency?: "safe" \| "unsafe"`, also taken by `listQuery`, forwarded nowhere | `ReadOptions` has only `signal`; `listQuery` takes `ListQueryOptions`; `ReadConsistency` exported | remove `consistency` from `readState`, `exists`, `query`; pass it to `listQuery`, where it now selects the lane |
| existence and capability | `readState` derived `exists` from a payload `status: "empty"` sentinel and read tag-state only; `exists` failed with code `transport` without `readTagLatestSortable` | `readState`, `exists`, read-through `execute` use the authority and fail `unsupported_capability` / `501` without it | custom adapters implement `readTagLatestSortable`; match `unsupported_capability` instead of `transport` |
| Node16 declarations | `./index` imports without extension in client `executor.d.ts` and core `materializedView.d.ts` (TS2835) | `./index.js` | Node16 consumers narrow on `kind` where they relied on `any` |
| additive | — | `createHttpTransport` `serviceId?`; `ListQueryResponse.readHead?` | none |
| core, domain, domain/testing | — | no surface difference after normalization; client depends on core and domain at exactly `0.2.0` | upgrade the three together |

## AC10 — consumer consultation

### Requirement

Each consuming team's named owner acknowledges receipt of the exact surface
hash, the contract label `executor-facade-v1` and the carrying version `0.2.0`,
together with the compatibility and risk statement, and records either no
interface-level blocker or a specific objection. Silence past a design-set
window becomes an explicit design waiver listing the unanswered items, never
agreement. A concrete interface contradiction blocks the freeze.

### First consultation and the withdrawn waivers

| consumer | consultation comment | posted | outcome |
| --- | --- | --- | --- |
| SekibanWasmRuntime [#283](https://github.com/J-Tech-Japan/SekibanWasmRuntime/issues/283) | [5652138647](https://github.com/J-Tech-Japan/SekibanWasmRuntime/issues/283#issuecomment-5652138647) | 2026-09-13T08:11:05Z | silent through 2026-09-14T08:11:06Z; waiver recorded, then withdrawn |
| SekibanAsAService [#1914](https://github.com/J-Tech-Japan/SekibanAsAService/issues/1914) | [5652138706](https://github.com/J-Tech-Japan/SekibanAsAService/issues/1914#issuecomment-5652138706) | 2026-09-13T08:11:06Z | silent through 2026-09-14T08:11:06Z; waiver recorded, then withdrawn |
| Sekiban [#1172](https://github.com/J-Tech-Japan/sekiban/issues/1172) | [5652138750](https://github.com/J-Tech-Japan/sekiban/issues/1172#issuecomment-5652138750) | 2026-09-13T08:11:06Z | the issue had been closed since 2026-09-02T18:36:07Z; waiver recorded, then withdrawn |

The waivers recorded at 2026-09-14 08:15 UTC were withdrawn at 09:15 UTC because
the consultation was defective in three independent ways: it quoted
`ebc3da21…e668a`, which is not the hash being frozen; it described the
ordering-gap risk wrongly; and one of the three was posted to a closed issue.
Silence on that consultation cannot support a waiver.

Three further loose ends are reconciled here, each checked against the posted
comments. The first consultation's text said "A missing response is not
relabelled as agreement or a waiver", while AC10 provides for an explicit waiver
after the window; the re-consultation states the AC10 rule as written. Its
deadline line read `RESPONSE_DEADLINE_UTC` when posted at 08:11:05Z and was
edited to the deadline at 08:11:24Z (GitHub edit history); the re-consultation
carries its deadline in the posted text. It also dated the safe-lane latency
window 2026-09-08, while the run was on 2026-09-07.

### Re-consultation

Pending: it is posted after the independent re-review of this update, on the
hash above, to open and watched issues, with a new window. Its locations, window
and each consumer's separate `received`, `no-objection`, `agreed` and `adopted`
statuses are recorded here as they actually arrive.

| consumer | consultation location | window closes | `received` | `no-objection` | `agreed` | `adopted` |
| --- | --- | --- | --- | --- | --- | --- |
| SekibanWasmRuntime | not yet posted | — | not recorded | not recorded | not recorded | not recorded |
| SekibanAsAService | not yet posted | — | not recorded | not recorded | not recorded | not recorded |
| Sekiban | not yet posted (a new issue, because #1172 is closed) | — | not recorded | not recorded | not recorded | not recorded |

### After landing (still owed)

All three consumers are notified with the immutable enumeration, the package and
release status, the migration instructions and the risks, including the note that
the first consultation carried the earlier ordering-gap wording, through open
channels. No notification has been sent; this unit has not landed.

## AC11 — process and CI

The issue claim preceded source edits and the dedicated branch was based on
current main. The `foundation-g74` lane added on 2026-09-14 (design ruling 08:40
UTC) runs `npm run test:g74` in hosted CI:

```
{"id": "foundation-g74", "command": "npm run test:g74"}
```

It added five G40 step-inventory entries and removed none, and
`docs/evidence/SDT-G40-ci-step-inventory-allowlist.json` changed only in
`addedManifestCommands` (count 133 → 134, entrySetSha256
`de3f1d92629c8cc7717832124864bbde1746cd6771359d28ef1f0f00e1d38250`, idSetSha256
`408104385bd7e6fb1f4f4263544ed48a17ff7cbc8ea08511d1bc574cb53674f3`) and
`addedManifestClosure` (count 56 → 60, entrySetSha256
`a9c0ff5858ccba457e2eadc461d91271427e3a741997ef07691b38976b135db7`, idSetSha256
`e526d1c7e97da3545ec115468f860bd6e88cdba12a0f5b2261a77517d3b94597`). This update
changes no npm script, so those values stand. The earlier ruling's claim that the
lane enforced the freeze was an overstatement until B1 and B2 were fixed; it is
true of this update.

### Local verification of this update

Run on 2026-09-14 against the working tree committed in this update, all exit 0:

| command | result |
| --- | --- |
| `npm run test:g74` | surface guard PASS at `0c87402de0a3e8a3c894fe73d33506f44789fac6e027728dc90e2c69a573ffce`; positive control `REPRODUCES_BASELINE`; artifact mutants 13 of 13 `RED`; both hash-participation proofs `HOLDS`; `unclassified-executor-export` `RED_DETECTED`; packed consumer Node16, Bundler and strict (`skipLibCheck:false`) status 0; 11 labelled rejections matched; consumer declaration mutants 5 of 5 `RED` and restored control status 0; TS2578 control and deep-import negative both exited 2; runtime namespaces PASS; contract `--check` PASS |
| `npm run test:g40:tiers` | coverage self-test, coverage check, mutation-proof self-test, mutation proof and ignored-paths check |
| `npm run lint` | `eslint . --max-warnings=0` |
| `npm run typecheck` | all package builds and root `tsc --noEmit` |
| `git diff --check origin/main` | no whitespace errors |
