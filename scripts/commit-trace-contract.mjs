#!/usr/bin/env node
/**
 * Target-side, read-only verifier for the host-owned G30 authority bundle.
 *
 * This script intentionally has no --write or --seal mode. The host owns
 * generation and sealing; target CI verifies the mirrored bytes, bundle
 * digest, typed pin, and manifest structure without ever deriving expected
 * artifacts from target source.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const contractDirectory = resolve(root, "contracts");
const bundlePath = resolve(contractDirectory, "commit-trace-bundle.json");
const manifestPath = resolve(contractDirectory, "commit-trace-manifest.json");
const pinPath = resolve(contractDirectory, "host-pin.json");
const EXPECTED_A = "b8390959ddbe8c824dfe99c0149ca1c008367b45";
const EXPECTED_S = "26fb3b474e22fdb880955b8e7240bdbf605622ee";
const EXPECTED_P = "46d34ad72a1f4ddbf9e7aab7f44d32b3a082b541";
const EXPECTED_BUNDLE_DIGEST = "sha256:7fa89d23bbb532d40010f8e39fb002d676e9542abe058a5b326ccfa5940af441";
const REQUIRED_FACES = Object.freeze(["pre-admission", "accepted", "reconcile-root", "repair-root"]);
const REQUIRED_STATES = Object.freeze(["required", "optional", "forbidden"]);
const PROVIDER_ADAPTER_FIELDS = new Set(["script.version", "colo", "placement"]);
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;

function read(path) {
  return readFileSync(path, "utf8");
}

function parse(path) {
  return JSON.parse(read(path));
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fail(code, message) {
  throw new Error(`commit-trace-contract:${code}:${message}`);
}

function exactSet(actual, expected, label) {
  const sorted = [...actual].sort();
  const wanted = [...expected].sort();
  if (!same(sorted, wanted)) fail("exact-set", `${label} differs (actual=${sorted.join(",")}; expected=${wanted.join(",")})`);
}

/**
 * These identity lists are captured from the verified immutable bundle bytes
 * at process startup, not hand-written parallel expectations. A changed
 * target artifact is first rejected by its host digest before shape checks.
 */
const baselineManifest = parse(manifestPath);
const AUTHORITY_ATTRIBUTE_IDS = Object.freeze(Object.keys(baselineManifest.attributeMatrix?.attributes ?? {}).sort());
const AUTHORITY_SCHEMA_IDS = Object.freeze(Object.keys(baselineManifest.schemas ?? {}).sort());
const AUTHORITY_RECOVERY_IDS = Object.freeze(Object.keys(baselineManifest.schemas?.["sdt.commit.reconcile/v1"]?.recoveryDag ?? {}).sort());
const AUTHORITY_REPAIR_LINKS = Object.freeze((baselineManifest.schemas?.["sdt.commit.repair/v1"]?.parentLinks ?? []).map((link) => `${link.row}|${link.linkedTo}|${link.via}`).sort());
const AUTHORITY_ROWS = Object.freeze(Object.fromEntries(
  Object.entries(baselineManifest.schemas ?? {}).map(([schema, value]) => [
    schema,
    Object.freeze((value.rows ?? []).map((row) => Object.freeze({
      rowId: row.rowId,
      span: row.span,
      emitter: row.emitter,
      start: row.start,
      end: row.end,
      logicalParent: row.logicalParent,
      coverage: row.coverage,
      kind: row.kind,
      successCardinality: row.successCardinality,
    }))),
  ]),
));

function assertAuthorityRows(manifest) {
  for (const [schema, expectedRows] of Object.entries(AUTHORITY_ROWS)) {
    const actualRows = manifest.schemas?.[schema]?.rows;
    if (!same(actualRows, expectedRows)) {
      fail("row-authority", `${schema} row emitter/start/end/parent/coverage/kind/cardinality differs from the host authority`);
    }
  }
}

function assertAuthoritySections(manifest) {
  // The host-owned machine artifact is the sole expectation. Capturing these
  // immutable sections at process startup is only a mutation oracle: normal
  // checks first reject any target byte drift by digest and never regenerate
  // values from target source code.
  for (const schema of AUTHORITY_SCHEMA_IDS) {
    const actual = manifest.schemas?.[schema];
    const expected = baselineManifest.schemas?.[schema];
    for (const field of ["universe", "boundaries", "callerCoverageIntervals", "recoveryDag", "terminalAtEntryBoundary", "generationStateMachine", "sealPredicates", "parentLinks"]) {
      if (!same(actual?.[field], expected?.[field])) {
        fail("schema-authority", `${schema}.${field} differs from the host authority`);
      }
    }
  }
  if (!same(manifest.remoteInvocationUniverse, baselineManifest.remoteInvocationUniverse)) {
    fail("remote-authority", "remoteInvocationUniverse differs from the host authority");
  }
  if (!same(manifest.attributeMatrix, baselineManifest.attributeMatrix)) {
    fail("matrix-authority", "attribute matrix differs from the host authority");
  }
}

export function assertTargetInvocation(argv = process.argv.slice(2)) {
  if (argv.some((value) => value === "--write" || value === "--seal")) {
    fail("target-write-forbidden", "the target checker is read-only; use the host authority workflow");
  }
  if (argv.some((value) => value !== "--check" && value !== "--self-test")) {
    fail("argument", `unsupported target checker argument(s): ${argv.join(" ")}`);
  }
}

export function loadAuthority(
  readText = read,
) {
  const bundle = JSON.parse(readText(bundlePath));
  const manifest = JSON.parse(readText(manifestPath));
  const pin = JSON.parse(readText(pinPath));
  return { bundle, manifest, pin };
}

export function assertMirroredDigests(bundle, readText = read) {
  if (!Array.isArray(bundle?.mirroredFiles) || !Array.isArray(bundle?.hostOnlyInputs)) {
    fail("bundle-shape", "mirroredFiles and hostOnlyInputs must be arrays");
  }
  for (const entry of bundle.mirroredFiles) {
    if (typeof entry?.hostPath !== "string" || typeof entry?.targetPath !== "string" || !SHA256.test(entry?.digest ?? "")) {
      fail("bundle-entry", "mirrored file entry is malformed");
    }
    const observed = digest(readText(resolve(root, entry.targetPath)));
    if (observed !== entry.digest) fail("mirror-drift", `${entry.targetPath} does not match host digest`);
  }
  for (const entry of bundle.hostOnlyInputs) {
    if (typeof entry?.hostPath !== "string" || entry?.targetPath !== null || !SHA256.test(entry?.digest ?? "")) {
      fail("bundle-host-only", "host-only input declaration is malformed");
    }
  }
  return { mirroredFiles: bundle.mirroredFiles.length, hostOnlyInputs: bundle.hostOnlyInputs.length };
}

export function calculateBundleDigest(bundle) {
  const entries = [...bundle.mirroredFiles, ...bundle.hostOnlyInputs];
  const joined = entries.map((entry) => `${entry.hostPath}\n${entry.digest}\n`).join("");
  return digest(joined);
}

export function assertBundle(bundle, pin) {
  if (bundle?.schemaVersion !== 3 || bundle?.name !== "commit-trace-bundle") fail("bundle-shape", "unexpected bundle schema/name");
  const computed = calculateBundleDigest(bundle);
  if (computed !== bundle.bundleDigest || computed !== EXPECTED_BUNDLE_DIGEST) fail("bundle-digest", "bundle digest mismatch");
  if (pin?.schemaVersion !== 2 || pin?.state !== "sealed") fail("pin-state", "host pin must be sealed");
  if (pin.hostCommit !== EXPECTED_A || !SHA.test(pin.hostCommit)) fail("pin-a", "host pin must name the sealed A authority");
  if (pin.bundleDigest !== computed) fail("pin-digest", "host pin bundle digest mismatch");
  return { bundleDigest: computed, hostCommit: pin.hostCommit, stages: { A: EXPECTED_A, S: EXPECTED_S, P: EXPECTED_P } };
}

function rowsFor(schema) {
  if (!Array.isArray(schema?.rows)) fail("schema-rows", "schema rows must be an array");
  const ids = schema.rows.map((row) => row?.rowId);
  if (ids.some((id) => typeof id !== "string" || id.length === 0) || new Set(ids).size !== ids.length) {
    fail("row-id", "row ids must be non-empty and unique");
  }
  return ids;
}

function assertBoundaryUniverse(schema, name) {
  if (!Array.isArray(schema?.boundaries)) return;
  const universe = schema.universe;
  if (!Array.isArray(universe)) fail("universe", `${name} lacks an explicit universe`);
  for (const boundary of schema.boundaries) {
    const required = Array.isArray(boundary?.requiredRows) ? boundary.requiredRows : fail("boundary", `${name} requiredRows malformed`);
    const forbidden = Array.isArray(boundary?.forbiddenRows) ? boundary.forbiddenRows : fail("boundary", `${name} forbiddenRows malformed`);
    const conditional = Array.isArray(boundary?.conditionalRows) ? boundary.conditionalRows : fail("boundary", `${name} conditionalRows malformed`);
    const conditionalIds = conditional.map((row) => {
      if (
        typeof row?.rowId !== "string" ||
        !("predicate" in row) ||
        !("instanceCount" in row) ||
        !["required", "forbidden"].includes(row.whenTrue) ||
        !["required", "forbidden"].includes(row.whenFalse)
      ) fail("conditional", `${name} conditional row malformed`);
      return row.rowId;
    });
    const all = [...required, ...forbidden, ...conditionalIds];
    if (new Set(all).size !== all.length) fail("boundary-overlap", `${name}/${boundary.name} overlaps required/conditional/forbidden rows`);
    exactSet(all, universe, `${name}/${boundary.name} universe`);
  }
}

function assertNoParentCycles(schema, name) {
  const rows = schema.rows;
  const ids = new Set(rows.map((row) => row.rowId));
  const parent = new Map();
  for (const row of rows) {
    if (row.logicalParent === "provider-subrequest") continue;
    if (row.logicalParent !== null && !ids.has(row.logicalParent)) fail("parent-orphan", `${name}/${row.rowId} parent missing`);
    if (row.logicalParent === row.rowId) fail("parent-self", `${name}/${row.rowId} self-parent`);
    parent.set(row.rowId, row.logicalParent);
  }
  for (const row of rows) {
    const visited = new Set();
    let cursor = row.rowId;
    while (parent.get(cursor) !== null && parent.get(cursor) !== undefined) {
      cursor = parent.get(cursor);
      if (visited.has(cursor)) fail("parent-cycle", `${name} contains parent cycle at ${cursor}`);
      visited.add(cursor);
    }
  }
}

function rowsById(manifest) {
  const rows = new Map();
  for (const schema of Object.values(manifest.schemas ?? {})) {
    for (const row of schema.rows ?? []) rows.set(row.rowId, row);
  }
  return rows;
}

function assertRowScopedAttributes(manifest) {
  const matrix = manifest.attributeMatrix;
  const rows = rowsById(manifest);
  const spanKind = matrix?.attributes?.["span.kind"];
  if (!Array.isArray(spanKind?.values)) fail("span-kind-enum", "span.kind must declare an enum value set");

  const declaredKinds = new Set(spanKind.values);
  const usedKinds = new Set([...rows.values()].map((row) => row.kind));
  const undeclaredKinds = [...usedKinds].filter((kind) => !declaredKinds.has(kind));
  if (undeclaredKinds.length > 0) {
    fail("row-kind-undeclared", `rows use kinds that are not declared: ${undeclaredKinds.sort().join(",")}`);
  }
  const unusedKinds = [...declaredKinds].filter((kind) => !usedKinds.has(kind));
  if (unusedKinds.length > 0) {
    fail("row-kind-unused", `declared kinds that no row uses: ${unusedKinds.sort().join(",")}`);
  }

  const recovery = matrix.attributes?.["recovery.kind"];
  if (recovery?.factDerived !== true || !same(recovery.rowScope, ["R00"])) {
    fail("recovery-kind-scope", "recovery.kind must be factDerived and scoped to R00 only");
  }

  for (const [attribute, declaration] of Object.entries(matrix.attributes ?? {})) {
    const scope = declaration.rowScope;
    if (scope === undefined) continue;
    if (!Array.isArray(scope)) fail("row-scope-type", `${attribute}.rowScope must be an array`);
    if (scope.length === 0) fail("row-scope-empty", `${attribute}.rowScope must not be empty`);
    if (new Set(scope).size !== scope.length) fail("row-scope-duplicate", `${attribute}.rowScope must not repeat a row`);
    const unknown = scope.filter((rowId) => !rows.has(rowId));
    if (unknown.length > 0) fail("row-scope-unknown", `${attribute}.rowScope references unknown rows ${unknown.join(",")}`);
    if (declaration.factDerived === true && scope.some((rowId) => rows.get(rowId)?.logicalParent !== null)) {
      fail("fact-derived-root", `${attribute} is fact-derived and may only be carried by a root row that is still open`);
    }
  }

  const memberRows = new Set(
    [...rows.values()]
      .filter((row) => row.kind === "fanout-member" || row.kind === "sequential-member")
      .map((row) => row.rowId),
  );
  for (const attribute of ["member.index", "tag.key_hash"]) {
    const scope = matrix.attributes?.[attribute]?.rowScope;
    if (!Array.isArray(scope)) fail("member-scope-type", `${attribute}.rowScope must be an array`);
    const scopeRows = new Set(scope);
    const missing = [...memberRows].filter((rowId) => !scopeRows.has(rowId));
    if (missing.length > 0) {
      fail("member-scope-missing", `${attribute} member rows missing from rowScope: ${missing.sort().join(",")}`);
    }
    const nonMember = [...scopeRows].filter((rowId) => !memberRows.has(rowId));
    if (nonMember.length > 0) {
      fail("member-scope-nonmember", `${attribute} rowScope lists non-member rows: ${nonMember.sort().join(",")}`);
    }
  }
}

function assertRecoveryTermination(reconcile) {
  const recoveryDag = reconcile?.recoveryDag;
  if (recoveryDag === null || typeof recoveryDag !== "object" || Array.isArray(recoveryDag)) {
    fail("recovery-dag", "reconcile recoveryDag must be an object");
  }
  for (const [kind, branch] of Object.entries(recoveryDag)) {
    if (typeof branch?.terminatesInvocation !== "boolean") {
      fail("recovery-termination-flag", `${kind} must declare boolean terminatesInvocation`);
    }
    if (!Array.isArray(branch.transitions) || branch.transitions.length === 0) {
      fail("recovery-transitions", `${kind} must declare a non-empty transition sequence`);
    }
    if (typeof branch.terminalOutcome !== "string") {
      fail("recovery-terminal-outcome", `${kind} must declare terminalOutcome text`);
    }
    if (!Array.isArray(branch.forbiddenRows)) {
      fail("recovery-forbidden", `${kind} must declare forbiddenRows`);
    }
    const endsAtTerminal = branch.transitions.at(-1) === "terminal";
    if (branch.terminatesInvocation) {
      if (!endsAtTerminal) {
        fail("recovery-terminating-tail", `${kind} terminates but its transitions do not end at terminal`);
      }
      continue;
    }
    if (endsAtTerminal) {
      fail("recovery-nonterminating-tail", `${kind} is non-terminating but ends at terminal`);
    }
    if (!branch.terminalOutcome.includes("NON-TERMINAL")) {
      fail("recovery-nonterminating-outcome", `${kind} is non-terminating but terminalOutcome does not say NON-TERMINAL`);
    }
    if (!branch.forbiddenRows.includes("R06")) {
      fail("recovery-nonterminating-r06", `${kind} is non-terminating but does not forbid terminal CAS row R06`);
    }
  }
}

export function assertManifest(manifest) {
  if (manifest?.name !== "commit-trace-manifest" || manifest?.schemaVersion !== 2) fail("manifest-shape", "unexpected manifest schema/name");
  exactSet(Object.keys(manifest.schemas ?? {}), AUTHORITY_SCHEMA_IDS, "schema identity");
  assertAuthorityRows(manifest);
  for (const [name, schema] of Object.entries(manifest.schemas ?? {})) {
    rowsFor(schema);
    assertNoParentCycles(schema, name);
    assertBoundaryUniverse(schema, name);
  }

  const v1 = manifest.schemas["sdt.commit/v1"];
  const v1Rows = rowsFor(v1);
  const remote = manifest.remoteInvocationUniverse;
  if (!Array.isArray(remote) || !same(remote, ["S16"])) fail("remote-universe", "S16 must be the sole remote invocation universe");
  if (!v1Rows.includes("S16") || v1.universe.includes("S16")) fail("remote-partition", "S16 must be a row but excluded from the v1 request universe");
  const requestIds = v1Rows.filter((row) => row !== "S16");
  exactSet(v1.universe, requestIds, "v1 request universe");

  const matrix = manifest.attributeMatrix;
  exactSet(matrix?.faces ?? [], REQUIRED_FACES, "attribute faces");
  exactSet(matrix?.states ?? [], REQUIRED_STATES, "attribute states");
  exactSet(Object.keys(matrix?.attributes ?? {}), AUTHORITY_ATTRIBUTE_IDS, "attribute identity");
  if (AUTHORITY_ATTRIBUTE_IDS.length !== 30) fail("attribute-count", "the authority attribute matrix must contain 30 attributes");
  for (const [attribute, declaration] of Object.entries(matrix.attributes)) {
    exactSet(Object.keys(declaration.faces ?? {}), REQUIRED_FACES, `attribute face set ${attribute}`);
    for (const state of Object.values(declaration.faces ?? {})) {
      if (!REQUIRED_STATES.includes(state)) fail("attribute-state", `${attribute} has invalid state ${state}`);
    }
    if (declaration.type === "enum" && (!Array.isArray(declaration.values) || declaration.values.length === 0)) {
      fail("attribute-enum", `${attribute} enum must declare values`);
    }
    if (PROVIDER_ADAPTER_FIELDS.has(attribute) && Object.values(declaration.faces).includes("required")) {
      fail("provider-required", `${attribute} is adapter input and can never be required`);
    }
  }
  if (matrix.attributes["attempt.id"].faces["pre-admission"] !== "forbidden" || matrix.attributes["attempt.id"].faces.accepted !== "required") {
    fail("attempt-matrix", "attempt.id must be forbidden pre-admission and required accepted");
  }
  if (matrix.attributes["tag.key_hash"].faces["pre-admission"] !== "forbidden") fail("tag-matrix", "derived tag key is forbidden pre-admission");
  if (matrix.attributes["http.status"].faces["reconcile-root"] !== "forbidden") fail("status-matrix", "http.status is forbidden on alarm roots");
  assertRowScopedAttributes(manifest);

  const reconcile = manifest.schemas["sdt.commit.reconcile/v1"];
  exactSet(Object.keys(reconcile.recoveryDag ?? {}), AUTHORITY_RECOVERY_IDS, "recovery kinds");
  assertRecoveryTermination(reconcile);
  const repair = manifest.schemas["sdt.commit.repair/v1"];
  const links = (repair.parentLinks ?? []).map((link) => `${link.row}|${link.linkedTo}|${link.via}`).sort();
  exactSet(links, AUTHORITY_REPAIR_LINKS, "repair parent links");
  if (!links.includes("X03e|X02|repair.lease.id + tag.key_hash")) fail("repair-link", "X03e must link to X02 without becoming its child");

  assertAuthoritySections(manifest);

  return {
    schemas: Object.keys(manifest.schemas).length,
    attributes: AUTHORITY_ATTRIBUTE_IDS.length,
    v1Rows: v1Rows.length,
    recoveryKinds: AUTHORITY_RECOVERY_IDS.length,
  };
}

export function check(readText = read) {
  const { bundle, manifest, pin } = loadAuthority(readText);
  const mirrors = assertMirroredDigests(bundle, readText);
  const bundleCheck = assertBundle(bundle, pin);
  const structure = assertManifest(manifest);
  return Object.freeze({ mode: "check", mirrors, bundle: bundleCheck, structure });
}

export function selfTest() {
  const baseline = check();
  let writeRejected = false;
  try { assertTargetInvocation(["--write"]); } catch (error) { writeRejected = String(error).includes("target-write-forbidden"); }
  if (!writeRejected) fail("self-test", "target-side --write mutation unexpectedly passed");
  let matrixRejected = false;
  try {
    const altered = structuredClone(baselineManifest);
    delete altered.attributeMatrix.attributes.colo;
    assertManifest(altered);
  } catch (error) { matrixRejected = String(error).includes("exact-set"); }
  if (!matrixRejected) fail("self-test", "attribute-row deletion mutation unexpectedly passed");
  let rowDeletionRejected = false;
  try {
    const altered = structuredClone(baselineManifest);
    altered.schemas["sdt.commit/v1"].rows = altered.schemas["sdt.commit/v1"].rows.filter((row) => row.rowId !== "S14");
    assertManifest(altered);
  } catch (error) { rowDeletionRejected = String(error).includes("row-authority"); }
  if (!rowDeletionRejected) fail("self-test", "canonical row deletion mutation unexpectedly passed");
  let boundaryRejected = false;
  try {
    const altered = structuredClone(baselineManifest);
    altered.schemas["sdt.commit/v1"].boundaries[0].forbiddenRows.push("S00");
    assertManifest(altered);
  } catch (error) { boundaryRejected = String(error).includes("boundary-overlap"); }
  if (!boundaryRejected) fail("self-test", "boundary overlap mutation unexpectedly passed");
  let parentRejected = false;
  try {
    const altered = structuredClone(baselineManifest);
    altered.schemas["sdt.commit/v1"].rows.find((row) => row.rowId === "S01").logicalParent = "S01";
    assertManifest(altered);
  } catch (error) { parentRejected = String(error).includes("row-authority"); }
  if (!parentRejected) fail("self-test", "self-parent mutation unexpectedly passed");
  let parentReversalRejected = false;
  try {
    const altered = structuredClone(baselineManifest);
    const stage = altered.schemas["sdt.commit.reconcile/v1"].rows.find((row) => row.rowId === "R03");
    const member = altered.schemas["sdt.commit.reconcile/v1"].rows.find((row) => row.rowId === "R04");
    stage.logicalParent = "R04";
    member.logicalParent = "R00";
    assertManifest(altered);
  } catch (error) { parentReversalRejected = String(error).includes("row-authority"); }
  if (!parentReversalRejected) fail("self-test", "logical-parent reversal mutation unexpectedly passed");
  let emitterRejected = false;
  try {
    const altered = structuredClone(baselineManifest);
    altered.schemas["sdt.commit/v1"].rows.find((row) => row.rowId === "S02").emitter = "root-worker";
    assertManifest(altered);
  } catch (error) { emitterRejected = String(error).includes("row-authority"); }
  if (!emitterRejected) fail("self-test", "emitter swap mutation unexpectedly passed");
  let timingRejected = false;
  try {
    const altered = structuredClone(baselineManifest);
    altered.schemas["sdt.commit/v1"].rows.find((row) => row.rowId === "S01").start = "after request.json";
    assertManifest(altered);
  } catch (error) { timingRejected = String(error).includes("row-authority"); }
  if (!timingRejected) fail("self-test", "start-point mutation unexpectedly passed");
  let endTimingRejected = false;
  try {
    const altered = structuredClone(baselineManifest);
    altered.schemas["sdt.commit/v1"].rows.find((row) => row.rowId === "S01").end = "response complete";
    assertManifest(altered);
  } catch (error) { endTimingRejected = String(error).includes("row-authority"); }
  if (!endTimingRejected) fail("self-test", "end-point mutation unexpectedly passed");
  let cardinalityMinusRejected = false;
  try {
    const altered = structuredClone(baselineManifest);
    altered.schemas["sdt.commit/v1"].rows.find((row) => row.rowId === "S07").successCardinality = "0";
    assertManifest(altered);
  } catch (error) { cardinalityMinusRejected = String(error).includes("row-authority"); }
  if (!cardinalityMinusRejected) fail("self-test", "success-cardinality minus mutation unexpectedly passed");
  let cardinalityPlusRejected = false;
  try {
    const altered = structuredClone(baselineManifest);
    altered.schemas["sdt.commit/v1"].rows.find((row) => row.rowId === "S07").successCardinality = "N+1";
    assertManifest(altered);
  } catch (error) { cardinalityPlusRejected = String(error).includes("row-authority"); }
  if (!cardinalityPlusRejected) fail("self-test", "success-cardinality plus mutation unexpectedly passed");
  let providerRejected = false;
  try {
    const altered = structuredClone(baselineManifest);
    altered.attributeMatrix.attributes.colo.faces.accepted = "required";
    assertManifest(altered);
  } catch (error) { providerRejected = String(error).includes("provider-required"); }
  if (!providerRejected) fail("self-test", "provider-required mutation unexpectedly passed");
  let emptyScopeRejected = false;
  try {
    const altered = structuredClone(baselineManifest);
    altered.attributeMatrix.attributes["phase.ordinal"].rowScope = [];
    assertManifest(altered);
  } catch (error) { emptyScopeRejected = String(error).includes("row-scope-empty"); }
  if (!emptyScopeRejected) fail("self-test", "empty rowScope mutation unexpectedly passed");
  let unknownScopeRejected = false;
  try {
    const altered = structuredClone(baselineManifest);
    altered.attributeMatrix.attributes["phase.ordinal"].rowScope.push("UNKNOWN");
    assertManifest(altered);
  } catch (error) { unknownScopeRejected = String(error).includes("row-scope-unknown"); }
  if (!unknownScopeRejected) fail("self-test", "unknown rowScope mutation unexpectedly passed");
  let factDerivedRejected = false;
  try {
    const altered = structuredClone(baselineManifest);
    altered.attributeMatrix.attributes["tag.key_hash"].factDerived = true;
    assertManifest(altered);
  } catch (error) { factDerivedRejected = String(error).includes("fact-derived-root"); }
  if (!factDerivedRejected) fail("self-test", "non-root fact-derived mutation unexpectedly passed");
  let recoveryScopeRejected = false;
  try {
    const altered = structuredClone(baselineManifest);
    altered.attributeMatrix.attributes["recovery.kind"].rowScope = ["R00", "R01"];
    assertManifest(altered);
  } catch (error) { recoveryScopeRejected = String(error).includes("recovery-kind-scope"); }
  if (!recoveryScopeRejected) fail("self-test", "recovery.kind scope mutation unexpectedly passed");
  let sequentialKindRejected = false;
  try {
    const altered = structuredClone(baselineManifest);
    altered.attributeMatrix.attributes["span.kind"].values = altered.attributeMatrix.attributes["span.kind"].values.filter((value) => value !== "sequential-stage");
    assertManifest(altered);
  } catch (error) { sequentialKindRejected = String(error).includes("row-kind-undeclared"); }
  if (!sequentialKindRejected) fail("self-test", "sequential row-kind deletion mutation unexpectedly passed");
  let ghostKindRejected = false;
  try {
    const altered = structuredClone(baselineManifest);
    altered.attributeMatrix.attributes["span.kind"].values.push("ghost-kind");
    assertManifest(altered);
  } catch (error) { ghostKindRejected = String(error).includes("row-kind-unused"); }
  if (!ghostKindRejected) fail("self-test", "unused span.kind mutation unexpectedly passed");
  let memberScopeMissingRejected = false;
  try {
    const altered = structuredClone(baselineManifest);
    altered.attributeMatrix.attributes["member.index"].rowScope = altered.attributeMatrix.attributes["member.index"].rowScope.filter((row) => row !== "S14");
    assertManifest(altered);
  } catch (error) { memberScopeMissingRejected = String(error).includes("member-scope-missing"); }
  if (!memberScopeMissingRejected) fail("self-test", "member scope omission mutation unexpectedly passed");
  let memberScopeNonMemberRejected = false;
  try {
    const altered = structuredClone(baselineManifest);
    altered.attributeMatrix.attributes["tag.key_hash"].rowScope.push("S00");
    assertManifest(altered);
  } catch (error) { memberScopeNonMemberRejected = String(error).includes("member-scope-nonmember"); }
  if (!memberScopeNonMemberRejected) fail("self-test", "non-member scope expansion mutation unexpectedly passed");
  let terminatingTailRejected = false;
  try {
    const altered = structuredClone(baselineManifest);
    altered.schemas["sdt.commit.reconcile/v1"].recoveryDag["post-allocation-full-write"].transitions.pop();
    assertManifest(altered);
  } catch (error) { terminatingTailRejected = String(error).includes("recovery-terminating-tail"); }
  if (!terminatingTailRejected) fail("self-test", "terminating recovery tail mutation unexpectedly passed");
  let nonterminatingTailRejected = false;
  try {
    const altered = structuredClone(baselineManifest);
    altered.schemas["sdt.commit.reconcile/v1"].recoveryDag["journal-pre-allocation-vector-present"].transitions.push("terminal");
    assertManifest(altered);
  } catch (error) { nonterminatingTailRejected = String(error).includes("recovery-nonterminating-tail"); }
  if (!nonterminatingTailRejected) fail("self-test", "non-terminating recovery tail mutation unexpectedly passed");
  let nonterminatingOutcomeRejected = false;
  try {
    const altered = structuredClone(baselineManifest);
    altered.schemas["sdt.commit.reconcile/v1"].recoveryDag["journal-pre-allocation-vector-present"].terminalOutcome = "ALLOCATED";
    assertManifest(altered);
  } catch (error) { nonterminatingOutcomeRejected = String(error).includes("recovery-nonterminating-outcome"); }
  if (!nonterminatingOutcomeRejected) fail("self-test", "non-terminating outcome mutation unexpectedly passed");
  let nonterminatingR06Rejected = false;
  try {
    const altered = structuredClone(baselineManifest);
    altered.schemas["sdt.commit.reconcile/v1"].recoveryDag["journal-pre-allocation-vector-present"].forbiddenRows = altered.schemas["sdt.commit.reconcile/v1"].recoveryDag["journal-pre-allocation-vector-present"].forbiddenRows.filter((row) => row !== "R06");
    assertManifest(altered);
  } catch (error) { nonterminatingR06Rejected = String(error).includes("recovery-nonterminating-r06"); }
  if (!nonterminatingR06Rejected) fail("self-test", "non-terminating R06 mutation unexpectedly passed");
  let bundleRejected = false;
  try {
    const altered = structuredClone(parse(bundlePath));
    altered.bundleDigest = `sha256:${"0".repeat(64)}`;
    assertBundle(altered, parse(pinPath));
  } catch (error) { bundleRejected = String(error).includes("bundle-digest"); }
  if (!bundleRejected) fail("self-test", "bundle drift mutation unexpectedly passed");
  return { ...baseline, mutations: ["target-write", "matrix-row-delete", "canonical-row-delete", "boundary-overlap", "parent-self", "logical-parent-reversal", "emitter-swap", "start-point", "end-point", "cardinality-minus", "cardinality-plus", "provider-required", "row-scope-empty", "row-scope-unknown", "fact-derived-root", "recovery-kind-scope", "sequential-row-kind", "ghost-row-kind", "member-scope-missing", "member-scope-nonmember", "recovery-terminating-tail", "recovery-nonterminating-tail", "recovery-nonterminating-outcome", "recovery-nonterminating-r06", "bundle-drift"] };
}

function main() {
  assertTargetInvocation();
  if (process.argv.includes("--self-test")) {
    console.log(JSON.stringify(selfTest(), null, 2));
    return;
  }
  console.log(JSON.stringify(check(), null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
