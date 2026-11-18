#!/usr/bin/env node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guard = join(root, "scripts/g150-mv-status-guard.mjs");
const files = {
  ordinary: "packages/dcb-runtime/src/index.ts",
  cloudflare: "packages/dcb-runtime/src/cloudflare.ts",
  status: "packages/dcb-runtime/src/mv/ProjectionStatus.ts",
  catchUp: "packages/dcb-runtime/src/mv/MaterializedViewCatchUp.ts",
  d1: "packages/dcb-runtime/src/store/D1EventStore.ts",
  postgres: "packages/dcb-runtime/src/store/PostgresEventStore.ts",
  compose: "packages/dcb-cloudflare/src/compose.ts",
  template: "packages/create-dcb/template/migrations/d1/g32/0022_g150_projection_statuses.sql",
  spec: "test/g150-mv-status.spec.ts",
  deploy: "packages/create-dcb/template/scripts/deploy-check.mjs",
  store: "packages/dcb-runtime/src/mv/MaterializedViewStore.ts",
  rootMigration: "migrations/d1/g32/0022_g150_projection_statuses.sql",
  legacyMigration: "migrations/d1/0004_g150_projection_statuses.sql",
  postgresMigration: "migrations/postgres/0001_g150_projection_statuses.sql",
};

const route = `      if (url.pathname === "/api/sekiban/serialized/projection-status") {
        return handleSerializedProjectionStatus(request, {
          serverServiceId: requestServiceId,
          createStore: () => storeProvider.create(env),
        });
      }`;

const mutants = [
  { name: "ordinary-route", file: "ordinary", from: route, to: "" },
  { name: "cloudflare-route", file: "cloudflare", from: route, to: "" },
  {
    name: "d1-expected-sequence",
    file: "d1",
    from: "dcb_projection_statuses.sequence = ? AND excluded.sequence > dcb_projection_statuses.sequence",
    to: "excluded.sequence > dcb_projection_statuses.sequence",
  },
  {
    name: "postgres-expected-sequence",
    file: "postgres",
    from: "dcb_projection_statuses.sequence = $1 AND EXCLUDED.sequence > dcb_projection_statuses.sequence",
    to: "EXCLUDED.sequence > dcb_projection_statuses.sequence",
  },
  {
    name: "rebuild-before-active",
    file: "status",
    from: 'if (facts.rebuildRequired) return "catchingUp";',
    to: 'if (facts.rebuildRequired) return "active";',
  },
  {
    name: "hard-finding-fault",
    file: "status",
    from: "facts.checkpointAhead || facts.targetPoison || facts.openOrderingQuarantine",
    to: "facts.targetPoison || facts.openOrderingQuarantine",
  },
  {
    name: "publication-guard",
    file: "catchUp",
    from: `      await Promise.race([
        this.writeProjectionStatusHeartbeat(input).catch(() => undefined),
        timeout.catch(() => undefined),
      ]);`,
    to: `      await this.writeProjectionStatusHeartbeat(input);`,
  },
  {
    name: "status-read-ddl",
    file: "postgres",
    from: 'await sql.unsafe("SELECT 1 AS status_connection");',
    to: 'await sql.unsafe("CREATE TABLE dcb_projection_statuses (service_id text)");',
  },
  {
    name: "reader-isolation",
    file: "status",
    from: 'export const PROJECTION_STATUS_PATH = "/api/sekiban/serialized/projection-status";',
    to: 'export const PROJECTION_STATUS_PATH = "/api/sekiban/serialized/projection-status";\nconst touchedTarget = "D1_MV";',
  },
  {
    name: "runtime-ddl",
    file: "d1",
    from: 'await this.database.prepare("SELECT 1 AS migration_binding").all();',
    to: 'await this.database.prepare("CREATE TABLE dcb_projection_statuses (service_id TEXT)").all();\n    await this.database.prepare("SELECT 1 AS migration_binding").all();',
  },
  {
    name: "migration-parity",
    file: "template",
    from: "CREATE TABLE dcb_projection_statuses (",
    to: "CREATE TABLE dcb_projection_status_diverged (",
  },
  {
    name: "v1-members",
    file: "status",
    from: '"faultMessage",\n  "isFresh",',
    to: '"faultMessage",',
  },
  {
    name: "seven-path-set",
    file: "compose",
    from: '  "/api/sekiban/serialized/projection-status",\n',
    to: "",
  },
];

function copyTree(target) {
  for (const relative of Object.values(files)) {
    const destination = join(target, relative);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(join(root, relative)));
  }
}

function runGuard(target) {
  return spawnSync(process.execPath, [guard, "--root", target], { encoding: "utf8" });
}

if (process.argv.includes("--self-test")) {
  for (const mutant of mutants) {
    const source = readFileSync(join(root, files[mutant.file]), "utf8");
    const matches = source.split(mutant.from).length - 1;
    if (matches !== 1) {
      console.error(`anchor ${mutant.name} matched ${matches} times`);
      process.exit(1);
    }
  }
  console.log("g150 mutation anchors passed");
  process.exit(0);
}

const clean = mkdtempSync(join(tmpdir(), "g150-clean-"));
try {
  copyTree(clean);
  const baseline = runGuard(clean);
  if (baseline.status !== 0) {
    console.error(baseline.stdout);
    console.error(baseline.stderr);
    throw new Error("guard failed on the unmodified sources");
  }
  for (const mutant of mutants) {
    const directory = mkdtempSync(join(tmpdir(), "g150-mutant-"));
    try {
      copyTree(directory);
      const path = join(directory, files[mutant.file]);
      const source = readFileSync(path, "utf8");
      if (!source.includes(mutant.from)) throw new Error(`missing anchor for ${mutant.name}`);
      writeFileSync(path, source.replace(mutant.from, mutant.to));
      const result = runGuard(directory);
      const output = `${result.stdout}\n${result.stderr}`;
      if (result.status === 0 || !output.includes(`FAIL ${mutant.name}`)) {
        console.error(output);
        throw new Error(`mutant ${mutant.name} did not fail ${mutant.name}`);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
} finally {
  rmSync(clean, { recursive: true, force: true });
}
console.log("g150 materialized-view status mutation runner passed");
