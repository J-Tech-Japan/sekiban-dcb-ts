# SDT-G104 evidence

This evidence was produced locally on 2026-09-29 with `cf 1.0.0-beta.5`.
The `--check` run is credential-free and does not require `cf`. The local
`--with-cf` run removes `CLOUDFLARE_API_TOKEN` only for the `cf` process itself,
uses only throwaway directories, uses `--persist-to` for local D1 state, and
does not run a live D1 call or a non-dry-run deploy.

The Cloudflare announcement is [Introducing cf: the agentic CLI for the entire
Cloudflare API](https://blog.cloudflare.com/cloudflare-cf-cli-launch/).

## Guard answer to `cf migrate`

`cf migrate` reports that the existing `cloudflare.config.ts` should be
“inspected and finished”. The guard header deliberately answers that prompt:
this file is a deliberate `cf` CLI guard, not an unfinished migration; it must
not be edited, completed, or deleted. The supported project path remains the
Wrangler-based `npm run migrate` and `npm run deploy` path. The marker branch
exists only for the helper's opt-in `--cli cf` D1 migration child, and exports
`{}` with no Worker.

## Actual `--check` output

```console
$ node scripts/g104-cf-cli.mjs --check
```

```json
{
  "result": "g104-cf-cli-check-passed",
  "project": "g104-cf-cli-project",
  "create": {
    "cleanTempDirectory": true,
    "output": "Created /tmp/sdt-g104-check-E7rDmX/g104-cf-cli-project\nNext: create the two D1 databases, fill database_id values in wrangler.jsonc, then npm install."
  },
  "starter": {
    "guardByteIdentical": true,
    "generatedGuard": true,
    "noCloudflareDirectory": true,
    "noGitignore": true,
    "assetsIgnore": [
      "cloudflare.config.ts",
      "wrangler.config.ts"
    ],
    "guidance": true
  },
  "guard": {
    "withoutMarker": {
      "status": 1,
      "refused": true,
      "message": "cf commands that load this project's config are refused in the project root. Use npm run migrate and npm run deploy. Create D1 databases with npx wrangler d1 create ... or run cf resource commands from outside the project directory."
    },
    "withMarker": {
      "status": 0,
      "refused": false,
      "export": {
        "keys": [],
        "worker": false
      }
    }
  },
  "plans": {
    "defaultPlansPinned": true,
    "starterPlan": [
      [
        "wrangler",
        "d1",
        "migrations",
        "apply",
        "{{PIPELINE_DB}}",
        "--config",
        "wrangler.jsonc",
        "--remote"
      ],
      [
        "wrangler",
        "d1",
        "migrations",
        "apply",
        "{{MV_DB}}",
        "--config",
        "wrangler.jsonc",
        "--remote"
      ]
    ],
    "samplePlan": [
      [
        "wrangler",
        "d1",
        "migrations",
        "apply",
        "sekiban-dcb-meeting-room-cloudflare-pipeline",
        "--config",
        "samples/meeting-room/wrangler.cloudflare-only.jsonc",
        "--remote"
      ],
      [
        "wrangler",
        "d1",
        "migrations",
        "apply",
        "sekiban-dcb-meeting-room-cloudflare-mv",
        "--config",
        "samples/meeting-room/wrangler.cloudflare-only.jsonc",
        "--remote"
      ]
    ],
    "sampleCfDirectories": [
      {
        "cwd": "/home/parallels/dev/work/sekiban-dcb-ts-g33-impl/samples/meeting-room",
        "command": [
          "cf",
          "d1",
          "migrations",
          "apply",
          "f26d1299-82d9-4a64-8647-bc2ec86326ac",
          "--dir",
          "../../migrations/d1/g32"
        ]
      },
      {
        "cwd": "/home/parallels/dev/work/sekiban-dcb-ts-g33-impl/samples/meeting-room",
        "command": [
          "cf",
          "d1",
          "migrations",
          "apply",
          "b416b212-4d09-413c-9b8d-7660e475772f",
          "--dir",
          "../../migrations/mv"
        ]
      }
    ],
    "cfRequests": [
      {
        "command": [
          "/tmp/sdt-g104-plan-ZKqYLU/cf-from-CF_BIN",
          "d1",
          "migrations",
          "apply",
          "11111111-1111-4111-8111-111111111111",
          "--dir",
          "migrations/d1/g32",
          "--table",
          "custom_d1_migrations"
        ],
        "cwd": "/tmp/sdt-g104-plan-ZKqYLU/configs",
        "account": "account-g104",
        "marker": "d1-migrations",
        "token": "parent-token-g104"
      },
      {
        "command": [
          "/tmp/sdt-g104-plan-ZKqYLU/cf-from-CF_BIN",
          "d1",
          "migrations",
          "apply",
          "22222222-2222-4222-8222-222222222222",
          "--dir",
          "/tmp/sdt-g104-plan-ZKqYLU/absolute-migrations"
        ],
        "cwd": "/tmp/sdt-g104-plan-ZKqYLU/configs",
        "account": "account-g104",
        "marker": "d1-migrations",
        "token": "parent-token-g104"
      }
    ],
    "wranglerMarkerRemoved": true,
    "refusals": [
      {
        "label": "local",
        "reason": "--cli cf refuses --local; cf local state is not Wrangler's .wrangler/state"
      },
      {
        "label": "env",
        "reason": "--cli cf refuses --env because env blocks can swap databases"
      },
      {
        "label": "extra",
        "reason": "--cli cf refuses arguments after --"
      },
      {
        "label": "keep-vars",
        "reason": "--cli cf refuses --keep-vars"
      },
      {
        "label": "repeated",
        "reason": "--cli cf refuses repeated flag --config"
      },
      {
        "label": "unknown",
        "reason": "--cli cf refuses --profile; only --config and --cli are supported"
      },
      {
        "label": "deploy",
        "reason": "--cli cf is supported only for migrate; deploy remains a Wrangler operation"
      },
      {
        "label": "cli-missing",
        "reason": "--cli requires a value: use --cli wrangler or --cli cf"
      },
      {
        "label": "cli-invalid",
        "reason": "unsupported --cli value other; use wrangler or cf"
      },
      {
        "label": "missing database_id",
        "reason": "--cli cf requires a real UUID database_id for D1; database_id is missing; paste the real Cloudflare database ID"
      },
      {
        "label": "placeholder database_id",
        "reason": "--cli cf requires a real UUID database_id for D1; database_id is not a UUID (REPLACE_WITH_PIPELINE_D1_ID); paste the real Cloudflare database ID"
      },
      {
        "label": "non-UUID database_id",
        "reason": "--cli cf requires a real UUID database_id for D1; database_id is not a UUID (not-a-uuid); paste the real Cloudflare database ID"
      }
    ],
    "resolution": [
      {
        "label": "CF_BIN",
        "executable": "/tmp/sdt-g104-plan-ZKqYLU/cf-from-CF_BIN"
      },
      {
        "label": "config-local-bin",
        "executable": "/tmp/sdt-g104-plan-ZKqYLU/configs/node_modules/.bin/cf"
      },
      {
        "label": "PATH",
        "executable": "/tmp/sdt-g104-plan-ZKqYLU/fake-bin/cf"
      }
    ],
    "missingCfHint": "cf executable not found; install cf with `npm i -g cf` or `npm i -D cf` (cf needs node >=22)"
  },
  "credentialFree": true,
  "cfInvoked": false
}
```

## Actual `--with-cf` output

```console
$ node scripts/g104-cf-cli.mjs --with-cf
```

```json
{
  "result": "g104-cf-cli-with-cf-passed",
  "cfVersion": {
    "command": [
      "env",
      "-u",
      "CLOUDFLARE_API_TOKEN",
      "cf",
      "--version"
    ],
    "output": "🍊☁️  cf · v1.0.0-beta.5\n────────────────────────"
  },
  "project": "g104-cf-cli-project",
  "create": {
    "output": "Created /tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project\nNext: create the two D1 databases, fill database_id values in wrangler.jsonc, then npm install."
  },
  "installs": {
    "matchedSet": {
      "source": "https://registry.npmjs.org",
      "packages": {
        "@sekiban/dcb-core": {
          "version": "0.2.0",
          "resolved": "https://registry.npmjs.org/@sekiban/dcb-core/-/dcb-core-0.2.0.tgz"
        },
        "@sekiban/dcb-domain": {
          "version": "0.2.0",
          "resolved": "https://registry.npmjs.org/@sekiban/dcb-domain/-/dcb-domain-0.2.0.tgz"
        },
        "@sekiban/dcb-client": {
          "version": "0.2.0",
          "resolved": "https://registry.npmjs.org/@sekiban/dcb-client/-/dcb-client-0.2.0.tgz"
        },
        "@sekiban/dcb-runtime": {
          "version": "0.2.0",
          "resolved": "https://registry.npmjs.org/@sekiban/dcb-runtime/-/dcb-runtime-0.2.0.tgz"
        }
      }
    },
    "helper": {
      "source": "local npm pack",
      "version": "0.1.0"
    },
    "wrangler": {
      "version": "4.125.0"
    }
  },
  "pinnedWrangler": [
    {
      "label": "4.125 deploy",
      "status": 1,
      "output": "├  Build\n\nwrangler@4.125.0 is installed, but it is not compatible with cf's local runtime.\n\ncf requires wrangler@4.136.0 or newer for cf dev, cf build, cf deploy, and cf previews deploy.\nTry: npm install --save-dev wrangler@latest",
      "unchanged": true
    },
    {
      "label": "4.125 build",
      "status": 1,
      "output": "├  Build\n\nwrangler@4.125.0 is installed, but it is not compatible with cf's local runtime.\n\ncf requires wrangler@4.136.0 or newer for cf dev, cf build, cf deploy, and cf previews deploy.\nTry: npm install --save-dev wrangler@latest",
      "unchanged": true
    },
    {
      "label": "4.125 dev",
      "status": 1,
      "output": "wrangler@4.125.0 is installed, but it is not compatible with cf's local runtime.\n\ncf requires wrangler@4.136.0 or newer for cf dev, cf build, cf deploy, and cf previews deploy.\nTry: npm install --save-dev wrangler@latest",
      "unchanged": true
    },
    {
      "label": "4.125 init",
      "status": 0,
      "output": "●  Setting up the existing project in /tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project\n●  Found an existing Cloudflare configuration in the current directory.\n│\n├  Next steps\n│    cf dev     Start a local development server\n│    cf deploy  Deploy to Cloudflare",
      "unchanged": true
    },
    {
      "label": "4.125 migrate",
      "status": 1,
      "output": "Using the Wrangler bundler because @cloudflare/vite-plugin is not declared. Pass --bundler vite to override.\n\n┌ Error\n│ Cannot migrate because\n│ /tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/cloudflare.config.ts already\n│ exists. Inspect and finish the existing migration; it will not be overwritten.\n│ Automated agents should read its TODOs and ask the user about unresolved\n│ choices.\n└",
      "unchanged": true
    }
  ],
  "modernWrangler": [
    {
      "label": "4.143 deploy guard",
      "status": 1,
      "output": "├  Build\n│  Delegating to Wrangler\nError: cf commands that load this project's config are refused in the project root. Use npm run migrate and npm run deploy. Create D1 databases with npx wrangler d1 create ... or run cf resource commands from outside the project directory.\n    at file:///tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/cloudflare.config.ts?cf-no-cache=a602c152-f342-4fda-a7f8-ff8443400cfe:8:9\n    at ModuleJob.run (node:internal/modules/esm/module_job:345:25)\n    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:651:26)\n    at async loadConfig (/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/node_modules/wrangler/wrangler-dist/cli.js:135809:16)\n    at async loadAndParseConfig (/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/node_modules/wrangler/wrangler-dist/cli.js:136057:45)\n    at async loadNewConfig (/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/node_modules/wrangler/wrangler-dist/cli.js:180713:24)\n    at async readNewConfig (/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/node_modules/wrangler/wrangler-dist/cli.js:181661:18)\n    at async writeBuildOutput (/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/node_modules/wrangler/wrangl…",
      "unchanged": true
    },
    {
      "label": "4.143 build guard",
      "status": 1,
      "output": "├  Build\n│  Delegating to Wrangler\nError: cf commands that load this project's config are refused in the project root. Use npm run migrate and npm run deploy. Create D1 databases with npx wrangler d1 create ... or run cf resource commands from outside the project directory.\n    at file:///tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/cloudflare.config.ts?cf-no-cache=d0260ba3-6d08-48d9-8402-dfc5e1d6628a:8:9\n    at ModuleJob.run (node:internal/modules/esm/module_job:345:25)\n    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:651:26)\n    at async loadConfig (/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/node_modules/wrangler/wrangler-dist/cli.js:135809:16)\n    at async loadAndParseConfig (/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/node_modules/wrangler/wrangler-dist/cli.js:136057:45)\n    at async loadNewConfig (/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/node_modules/wrangler/wrangler-dist/cli.js:180713:24)\n    at async readNewConfig (/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/node_modules/wrangler/wrangler-dist/cli.js:181661:18)\n    at async writeBuildOutput (/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/node_modules/wrangler/wrangl…",
      "unchanged": true
    },
    {
      "label": "4.143 dev guard",
      "status": 1,
      "output": "Error: cf commands that load this project's config are refused in the project root. Use npm run migrate and npm run deploy. Create D1 databases with npx wrangler d1 create ... or run cf resource commands from outside the project directory.\n    at file:///tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/cloudflare.config.ts?cf-no-cache=7bd4dcd9-53f8-4c81-8f37-59eef4e1a229:8:9\n    at ModuleJob.run (node:internal/modules/esm/module_job:345:25)\n    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:651:26)\n    at async loadConfig (/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/node_modules/wrangler/wrangler-dist/cli.js:135809:16)\n    at async loadAndParseConfig (/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/node_modules/wrangler/wrangler-dist/cli.js:136057:45)\n    at async loadNewConfig (/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/node_modules/wrangler/wrangler-dist/cli.js:180713:24)\n    at async readNewConfig (/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/node_modules/wrangler/wrangler-dist/cli.js:181661:18)\n    at async #updateConfig (/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/node_modules/wrangler/wrangler-dist/cli.js:206583:27)\n    at async…",
      "unchanged": true
    },
    {
      "label": "4.143 deploy marked",
      "status": 1,
      "output": "├  Build\n│  Delegating to Wrangler\nError: `cloudflare.config.ts` must define a Worker using the `worker` property.\n    at loadNewConfig (/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/node_modules/wrangler/wrangler-dist/cli.js:180725:11)\n    at async readNewConfig (/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/node_modules/wrangler/wrangler-dist/cli.js:181661:18)\n    at async writeBuildOutput (/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/node_modules/wrangler/wrangler-dist/cli.js:213269:21)\n    at async Object.runCfWranglerBuild [as run] (/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/node_modules/wrangler/wrangler-dist/cli.js:370186:3)",
      "unchanged": true
    },
    {
      "label": "4.143 build marked",
      "status": 1,
      "output": "├  Build\n│  Delegating to Wrangler\nError: `cloudflare.config.ts` must define a Worker using the `worker` property.\n    at loadNewConfig (/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/node_modules/wrangler/wrangler-dist/cli.js:180725:11)\n    at async readNewConfig (/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/node_modules/wrangler/wrangler-dist/cli.js:181661:18)\n    at async writeBuildOutput (/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/node_modules/wrangler/wrangler-dist/cli.js:213269:21)\n    at async Object.runCfWranglerBuild [as run] (/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/node_modules/wrangler/wrangler-dist/cli.js:370186:3)",
      "unchanged": true
    },
    {
      "label": "4.143 dev marked",
      "status": 1,
      "output": "Error: `cloudflare.config.ts` must define a Worker using the `worker` property.\n    at loadNewConfig (/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/node_modules/wrangler/wrangler-dist/cli.js:180725:11)\n    at async readNewConfig (/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/node_modules/wrangler/wrangler-dist/cli.js:181661:18)\n    at async #updateConfig (/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/node_modules/wrangler/wrangler-dist/cli.js:206583:27)\n    at async setupDevEnv (/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/node_modules/wrangler/wrangler-dist/cli.js:368247:3)\n    at async startDev (/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/node_modules/wrangler/wrangler-dist/cli.js:368191:7)\n    at async runCfWranglerDev (/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/node_modules/wrangler/wrangler-dist/cli.js:370199:23)",
      "unchanged": true
    },
    {
      "label": "4.143 init",
      "status": 0,
      "output": "●  Setting up the existing project in /tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project\n●  Found an existing Cloudflare configuration in the current directory.\n│\n├  Next steps\n│    cf dev     Start a local development server\n│    cf deploy  Deploy to Cloudflare",
      "unchanged": true
    },
    {
      "label": "4.143 migrate",
      "status": 1,
      "output": "Using the Wrangler bundler because @cloudflare/vite-plugin is not declared. Pass --bundler vite to override.\n\n┌ Error\n│ Cannot migrate because\n│ /tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/cloudflare.config.ts already\n│ exists. Inspect and finish the existing migration; it will not be overwritten.\n│ Automated agents should read its TODOs and ask the user about unresolved\n│ choices.\n└",
      "unchanged": true
    }
  ],
  "d1": [
    {
      "label": "list without marker",
      "status": 1,
      "output": "┌ Error\n│ cf commands that load this project's config are refused in the project root.\n│ Use npm run migrate and npm run deploy. Create D1 databases with npx wrangler\n│ d1 create ... or run cf resource commands from outside the project directory.\n└",
      "persistTo": "/tmp/sdt-g104-cf-state-ewV38c",
      "unchanged": true
    },
    {
      "label": "apply g32",
      "status": 0,
      "output": "[\n  {\n    \"name\": \"0001_dcb_events.sql\",\n    \"status\": \"✅\"\n  },\n  {\n    \"name\": \"0002_g44_global_completeness.sql\",\n    \"status\": \"✅\"\n  },\n  {\n    \"name\": \"0003_g58_safe_lane_health.sql\",\n    \"status\": \"✅\"\n  },\n  {\n    \"name\": \"0004_g58_live_poll_health.sql\",\n    \"status\": \"✅\"\n  },\n  {\n    \"name\": \"0005_g58_safe_lane_history.sql\",\n    \"status\": \"✅\"\n  },\n  {\n    \"name\": \"0006_g60_durable_hop_measurements.sql\",\n    \"status\": \"✅\"\n  },\n  {\n    \"name\": \"0007_g60_post_admission_decomposition.sql\",\n    \"status\": \"✅\"\n  },\n  {\n    \"name\": \"0008_g60_unsafe_writer_boundaries.sql\",\n    \"status\": \"✅\"\n  },\n  {\n    \"name\": \"0009_g65_admission_attempts.sql\",\n    \"status\": \"✅\"\n  },\n  {\n    \"name\": \"0010_g65_direct_rings.sql\",\n    \"status\": \"✅\"\n  },\n  {\n    \"name\": \"0011_g67_safe_lane_passes.sql\",\n    \"status\": \"✅\"\n  },\n  {\n    \"name\": \"0012_g67_safe_lane_pass_ownership.sql\",\n    \"status\": \"✅\"\n  },\n  {\n    \"name\": \"0013_g67_safe_lane_catch_up_observations.sql\",\n    \"status\": \"✅\"\n  },\n  {\n    \"name\": \"0014_g67_safe_lane_fence_expiry.sql\",\n    \"status\": \"✅\"\n  },\n  {\n    \"name\": \"0015_g69_admission_attempts.sql\",\n    \"status\": \"✅\"\n  },\n  {\n    \"name\": \"0016_g69_consultation003.sql\",\n    \"status\": \"✅\"\n …",
      "persistTo": "/tmp/sdt-g104-cf-state-TZFN6b",
      "unchanged": true
    },
    {
      "label": "apply mv",
      "status": 0,
      "output": "[\n  {\n    \"name\": \"0001_materialized_views.sql\",\n    \"status\": \"✅\"\n  },\n  {\n    \"name\": \"0002_unsafe_window_materialized_views.sql\",\n    \"status\": \"✅\"\n  },\n  {\n    \"name\": \"0003_checkpoint_ahead_hardening.sql\",\n    \"status\": \"✅\"\n  },\n  {\n    \"name\": \"0004_unsafe_window_failure_findings.sql\",\n    \"status\": \"✅\"\n  },\n  {\n    \"name\": \"0005_g31_wait_receipts.sql\",\n    \"status\": \"✅\"\n  },\n  {\n    \"name\": \"0006_g31_wait_target_poison.sql\",\n    \"status\": \"✅\"\n  },\n  {\n    \"name\": \"0007_g69_ordering_quarantine.sql\",\n    \"status\": \"✅\"\n  },\n  {\n    \"name\": \"0008_g69_rebuild_verification.sql\",\n    \"status\": \"✅\"\n  },\n  {\n    \"name\": \"0009_g69_rebuild_proof.sql\",\n    \"status\": \"✅\"\n  }\n]\n? About to apply 9 migration(s)\nYour database may not be available to serve requests during the migration, continue?\n  Using fallback value in non-interactive context: yes",
      "persistTo": "/tmp/sdt-g104-cf-state-xImvJW",
      "unchanged": true
    }
  ],
  "wranglerRuns": [
    {
      "version": "4.125.0",
      "durableObjects": [
        "AllocatorDurableObject",
        "BootstrapCoordinatorDurableObject",
        "JournalDurableObject",
        "TagDurableObject",
        "TagStateDurableObject"
      ],
      "d1": [
        "g104-cf-cli-project-pipeline",
        "g104-cf-cli-project-mv"
      ],
      "queue": "g104-cf-cli-project-outbox",
      "uploadedAssets": [
        "app.js",
        "index.html",
        "styles.css"
      ],
      "ignoredAssets": [
        "public/.assetsignore"
      ],
      "output": "🪵  Writing logs to \"/home/parallels/.config/.wrangler/logs/wrangler-2026-09-29_09-04-30_982.log\"\n.env file not found at \"/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/.env\". Continuing... For more details, refer to https://developers.cloudflare.com/workers/wrangler/system-environment-variables/\n.env file not found at \"/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/.env.local\". Continuing... For more details, refer to https://developers.cloudflare.com/workers/wrangler/system-environment-variables/\n\n ⛅️ wrangler 4.125.0 (update available 4.143.0)\n───────────────────────────────────────────────\n\nCloudflare collects anonymous telemetry about your usage of Wrangler. Learn more at https://github.com/cloudflare/workers-sdk/tree/main/packages/wrangler/telemetry.md\nMetrics dispatcher: Dispatching disabled - would have sent {\"deviceId\":\"<redacted>\",\"event\":\"wrangler command started\",\"timestamp\":1790672671290,\"properties\":{\"amplitude_session_id\":1790672671281,\"amplitude_event_id\":0,\"wranglerVersion\":\"4.125.0\",\"wranglerMajorVersion\":4,\"wranglerMinorVersion\":125,\"wranglerPatchVersion\":0,\"osPlatform\":\"Linux\",\"osVersion\":\"#34~24.04.1-Ubuntu SMP PREEMPT_DYNAMIC Fri Sep  4 16:05:40 UTC 2\",\"no…"
    },
    {
      "version": "4.143.0",
      "durableObjects": [
        "AllocatorDurableObject",
        "BootstrapCoordinatorDurableObject",
        "JournalDurableObject",
        "TagDurableObject",
        "TagStateDurableObject"
      ],
      "d1": [
        "g104-cf-cli-project-pipeline",
        "g104-cf-cli-project-mv"
      ],
      "queue": "g104-cf-cli-project-outbox",
      "uploadedAssets": [
        "app.js",
        "index.html",
        "styles.css"
      ],
      "ignoredAssets": [
        "public/.assetsignore"
      ],
      "output": "🪵  Writing logs to \"/home/parallels/.config/.wrangler/logs/wrangler-2026-09-29_09-04-45_149.log\"\n.env file not found at \"/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/.env\". Continuing... For more details, refer to https://developers.cloudflare.com/workers/wrangler/system-environment-variables/\n.env file not found at \"/tmp/sdt-g104-with-cf-YaeUOr/g104-cf-cli-project/.env.local\". Continuing... For more details, refer to https://developers.cloudflare.com/workers/wrangler/system-environment-variables/\n\n ⛅️ wrangler 4.143.0\n────────────────────\n\nCloudflare collects anonymous telemetry about your usage of Wrangler. Learn more at https://github.com/cloudflare/workers-sdk/tree/main/packages/wrangler/telemetry.md\nMetrics dispatcher: Dispatching disabled - would have sent {\"deviceId\":\"<redacted>\",\"event\":\"wrangler command started\",\"timestamp\":1790672685332,\"properties\":{\"amplitude_session_id\":1790672685323,\"amplitude_event_id\":0,\"wranglerVersion\":\"4.143.0\",\"wranglerMajorVersion\":4,\"wranglerMinorVersion\":143,\"wranglerPatchVersion\":0,\"osPlatform\":\"Linux\",\"osVersion\":\"#34~24.04.1-Ubuntu SMP PREEMPT_DYNAMIC Fri Sep  4 16:05:40 UTC 2\",\"nodeVersion\":22,\"isFirstUsage\":false,\"configFileType\":\"j…"
    }
  ],
  "subdirectories": [
    {
      "command": [
        "env",
        "-u",
        "CLOUDFLARE_API_TOKEN",
        "cf",
        "deploy",
        "--dry-run"
      ],
      "status": 1,
      "output": "Detected Project Settings:\n - Worker Name: public\n - Framework: Static\n - Output Directory: .\n\n\n📄 Create cloudflare.config.ts:\n  import { defineConfig } from \"cf/config\";\n  \n  export default defineConfig({\n    worker: {\n      \"name\": \"public\",\n      \"compatibilityDate\": \"2026-09-25\",\n      \"observability\": {\n        \"enabled\": true\n      }\n    }\n  });\n\n📄 Create wrangler.config.ts:\n  import { defineWranglerConfig } from \"wrangler/experimental-config\";\n  \n  export default defineWranglerConfig({\n    \"assetsDirectory\": \".\"\n  });\n\n├  Build\n\nNo Cloudflare dev-server is installed in this project.\n\nA project must declare exactly one of the following in its manifest:\n\n  @cloudflare/vite-plugin  (Vite-based dev server (recommended for JavaScript/TypeScript))\n    install:  npm install --save-dev @cloudflare/vite-plugin@beta\n  wrangler  (Wrangler-based dev server (legacy Worker projects))\n    install:  npm install --save-dev wrangler@latest\n  cloudflare-py-dev-server  (Python dev server (Pyodide via workerd))\n    install:  pip install cloudflare-py-dev-server   (or: uv add --dev cloudflare-py-dev-server)\n  cloudflare-rs-dev-server  (Rust dev server (wasm-bindgen + workerd))\n    install:  car…",
      "changedPaths": [
        "public/cloudflare.config.ts",
        "public/wrangler.config.ts"
      ],
      "manifestRule": "exempt: fresh subdirectory copy intentionally records cf additions",
      "wranglerAssets": [
        "app.js",
        "index.html",
        "styles.css"
      ],
      "ignoredAssets": [
        "public/.assetsignore",
        "public/cloudflare.config.ts",
        "public/wrangler.config.ts"
      ]
    },
    {
      "command": [
        "env",
        "-u",
        "CLOUDFLARE_API_TOKEN",
        "cf",
        "init",
        "public",
        "--no-install"
      ],
      "status": 0,
      "output": "●  Setting up the existing project in /tmp/sdt-g104-with-cf-YaeUOr/subdir-init/public\n▲  --no-install and --package-manager only apply when creating a new project. Setting up an existing project uses its own package manager.\n\nDetected Project Settings:\n - Worker Name: public\n - Framework: Static\n - Output Directory: .\n\n\n📄 Create cloudflare.config.ts:\n  import { defineConfig } from \"cf/config\";\n  \n  export default defineConfig({\n    worker: {\n      \"name\": \"public\",\n      \"compatibilityDate\": \"2026-09-25\",\n      \"observability\": {\n        \"enabled\": true\n      }\n    }\n  });\n\n📄 Create wrangler.config.ts:\n  import { defineWranglerConfig } from \"wrangler/experimental-config\";\n  \n  export default defineWranglerConfig({\n    \"assetsDirectory\": \".\"\n  });\n\n◆  Set up public for Cloudflare.\n│\n├  Next steps\n│    cd public\n│    cf dev     Start a local development server\n│    cf deploy  Deploy to Cloudflare",
      "changedPaths": [
        "public/cloudflare.config.ts",
        "public/wrangler.config.ts"
      ],
      "manifestRule": "exempt: fresh subdirectory copy intentionally records cf additions",
      "wranglerAssets": [
        "app.js",
        "index.html",
        "styles.css"
      ],
      "ignoredAssets": [
        "public/.assetsignore",
        "public/cloudflare.config.ts",
        "public/wrangler.config.ts"
      ]
    }
  ],
  "safety": {
    "credentialFree": true,
    "tokenUnsetForEveryCfCall": true,
    "allCfCallsInThrowawayDirectory": true,
    "noRemoteD1": true,
    "noNonDryRunDeploy": true,
    "rootAndD1ManifestsUnchanged": true
  }
}
```

## Non-goals and known limits

- The starter and sample are not migrated to `cloudflare.config.ts`, Vite, or
  `@cloudflare/vite-plugin`.
- No Durable Object `exports` lifecycle or Durable Object migration change is
  included.
- There is no `cf deploy`, `cf build`, or `cf dev` path in the helper, and no
  local cf migration backend in the helper.
- `cf deploy --prebuilt` and cf commands run from a subdirectory are documented
  as forbidden but are not technically blocked by the root guard; the starter
  also explicitly forbids `cf init <subdir>`.
- The remote `npm run migrate -- --cli cf` path is not run against a real D1.
- `cf` is not a dependency and is not in CI. `samples/meeting-room` gets no
  guard.
- There is no npm publish, live D1 call, live deploy, or `G32_DEPLOY_LIVE=1`.

