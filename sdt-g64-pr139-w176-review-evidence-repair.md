# SDT-G64-PR139-W176-REVIEW-EVIDENCE-REPAIR

Status: completed — the two review gaps on PR #139 are repaired in the
existing branch, with no package publication, tag, credential, deployment, or
merge operation.

## Identity

- PR: [#139](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/139)
- Issue: [#120](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/120)
- Branch: `claude/sdt-g64-npm-matched-set-claim-recovery-w174`
- Review repair starting head: `2ebf12b8701dad118c4585df4778d046c7650df6`
- Scoped repair head: `f7b4b84951fcfe8d766c6bda58b20b959c33821b`
- Review: `5146205637`
- PR body updated through `gh pr edit --body-file` to match this receipt.

## F1 — raw V1 byte negative/red proof

`scripts/dcb-matched-set-consumer-check.mjs` already exercised the real
packaged facade against a fake fetch and captured the actual
`RequestInit.body`. This repair adds a negative proof to that same execution:

1. The clean consumer captures the committed V1 body and the positive
   UTF-8-byte comparison passes.
2. The guard injects one whitespace byte before `eventCandidates` in that
   captured body. `JSON.parse` produces the same object, proving this is a
   serialization-only mutation.
3. The raw-byte assertion rejects the mutation with
   `V1 raw-byte mismatch`, recorded as `RED_DETECTED`.
4. The unmutated body then passes in Node16, Bundler, and esbuild consumers.

Focused output included three `rawByteMutationReceipt` records with:

```text
status=RED_DETECTED
parsedJsonUnchanged=true
reason=V1 raw-byte mismatch
```

The positive body remains:

```text
{"version":1,"eventCandidates":[{"payload":"eyJyb29tSWQiOiJyb29tLTEifQ==","eventPayloadName":"RoomOpened","tags":["room:room-1"]}],"consistencyTags":[{"tag":"room:room-1","lastSortableUniqueId":""}]}
```

Its UTF-8 length is `199` and SHA-256 is
`5c46a252c8d4136de1c0d842ba39732cbb58983957488053431639ebfa2c2695`.
This is proof code only; no production transport behavior changed.

## F2 — acceptance and G22 audit wording

The evidence and PR body now map proof to the actual issue-#120 clauses:

| Issue clause | Published proof |
| --- | --- |
| AC1 publishable manifests | Public matched metadata, exports, README/LICENSE allowlist, and package shape for core, domain, and client. |
| AC2 dependency correctness | Exact matched core/domain runtime dependencies for client and no workspace/file/link specifiers. |
| AC3 tarball guards | Exact `npm pack --dry-run --json` allowlists, size bounds, and stray-file red probes. |
| AC4 clean consumer | Node16, Bundler, and esbuild packaged consumer execution, official V1 raw bytes, and negative deep-import proofs. |
| AC5 release workflow | Version/tag validation, pre-publish test gates, dependency-ordered credential-free dry-run, and operator-only real publish branches. |
| AC6 downstream-consumer documentation | Matched install/release procedure for the SekibanWasmRuntime consumer. |
| AC7 scope boundary | Runtime APIs, runtime package, sample, existing guards, deployment, credentials, tags, and real publish remain outside this change. |
| AC8 lifecycle | Dedicated branch, non-draft PR, canonical lifecycle receipts, exact-head CI, and evidence. |

The W176 G22 audit is also explicit. Hosted job
`102174375025` belonged to `ci-g21-g25`, not `ci-local-e2e`, and failed because
Miniflare D1 `.all()` returned driver-only `meta.duration` `1` versus `0`.
The authorized repair in `test/g22-bootstrap-d1.spec.ts` excludes only
driver-only timing metadata from the diagnostic envelope comparison and keeps
all semantic fields, canonical-key divergence behavior, and zero-mutation
assertions. It is a test-quality comparison normalization, not a runtime or
package-resolution change. The repository audit found no other same-shape
semantic D1 result comparison requiring this normalization.

The PR body no longer claims that no assertion changed; it acknowledges this
authorized G22 comparison repair and does not call the failure a local-e2e
failure.

## Verification

```text
NPM_CONFIG_CACHE=/private/tmp/sdt-g64-npm-cache npm run test:g64:consumer  PASS
  Node16/Bundler/esbuild green; actual captured-body whitespace mutation
  parsed identically and was RED_DETECTED by the byte assertion.

NPM_CONFIG_CACHE=/private/tmp/sdt-g64-npm-cache npm run test:g64           PASS
NPM_CONFIG_CACHE=/private/tmp/sdt-g64-npm-cache npm run lint             PASS
NPM_CONFIG_CACHE=/private/tmp/sdt-g64-npm-cache npm run typecheck        PASS
NPM_CONFIG_CACHE=/private/tmp/sdt-g64-npm-cache npm run test:g22         PASS (2 files, 7 tests)
NPM_CONFIG_CACHE=/private/tmp/sdt-g64-npm-cache npm run test:g59         PASS
node scripts/g40-ci-coverage-check.mjs                                 PASS
git diff --check                                                         PASS
```

The matched-set gate retained all earlier package, tarball, deep-import,
release-order, and dry-run checks. No actual `npm publish`, tag push,
credential creation, deployment, G32 operation, merge, or issue closure was
performed. The existing PR remains open and non-draft.

The prior exact-head run `34265431951` was terminal green at the starting
head. A fresh exact-head run for `f7b4b84951fcfe8d766c6bda58b20b959c33821b`
was requested by this push; its terminal result and URL are reported with the
canonical handoff.
