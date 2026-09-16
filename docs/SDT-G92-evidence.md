# SDT-G92 — domain publish dry-run collision PASS

Issue: [#190](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/190)
Branch: `claude/sdt-g92-domain-dry-run-collision-w901`

## Baseline and scope

- **Pre-change baseline (main):** `7d23ac4dfbb39e5fbc68e20c654e68d8b1eacb0e`
- **G90 precedent:** `scripts/dcb-matched-set-publish-dry-run.mjs` (merge `ce411d4`) already PASSes classified `version-collision` as `outcome: version-already-published`.
- **This slice:** mirror the same collision-only PASS policy in `scripts/dcb-domain-publish-dry-run.mjs`; keep invalid-packaging and other failures fail-closed; no version bump, classifier broadening, or authenticated-publish change.

## AC5 — before (G91 failure on main)

Every PR after `@sekiban/dcb-domain@0.2.0` landed on npm failed `dcb-domain-release-preflight` solely on expected version-collision while other package/consumer checks passed.

| Field | Value |
| --- | --- |
| PR / head | G91 `51e2686` |
| Workflow run | [35111022002](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35111022002) |
| Step | Credential-free release-path dry-run proof |
| Classified kind | `version-collision` |
| Package / version | `@sekiban/dcb-domain@0.2.0` |
| Pre-G92 status | `FAIL` (exit 1) |

Collected failure excerpt:

```json
{
  "status": "FAIL",
  "failure": {
    "kind": "version-collision",
    "packageName": "@sekiban/dcb-domain",
    "version": "0.2.0",
    "reason": "target package version is already published"
  }
}
```

npm stderr (truncated): `npm error You cannot publish over the previously published versions: 0.2.0.`

## AC3 — local self-test fixtures

`node scripts/dcb-domain-publish-dry-run.mjs --self-test` (2026-09-16):

```json
{
  "status": "PASS",
  "guard": "dcb-domain-publish-dry-run",
  "fixtures": {
    "versionCollision": { "result": "pass", "outcome": "version-already-published" },
    "invalidPackaging": { "result": "fail", "kind": "invalid-packaging" },
    "genericFailure": { "result": "fail", "kind": "publish-or-environment-failure" }
  }
}
```

Classifier red mutant (`broken-manifest-as-version-collision`) remains correct via `npm-publish-dry-run-classifier.mjs --self-test`.

## AC5 — after (G92 PR preflight green)

| Field | Value |
| --- | --- |
| PR | [#191](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/191) |
| Final head | `d8b7026` |
| Workflow run | [35113543488](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35113543488) |
| Step | Credential-free release-path dry-run proof |
| Post-G92 status | `PASS` (exit 0) |
| Outcome | `version-already-published` |
| Package / version | `@sekiban/dcb-domain@0.2.0` |

Collected success excerpt:

```json
{
  "status": "PASS",
  "guard": "dcb-domain-publish-dry-run",
  "outcome": "version-already-published",
  "failure": {
    "kind": "version-collision",
    "packageName": "@sekiban/dcb-domain",
    "version": "0.2.0",
    "reason": "target package version is already published"
  }
}
```

Hosted lane summary on final head `d8b7026`:

| Lane | Run | Result |
| --- | --- | --- |
| `dcb-domain-release-preflight` | [35113543488](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35113543488) | **success** |
| `ci-pr-cheap` | [35113543397](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35113543397) job [104853091281](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35113543397/job/104853091281) | **success** |
| `ci-foundation` | [35113543397](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35113543397) job [104853090930](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35113543397/job/104853090930) | failure (`CALIBRATION_INCONCLUSIVE` residual 44.125 > bound 7; unrelated to this script-only slice) |

## AC4 — caller consistency

Both credential-free domain dry-run call sites invoke the shared script unchanged:

- `.github/workflows/dcb-domain-release-preflight.yml`
- `.github/workflows/release-dcb-domain.yml`

Authenticated publish in `release-dcb-domain.yml` (`npm publish --provenance --access public`) is untouched and remains fail-closed on duplicates.
