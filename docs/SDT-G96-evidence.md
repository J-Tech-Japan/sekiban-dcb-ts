# SDT-G96 — wire test:g93 into PR cheap lane

Issue: [#198](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/198)
Branch: `claude/sdt-g96-wire-g93-cheap-w901`

## Baseline and scope

- **Pre-change baseline (main):** `809948a` (includes SDT-G93 guard script and `npm run test:g93`, but no cheap-lane registration).
- **G93 review non-blocking note:** `test:g93` was not invoked by `ci/lanes.json`; operator chose option A (wire into cheap).
- **This slice:** register `{ "id": "g93", "command": "npm run test:g93" }` in the cheap lane after g72; extend cheap `affectedPaths` with `.github/workflows/**` and `ci/lanes.json`. No Action major, package URL, version, or publish changes.

## AC1 — cheap.commands registration

`ci/lanes.json` cheap lane now includes g93 adjacent to g64/g72:

```json
{"id": "g64", "command": "npm run test:g64"},
{"id": "g72", "command": "npm run test:g72:trusted-publishing"},
{"id": "g93", "command": "npm run test:g93"},
```

## AC2 — cheap.affectedPaths

Extended with `.github/workflows/**` and `ci/lanes.json` so workflow pin reverts and lanes edits select the cheap lane under `ci:local` path filtering.

## AC3 — local guard output

`npm run test:g93` (2026-09-16):

```text
> serialized-dcb-v1-runtime@0.1.0 test:g93
> node scripts/sdt-g93-workflow-package-guard.mjs

{
  "status": "PASS",
  "guard": "sdt-g93-workflow-package",
  "workflow": {
    "workflowFiles": [
      "ci-full.yml",
      "ci.yml",
      "dcb-domain-release-preflight.yml",
      "release-dcb-domain.yml",
      "release-dcb-matched-set.yml"
    ],
    "counts": {
      "actions/checkout@v5": 7,
      "actions/setup-node@v5": 7,
      "actions/cache@v5": 2,
      "actions/setup-dotnet@v5": 1
    },
    "node24ActionContract": {
      "actions/checkout@v5": "node24",
      "actions/setup-node@v5": "node24",
      "actions/cache@v5": "node24",
      "actions/setup-dotnet@v5": "node24"
    }
  },
  "packages": {
    "packages": {
      "dcb-core": "git+https://github.com/J-Tech-Japan/sekiban-dcb-ts.git",
      "dcb-domain": "git+https://github.com/J-Tech-Japan/sekiban-dcb-ts.git",
      "dcb-client": "git+https://github.com/J-Tech-Japan/sekiban-dcb-ts.git"
    },
    "canonicalRepositoryUrl": "git+https://github.com/J-Tech-Japan/sekiban-dcb-ts.git"
  }
}
```

Hosted proof: PR `ci-pr-cheap` must show the **g93** step green (pending at open).

## AC4 — scope fence

Diff limited to `ci/lanes.json` and this evidence doc. No Action majors, package `repository.url`, versions, publish paths, or G94 timeout files touched.
