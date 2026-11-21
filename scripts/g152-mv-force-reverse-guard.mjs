#!/usr/bin/env node
// SDT-G152 static guard for break-glass materialized-view force reverse.
// Behavioral proof lives in test/g152-mv-force-reverse.spec.ts; this guard
// keeps the reverse-only, retired-only, quarantine-history, pointer-fence,
// forced-audit, required-migration, and route boundaries from silently
// regressing. `--root <dir>` lets the mutation runner evaluate a scratch copy.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : process.cwd());
const read = (path) => readFileSync(resolve(root, path), "utf8");

const store = read("packages/dcb-runtime/src/mv/MaterializedViewStore.ts");
const catchUp = read("packages/dcb-runtime/src/mv/MaterializedViewCatchUp.ts");
const actions = read("packages/dcb-runtime/src/mv/MaterializedViewActions.ts");
const rootMigration = read("migrations/mv/0010_g152_force_reverse_audit.sql");
const templateMigration = read("packages/create-dcb/template/migrations/mv/0010_g152_force_reverse_audit.sql");
const compose = read("packages/dcb-cloudflare/src/compose.ts");
const spec = read("test/g152-mv-force-reverse.spec.ts");

function slice(source, start, end) {
  const from = source.indexOf(start);
  const to = from < 0 ? -1 : source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) return "";
  return source.slice(from, to);
}

function before(source, first, second) {
  const a = source.indexOf(first);
  const b = source.indexOf(second);
  return a >= 0 && b >= 0 && a < b;
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

const reverse = slice(store, "async forceReverseGeneration(", "/** Short aliases make the port convenient");
const reverseGuard = slice(reverse, "INSERT INTO mv_atomic_guards", "THEN 1 ELSE NULL END");
const historyClause = slice(reverseGuard, "NOT EXISTS (", "AND EXISTS (");
const historyRead = slice(reverse, "const history = await", ".first<D1Row>();");
const reverseInput = slice(store, "export interface MaterializedViewForceReverseInput", "}");
const normalize = slice(store, "export function normalizeMaterializedViewForceReverseReason", "export interface MaterializedViewQueryOptions");
const initialize = slice(store, "async initialize(): Promise<void>", "async createActive(");
const createActive = slice(store, "async createActive(", "async createCandidate(");
const promote = slice(store, "async promoteGeneration(", "async forceReverseGeneration(");
const facts = slice(store, "async readStatusFacts(", "async recordUnsafeFailureFinding(");
const runtimeReverse = slice(catchUp, "async forceReverse(", "private async followGeneration<");
const heartbeat = slice(catchUp, "private async writeHeartbeat(", "private async detectLateLowerSuid(");
const parser = slice(actions, "function parseForceReverse(", "function isGeneration(");
const errors = slice(actions, "function actionError", "export async function readMaterializedViewRuntimeStatus");
const actionBody = slice(actions, "async function actionResponse", "class EnsureStartedUnavailable");
const statusRead = slice(actions, "export async function readMaterializedViewRuntimeStatus", "async function statusResponse");
const retire = "SET status = 'retired', updated_at = ?";
const activate = "SET status = 'active'\n";

check("reverse-only", reverse.includes("if (input.retainedGeneration >= input.expectedActiveGeneration) {")
  && before(reverse, "if (input.retainedGeneration >= input.expectedActiveGeneration) {", "this.database.")
  && parser.includes("if (retainedGeneration >= expectedActiveGeneration) throw new InvalidActionRequest();"));

check("retired-only", reverse.includes('if (retained === undefined || retained.status !== "retired") {')
  && reverseGuard.includes("AND retained.generation = ? AND retained.status = 'retired'")
  && reverse.includes("WHERE service_id = ? AND view_id = ? AND generation = ? AND status = 'retired'")
  && !reverse.includes("'candidate'"));

check("reverse-cas-not-promote", reverse.length > 0
  && !reverse.includes("promoteGeneration")
  && runtimeReverse.includes("this.materializedViews.forceReverseGeneration({")
  && !runtimeReverse.includes("promoteGeneration(")
  && !runtimeReverse.includes(".promote(")
  && actionBody.includes("result = await runtime.forceReverse("));

check("reason-validation", reverse.includes("const reason = normalizeMaterializedViewForceReverseReason(input.reason);")
  && before(reverse, "normalizeMaterializedViewForceReverseReason(input.reason)", "this.database.")
  && normalize.includes("const trimmed = reason.trim();")
  && normalize.includes("trimmed.length === 0 || trimmed.length > MAX_FORCE_REVERSE_REASON_LENGTH")
  && normalize.includes("/[\\u0000-\\u001f\\u007f-\\u009f]/")
  && store.includes("const MAX_FORCE_REVERSE_REASON_LENGTH = 1_024;")
  && parser.includes("const reason = normalizeMaterializedViewForceReverseReason(value.reason);"));

check("quarantine-history", historyClause.includes("FROM mv_ordering_quarantines retained_history")
  && historyClause.includes("retained_history.generation = retained.generation")
  && !historyClause.includes("status")
  && historyRead.includes("FROM mv_ordering_quarantines")
  && historyRead.includes("WHERE service_id = ? AND view_id = ? AND generation = ? LIMIT 1")
  && !historyRead.includes("status")
  && reverse.includes("if (history !== null && history !== undefined) {"));

check("quarantine-untouched", reverse.length > 0
  && !/(UPDATE|DELETE FROM|INSERT INTO)\s+mv_ordering_quarantines/.test(reverse));

check("forced-audit", reverse.includes("SET generation = ?, updated_at = ?, switch_kind = 'forced', switch_reason = ?, switched_at = ?")
  && runtimeReverse.includes('switch: { kind: "forced", reason: reason.trim() },')
  && heartbeat.includes("switchKind: recordSwitch?.kind ?? null,")
  && heartbeat.includes("switchReason: recordSwitch?.reason ?? null,"));

check("pointer-fence", reverseGuard.includes("AND pointer.generation = ? AND current.status = 'active'")
  && reverse.includes("WHERE service_id = ? AND view_id = ? AND generation = ?`,\n      ).bind(\n        input.retainedGeneration,")
  && reverse.includes("if (isCasFailure(error)) throw new MaterializedViewForceReverseCasError();"));

check("non-null-expectation", reverseInput.includes("readonly expectedActiveGeneration: number;")
  && !reverseInput.includes("null")
  && reverse.includes('this.validateGeneration(input.expectedActiveGeneration, "force-reverse");')
  && parser.includes("if (!isGeneration(retainedGeneration) || !isGeneration(expectedActiveGeneration)) throw new InvalidActionRequest();")
  && !parser.includes("!== null"));

check("initialize-probe", initialize.includes("SELECT 1 FROM mv_active_generations WHERE switch_kind IS NOT NULL OR switch_reason IS NOT NULL OR switched_at IS NOT NULL LIMIT 1")
  && before(initialize, "switched_at IS NOT NULL LIMIT 1", "this.initialized = true;")
  && [store, catchUp, actions].every((source) => !/ALTER TABLE|CREATE TABLE/.test(source)));

check("legacy-default", rootMigration === templateMigration
  && rootMigration.includes("NOT NULL DEFAULT 'legacy'")
  && rootMigration.includes("CHECK (switch_kind IN ('ordinary', 'forced', 'legacy'))")
  && (rootMigration.match(/ALTER TABLE mv_active_generations ADD COLUMN/g) ?? []).length === 3
  && !/CREATE (TABLE|INDEX)/.test(rootMigration));

check("legacy-read", facts.includes("switchKind: switchKind ?? null,")
  && facts.includes('switchKind !== "ordinary" && switchKind !== "forced" && switchKind !== "legacy"')
  && statusRead.includes("switchKind: active === undefined ? null : facts?.switchKind ?? null,"));

check("ordinary-audit", createActive.includes("VALUES (?, ?, ?, ?, 'ordinary', NULL, ?)")
  && promote.includes("VALUES (?, ?, ?, ?, 'ordinary', NULL, ?)")
  && promote.includes("switch_kind = excluded.switch_kind, switch_reason = excluded.switch_reason, switched_at = excluded.switched_at"));

check("retire-before-activate", before(reverse, retire, activate)
  && before(reverse, "INSERT INTO mv_atomic_guards", retire)
  && before(reverse, activate, "UPDATE mv_active_generations"));

check("route-registration", actions.includes('"force-reverse": "POST",')
  && actions.includes('| "force-reverse"'));

check("error-mapping", errors.includes('case "MV_FORCE_REVERSE_CAS_MISMATCH":\n        return errorResponse(409, "materialized_view_force_reverse_conflict"')
  && errors.includes('case "MV_FORCE_REVERSE_REJECTED":\n        return errorResponse(409, "materialized_view_force_reverse_rejected"'));

const serialized = quotedPaths(compose, "export const SERIALIZED_PATHS");
check("serialized-paths", serialized.length === 7 && serialized.every((route) => !route.includes("materialized-views")));

check("behavioral-oracles", spec.includes("toEqual([200, 409])")
  && spec.includes("MV_FORCE_REVERSE_CAS_MISMATCH")
  && spec.includes("initializeFailedBefore0010")
  && spec.includes('switch_kind: "legacy"')
  && spec.includes("leavingGenerationQuarantineOpen: true")
  && spec.includes("createCloudflareOnlyRuntimeWorker"));

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log("g152 materialized-view force-reverse guard passed");
