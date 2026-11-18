#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : process.cwd());
const read = (path) => readFileSync(resolve(root, path), "utf8");

const ordinary = read("packages/dcb-runtime/src/index.ts");
const cloudflare = read("packages/dcb-runtime/src/cloudflare.ts");
const status = read("packages/dcb-runtime/src/mv/ProjectionStatus.ts");
const catchUp = read("packages/dcb-runtime/src/mv/MaterializedViewCatchUp.ts");
const d1 = read("packages/dcb-runtime/src/store/D1EventStore.ts");
const postgres = read("packages/dcb-runtime/src/store/PostgresEventStore.ts");
const compose = read("packages/dcb-cloudflare/src/compose.ts");
const deploy = read("packages/create-dcb/template/scripts/deploy-check.mjs");
const spec = read("test/g150-mv-status.spec.ts");
const rootMigration = read("migrations/d1/g32/0022_g150_projection_statuses.sql");
const templateMigration = read("packages/create-dcb/template/migrations/d1/g32/0022_g150_projection_statuses.sql");

const route = `if (url.pathname === "/api/sekiban/serialized/projection-status") {
        return handleSerializedProjectionStatus(request, {`;
const members = [
  "projectorName",
  "projectorVersion",
  "clusterId",
  "activationId",
  "sequence",
  "appliedEventCount",
  "lastAppliedSortableUniqueId",
  "lastTraversedSortableUniqueId",
  "totalEventCount",
  "remainingEventCount",
  "sampledAtUtc",
  "consistency",
  "isCaughtUp",
  "hasConflict",
  "conflictingActivationIds",
  "phase",
  "leaseExpiresAtUtc",
  "isFaulted",
  "faultMessage",
  "isFresh",
];

function slice(source, start, end) {
  const from = source.indexOf(start);
  const to = from < 0 ? -1 : source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) return "";
  return source.slice(from, to);
}

function quotedPaths(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) return [];
  const end = source.indexOf("]", start);
  return [...source.slice(start, end).matchAll(/"(\/[^"]+)"/g)].map((match) => match[1]);
}

const failures = [];
function check(name, ok) {
  if (!ok) failures.push(name);
}

const phase = slice(status, "export function mapMaterializedViewStatusPhase", "export function serializeProjectionStatusRequestV1");
const publication = slice(catchUp, "private async publishProjectionStatusBestEffort", "private async writeProjectionStatusHeartbeat");
const build = slice(catchUp, "async build<", "async follow<");
const follow = slice(catchUp, "async follow<", "async rebuild<");
const rebuild = slice(catchUp, "async rebuild<", "async promote(");
const promote = slice(catchUp, "async promote(", "async read(");
const composed = quotedPaths(compose, "export const SERIALIZED_PATHS");
const deployed = quotedPaths(deploy, "const serializedRoutePaths");
const runtimeSources = [ordinary, cloudflare, status, catchUp, d1, postgres, read("packages/dcb-runtime/src/mv/MaterializedViewStore.ts")];

check("ordinary-route", ordinary.includes(route));
check("cloudflare-route", cloudflare.includes(route));
check("seven-path-set", composed.length === 7
  && composed.at(-1) === "/api/sekiban/serialized/projection-status"
  && composed.join("\n") === deployed.join("\n"));
check("identity-literals", status.includes('projectorName: `mv:${encoded}`')
  && status.includes('projectorVersion: `v:${definitionVersion}`')
  && status.includes('export const PROJECTION_STATUS_CLUSTER_ID = "cloudflare"')
  && status.includes('export const PROJECTION_STATUS_ACTIVATION_ID = "scheduled"'));
check("v1-members", status.includes(members.map((member) => `"${member}"`).join(",\n  ")));
check("reader-isolation", !status.includes("D1_MV") && !status.includes("readStatusFacts"));
check("runtime-ddl", runtimeSources.every((source) => !source.includes("CREATE TABLE dcb_projection_statuses")
  && !source.includes("CREATE TABLE IF NOT EXISTS dcb_projection_statuses")));
check("migration-parity", rootMigration === templateMigration && rootMigration.includes("PRIMARY KEY (service_id, projector_name, projector_version, cluster_id)"));
check("d1-expected-sequence", d1.includes("dcb_projection_statuses.sequence = ? AND excluded.sequence > dcb_projection_statuses.sequence"));
check("postgres-expected-sequence", postgres.includes("dcb_projection_statuses.sequence = $1 AND EXCLUDED.sequence > dcb_projection_statuses.sequence"));
check("rebuild-before-active", phase.includes('if (facts.rebuildRequired) return "catchingUp";')
  && phase.indexOf('return "faulted"') < phase.indexOf('return "active"')
  && phase.indexOf("facts.rebuildRequired") < phase.indexOf('return "active"'));
check("hard-finding-fault", phase.includes("facts.checkpointAhead || facts.targetPoison || facts.openOrderingQuarantine"));
check("publication-guard", publication.includes("try {")
  && publication.indexOf("try {") < publication.indexOf("await this.writeProjectionStatusHeartbeat(input);")
  && publication.includes("} catch {")
  && publication.includes("return;"));
check("publication-after-action", build.indexOf("createActive(") < build.indexOf("publishProjectionStatusBestEffort(")
  && follow.indexOf("followGeneration(") < follow.indexOf("publishProjectionStatusBestEffort(")
  && rebuild.lastIndexOf("markGenerationRebuilt(") < rebuild.lastIndexOf("publishProjectionStatusBestEffort(")
  && promote.indexOf("promoteGeneration(") < promote.indexOf("publishProjectionStatusBestEffort("));
check("target-isolation-oracle", spec.includes("D1_MV") && spec.includes("toBe(0)"));
check("original-error-oracle", spec.includes("toBe(sentinel)"));

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log("g150 materialized-view status guard passed");
