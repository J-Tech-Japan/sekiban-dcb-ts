# SDT-G99 evidence

## AC1 — `@sekiban/dcb-runtime@0.2.0` public matched-set member

- Manifest: `private: false`, `version: 0.2.0`, Elastic-2.0, `publishConfig.access=public`, dependency `@sekiban/dcb-core: 0.2.0` (no `file:`).
- Matched-set release/pack/publish scripts and `release-dcb-matched-set.yml` include `packages/dcb-runtime`.
- Publish path: `.github/workflows/publish-dcb-unpublished.yml` uses **G72 trusted publishing** (`NPM_TRUSTED_PUBLISHING=true` → OIDC, `NODE_AUTH_TOKEN` unset). Token fallback is not the AC1 product path.
- Chicken-and-egg: npm Trusted Publishers attach to an **existing** package. Local bootstrap: `npm run publish:g99:runtime-bootstrap` from the repo root (`scripts/dcb-runtime-bootstrap-publish.sh`). Then register Trusted Publisher for `publish-dcb-unpublished.yml`, then re-run OIDC publish.

```text
npm view @sekiban/dcb-runtime version
0.2.0
```

## AC2 — sample registry semver deps

`samples/meeting-room/package.json`:

```json
"dependencies": {
  "@sekiban/dcb-client": "0.2.0",
  "@sekiban/dcb-core": "0.2.0",
  "@sekiban/dcb-domain": "0.2.0",
  "@sekiban/dcb-runtime": "0.2.0"
}
```

## AC3 — npm-consumer tip deploy path

Script: `scripts/deploy/g99-npm-consumer-deploy.sh`

```text
g99-npm-consumer: resolved @sekiban/dcb-runtime -> .../.artifacts/sdt-g99-npm-consumer/app/node_modules/@sekiban/dcb-runtime
Current Version ID: fa32647c-7c3e-4bf0-8b58-7545d85eae7d
sourceCommit: 6728e961b5190af521829998c92b75a96f1cdf50
message: SDT-G99 npm-consumer tip 6728e961b5190af521829998c92b75a96f1cdf50
```

## AC4 — tip CF + speed identity

- Active Worker: `sekiban-dcb-meeting-room-cloudflare-only`
- Version ID: `fa32647c-7c3e-4bf0-8b58-7545d85eae7d`
- Deploy message marker: `SDT-G99 npm-consumer tip <commit>`
- Unit gate: `npm run test:g99:tip-identity` (`scripts/deploy/g99-tip-identity*.mjs`)
- Live gate: `npm run test:g99:tip-identity:live` (`assertLiveTipIdentity`)
- g50 wiring (fail-closed off tip):
  - `g50-deployed-identity` requires tip marker + commit on the version message and checks live deployments tip before reuse
  - `g50-commit-latency` calls `assertLiveTipIdentity` before sampling
  - foundation lane `foundation-g50-guards` runs tip-identity + deployed-identity + commit-latency guards

```text
npm run test:g99:tip-identity
# matching.ok=true; wrongWorker/missingMarker/wrongCommit/wrongVersion fail-closed

G50_SOURCE_COMMIT=6728e961b5190af521829998c92b75a96f1cdf50 \
G50_VERSION_ID=fa32647c-7c3e-4bf0-8b58-7545d85eae7d \
npm run test:g99:tip-identity:live
# ok=true; activeVersionId=fa32647c-7c3e-4bf0-8b58-7545d85eae7d
# message=SDT-G99 npm-consumer tip 6728e961b5190af521829998c92b75a96f1cdf50
```

## AC5 — scope

No SafeWindow/G67 AC3 changes; no second product sample; no `@sekiban/cloud-client`; core/domain/client remain at published `0.2.0`.
