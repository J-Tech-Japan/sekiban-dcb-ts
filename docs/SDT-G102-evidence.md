# SDT-G102 evidence

Cheap lane: `npm run test:g102` (`node scripts/g102-registry-consumer.mjs --check`).

`@sekiban/dcb-cloudflare` was not published. The live meeting-room worker was not deployed. `G32_DEPLOY_LIVE` was not set. The matched set is still the four `0.2.0` packages. `scripts/deploy/g99-npm-consumer-deploy.sh` still packs this worktree. Meeting-room migrate and deploy, including the G20 witness, call the helper with the sample wrangler config.

```json
{
  "result": "g102-published-consumer-check-passed",
  "probes": {
    "segment-boundary": "app",
    "rewritten": {
      "status": 200,
      "response": "sekiban",
      "request": {
        "path": "/api/sekiban/serialized/commit",
        "search": "?x=1",
        "method": "POST",
        "header": "kept",
        "body": "payload"
      }
    },
    "operator-not-forwarded": {
      "status": 404,
      "calls": 1
    },
    "extra-path": {
      "status": 200,
      "calls": 2
    },
    "authorize-required": true,
    "authorize-denial": {
      "status": 401,
      "body": "denied",
      "called": false
    },
    "no-mount": "app",
    "prefix-root-refused": true,
    "prefix-empty-refused": true,
    "queue-scheduled": {
      "order": [
        "runtime-queue",
        "app-queue",
        "runtime-scheduled",
        "app-scheduled"
      ],
      "runtimeFailed": true,
      "appAfterFailure": false
    },
    "cli": {
      "missingConfig": 1,
      "spawned": 0,
      "remote": [
        [
          "wrangler",
          "d1",
          "migrations",
          "apply",
          "caller-pipeline",
          "--config",
          "caller.jsonc",
          "--remote"
        ],
        [
          "wrangler",
          "d1",
          "migrations",
          "apply",
          "caller-mv",
          "--config",
          "caller.jsonc",
          "--remote"
        ]
      ],
      "deployed": [
        [
          "wrangler",
          "d1",
          "migrations",
          "apply",
          "caller-pipeline",
          "--config",
          "caller.jsonc",
          "--remote",
          "--env",
          "staging"
        ],
        [
          "wrangler",
          "d1",
          "migrations",
          "apply",
          "caller-mv",
          "--config",
          "caller.jsonc",
          "--remote",
          "--env",
          "staging"
        ],
        [
          "wrangler",
          "deploy",
          "--config",
          "caller.jsonc",
          "--env",
          "staging"
        ]
      ],
      "deployLocal": true,
      "keepVars": [
        "wrangler",
        "deploy",
        "--config",
        "caller.jsonc",
        "--keep-vars"
      ],
      "extra": [
        "wrangler",
        "deploy",
        "--config",
        "caller.jsonc",
        "--strict"
      ]
    },
    "package": {
      "name": "@sekiban/dcb-cloudflare",
      "private": false,
      "license": "Elastic-2.0",
      "dependency": "0.2.0",
      "fileDeps": false,
      "forbidden": []
    },
    "matched-set": true
  },
  "registry": {
    "resolved": {
      "@sekiban/dcb-core": "https://registry.npmjs.org/@sekiban/dcb-core/-/dcb-core-0.2.0.tgz",
      "@sekiban/dcb-domain": "https://registry.npmjs.org/@sekiban/dcb-domain/-/dcb-domain-0.2.0.tgz",
      "@sekiban/dcb-client": "https://registry.npmjs.org/@sekiban/dcb-client/-/dcb-client-0.2.0.tgz",
      "@sekiban/dcb-runtime": "https://registry.npmjs.org/@sekiban/dcb-runtime/-/dcb-runtime-0.2.0.tgz"
    },
    "marker": "g102-app-marker",
    "worker": "sdt-g102-registry-consumer"
  },
  "sampleCallsHelper": true,
  "g99PacksWorktree": true,
  "sampleRouteRemains": true
}
```
