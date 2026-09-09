# SDT-G75-CERTIFICATE-SCOPE-W188 handoff

- Task: `SDT-G75-CERTIFICATE-SCOPE-W188`
- Issue: [#152](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/152)
- Pull request: [#155](https://github.com/J-Tech-Japan/sekiban-dcb-ts/pull/155)
- Base: `origin/main` at `3769ccd` when the dedicated worktree was created
- Implementation commit: `f2a8bf733a3d6ae662eb593238fb3cb5abd635d3`
- Branch: `claude/sdt-g75-certificate-scope-w188`
- PR state: ready for review, body contains `Closes #152`

## Delivered contract

The closed-prefix certificate is represented as a consumer-bound allocator
transaction fact and is validated only at the explicit safe-view advance
decision. The validated closed prefix is an additional runtime stop condition;
the existing `maximumSuid` G44/G62 frontier remains independent. Missing,
unready, consumer-mismatched, lineage-mismatched, or raw-prefix-only safe
requests fail closed. Ordinary scheduled compatibility polling, diagnostics /
on-demand projection catch-up, durable tag-state rebuilds, and materialized-view
callers do not invoke the validator and do not acquire
`ordering_certificate_unavailable` because a certificate is absent.

The complete call-site classification is in
[`docs/SDT-G70A-evidence.md`](docs/SDT-G70A-evidence.md). No allocator issuance
protocol, legacy reconciliation, migration, commit outcome, partial-write,
SafeWindow, fence-clock, retry, drain, package-version, deployment, publish,
G76, or G77 work was included.

## Local evidence

| Check | Result |
| --- | --- |
| `npm run test:g75:certificate-scope` | pass: runtime build, 4 focused tests, source guard, and both behavioral product mutants red |
| `omit-g44-settled-frontier` | red under the focused product oracle |
| `omit-closed-prefix-certificate-gate` | red under the focused product oracle |
| G58 focused Vitest files | pass: 5 files / 15 tests |
| G44 + G62 focused Vitest files | pass: 2 files / 11 tests |
| `npm run typecheck --workspace @sekiban/dcb-runtime` | pass |
| changed-file ESLint | pass with `--max-warnings=0` |
| `actionlint .github/workflows/ci.yml` | pass |
| `git diff --check` | pass |

The aggregate local `npm run build:packages` was attempted and reached
unrelated pre-existing dcb-client and meeting-room workspace export/type drift
on `origin/main` (for example `SnapshotReader.head`, current runtime G60/MV
exports, and sample transport symbols). No bypass, timeout inflation, or test
relaxation was used.

## Hosted status

Hosted CI is being watched on PR #155 after this artifact commit. The final
handoff reports the terminal check state and exact PR tip; no claim of hosted
green is made before those checks finish.

## Process record

- Canonical issue claim for #152 completed before implementation:
  `intent-cli worker claim --kind issue --number 152 --repo J-Tech-Japan/sekiban-dcb-ts --github-only --write --format json`.
- `intent-cli worker result-summary --kind issue-to-pr --issue 152 --pr 155 --repo J-Tech-Japan/sekiban-dcb-ts --pr-draft false --outcome pr-created --format json` completed.
- `intent-cli worker complete --kind issue --number 152 --repo J-Tech-Japan/sekiban-dcb-ts --github-only --outcome pr-created --pr 155 --write --format json` completed.
