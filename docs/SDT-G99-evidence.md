# SDT-G99 evidence

## AC1 — `@sekiban/dcb-runtime@0.2.0` public matched-set member

- Manifest: `private: false`, `version: 0.2.0`, Elastic-2.0, `publishConfig.access=public`, dependency `@sekiban/dcb-core: 0.2.0` (no `file:`).
- Matched-set release/pack/publish scripts and `release-dcb-matched-set.yml` include `packages/dcb-runtime`.
- Unpublished-member publish path: `.github/workflows/publish-dcb-unpublished.yml` + `scripts/dcb-matched-set-publish-unpublished.mjs`.

```text
# after publish workflow / npm publish
npm view @sekiban/dcb-runtime version
# expected: 0.2.0
```

*(Paste live `npm view` output in the PR Criterion fence after the publish job completes.)*

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
Dry-run packing/install proves resolution under `.artifacts/.../node_modules/@sekiban/dcb-runtime` (not `packages/`).

```text
# paste G99_DRY_RUN=1 and/or live deploy receipt
```

## AC4 — tip CF + speed identity

- Active Worker: `sekiban-dcb-meeting-room-cloudflare-only`
- Deploy message marker: `SDT-G99 npm-consumer tip <commit>`
- Gate: `npm run test:g99:tip-identity` (`scripts/deploy/g99-tip-identity*.mjs`)

```text
# paste Version ID + tip-identity evaluation against tip commit
```

## AC5 — scope

No SafeWindow/G67 AC3 changes; no second product sample; no `@sekiban/cloud-client`; core/domain/client remain at published `0.2.0`.
