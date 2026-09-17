# Local bootstrap publish: `@sekiban/dcb-runtime`

Trusted Publishing (OIDC) cannot create a **new** package. Use this local path
once, then register the GitHub Actions Trusted Publisher, then use the OIDC
workflow for ongoing publishes.

## Official docs / URLs

- Trusted publishing overview: https://docs.npmjs.com/trusted-publishers/
- GitHub Actions Trusted Publisher fields: https://docs.npmjs.com/trusted-publishers/#for-github-actions
- npm login: https://www.npmjs.com/login
- Access tokens (only if you choose token bootstrap instead of OTP): https://www.npmjs.com/settings/~/tokens
- Package (after bootstrap): https://www.npmjs.com/package/@sekiban/dcb-runtime
- Package access / Trusted Publisher UI: https://www.npmjs.com/package/@sekiban/dcb-runtime/access
- OIDC workflow: https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/workflows/publish-dcb-unpublished.yml

## Prerequisites

1. Maintainer on the `@sekiban` npm org / package.
2. Logged in locally: `npm login` then `npm whoami`.
3. Repo root with a clean enough tree to build `packages/dcb-runtime`.

## Step-by-step

### 1. Dry-run (no registry write)

```sh
# from repository root
./scripts/dcb-runtime-bootstrap-publish.sh --dry-run
# or
npm run publish:g99:runtime-bootstrap -- --dry-run
```

### 2. Live bootstrap publish

```sh
./scripts/dcb-runtime-bootstrap-publish.sh
# or
npm run publish:g99:runtime-bootstrap
```

The script:

- asserts `packages/dcb-runtime` is `@sekiban/dcb-runtime@0.2.0` and `private:false`
- requires `npm whoami`
- builds core + runtime
- stages a **temp** tree with `publishConfig.provenance` removed (git tree untouched)
- runs `NPM_CONFIG_PROVENANCE=false npm publish --access public` (OTP/2FA as prompted)
- verifies `npm view @sekiban/dcb-runtime version` → `0.2.0`
- writes `.artifacts/sdt-g99-runtime-bootstrap-publish.json`

If the version is already on the registry, it skips republish and prints the Trusted Publisher next steps.

### 3. Register Trusted Publisher on npmjs.com

Open https://www.npmjs.com/package/@sekiban/dcb-runtime/access → **Trusted Publisher** → **GitHub Actions**:

| Field | Value |
|-------|--------|
| Organization or user | `J-Tech-Japan` |
| Repository | `sekiban-dcb-ts` |
| Workflow filename | `publish-dcb-unpublished.yml` |
| Environment name | *(empty)* |
| Allowed actions | allow **`npm publish`** |

Optional second connection: workflow filename `release-dcb-matched-set.yml`.

### 4. OIDC publish (steady-state / AC1 evidence)

1. Merge any open PR that restores the trusted-publishing workflow if needed.
2. Run https://github.com/J-Tech-Japan/sekiban-dcb-ts/actions/workflows/publish-dcb-unpublished.yml on `main` (`packages: dcb-runtime`).
3. Confirm log shows `trusted-publishing` and `npm view` prints `0.2.0`.

## What this path is not

- Not the long-term product publish path (that is G72 OIDC / Trusted Publishing).
- Not a substitute for registering the Trusted Publisher after bootstrap.
- Does not commit or leave `packages/dcb-runtime/package.json` dirty.
