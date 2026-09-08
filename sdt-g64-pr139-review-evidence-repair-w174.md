# SDT-G64-PR139-REVIEW-EVIDENCE-REPAIR-W174

Status: completed — both review evidence findings are repaired locally and
the scoped branch is ready for rereview.

## Identity and scope

- PR: [#139](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/139)
- Requested starting head: `0b7a8eb9c67a0026dff33655ab3798bc79831337`
- Source/evidence repair commit: `9ced4bc4ad26a6553499d5fc870ff9800488eee6`
- Branch: `claude/sdt-g64-npm-matched-set-claim-recovery-w174`
- Only release-evidence scripts, the consumer proof, release workflow wiring,
  and evidence documentation changed. Runtime behavior, G22/D1 tests,
  timeout policies, deployment, tags, credentials, and host state were not
  changed.

## F1 — reproducible all-package publish dry-run

Added `scripts/dcb-matched-set-publish-dry-run.mjs` and the
`test:g64:publish-dry-run` script. It runs the exact command below separately
for every package and fails on any nonzero result:

```text
npm publish --dry-run --provenance --access public
```

The order is explicitly core → domain → client. The release workflow invokes
the same script after its pre-publish test gates and before its operator-only
real publish branch. Fresh local receipts were status `0` for all packages:

```text
@sekiban/dcb-core   sekiban-dcb-core-0.1.0.tgz   11.1 kB / 51.6 kB   shasum 229ec62ef961eaa269d2cff226312ebe83c17309
@sekiban/dcb-domain sekiban-dcb-domain-0.1.0.tgz 110.6 kB / 699.4 kB shasum 04fb7cfdc2d3d6682d0ed42162dc2366378f8cee
@sekiban/dcb-client sekiban-dcb-client-0.1.0.tgz 99.7 kB / 638.4 kB shasum e63e66604feee26725a4d8d452a9ab3152e2dc50
```

Each raw npm notice ended with `Publishing to
https://registry.npmjs.org/ with tag latest and public access (dry-run)`.
The domain prepack receipt also passed its declaration preparation. npm only
reported repository URL normalization warnings; no package was published.
The script prints and retains each package's raw stdout/stderr/status rather
than asserting only the manifest order.

## F2 — raw V1 bytes from packaged facade

The clean consumer guard already installs the generated tarballs outside the
workspace under Node16, Bundler, and esbuild. It now captures the actual
`RequestInit.body`, compares its UTF-8 bytes to the expected serialized V1
body, and emits the raw receipt in each of the three runtime executions.

```text
{"version":1,"eventCandidates":[{"payload":"eyJyb29tSWQiOiJyb29tLTEifQ==","eventPayloadName":"RoomOpened","tags":["room:room-1"]}],"consistencyTags":[{"tag":"room:room-1","lastSortableUniqueId":""}]}
```

The asserted raw byte proof is:

```text
utf8 byte length: 199
sha256: 5c46a252c8d4136de1c0d842ba39732cbb58983957488053431639ebfa2c2695
```

This is a byte comparison, not merely a decoded-object comparison; the
Node16, Bundler, and esbuild raw receipts all match.

## Verification

```text
NPM_CONFIG_CACHE=/private/tmp/sdt-g64-npm-cache npm run test:g64
  PASS — build, pack, consumer, release order, all-package publish dry-run
NPM_CONFIG_CACHE=/private/tmp/sdt-g64-npm-cache npm run lint
  PASS
NPM_CONFIG_CACHE=/private/tmp/sdt-g64-npm-cache npm run typecheck
  PASS
git diff --check / staged diff check
  PASS
```

The expected red probes remain present and detected: stray core/client files,
private pre-change manifest, and six Node16/Bundler shipped deep-import probes.
No actual npm publish, tag, credential, deployment, runtime API, G32, or host
operation was performed. The real tag/publish action remains operator-only.
