# SDT-G99 evidence

## AC1 — `@sekiban/dcb-runtime@0.2.0` public matched-set member

- Manifest: `private: false`, `version: 0.2.0`, Elastic-2.0, `publishConfig.access=public`, dependency `@sekiban/dcb-core: 0.2.0` (no `file:`).
- Matched-set release/pack/publish scripts and `release-dcb-matched-set.yml` include `packages/dcb-runtime`.
- Publish path: `.github/workflows/publish-dcb-unpublished.yml` uses **G72 trusted publishing** (`NPM_TRUSTED_PUBLISHING=true` → OIDC, `NODE_AUTH_TOKEN` unset). Token fallback is not the AC1 product path.
- Chicken-and-egg: npm Trusted Publishers attach to an **existing** package. Local bootstrap: `npm run publish:g99:runtime-bootstrap` from the repo root (`scripts/dcb-runtime-bootstrap-publish.sh`). Then register Trusted Publisher for `publish-dcb-unpublished.yml`, then re-run OIDC publish.

```text
# after trusted-publisher registration + publish-dcb-unpublished on main
npm view @sekiban/dcb-runtime version
# expected: 0.2.0
```

*(Live `npm view` pasted after the OIDC publish job on `main`.)*

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
Current Version ID: 6ab6989f-8355-43ca-8501-7c9dd147a1bc
sourceCommit: b6460cd7d47225c5b9fee105f4a587fd2dcb6555
message: SDT-G99 npm-consumer tip b6460cd7d47225c5b9fee105f4a587fd2dcb6555
```

## AC4 — tip CF + speed identity

- Active Worker: `sekiban-dcb-meeting-room-cloudflare-only`
- Version ID: `6ab6989f-8355-43ca-8501-7c9dd147a1bc`
- Deploy message marker: `SDT-G99 npm-consumer tip <commit>`
- Gate: `npm run test:g99:tip-identity` (`scripts/deploy/g99-tip-identity*.mjs`) — unit mutants green.

```text
npm run test:g99:tip-identity
# matching.ok=true; wrongWorker/missingMarker/wrongCommit fail-closed
```

## AC5 — scope

No SafeWindow/G67 AC3 changes; no second product sample; no `@sekiban/cloud-client`; core/domain/client remain at published `0.2.0`.
