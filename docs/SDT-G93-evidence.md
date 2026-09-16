# SDT-G93 — Actions Node-24 majors and canonical repository.url

Issue: [#192](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/192)
Branch: `claude/sdt-g93-actions-npm-polish-w901`

## Baseline and scope

- **Pre-change baseline (main):** `6d67e168d9b10a0c4a26c0325f91c5c45ef97c7a`
- **Scope:** upgrade four Action majors `@v4`→`@v5` across five workflows; set `repository.url` to `git+https://…` on three public packages; no version bump, publish, tag, lockfile, or auth change.

## AC1 — workflow census (before)

On `main`, all five workflows pinned Node-20 Action majors:

| Action | Count on main |
| --- | --- |
| `actions/checkout@v4` | 7 |
| `actions/setup-node@v4` | 7 |
| `actions/cache@v4` | 2 |
| `actions/setup-dotnet@v4` | 1 |

Prior CI/release runs emitted GitHub annotation `Node.js 20 is deprecated` (e.g. [34735643032](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/34735643032), matched-set release [35070569044](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35070569044)).

## AC1 — workflow census (after)

`npm run test:g93` (2026-09-16):

```json
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
    }
  }
}
```

Zero forbidden `@v4` pins remain.

## AC2 — Node 24 action contract

Recorded upstream `runs.using` for the selected majors (design proposal + guard metadata):

| Action | Runtime |
| --- | --- |
| `actions/checkout@v5` | `node24` |
| `actions/setup-node@v5` | `node24` |
| `actions/cache@v5` | `node24` |
| `actions/setup-dotnet@v5` | `node24` |

Hosted confirmation: PR CI + `dcb-domain-release-preflight` run URLs recorded below once green.

## AC3 — canonical package metadata

One-line `repository.url` edits only:

| Package | Before | After |
| --- | --- | --- |
| `@sekiban/dcb-core` | `https://github.com/J-Tech-Japan/sekiban-dcb-ts.git` | `git+https://github.com/J-Tech-Japan/sekiban-dcb-ts.git` |
| `@sekiban/dcb-domain` | same | same |
| `@sekiban/dcb-client` | same | same |

`package-lock.json` unchanged.

## AC4 — no npm normalization

Local `npm run test:g64` (2026-09-16) — exit 0. Grep over full log:

```
NO_WARNINGS_FOUND
```

(no `Please run "npm pkg fix"`; no `"repository.url" was normalized`).

Matched-set publish dry-run receipts (core/domain/client) — excerpt from stderr shows clean tarball notices only; no normalization warnings.

## AC5 — release invariants preserved

Local gates (2026-09-16):

- `npm run test:g64` — PASS (build, pack, consumer, release-check, publish-shape, publish-dry-run)
- `npm run test:g72:trusted-publishing` — PASS (guard + mutation runner self-test + product mutants red)

`npm pkg delete publishConfig.provenance` private path unchanged in workflow/guards.

## AC6 — scope fence

Diff limited to: five workflow files, three public manifests, `package.json` (`test:g93`), `scripts/sdt-g93-workflow-package-guard.mjs`, this evidence doc. No tags, publications, version bumps, credentials, or lockfile changes. `git diff --check` passes.

## Hosted CI

PR [#193](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/193), head `207a95cb92c2d8afd51a3cf85b955d6d3fbe2a82`.

| Check | Run URL | Status |
| --- | --- | --- |
| CI (`ci-pr-cheap`) | [35119284935 / job 104872629536](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35119284935/job/104872629536) | pass |
| CI (`ci-foundation`) | [35119284935 / job 104872629780](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35119284935/job/104872629780) | pass |
| `dcb-domain-release-preflight` | [35119285094 / job 104872629778](https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/runs/35119285094/job/104872629778) | pass |

Check-run annotations on `ci-pr-cheap` and `dcb-domain-release-preflight`: `[]` (no `Node.js 20 is deprecated`).
