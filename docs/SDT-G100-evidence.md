# SDT-G100 evidence — deploy gate calls the Unit A core

Status: the two G32 configs go through `resolveCompositionInput` and `validateProfile` before any wrangler spawn. A witnessed production deploy, shard rotation, a queue-topology change, a manifest redesign, and Cloudflare placement are not done. `g32Accepts`, `legacyOverlapRows`, and `compareOverlap` are gone.

## Command

```
node scripts/g100-deploy-gate.mjs --check
node scripts/g32-cutover-check.mjs
```

The command is `npm run test:g100` on the cheap lane.

Paste from 2026-09-19:

```
{"result":"g100-deploy-gate-self-test-passed","digest":"5ff2347ea2a407b49aa89ef102112b5f5ac923e5e03fa0213bdfaf2cd7004c2b","probes":["wrapper-baseline","forced-red","deploy-script","invocation-count","missing-config","unresolved-kept-var","digest-mismatch","zero-wrangler"]}
{"result":"g100-deploy-gate-passed","digest":"5ff2347ea2a407b49aa89ef102112b5f5ac923e5e03fa0213bdfaf2cd7004c2b","invocations":2,"wranglerSpawns":0}
{"bridgeCandidate":"43029a8b8b0298b6cc30c531639d7398f6295805","bridgeCoverage":7,"digest":"5ff2347ea2a407b49aa89ef102112b5f5ac923e5e03fa0213bdfaf2cd7004c2b"}
```

The published digest is `manifestDigest` of the checked-in manifest. The invocation records that digest in `contracts/g32-published-digest.json`, which is outside the canonical payload. The preflight compares those two values. Each invocation carries the same explicit overrides the deploy script passes to wrangler: `SDT_SERVICE_ID`, `G32_SOURCE_COMMIT`, `G32_CONFIG_DIGEST`, and the dry-run fence fingerprint. `keepVars` stays empty because that script does not pass `--keep-vars`.
