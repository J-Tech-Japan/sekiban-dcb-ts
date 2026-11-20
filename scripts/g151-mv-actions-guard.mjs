#!/usr/bin/env node
// SDT-G151 static guard for the authenticated materialized-view actions.
// Behavioral proof lives in test/g151-mv-actions.spec.ts; this guard keeps the
// route, authentication order, registry, CAS, received gates, and GET
// observation boundaries from silently regressing. `--root <dir>` lets the
// mutation runner evaluate an owned scratch copy.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : process.cwd());
const read = (path) => readFileSync(resolve(root, path), "utf8");

const ordinary = read("packages/dcb-runtime/src/index.ts");
const cloudflare = read("packages/dcb-runtime/src/cloudflare.ts");
const actions = read("packages/dcb-runtime/src/mv/MaterializedViewActions.ts");
const catchUp = read("packages/dcb-runtime/src/mv/MaterializedViewCatchUp.ts");
const compose = read("packages/dcb-cloudflare/src/compose.ts");
const spec = read("test/g151-mv-actions.spec.ts");

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

function before(source, first, second) {
  const a = source.indexOf(first);
  const b = source.indexOf(second);
  return a >= 0 && b >= 0 && a < b;
}

const failures = [];
function check(name, ok) {
  if (!ok) failures.push(name);
}

const branch = `      if (isMaterializedViewActionPath(url.pathname)) {
        // Authenticated before any view/body parsing, identity, or store work.
        return handleMaterializedViewAction(request, {
          registry: materializedViewActions,
          operatorToken: env.REPAIR_OPERATOR_TOKEN,`;
const registry = "const materializedViewActions = createMaterializedViewActionRegistry(options.materializedViewActions);";
const option = "readonly materializedViewActions?: readonly MaterializedViewRowMaterializer[];";

const handler = slice(actions, "export async function handleMaterializedViewAction", "async function parseActionInput");
const ensure = slice(actions, "async function ensureStarted", "function actionError");
const actionBody = slice(actions, "async function actionResponse", "class EnsureStartedUnavailable");
const prepareCase = slice(actionBody, 'case "prepare":', "break;");
const errors = slice(actions, "function actionError", "export async function readMaterializedViewRuntimeStatus");
const statusRead = slice(actions, "export async function readMaterializedViewRuntimeStatus", "async function statusResponse");
const statusRoute = slice(actions, "async function statusResponse", "async function receivedResponse");
const received = slice(actions, "async function receivedResponse", "function json(");
const follow = slice(catchUp, "async follow<", "async rebuild<");
const promote = slice(catchUp, "async promote(", "async read(");
const ordinaryFetch = slice(ordinary, "async fetch(request, env, ctx)", "async queue(");
const cloudflareFetch = slice(cloudflare, "async fetch(request, env, ctx)", "async queue(");

check("ordinary-branch", ordinary.includes(option)
  && ordinary.includes(registry)
  && ordinaryFetch.includes(branch)
  && before(ordinaryFetch, branch, "const serviceIdentity = options.serviceIdentityProvider ?? envServiceIdentity(env);"));
check("cloudflare-branch", cloudflare.includes(option)
  && cloudflare.includes(registry)
  && cloudflareFetch.includes(branch)
  && before(cloudflareFetch, branch, "const serviceIdentity = options.serviceIdentityProvider ?? envServiceIdentity(env);")
  && before(cloudflareFetch, branch, "createG60DurableHopObserver("));

const auth = "const denied = await authenticateOperatorRepair(request, dependencies.operatorToken);\n  if (denied !== undefined) return denied;";
check("auth-first", handler.includes(auth)
  && ["new URL(request.url)", "decodeURIComponent(", "dependencies.registry.lookup(", "parseActionInput(", "dependencies.resolveServiceId()", "dependencies.createSource()", "dependencies.materializedViewDatabase()"]
    .every((later) => before(handler, auth, later)));

check("definition-version-guard", follow.includes("if (materializer.version !== active.definitionVersion) {\n      throw new MaterializedViewDefinitionVersionMismatchError();\n    }")
  && before(follow, "throw new MaterializedViewDefinitionVersionMismatchError();", "const observation")
  && before(follow, "throw new MaterializedViewDefinitionVersionMismatchError();", "try {")
  && before(follow, "throw new MaterializedViewDefinitionVersionMismatchError();", "this.followGeneration(")
  && catchUp.includes('readonly code = "MV_DEFINITION_VERSION_MISMATCH" as const;')
  && errors.includes("if (error instanceof MaterializedViewDefinitionVersionMismatchError) {\n    return errorResponse(409, \"materialized_view_definition_version_mismatch\""));

check("registry-lookup", handler.includes("const materializer = dependencies.registry.lookup(viewId);\n  if (materializer === undefined) return notFound();")
  && !/version\s*:/.test(handler)
  && !actions.includes('searchParams.get("version")')
  && !actions.includes("value.version")
  && !actions.includes("value.definitionVersion"));

check("ensure-idempotent", ensure.includes("if (existing !== undefined) return null;")
  && before(ensure, "if (existing !== undefined) return null;", "runtime.build(")
  && ensure.includes('error.code !== "MV_INSTANCE_EXISTS"')
  && ensure.includes("if (reread === undefined) throw new EnsureStartedUnavailable();")
  && (ensure.match(/runtime\.build\(/g) ?? []).length === 1);

check("prepare-no-cutover", prepareCase.includes("runtime.rebuild(serviceId, materializer, nowMs, input.rebuildId)")
  && !prepareCase.includes("promote"));

check("expected-active-pass-through", promote.includes("options.expectedActiveGeneration !== undefined\n        ? options.expectedActiveGeneration\n        : active?.generation ?? null")
  && actionBody.includes("expectedActiveGeneration: input.expectedActiveGeneration,")
  && !actionBody.includes("expectedActiveGeneration ??"));

check("cas-conflict-409", errors.includes('case "MV_PROMOTION_CAS_MISMATCH":\n        return errorResponse(409, "materialized_view_switch_conflict"'));

const gate = received.match(/if \((state\.[^)]*)\) return unavailable\(\);/)?.[1] ?? "";
const success = "if (state.targetReceipt || compareSuid(state.safeContiguousHead, lookup.suid) >= 0) return json(200, true);";
check("received-incident-gate", received.includes('if (lookup.kind === "unavailable") return unavailable();')
  && before(received, 'if (lookup.kind === "unavailable") return unavailable();', "target.readWaitForState("));
check("received-checkpoint-gate", gate.includes("state.checkpointAhead") && before(received, "state.checkpointAhead", success));
check("received-rebuild-gate", gate.includes("state.rebuildRequired") && before(received, "state.rebuildRequired", success));
check("received-poison-gate", gate.includes("state.poison") && before(received, "state.poison", success));
check("received-unique-source", received.includes('if (lookup.kind !== "stored" || state.activeGeneration === undefined) return json(200, false);')
  && before(received, 'if (lookup.kind !== "stored"', success)
  && (received.match(/readWaitForTarget\(/g) ?? []).length === 1
  && (received.match(/readWaitForState\(/g) ?? []).length === 1
  && !received.includes("readAllEvents")
  && !received.includes("setTimeout"));

const observationOnly = [statusRead, statusRoute, received];
check("get-no-catch-up", observationOnly.every((source) => source.length > 0
  && !source.includes("MaterializedViewCatchUpRuntime")
  && !source.includes(".follow(")
  && !source.includes(".build(")
  && !source.includes(".rebuild(")
  && !source.includes(".promote(")
  && !source.includes("upsertProjectionStatusHeartbeat")
  && !source.includes("publish")));

const serialized = quotedPaths(compose, "export const SERIALIZED_PATHS");
check("serialized-paths", serialized.length === 7 && serialized.every((route) => !route.includes("materialized-views")));

check("operator-lane", actions.includes('new MaterializedViewCatchUpRuntime(source, target, { publicationActivationId: "operator" })')
  && catchUp.includes("activationId: this.context.publicationActivationId ?? PROJECTION_STATUS_ACTIVATION_ID,")
  && catchUp.includes("private readonly context: MaterializedViewCatchUpRuntimeContext = {},"));

check("behavioral-oracles", spec.includes("materialized_view_switch_conflict")
  && spec.includes("toEqual([200, 409])")
  && spec.includes("MaterializedViewDefinitionVersionMismatchError")
  && spec.includes("targetReads: 0")
  && spec.includes("createCloudflareOnlyRuntimeWorker"));

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log("g151 materialized-view actions guard passed");
