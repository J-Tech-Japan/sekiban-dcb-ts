# SDT-G103 evidence

Cheap lane: `npm run test:g103` (`node scripts/g103-create-starter.mjs --check`).

`@sekiban/create-dcb` and `@sekiban/dcb-cloudflare` were not published. Live D1/queue resources were not created. The live meeting-room worker was not deployed. `G32_DEPLOY_LIVE` was not set. `samples/meeting-room` was not rewritten in place. The matched set remains the four `0.2.0` packages. The generated starter pins project-local `wrangler@4.125.0` so migrate/deploy do not depend on a monorepo or global Wrangler install.

```json
{
  "result": "g103-create-starter-check-passed",
  "project": "g103-starter-booking",
  "create": {
    "cleanTempDirectory": true,
    "slugifiedDirectory": true,
    "stdout": "Created /tmp/sdt-g103-zzgmvC/g103-starter-booking\nNext: create the two D1 databases, fill database_id values in wrangler.jsonc, then npm install."
  },
  "inventory": {
    "files": [
      "LICENSE",
      "README.md",
      "REPLACE.md",
      "migrations/d1/g32/0001_dcb_events.sql",
      "migrations/d1/g32/0002_g44_global_completeness.sql",
      "migrations/d1/g32/0003_g58_safe_lane_health.sql",
      "migrations/d1/g32/0004_g58_live_poll_health.sql",
      "migrations/d1/g32/0005_g58_safe_lane_history.sql",
      "migrations/d1/g32/0006_g60_durable_hop_measurements.sql",
      "migrations/d1/g32/0007_g60_post_admission_decomposition.sql",
      "migrations/d1/g32/0008_g60_unsafe_writer_boundaries.sql",
      "migrations/d1/g32/0009_g65_admission_attempts.sql",
      "migrations/d1/g32/0010_g65_direct_rings.sql",
      "migrations/d1/g32/0011_g67_safe_lane_passes.sql",
      "migrations/d1/g32/0012_g67_safe_lane_pass_ownership.sql",
      "migrations/d1/g32/0013_g67_safe_lane_catch_up_observations.sql",
      "migrations/d1/g32/0014_g67_safe_lane_fence_expiry.sql",
      "migrations/d1/g32/0015_g69_admission_attempts.sql",
      "migrations/d1/g32/0016_g69_consultation003.sql",
      "migrations/d1/g32/0017_g69_receipt_identity.sql",
      "migrations/d1/g32/0018_g69_mutation_evidence.sql",
      "migrations/d1/g32/0019_g69_mutation_receipt_label.sql",
      "migrations/d1/g32/0020_g69_hotpath_costs.sql",
      "migrations/mv/0001_materialized_views.sql",
      "migrations/mv/0002_unsafe_window_materialized_views.sql",
      "migrations/mv/0003_checkpoint_ahead_hardening.sql",
      "migrations/mv/0004_unsafe_window_failure_findings.sql",
      "migrations/mv/0005_g31_wait_receipts.sql",
      "migrations/mv/0006_g31_wait_target_poison.sql",
      "migrations/mv/0007_g69_ordering_quarantine.sql",
      "migrations/mv/0008_g69_rebuild_verification.sql",
      "migrations/mv/0009_g69_rebuild_proof.sql",
      "package.json",
      "public/app.js",
      "public/index.html",
      "public/styles.css",
      "scripts/deploy.sh",
      "scripts/migrate.sh",
      "src/booking-domain.ts",
      "src/booking-mv.ts",
      "src/booking-routes.ts",
      "src/booking-transport.ts",
      "src/worker.ts",
      "tsconfig.json",
      "wrangler.jsonc"
    ],
    "bookingCommands": [
      "create-room",
      "reserve-room",
      "cancel-reservation",
      "release-room"
    ],
    "ui": [
      "public/index.html",
      "public/app.js",
      "public/styles.css"
    ],
    "forbiddenFilesAbsent": true,
    "forbiddenWorkerImportsAbsent": true
  },
  "config": {
    "names": {
      "worker": "g103-starter-booking-worker",
      "service": "g103-starter-booking",
      "pipeline": "g103-starter-booking-pipeline",
      "mv": "g103-starter-booking-mv",
      "queue": "g103-starter-booking-outbox",
      "dlq": "g103-starter-booking-outbox-dlq"
    },
    "migrations": [
      {
        "path": "migrations/d1/g32",
        "resolvedInsideProject": "migrations/d1/g32",
        "sqlFiles": 20
      },
      {
        "path": "migrations/mv",
        "resolvedInsideProject": "migrations/mv",
        "sqlFiles": 9
      }
    ],
    "placeholders": [
      "REPLACE_WITH_PIPELINE_D1_ID",
      "REPLACE_WITH_MV_D1_ID"
    ]
  },
  "replace": {
    "removableDemoFiles": [
      "src/booking-domain.ts",
      "src/booking-transport.ts",
      "src/booking-mv.ts",
      "src/booking-routes.ts",
      "public/index.html",
      "public/app.js",
      "public/styles.css"
    ],
    "keepsInfrastructure": true
  },
  "package": {
    "name": "g103-starter-booking",
    "matchedSetVersions": {
      "@sekiban/dcb-core": "0.2.0",
      "@sekiban/dcb-domain": "0.2.0",
      "@sekiban/dcb-client": "0.2.0",
      "@sekiban/dcb-runtime": "0.2.0"
    },
    "helper": "^0.1.0",
    "wrangler": "4.125.0"
  },
  "installs": {
    "matchedSet": {
      "source": "https://registry.npmjs.org",
      "packages": {
        "@sekiban/dcb-core": {
          "version": "0.2.0",
          "resolved": "https://registry.npmjs.org/@sekiban/dcb-core/-/dcb-core-0.2.0.tgz",
          "insideWorktree": false
        },
        "@sekiban/dcb-domain": {
          "version": "0.2.0",
          "resolved": "https://registry.npmjs.org/@sekiban/dcb-domain/-/dcb-domain-0.2.0.tgz",
          "insideWorktree": false
        },
        "@sekiban/dcb-client": {
          "version": "0.2.0",
          "resolved": "https://registry.npmjs.org/@sekiban/dcb-client/-/dcb-client-0.2.0.tgz",
          "insideWorktree": false
        },
        "@sekiban/dcb-runtime": {
          "version": "0.2.0",
          "resolved": "https://registry.npmjs.org/@sekiban/dcb-runtime/-/dcb-runtime-0.2.0.tgz",
          "insideWorktree": false
        }
      }
    },
    "helper": {
      "source": "local npm pack",
      "version": "0.1.0",
      "resolved": "file:/tmp/sdt-g103-pack-eyR2Ue/sekiban-dcb-cloudflare-0.1.0.tgz",
      "bin": "dcb-cloudflare"
    },
    "wrangler": {
      "source": "project dependency",
      "version": "4.125.0"
    }
  },
  "helperPlans": {
    "migrate": [
      [
        "wrangler",
        "d1",
        "migrations",
        "apply",
        "g103-starter-booking-pipeline",
        "--config",
        "wrangler.jsonc",
        "--remote"
      ],
      [
        "wrangler",
        "d1",
        "migrations",
        "apply",
        "g103-starter-booking-mv",
        "--config",
        "wrangler.jsonc",
        "--remote"
      ]
    ],
    "deploy": [
      [
        "wrangler",
        "d1",
        "migrations",
        "apply",
        "g103-starter-booking-pipeline",
        "--config",
        "wrangler.jsonc",
        "--remote"
      ],
      [
        "wrangler",
        "d1",
        "migrations",
        "apply",
        "g103-starter-booking-mv",
        "--config",
        "wrangler.jsonc",
        "--remote"
      ],
      [
        "wrangler",
        "deploy",
        "--config",
        "wrangler.jsonc"
      ]
    ],
    "config": "wrangler.jsonc",
    "derivedNames": [
      "g103-starter-booking-pipeline",
      "g103-starter-booking-mv",
      "g103-starter-booking-outbox",
      "g103-starter-booking-outbox-dlq"
    ]
  },
  "dryRun": {
    "command": [
      "wrangler",
      "deploy",
      "--config",
      "wrangler.jsonc",
      "--dry-run"
    ],
    "worker": "g103-starter-booking-worker",
    "bundleBytes": 2942968,
    "bookingMarkers": [
      "create-room",
      "reserve-room"
    ],
    "wranglerSource": "project-local"
  },
  "safety": {
    "liveWorkerRefused": true,
    "liveDatabaseIdsAbsent": true,
    "meetingRoomResourceNamesAbsent": true,
    "g32DeployLiveUnsetForDryRun": true
  }
}
```
