#!/usr/bin/env node
/* global process, structuredClone, URL */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertArray,
  assertClosedObject,
  assertNonEmptyString,
  assertUnique,
  assertUniqueBy,
  canonicalJson,
  compareNormalizedRows,
  parseJsonc as parseSharedJsonc,
} from "./offline-provider-validation.mjs";

const project = process.cwd();
const topologyPath = join(project, "deployment-topology.json");
const wranglerPath = join(project, "wrangler.jsonc");
const runbookPath = join(project, "DEPLOYMENT.md");
const requireFromProject = createRequire(join(project, "package.json"));
const ts = requireFromProject("typescript");

function fail(reason, detail = "") {
  const suffix = detail.length === 0 ? "" : `: ${detail}`;
  throw new Error(`deploy-check:${reason}${suffix}`);
}

function assert(condition, reason, detail = "") {
  if (!condition) fail(reason, detail);
}


function parseJsonc(source, label) {
  return parseSharedJsonc(source, label, (value) => fail(value.reason, value.path));
}

function object(value, path, keys) {
  return assertClosedObject(value, path, keys, (diagnostic) => fail(diagnostic.reason, diagnostic.path));
}

function string(value, path) {
  return assertNonEmptyString(value, path, (diagnostic) => fail(diagnostic.reason, diagnostic.path));
}

function array(value, path) {
  return assertArray(value, path, (diagnostic) => fail(diagnostic.reason, diagnostic.path));
}

function unique(values, path) {
  assertUnique(values, path, (diagnostic) => fail(diagnostic.reason, diagnostic.path));
}

function uniqueEntries(entries, identity, path) {
  assertUniqueBy(entries, identity, path, (diagnostic) => fail(diagnostic.reason, diagnostic.path));
}

function validateCollectionIdentities(authority, config) {
  const d1 = config.d1_databases ?? [];
  uniqueEntries(d1, (entry) => entry?.binding, "wrangler.d1_databases.binding");
  uniqueEntries(d1, (entry) => entry?.database_name, "wrangler.d1_databases.database_name");

  const producers = config.queues?.producers ?? [];
  const consumers = config.queues?.consumers ?? [];
  uniqueEntries(producers, (entry) => entry?.binding, "wrangler.queues.producers.binding");
  uniqueEntries(producers, (entry) => entry?.queue, "wrangler.queues.producers.queue");
  uniqueEntries(consumers, (entry) => entry?.queue, "wrangler.queues.consumers.queue");

  const durableBindings = config.durable_objects?.bindings ?? [];
  const migrations = config.migrations ?? [];
  uniqueEntries(durableBindings, (entry) => entry?.name, "wrangler.durable_objects.bindings.name");
  uniqueEntries(durableBindings, (entry) => entry?.class_name, "wrangler.durable_objects.bindings.class_name");
  uniqueEntries(migrations, (entry) => entry?.tag, "wrangler.migrations.tag");
  const migratedClasses = migrations.flatMap((entry) => entry?.new_sqlite_classes ?? []);
  unique(migratedClasses, "wrangler.migrations.new_sqlite_classes");
  unique(config.triggers?.crons ?? [], "wrangler.triggers.crons");

  const creation = authority.queues.creation;
  uniqueEntries(creation, (entry) => entry?.kind, "$.queues.creation.kind");
  uniqueEntries(creation, (entry) => entry?.name, "$.queues.creation.name");
  uniqueEntries(authority.d1, (entry) => entry?.binding, "$.d1.binding");
  uniqueEntries(authority.d1, (entry) => entry?.databaseName, "$.d1.databaseName");
  uniqueEntries(authority.queues.producers, (entry) => entry?.binding, "$.queues.producers.binding");
  uniqueEntries(authority.queues.producers, (entry) => entry?.queue, "$.queues.producers.queue");
  uniqueEntries(authority.queues.consumers, (entry) => entry?.queue, "$.queues.consumers.queue");
  uniqueEntries(authority.durableObjects.bindings, (entry) => entry?.name, "$.durableObjects.bindings.name");
  uniqueEntries(authority.durableObjects.bindings, (entry) => entry?.className, "$.durableObjects.bindings.className");
  uniqueEntries(authority.durableObjects.migrations, (entry) => entry?.tag, "$.durableObjects.migrations.tag");
  unique(
    authority.durableObjects.migrations.flatMap((entry) => entry?.newSqliteClasses ?? []),
    "$.durableObjects.migrations.newSqliteClasses",
  );
  unique(authority.triggers.crons, "$.triggers.crons");
  unique(Object.keys(authority.vars), "$.vars");
  unique(authority.secrets.map((entry) => entry?.name), "$.secrets.name");

  const queueKinds = new Map();
  for (const [index, entry] of creation.entries()) {
    const prior = queueKinds.get(entry?.name);
    if (prior !== undefined && prior !== entry?.kind) fail("duplicate-collection-key", `$.queues.creation[${index}]`);
    queueKinds.set(entry?.name, entry?.kind);
  }
}

function validateAuthorityCollectionIdentities(authority) {
  uniqueEntries(authority.d1, (entry) => entry?.binding, "$.d1.binding");
  uniqueEntries(authority.d1, (entry) => entry?.databaseName, "$.d1.databaseName");
  uniqueEntries(authority.queues.producers, (entry) => entry?.binding, "$.queues.producers.binding");
  uniqueEntries(authority.queues.producers, (entry) => entry?.queue, "$.queues.producers.queue");
  uniqueEntries(authority.queues.consumers, (entry) => entry?.queue, "$.queues.consumers.queue");
  uniqueEntries(authority.durableObjects.bindings, (entry) => entry?.name, "$.durableObjects.bindings.name");
  uniqueEntries(authority.durableObjects.bindings, (entry) => entry?.className, "$.durableObjects.bindings.className");
  uniqueEntries(authority.durableObjects.migrations, (entry) => entry?.tag, "$.durableObjects.migrations.tag");
  unique(
    authority.durableObjects.migrations.flatMap((entry) => entry?.newSqliteClasses ?? []),
    "$.durableObjects.migrations.newSqliteClasses",
  );
  unique(authority.queues.creation.map((entry) => entry?.kind), "$.queues.creation.kind");
  unique(authority.queues.creation.map((entry) => entry?.name), "$.queues.creation.name");
  unique(authority.triggers.crons, "$.triggers.crons");
  unique(Object.keys(authority.vars), "$.vars");
  unique(authority.secrets.map((entry) => entry?.name), "$.secrets.name");
  const queueKinds = new Map();
  for (const [index, entry] of authority.queues.creation.entries()) {
    const prior = queueKinds.get(entry?.name);
    if (prior !== undefined && prior !== entry?.kind) fail("duplicate-collection-key", `$.queues.creation[${index}]`);
    queueKinds.set(entry?.name, entry?.kind);
  }
}

function validateAuthority(authority) {
  object(authority, "$", ["schema", "worker", "d1", "queues", "durableObjects", "assets", "triggers", "vars", "secrets"]);
  assert(authority.schema === "sekiban-create-dcb/deployment-topology/v1", "authority-schema", authority.schema);
  const worker = object(authority.worker, "$.worker", ["name", "entrypoint"]);
  string(worker.name, "$.worker.name");
  string(worker.entrypoint, "$.worker.entrypoint");

  const d1 = array(authority.d1, "$.d1");
  for (const [index, entry] of d1.entries()) {
    object(entry, `$.d1[${index}]`, ["binding", "databaseName", "idPlaceholder", "placeholderPath", "migrationsDir", "creationCommand", "replacement"]);
    for (const key of ["binding", "databaseName", "idPlaceholder", "placeholderPath", "migrationsDir", "creationCommand", "replacement"]) {
      string(entry[key], `$.d1[${index}].${key}`);
    }
  }
  validateAuthorityCollectionIdentities(authority);
  assert(d1.length === 2, "authority-d1-count", String(d1.length));

  const queues = object(authority.queues, "$.queues", ["producers", "consumers", "creation"]);
  const producers = array(queues.producers, "$.queues.producers");
  for (const [index, entry] of producers.entries()) {
    object(entry, `$.queues.producers[${index}]`, ["binding", "queue"]);
    string(entry.binding, `$.queues.producers[${index}].binding`);
    string(entry.queue, `$.queues.producers[${index}].queue`);
  }
  const consumers = array(queues.consumers, "$.queues.consumers");
  for (const [index, entry] of consumers.entries()) {
    object(entry, `$.queues.consumers[${index}]`, ["queue", "maxBatchTimeout", "maxRetries", "deadLetterQueue"]);
    string(entry.queue, `$.queues.consumers[${index}].queue`);
    assert(Number.isInteger(entry.maxBatchTimeout), "authority-shape", `$.queues.consumers[${index}].maxBatchTimeout`);
    assert(Number.isInteger(entry.maxRetries), "authority-shape", `$.queues.consumers[${index}].maxRetries`);
    string(entry.deadLetterQueue, `$.queues.consumers[${index}].deadLetterQueue`);
  }
  const creation = array(queues.creation, "$.queues.creation");
  for (const [index, entry] of creation.entries()) {
    object(entry, `$.queues.creation[${index}]`, ["kind", "name", "command"]);
    string(entry.kind, `$.queues.creation[${index}].kind`);
    string(entry.name, `$.queues.creation[${index}].name`);
    string(entry.command, `$.queues.creation[${index}].command`);
  }
  assert(producers.length === 1 && consumers.length === 1 && creation.length === 2, "authority-queue-count");

  const durableObjects = object(authority.durableObjects, "$.durableObjects", ["bindings", "migrations"]);
  const bindings = array(durableObjects.bindings, "$.durableObjects.bindings");
  for (const [index, entry] of bindings.entries()) {
    object(entry, `$.durableObjects.bindings[${index}]`, ["name", "className"]);
    string(entry.name, `$.durableObjects.bindings[${index}].name`);
    string(entry.className, `$.durableObjects.bindings[${index}].className`);
  }
  const migrations = array(durableObjects.migrations, "$.durableObjects.migrations");
  for (const [index, entry] of migrations.entries()) {
    object(entry, `$.durableObjects.migrations[${index}]`, ["tag", "newSqliteClasses"]);
    string(entry.tag, `$.durableObjects.migrations[${index}].tag`);
    const classes = array(entry.newSqliteClasses, `$.durableObjects.migrations[${index}].newSqliteClasses`);
    assert(classes.length > 0, "authority-shape", `$.durableObjects.migrations[${index}].newSqliteClasses`);
    classes.forEach((value, classIndex) => string(value, `$.durableObjects.migrations[${index}].newSqliteClasses[${classIndex}]`));
  }
  assert(bindings.length === 5 && migrations.length === 3, "authority-do-count");

  const assets = object(authority.assets, "$.assets", ["directory", "binding", "bindingStatus"]);
  string(assets.directory, "$.assets.directory");
  string(assets.binding, "$.assets.binding");
  assert(assets.bindingStatus === "unused", "authority-assets-status", assets.bindingStatus);
  const triggers = object(authority.triggers, "$.triggers", ["crons"]);
  const crons = array(triggers.crons, "$.triggers.crons");
  crons.forEach((value, index) => string(value, `$.triggers.crons[${index}]`));
  assert(crons.length > 0, "authority-cron-count");
  assert(
    authority.vars !== null && typeof authority.vars === "object" && !Array.isArray(authority.vars),
    "authority-shape",
    "$.vars must be an object",
  );
  const authoritySecretNames = new Set((authority.secrets ?? []).map((entry) => entry?.name));
  for (const key of Object.keys(authority.vars)) assert(!authoritySecretNames.has(key), "secret-in-vars");
  const vars = object(authority.vars, "$.vars", ["DOMAIN_DELIVERY_CLASS", "SDT_SERVICE_ID"]);
  for (const [key, value] of Object.entries(vars)) string(value, `$.vars.${key}`);
  const repairConditions = ["operator-route-mounted", "runtime-fetch-direct"];
  const secrets = array(authority.secrets, "$.secrets");
  for (const [index, entry] of secrets.entries()) {
    const path = `$.secrets[${index}]`;
    const hasVerification = Object.hasOwn(entry, "verification");
    const hasRequiredWhen = Object.hasOwn(entry, "requiredWhen");
    assert(hasVerification === hasRequiredWhen, "authority-secret-fields", path);
    const allowedKeys = hasVerification
      ? ["name", "optional", "ownership", "forbiddenIn", "verification", "requiredWhen"]
      : ["name", "optional", "ownership", "forbiddenIn"];
    object(entry, path, allowedKeys);
    string(entry.name, `${path}.name`);
    assert(typeof entry.optional === "boolean", "authority-shape", `${path}.optional`);
    string(entry.ownership, `${path}.ownership`);
    assert(entry.forbiddenIn === "vars", "authority-secret-boundary", `${path}.forbiddenIn`);
    assert(!Object.hasOwn(vars, entry.name), "secret-in-vars");
    if (!hasVerification) continue;
    assert(entry.verification === "external", "authority-secret-verification", `${path}.verification`);
    const conditions = array(entry.requiredWhen, `${path}.requiredWhen`);
    assert(conditions.length > 0, "authority-secret-conditions", `${path}.requiredWhen`);
    conditions.forEach((value, conditionIndex) => string(value, `${path}.requiredWhen[${conditionIndex}]`));
    unique(conditions, `${path}.requiredWhen`);
    for (const value of conditions) {
      assert(repairConditions.includes(value), "authority-secret-conditions", `${path}.requiredWhen`);
    }
    assert(conditions.length === repairConditions.length, "authority-secret-conditions", `${path}.requiredWhen`);
    for (const value of repairConditions) {
      assert(conditions.includes(value), "authority-secret-conditions", `${path}.requiredWhen`);
    }
  }
  const repairEntries = secrets.filter((entry) => entry.name === "REPAIR_OPERATOR_TOKEN");
  assert(repairEntries.length === 1, "authority-repair-entry", "$.secrets");
  assert(
    Object.hasOwn(repairEntries[0], "verification") && Object.hasOwn(repairEntries[0], "requiredWhen"),
    "authority-repair-entry",
    "$.secrets[name=REPAIR_OPERATOR_TOKEN]",
  );
  return authority;
}

function canonical(value) {
  return canonicalJson(value, "row-key");
}

function normalizedTopology(authority, config) {
  const d1 = config.d1_databases.map((entry) => ({
    kind: "d1",
    binding: entry.binding,
    databaseName: entry.database_name,
    migrationsDir: entry.migrations_dir,
  }));
  const producer = (config.queues?.producers ?? []).map((entry) => ({ kind: "queue-producer", binding: entry.binding, queue: entry.queue }));
  const consumer = (config.queues?.consumers ?? []).map((entry) => ({
    kind: "queue-consumer",
    queue: entry.queue,
    maxBatchTimeout: entry.max_batch_timeout,
    maxRetries: entry.max_retries,
    deadLetterQueue: entry.dead_letter_queue,
  }));
  const durableBindings = config.durable_objects.bindings.map((entry) => ({ kind: "durable-object", name: entry.name, className: entry.class_name }));
  const migrations = config.migrations.map((entry) => ({ kind: "durable-migration", tag: entry.tag, newSqliteClasses: entry.new_sqlite_classes }));
  return [...d1, ...producer, ...consumer, ...durableBindings, ...migrations,
    { kind: "assets", directory: config.assets?.directory },
    ...(config.triggers?.crons ?? []).map((cron) => ({ kind: "cron", cron })),
    ...Object.entries(config.vars ?? {}).map(([name, value]) => ({ kind: "var", name, value })),
  ];
}

function expectedTopology(authority) {
  return [
    ...authority.d1.map((entry) => ({ kind: "d1", binding: entry.binding, databaseName: entry.databaseName, migrationsDir: entry.migrationsDir })),
    ...authority.queues.producers.map((entry) => ({ kind: "queue-producer", binding: entry.binding, queue: entry.queue })),
    ...authority.queues.consumers.map((entry) => ({ kind: "queue-consumer", queue: entry.queue, maxBatchTimeout: entry.maxBatchTimeout, maxRetries: entry.maxRetries, deadLetterQueue: entry.deadLetterQueue })),
    ...authority.durableObjects.bindings.map((entry) => ({ kind: "durable-object", name: entry.name, className: entry.className })),
    ...authority.durableObjects.migrations.map((entry) => ({ kind: "durable-migration", tag: entry.tag, newSqliteClasses: entry.newSqliteClasses })),
    { kind: "assets", directory: authority.assets.directory },
    ...authority.triggers.crons.map((cron) => ({ kind: "cron", cron })),
    ...Object.entries(authority.vars).map(([name, value]) => ({ kind: "var", name, value })),
  ];
}

function compareTopology(authority, config) {
  assert(!Object.hasOwn(config, "account_id"), "account-id-forbidden");
  object(config, "wrangler", ["$schema", "name", "main", "compatibility_date", "compatibility_flags", "vars", "assets", "triggers", "d1_databases", "queues", "durable_objects", "migrations"]);
  validateCollectionIdentities(authority, config);
  const secretNames = new Set(authority.secrets.map((entry) => entry.name));
  for (const name of Object.keys(config.vars ?? {})) assert(!secretNames.has(name), "secret-in-vars");
  assert(config.name === authority.worker.name, "worker-name", config.name);
  assert(config.main === authority.worker.entrypoint, "worker-entrypoint", config.main);
  assert(canonical(config.compatibility_flags) === canonical(["nodejs_compat"]), "compatibility-flags");
  const expected = expectedTopology(authority);
  const actual = normalizedTopology(authority, config);
  const kinds = [
    ["d1", "d1-parity"],
    ["queue-producer", "queue-producer-parity"],
    ["queue-consumer", "queue-consumer-parity"],
    ["durable-object", "durable-object-parity"],
    ["durable-migration", "durable-migration-parity"],
    ["assets", "assets-parity"],
    ["cron", "cron-parity"],
    ["var", "var-parity"],
  ];
  compareNormalizedRows(actual, expected, kinds, "wrangler.topology", (diagnostic) => fail(diagnostic.reason, diagnostic.path));
  assert(canonical(config.vars) === canonical(authority.vars), "vars-parity");
  assert(canonical(config.triggers?.crons ?? []) === canonical(authority.triggers.crons), "cron-parity");
  assert(config.assets?.directory === authority.assets.directory && !Object.hasOwn(config.assets, "binding"), "assets-parity");
  assert(config.queues.producers.length === 1 && config.queues.consumers.length === 1, "queue-cardinality");
  assert(config.durable_objects.bindings.length === 5 && config.migrations.length === 3, "do-cardinality");
}

function assertInsideProject(path, label) {
  const projectReal = realpathSync(project);
  const resolved = resolve(project, path);
  assert(resolved === projectReal || resolved.startsWith(`${projectReal}${sep}`), "migration-path-escape", label);
  return resolved;
}

function migrationCounts(authority) {
  return authority.d1.map((entry) => {
    const path = assertInsideProject(entry.migrationsDir, entry.migrationsDir);
    assert(existsSync(path) && statSync(path).isDirectory(), "migration-directory-missing", entry.migrationsDir);
    const files = readdirSync(path, { withFileTypes: true })
      .filter((file) => file.isFile() && file.name.endsWith(".sql"))
      .map((file) => file.name)
      .sort();
    assert(files.length > 0, "migration-directory-empty", entry.migrationsDir);
    return { binding: entry.binding, directory: entry.migrationsDir, files: files.length };
  });
}

function placeholderEntries(authority, config, requireConfigured = false) {
  const expected = new Map(authority.d1.map((entry) => [entry.idPlaceholder, entry]));
  const found = [];
  function walk(value, path) {
    if (typeof value === "string") {
      if (!/^REPLACE_WITH_[A-Z0-9_]+$/.test(value)) return;
      const entry = expected.get(value);
      assert(entry !== undefined, "unknown-placeholder", path);
      assert(path === entry.placeholderPath, "placeholder-location", path);
      found.push({
        binding: entry.binding,
        path,
        databaseName: entry.databaseName,
        placeholder: value,
        creationCommand: entry.creationCommand,
        replacement: entry.replacement,
      });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const itemPath = path === "d1_databases" && item && typeof item === "object" && typeof item.binding === "string"
          ? `d1_databases[binding=${item.binding}]`
          : `${path}[${index}]`;
        walk(item, itemPath);
      });
    } else if (value !== null && typeof value === "object") {
      Object.entries(value).forEach(([key, item]) => walk(item, path === "$" ? key : `${path}.${key}`));
    }
  }
  walk(config, "$");
  if (requireConfigured) return found.sort((a, b) => a.binding.localeCompare(b.binding));
  assert(found.length === expected.size, "placeholder-count", `${found.length}/${expected.size}`);
  for (const entry of expected.values()) assert(found.some((item) => item.binding === entry.binding), "placeholder-report-missing", entry.binding);
  return found.sort((a, b) => a.binding.localeCompare(b.binding));
}

function configuredD1Ids(authority, config, requireConfigured) {
  const placeholders = placeholderEntries(authority, config, requireConfigured);
  if (requireConfigured) {
    assert(placeholders.length === 0, "require-configured-placeholder");
    for (const entry of config.d1_databases) assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entry.database_id), "configured-id-shape", entry.binding);
  }
  return placeholders;
}

function wranglerFailure(result) {
  if (result.signal) return `signal-${result.signal}`;
  return `exit-status-${result.status ?? "unknown"}`;
}

function assertPlaceholderReceipt(expected, reported) {
  assert(canonical(expected.map((entry) => entry.binding)) === canonical(reported.map((entry) => entry.binding)), "placeholder-report-missing");
  for (const entry of expected) {
    const match = reported.find((item) => item.binding === entry.binding);
    assert(match?.path === entry.path && match?.databaseName === entry.databaseName, "placeholder-report-mismatch", entry.binding);
  }
}

function sourceFile(path, source) {
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert(parsed.parseDiagnostics.length === 0, "worker-source-parse", path);
  return parsed;
}

function propertyNames(node) {
  if (!node || !ts.isObjectLiteralExpression(node)) return [];
  return node.properties.filter((entry) => ts.isPropertyAssignment(entry) || ts.isMethodDeclaration(entry))
    .map((entry) => (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name) ? entry.name.text : ""));
}

function isOperatorMount(value) {
  return value === "/operator" || value.startsWith("/operator/");
}

const serializedRoutePaths = [
  "/api/sekiban/serialized/commit",
  "/api/sekiban/serialized/query",
  "/api/sekiban/serialized/list-query",
  "/api/sekiban/serialized/tag-latest-sortable",
  "/api/sekiban/serialized/tag-state",
];

function booleanLiteral(node) {
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

function overlapsSerializedRoute(paths, prefixes) {
  const pathOverlap = paths.some((value) => serializedRoutePaths.includes(value));
  const prefixOverlap = prefixes.some((prefix) => serializedRoutePaths.some((route) => (
    route === prefix || route.startsWith(`${prefix}/`)
  )));
  return pathOverlap || prefixOverlap;
}

function serializedRouteState(shape) {
  const prefixes = Array.isArray(shape.extraPrefixes) ? shape.extraPrefixes : [];
  const paths = Array.isArray(shape.extraPaths) ? shape.extraPaths : [];
  const singleMaintenance = prefixes.length === 1 && prefixes[0] === "/maintenance";
  const accepted = shape.forwardSerializedRoutes === false
    && shape.extraPaths === null
    && singleMaintenance
    && !overlapsSerializedRoute(paths, prefixes);
  return accepted ? "unmounted" : "mounted";
}

function assertMaintenanceOnlyMount(structure) {
  if (structure.serializedRoutes !== "unmounted") {
    fail("generated runtime mount is not maintenance-only");
  }
}

function externalPrerequisiteDiagnostic(structure) {
  const source = [...structure.source].sort((left, right) => (
    left.property.localeCompare(right.property)
    || left.value.localeCompare(right.value)
    || left.line - right.line
  ));
  return {
    code: "missing-external-prerequisite",
    path: "$.secrets[name=REPAIR_OPERATOR_TOKEN]",
    prerequisite: "REPAIR_OPERATOR_TOKEN",
    triggers: [...structure.triggers].sort(),
    source,
    verification: "external",
    remoteStateChecked: false,
  };
}

function assertExternalPrerequisite(structure) {
  if (structure.triggers.length === 0) return;
  fail("missing-external-prerequisite", JSON.stringify(externalPrerequisiteDiagnostic(structure)));
}

function unresolvedSourceShape(property, line) {
  fail("unresolved-source-shape", JSON.stringify({
    code: "unresolved-source-shape",
    property,
    line,
  }));
}

function workerStructure(authority, source, label) {
  const worker = sourceFile(label, source);
  const expectedClasses = authority.durableObjects.bindings.map((entry) => entry.className).sort();
  const exports = [];
  let composedWorker = null;
  let exportedWorker = false;
  const compositionCalls = [];
  const runtimeDeclarations = new Map();
  const initializers = new Map();
  const defaultExpressions = [];
  const handlers = { application: false, fetch: false, queue: false, scheduled: false };
  const exposure = [];
  let operatorMounted = false;
  let directRuntimeFetch = false;
  function lineOf(node) {
    return worker.getLineAndCharacterOfPosition(node.getStart(worker)).line + 1;
  }
  function propertyText(name) {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
    return undefined;
  }
  function isRuntimeIdentifier(node) {
    return ts.isIdentifier(node) && runtimeDeclarations.has(node.text);
  }
  function isRuntimeFetch(node) {
    return ts.isPropertyAccessExpression(node)
      && isRuntimeIdentifier(node.expression)
      && node.name.text === "fetch";
  }
  function staticStringArray(node) {
    if (!ts.isArrayLiteralExpression(node)) return undefined;
    const values = [];
    for (const element of node.elements) {
      if (ts.isSpreadElement(element)) return undefined;
      if (!ts.isStringLiteral(element) && !ts.isNoSubstitutionTemplateLiteral(element)) return undefined;
      values.push({ value: element.text, line: lineOf(element) });
    }
    return values;
  }
  function containsCall(node, name) {
    let found = false;
    function inspect(child) {
      if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === name) {
        found = true;
      }
      if (!found) ts.forEachChild(child, inspect);
    }
    inspect(node);
    return found;
  }
  function runtimeProperty(node, names, member) {
    return ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) &&
      names.has(node.expression.text) && node.name.text === member;
  }
  function isComposeHandlersCall(node) {
    return ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "composeHandlers";
  }
  function unwrapParens(node) {
    let current = node;
    while (ts.isParenthesizedExpression(current)) current = current.expression;
    return current;
  }
  function visit(node) {
    if (isComposeHandlersCall(node)) compositionCalls.push(node);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier?.text === "@sekiban/dcb-cloudflare" && ts.isNamedExports(node.exportClause)) {
      for (const specifier of node.exportClause.elements) exports.push((specifier.propertyName ?? specifier.name).text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.initializer) initializers.set(node.name.text, node.initializer);
      if (node.initializer && containsCall(node.initializer, "createCloudflareOnlyRuntimeWorker")) {
        runtimeDeclarations.set(node.name.text, node.initializer);
      }
    }
    if (ts.isExportAssignment(node) && !node.isExportEquals) defaultExpressions.push(node.expression);
    ts.forEachChild(node, visit);
  }
  visit(worker);
  function resolveExportedComposition() {
    if (compositionCalls.length !== 1) {
      const site = compositionCalls[1] ?? compositionCalls[0] ?? worker;
      unresolvedSourceShape("composeHandlers", lineOf(site));
    }
    const call = compositionCalls[0];
    let owner = call.parent;
    while (owner && ts.isParenthesizedExpression(owner)) owner = owner.parent;
    const declared = Boolean(owner) && ts.isVariableDeclaration(owner);
    const initializer = declared && owner.initializer ? unwrapParens(owner.initializer) : undefined;
    const list = declared ? owner.parent : undefined;
    const statement = list && list.parent;
    const topLevelConst = declared
      && ts.isIdentifier(owner.name)
      && initializer === call
      && ts.isVariableDeclarationList(list)
      && list.declarations.length === 1
      && (list.flags & ts.NodeFlags.Const) !== 0
      && ts.isVariableStatement(statement)
      && ts.isSourceFile(statement.parent);
    if (!topLevelConst) unresolvedSourceShape("composeHandlers", lineOf(call));
    const bindingName = owner.name.text;
    function isNonValueName(node) {
      const parent = node.parent;
      if (!parent) return false;
      if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
      if (ts.isQualifiedName(parent) && parent.right === node) return true;
      if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
      if (ts.isBindingElement(parent) && parent.propertyName === node) return true;
      if (ts.isEnumMember(parent) && parent.name === node) return true;
      if ((ts.isMethodDeclaration(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)
          || ts.isPropertyDeclaration(parent) || ts.isMethodSignature(parent) || ts.isPropertySignature(parent))
          && parent.name === node) return true;
      if (ts.isExportSpecifier(parent) && parent.propertyName && parent.name === node) return true;
      if (ts.isImportSpecifier(parent) && parent.propertyName === node) return true;
      return false;
    }
    function isCommonJsDefaultAssignment(node) {
      if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
      function exportsTarget(target) {
        if (ts.isIdentifier(target) && target.text === "exports") return true;
        if (!ts.isPropertyAccessExpression(target)) return false;
        if (target.name.text === "default") return exportsTarget(target.expression);
        return target.name.text === "exports"
          && ts.isIdentifier(target.expression)
          && target.expression.text === "module";
      }
      return exportsTarget(node.left);
    }
    function hasExportAndDefault(node) {
      const kinds = new Set((node.modifiers ?? []).map((modifier) => modifier.kind));
      return kinds.has(ts.SyntaxKind.ExportKeyword) && kinds.has(ts.SyntaxKind.DefaultKeyword);
    }
    function isDefaultExportedDeclaration(node) {
      return (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && hasExportAndDefault(node);
    }
    function isDefaultExportUnit(node) {
      if (ts.isExportAssignment(node) || isDefaultExportedDeclaration(node) || isCommonJsDefaultAssignment(node)) {
        return true;
      }
      if (ts.isExportSpecifier(node) && node.name.text === "default") return true;
      return ts.isNamespaceExport(node) && node.name.text === "default";
    }
    function unwrapExportExpression(node) {
      let current = unwrapParens(node);
      while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)
          || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)) {
        current = unwrapParens(current.expression);
      }
      return current;
    }
    function directExportIdentifier(unit) {
      if (ts.isExportAssignment(unit)) {
        const expression = unwrapExportExpression(unit.expression);
        return ts.isIdentifier(expression) ? expression : undefined;
      }
      if (ts.isExportSpecifier(unit)) {
        const declaration = unit.parent && unit.parent.parent;
        if (declaration && ts.isExportDeclaration(declaration) && declaration.moduleSpecifier) return undefined;
        const local = unit.propertyName ?? unit.name;
        return ts.isIdentifier(local) ? local : undefined;
      }
      if (isCommonJsDefaultAssignment(unit)) {
        const expression = unwrapExportExpression(unit.right);
        return ts.isIdentifier(expression) ? expression : undefined;
      }
      return undefined;
    }
    const defaultExports = [];
    const bindingReferences = [];
    function collectExportFacts(node) {
      if (isDefaultExportUnit(node)) defaultExports.push(node);
      if (ts.isIdentifier(node) && node.text === bindingName && node !== owner.name && !isNonValueName(node)) {
        bindingReferences.push(node);
      }
      ts.forEachChild(node, collectExportFacts);
    }
    collectExportFacts(worker);
    // Each default specifier and each default function or class counts separately.
    if (defaultExports.length !== 1) {
      unresolvedSourceShape("default", lineOf(defaultExports[1] ?? defaultExports[0] ?? worker));
    }
    const allowed = directExportIdentifier(defaultExports[0]);
    if (!allowed || allowed.text !== bindingName) {
      unresolvedSourceShape("default", lineOf(defaultExports[0]));
    }
    // Exactly one reference, and it is that default-export identifier.
    if (bindingReferences.length !== 1 || bindingReferences[0] !== allowed) {
      const extra = bindingReferences.find((node) => node !== allowed);
      unresolvedSourceShape(bindingName, lineOf(extra ?? owner));
    }
    return call;
  }
  composedWorker = resolveExportedComposition();
  exportedWorker = true;
  const runtimeNames = new Set(runtimeDeclarations.keys());
  const root = composedWorker?.arguments[0];
  const properties = root && ts.isObjectLiteralExpression(root) ? root.properties : [];
  const sekibanAssignments = [];
  const mountShape = {
    forwardSerializedRoutes: "omitted",
    extraPaths: null,
    extraPrefixes: null,
  };
  function recordStaticRoutes(name, entry) {
    if (!ts.isPropertyAssignment(entry)) unresolvedSourceShape(name, lineOf(entry));
    const values = staticStringArray(entry.initializer);
    if (values === undefined) unresolvedSourceShape(name, lineOf(entry));
    const texts = values.map((item) => item.value);
    if (name === "extraPaths") mountShape.extraPaths = texts;
    if (name === "extraPrefixes") mountShape.extraPrefixes = texts;
    for (const item of values) {
      if (!isOperatorMount(item.value)) continue;
      operatorMounted = true;
      exposure.push({ property: name, value: item.value, line: item.line });
    }
  }
  function inspectSekiban(property) {
    if (!ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(property.initializer)) {
      unresolvedSourceShape("sekiban", lineOf(property));
    }
    const counts = { forwardSerializedRoutes: 0, extraPaths: 0, extraPrefixes: 0 };
    for (const entry of property.initializer.properties) {
      if (ts.isSpreadAssignment(entry)) unresolvedSourceShape("sekiban", lineOf(entry));
      if (entry.name && ts.isComputedPropertyName(entry.name)) unresolvedSourceShape("sekiban", lineOf(entry));
      const name = entry.name ? propertyText(entry.name) : undefined;
      if (name === "forwardSerializedRoutes" || name === "extraPaths" || name === "extraPrefixes") {
        counts[name] += 1;
        if (counts[name] > 1) unresolvedSourceShape(name, lineOf(entry));
        if (!ts.isPropertyAssignment(entry)) unresolvedSourceShape(name, lineOf(entry));
        if (name === "forwardSerializedRoutes") {
          const literal = booleanLiteral(entry.initializer);
          if (literal === undefined) unresolvedSourceShape(name, lineOf(entry));
          mountShape.forwardSerializedRoutes = literal;
        } else {
          recordStaticRoutes(name, entry);
        }
      }
      if (!ts.isPropertyAssignment(entry) || !ts.isIdentifier(entry.name)) continue;
      if (entry.name.text === "fetch") handlers.fetch = runtimeProperty(entry.initializer, runtimeNames, "fetch");
      if (entry.name.text === "queue") handlers.queue = runtimeProperty(entry.initializer, runtimeNames, "queue");
      if (entry.name.text === "scheduled") {
        handlers.scheduled = runtimeProperty(entry.initializer, runtimeNames, "scheduled");
      }
    }
  }
  if (root && ts.isObjectLiteralExpression(root)) {
    for (const property of properties) {
      if (ts.isSpreadAssignment(property)) unresolvedSourceShape("sekiban", lineOf(property));
      if (property.name && ts.isComputedPropertyName(property.name)) {
        unresolvedSourceShape("sekiban", lineOf(property));
      }
      const name = property.name ? propertyText(property.name) : undefined;
      if (name === "application" && ts.isPropertyAssignment(property)) {
        handlers.application = true;
        handlers.fetch = propertyNames(property.initializer).includes("fetch");
      }
      if (name === "sekiban") sekibanAssignments.push(property);
    }
    if (sekibanAssignments.length !== 1) unresolvedSourceShape("sekiban", lineOf(root));
    inspectSekiban(sekibanAssignments[0]);
  }
  function classifyDefault(node, seen) {
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) {
      classifyDefault(node.expression, seen);
      return;
    }
    if (isRuntimeIdentifier(node)) {
      directRuntimeFetch = true;
      exposure.push({ property: "default", value: node.text, line: lineOf(node) });
      return;
    }
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text)) return;
      seen.add(node.text);
      const next = initializers.get(node.text);
      if (next === undefined) return;
      if (isRuntimeIdentifier(next)) {
        directRuntimeFetch = true;
        exposure.push({ property: node.text, value: next.text, line: lineOf(next) });
        return;
      }
      classifyDefault(next, seen);
      return;
    }
    if (!ts.isObjectLiteralExpression(node)) return;
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) unresolvedSourceShape("default", lineOf(property));
      if (property.name && ts.isComputedPropertyName(property.name)) unresolvedSourceShape("default", lineOf(property));
      if (!ts.isPropertyAssignment(property) || propertyText(property.name) !== "fetch") continue;
      if (isRuntimeFetch(property.initializer)) {
        directRuntimeFetch = true;
        exposure.push({
          property: "fetch",
          value: `${property.initializer.expression.text}.fetch`,
          line: lineOf(property.initializer),
        });
        continue;
      }
      if (ts.isElementAccessExpression(property.initializer) || ts.isCallExpression(property.initializer)) {
        unresolvedSourceShape("fetch", lineOf(property.initializer));
      }
    }
  }
  for (const expression of defaultExpressions) classifyDefault(expression, new Set());
  const triggers = [];
  if (operatorMounted) triggers.push("operator-route-mounted");
  if (directRuntimeFetch) triggers.push("runtime-fetch-direct");
  triggers.sort();
  exposure.sort((left, right) => (
    left.property.localeCompare(right.property)
    || left.value.localeCompare(right.value)
    || left.line - right.line
  ));
  let composedUsesRuntime = false;
  function inspectComposed(node) {
    if (ts.isIdentifier(node) && runtimeNames.has(node.text)) composedUsesRuntime = true;
    if (!composedUsesRuntime) ts.forEachChild(node, inspectComposed);
  }
  if (composedWorker) inspectComposed(composedWorker);
  const composition = exportedWorker && composedWorker !== null && composedUsesRuntime;
  return {
    exports: exports.sort(),
    expectedClasses,
    composition,
    handlers,
    operatorRoutes: operatorMounted ? "mounted" : "unmounted",
    directRuntimeFetch,
    triggers,
    source: exposure,
    forwardSerializedRoutes: mountShape.forwardSerializedRoutes,
    extraPaths: mountShape.extraPaths,
    extraPrefixes: mountShape.extraPrefixes,
    serializedRoutes: serializedRouteState(mountShape),
  };
}

function sourceParity(authority, overrides = new Map()) {
  const workerPath = join(project, authority.worker.entrypoint);
  assert(existsSync(workerPath), "worker-source-missing", authority.worker.entrypoint);
  const readSource = (path) => overrides.get(path) ?? readFileSync(path, "utf8");
  const structure = workerStructure(authority, readSource(workerPath), authority.worker.entrypoint);
  assertMaintenanceOnlyMount(structure);
  assertExternalPrerequisite(structure);
  assert(canonical(structure.exports) === canonical(structure.expectedClasses), "worker-do-exports");
  assert(structure.composition, "worker-runtime-composition");
  assert(structure.handlers.application && structure.handlers.fetch && structure.handlers.queue && structure.handlers.scheduled, "worker-handler-registration");

  const declared = new Set([...Object.keys(authority.vars), ...authority.d1.map((entry) => entry.binding), ...authority.queues.producers.map((entry) => entry.binding), ...authority.durableObjects.bindings.map((entry) => entry.name)]);
  const optionalUnused = new Set([authority.assets.binding]);
  const files = [];
  function collect(directory, prefix = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) collect(path, name);
      else if (entry.isFile() && /\.tsx?$/.test(entry.name)) files.push([name, path]);
    }
  }
  collect(join(project, "src"));
  const reads = new Set();
  for (const [name, path] of files) {
    const parsed = sourceFile(name, overrides.get(path) ?? readFileSync(path, "utf8"));
    const aliases = new Set(["env"]);
    let changed = true;
    while (changed) {
      changed = false;
      function findAliases(node) {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
            ts.isIdentifier(node.initializer) && aliases.has(node.initializer.text)) {
          if (!aliases.has(node.name.text)) {
            aliases.add(node.name.text);
            changed = true;
          }
        }
        ts.forEachChild(node, findAliases);
      }
      findAliases(parsed);
    }
    function inspect(node) {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && aliases.has(node.expression.text)) {
        reads.add(node.name.text);
      }
      if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && aliases.has(node.expression.text) &&
          node.argumentExpression && ts.isStringLiteral(node.argumentExpression)) {
        reads.add(node.argumentExpression.text);
      }
      ts.forEachChild(node, inspect);
    }
    inspect(parsed);
  }
  for (const name of reads) assert(declared.has(name) || optionalUnused.has(name), "worker-undeclared-read");
  return {
    exportedClasses: structure.expectedClasses,
    runtimeComposition: structure.composition,
    handlers: ["fetch", "queue", "scheduled"],
    optionalAssets: "unused",
    runtimeExposure: {
      operatorRoutes: structure.operatorRoutes,
      directRuntimeFetch: structure.directRuntimeFetch,
      serializedRoutes: structure.serializedRoutes,
    },
  };
}

function runbookRows(authority) {
  return [
    { kind: "worker", key: authority.worker.name, value: authority.worker.entrypoint },
    ...authority.d1.map((entry) => ({ kind: "d1", key: entry.binding, value: `${entry.databaseName};${entry.migrationsDir}` })),
    ...authority.queues.producers.map((entry) => ({ kind: "queue-producer", key: entry.binding, value: entry.queue })),
    ...authority.queues.consumers.map((entry) => ({ kind: "queue-consumer", key: entry.queue, value: `${entry.maxBatchTimeout};${entry.maxRetries};${entry.deadLetterQueue}` })),
    ...authority.durableObjects.bindings.map((entry) => ({ kind: "durable-object", key: entry.name, value: entry.className })),
    ...authority.durableObjects.migrations.map((entry) => ({ kind: "durable-migration", key: entry.tag, value: entry.newSqliteClasses.join(",") })),
    { kind: "assets", key: "directory", value: authority.assets.directory },
    ...authority.triggers.crons.map((cron) => ({ kind: "cron", key: cron, value: "" })),
    ...Object.entries(authority.vars).map(([name, value]) => ({ kind: "var", key: name, value })),
  ];
}

function parseRunbookRows(text) {
  const start = text.indexOf("<!-- deployment-topology:begin -->");
  const end = text.indexOf("<!-- deployment-topology:end -->");
  assert(start >= 0 && end > start, "runbook-table-missing");
  const lines = text.slice(start, end).split(/\r?\n/).filter((line) => line.trim().startsWith("|"));
  assert(lines.length >= 2, "runbook-table-empty");
  const rows = lines.slice(2).map((line) => {
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    assert(cells.length === 3, "runbook-row-shape", line);
    return { kind: cells[0], key: cells[1], value: cells[2] };
  });
  const identities = rows.map((row) => `${row.kind}|${row.key}`);
  const seen = new Set();
  identities.forEach((identity, index) => {
    if (seen.has(identity)) fail("duplicate-collection-key", `runbook.rows[${index}]`);
    seen.add(identity);
  });
  return rows;
}

function parseSmokeCurlCommands(text) {
  const commands = [];
  let pending = "";
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("curl ")) pending = trimmed;
    else if (pending.length > 0) pending += ` ${trimmed}`;
    else continue;
    if (!pending.endsWith("\\")) {
      commands.push(pending);
      pending = "";
    }
  }
  assert(pending.length === 0, "smoke-route-parity");
  return commands.map((command) => {
    const url = command.match(/"\$BASE_URL([^"]+)"/);
    assert(url !== null, "smoke-route-parity");
    const parsed = new URL(`https://smoke.invalid${url[1]}`);
    const bodyMatch = command.match(/\s-d\s+'([^']+)'/);
    let bodyKeys = [];
    if (bodyMatch !== null) {
      try {
        const body = JSON.parse(bodyMatch[1]);
        assert(body !== null && typeof body === "object" && !Array.isArray(body), "smoke-body-parity");
        bodyKeys = Object.keys(body).sort();
      } catch {
        fail("smoke-body-parity");
      }
    }
    return { path: parsed.pathname, queryKeys: [...parsed.searchParams.keys()].sort(), bodyKeys };
  });
}

function compareSmokeContract(text) {
  const routesSource = readFileSync(join(project, "src/booking-routes.ts"), "utf8");
  const transportSource = readFileSync(join(project, "src/booking-transport.ts"), "utf8");
  const domainSource = readFileSync(join(project, "src/booking-domain.ts"), "utf8");
  assert(routesSource.includes('path.startsWith("/api/commands/")'), "smoke-source-route");
  assert(
    routesSource.includes('"/api/read/room"') && routesSource.includes('"/api/read/reservation"'),
    "smoke-source-route",
  );
  assert(
    transportSource.includes('case "create-room"') && transportSource.includes('case "reserve-room"'),
    "smoke-source-command",
  );
  assert(
    /const roomInput\s*=\s*z\.object\(\{[\s\S]*roomId[\s\S]*name/.test(domainSource),
    "smoke-source-body",
  );
  assert(
    /const reservationInput\s*=\s*z\.object\(\{[\s\S]*roomId[\s\S]*reservationId/.test(domainSource),
    "smoke-source-body",
  );
  const documented = parseSmokeCurlCommands(text);
  const commandIds = [...transportSource.matchAll(/case\s+"([^"]+)":\s+return/g)].map((match) => match[1]);
  const generatedCommandPaths = new Set(commandIds.map((id) => `/api/commands/${id}`));
  const generatedReadRoutes = new Map([
    ["/api/read/room", ["roomId"]],
    ["/api/read/reservation", ["reservationId"]],
  ]);
  const generatedBodyKeys = new Map([
    ["create-room", ["name", "roomId"]],
    ["reserve-room", ["reservationId", "roomId"]],
  ]);
  assert(documented.length === 4, "smoke-route-parity");
  assert(
    canonical(documented.map((request) => request.path).sort()) === canonical([
      "/api/commands/create-room",
      "/api/commands/reserve-room",
      "/api/read/room",
      "/api/read/reservation",
    ].sort()),
    "smoke-route-parity",
  );
  for (const request of documented) {
    if (generatedCommandPaths.has(request.path)) {
      const commandId = request.path.slice("/api/commands/".length);
      assert(request.queryKeys.length === 0, "smoke-route-parity");
      assert(canonical(request.bodyKeys) === canonical(generatedBodyKeys.get(commandId)), "smoke-body-parity");
      continue;
    }
    const queryKeys = generatedReadRoutes.get(request.path);
    assert(queryKeys !== undefined, "smoke-route-parity");
    assert(canonical(request.queryKeys) === canonical(queryKeys), "smoke-route-parity");
    assert(request.bodyKeys.length === 0, "smoke-body-parity");
  }
  return {
    routes: documented.map((request) => request.path),
    bodyKeys: ["roomId", "name", "reservationId"],
  };
}

function compareRunbook(authority, text) {
  const actual = parseRunbookRows(text);
  const expected = runbookRows(authority);
  assert(canonical(actual) === canonical(expected), "runbook-topology-parity");
  const commands = authority.d1.map((entry) => entry.creationCommand)
    .concat(authority.queues.creation.map((entry) => entry.command));
  const foundCommands = [...text.matchAll(/^\s*(npx wrangler (?:d1|queues) create \S+)\s*$/gm)].map((match) => match[1]);
  assert(canonical(foundCommands) === canonical(commands), "runbook-creation-commands");
  assert(/npm run deploy\s*$/m.test(text) && !/npm run deploy\s+--keep-vars/.test(text), "runbook-keep-vars-default");
  const smoke = compareSmokeContract(text);
  return { rows: actual.length, creationCommands: commands.length, smoke };
}

function validateNoCfDependency(manifest, gateText) {
  assert(!Object.hasOwn(manifest.dependencies ?? {}, "cf") && !Object.hasOwn(manifest.devDependencies ?? {}, "cf"), "cf-dependency");
  const executableGate = gateText.slice(0, gateText.indexOf("function selfTest"));
  assert(!/(?:spawnSync|execFileSync)\(\s*["']cf["']/.test(executableGate), "cf-gate-invocation");
}

function validateProject({ authority, config, runbook, requireConfigured = false, sourceOverrides = new Map() }) {
  validateAuthority(authority);
  compareTopology(authority, config);
  const migrations = migrationCounts(authority);
  const placeholders = configuredD1Ids(authority, config, requireConfigured);
  const source = sourceParity(authority, sourceOverrides);
  const table = compareRunbook(authority, runbook);
  validateNoCfDependency(parseJsonc(readFileSync(join(project, "package.json"), "utf8"), "package.json"), readFileSync(fileURLToPath(import.meta.url), "utf8"));
  return { migrations, placeholders, source, table };
}

function safeArgs(args) {
  assert(args[0] === "deploy", "command-vector", "only deploy is permitted");
  assert(args.includes("--dry-run"), "command-without-dry-run");
  const remoteVerbs = /^(?:migrate|migration|create|delete|remove|destroy|login|deployments?|queues?|d1|secret|tail|whoami|list)$/i;
  assert(!args.some((arg) => remoteVerbs.test(arg) && !["deploy"].includes(arg)), "remote-command-vector");
  assert(args.includes("--config") && args.includes("wrangler.jsonc") && args.includes("--outdir") && args.includes("--outfile"), "command-vector", "required relative flags missing");
  assert(!args.some((arg) => arg === "npx" || arg === "cf" || arg.includes("CLOUDFLARE")), "remote-command-vector");
}

function sanitizeEnvironment(source) {
  const env = { ...source };
  const removed = [];
  for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "REPAIR_OPERATOR_TOKEN"]) {
    if (Object.hasOwn(env, name)) removed.push(name);
    delete env[name];
  }
  return { env, removed };
}

function renderFailure(error) {
  return `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`;
}

const removedCredentialVariables = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "REPAIR_OPERATOR_TOKEN",
];

function readProject() {
  const authority = parseJsonc(readFileSync(topologyPath, "utf8"), "deployment-topology.json");
  const config = parseJsonc(readFileSync(wranglerPath, "utf8"), "wrangler.jsonc");
  const runbook = readFileSync(runbookPath, "utf8");
  return { authority, config, runbook };
}

function receipt(validation, placeholders, removedCredentials) {
  const locations = placeholders.map((entry) => ({
    binding: entry.binding,
    path: entry.path,
    databaseName: entry.databaseName,
    creationCommand: entry.creationCommand,
    replacement: entry.replacement,
  }));
  assertPlaceholderReceipt(placeholders, locations);
  assert(
    removedCredentials.every((name) => removedCredentialVariables.includes(name)),
    "credential-sanitization",
  );
  return {
    command: ["deploy", "--config", "wrangler.jsonc", "--dry-run", "--outdir", "<owned-temp-dir>", "--outfile", "<owned-temp-dir>/worker.js"],
    topology: expectedTopology(readProject().authority).sort((a, b) => canonical(a).localeCompare(canonical(b))),
    migrationFileCounts: validation.migrations,
    placeholders: {
      status: placeholders.length === 0 ? "configured" : "fresh-template",
      locations,
    },
    bundle: { projectLocalWrangler: true, dryRun: true, createRoom: true, reserveRoom: true },
    removedCredentialVariables: [...removedCredentialVariables],
    runtimeExposure: validation.source.runtimeExposure,
    externalPrerequisites: [{
      name: "REPAIR_OPERATOR_TOKEN",
      required: false,
      verification: "external",
      remoteStateChecked: false,
    }],
  };
}

function runGate(requireConfigured, options = {}) {
  const validation = validateProject({
    ...readProject(),
    requireConfigured,
    sourceOverrides: options.sourceOverrides ?? new Map(),
  });
  const outdir = mkdtempSync(join(tmpdir(), "create-dcb-deploy-check-"));
  const outfile = join(outdir, "worker.js");
  const args = ["deploy", "--config", "wrangler.jsonc", "--dry-run", "--outdir", outdir, "--outfile", outfile];
  try {
    safeArgs(args);
    const wrangler = join(project, "node_modules/wrangler/bin/wrangler.js");
    assert(existsSync(wrangler), "project-local-wrangler-missing");
    const sanitized = sanitizeEnvironment({
      ...(options.env ?? process.env),
      CI: "true",
      WRANGLER_SEND_METRICS: "false",
    });
    const env = sanitized.env;
    const removedCredentials = sanitized.removed;
    const spawn = options.spawn ?? spawnSync;
    const result = spawn(process.execPath, [wrangler, ...args], {
      cwd: project,
      env,
      encoding: "utf8",
      shell: false,
      maxBuffer: 64 * 1024 * 1024,
    });
    assert(result.status === 0, "wrangler-dry-run", wranglerFailure(result));
    assert(existsSync(outfile), "bundle-missing");
    const bundle = readFileSync(outfile, "utf8");
    assert(bundle.includes("create-room"), "bundle-marker-create-room");
    assert(bundle.includes("reserve-room"), "bundle-marker-reserve-room");
    process.stdout.write(`${JSON.stringify(receipt(validation, validation.placeholders, removedCredentials), null, 2)}\n`);
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}

function assertRepairBindingNameOnly(source) {
  const binding = "REPAIR_OPERATOR_TOKEN";
  const end = source.indexOf("\nfunction selfTest(");
  assert(end > 0, "repair-binding-value-inspection");
  const executable = source.slice(0, end);
  const withoutLiterals = executable.replace(/`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "\"\"");
  assert(!withoutLiterals.includes(binding), "repair-binding-value-inspection");
  const direct = new RegExp(`(?:source|env|process\\.env)\\.${binding}\\b`);
  const computed = new RegExp(`(?:source|env|process\\.env)\\s*\\[\\s*["']${binding}["']\\s*\\]`);
  assert(!direct.test(executable), "repair-binding-value-inspection");
  assert(!computed.test(executable), "repair-binding-value-inspection");
  const start = executable.indexOf("\nfunction sanitizeEnvironment(");
  const readProjectAt = executable.indexOf("\nfunction readProject(");
  assert(start >= 0 && readProjectAt > start, "repair-binding-value-inspection");
  const sanitize = executable.slice(start, readProjectAt);
  const allowed = sanitize.replace(/Object\.hasOwn\(env,\s*name\)/g, "").replace(/delete env\[name\]/g, "");
  assert(!/env\[name\]/.test(allowed), "repair-binding-value-inspection");
  assert(!/source\[/.test(sanitize), "repair-binding-value-inspection");
}

function captureWrites(action) {
  const stdout = [];
  const stderr = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = (chunk) => {
    stdout.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk) => {
    stderr.push(String(chunk));
    return true;
  };
  try {
    action();
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  return { stdout: stdout.join(""), stderr: stderr.join("") };
}

function prerequisiteFailure(action, expected) {
  let error;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  if (!(error instanceof Error) || !error.message.startsWith("deploy-check:missing-external-prerequisite: ")) {
    fail("self-test-trigger-missing", error instanceof Error ? error.message : "no error");
  }
  const json = JSON.parse(error.message.slice("deploy-check:missing-external-prerequisite: ".length));
  assert(json.code === "missing-external-prerequisite", "self-test-diagnostic-shape");
  assert(json.path === "$.secrets[name=REPAIR_OPERATOR_TOKEN]", "self-test-diagnostic-shape");
  assert(json.prerequisite === "REPAIR_OPERATOR_TOKEN", "self-test-diagnostic-shape");
  assert(json.verification === "external", "self-test-diagnostic-shape");
  assert(json.remoteStateChecked === false, "self-test-diagnostic-shape");
  assert(canonical(json.triggers) === canonical(expected.triggers), "self-test-diagnostic-shape");
  assert(!JSON.stringify(json).toLowerCase().includes("absent"), "self-test-diagnostic-shape");
  for (const entry of expected.source) {
    const match = json.source.find((item) => item.property === entry.property && item.value === entry.value);
    assert(match !== undefined && Number.isInteger(match.line) && match.line > 0, "self-test-diagnostic-shape");
    assert(canonical(Object.keys(match).sort()) === canonical(["line", "property", "value"]), "self-test-diagnostic-shape");
  }
  const rendered = renderFailure(error);
  assert(rendered.includes('"remoteStateChecked":false'), "self-test-diagnostic-shape");
  assert(!rendered.includes("remote secret is absent"), "self-test-diagnostic-shape");
  throw error;
}

function expectFailure(name, action) {
  try {
    action();
  } catch (error) {
    assert(error instanceof Error && error.message.startsWith(`deploy-check:${name}`), "self-test-wrong-failure", `${name}/${error instanceof Error ? error.message : String(error)}`);
    return name;
  }
  fail("self-test-missing-failure", name);
}

function selfTest() {
  const baseline = readProject();
  const checks = [];
  assert(parseJsonc("// line comment\n{\"value\": 1}", "line-comment").value === 1, "jsonc-parse", "line comments are not accepted");
  assert(parseJsonc("/* block comment */ {\"value\": 1}", "block-comment").value === 1, "jsonc-parse", "block comments are not accepted");
  checks.push(expectFailure("jsonc-parse", () => parseJsonc("{\"value\": 1,}", "object-trailing-comma")));
  checks.push(expectFailure("jsonc-parse", () => parseJsonc("[1,]", "array-trailing-comma")));
  checks.push(expectFailure("duplicate-collection-key", () => parseJsonc("{\"value\": 1,\"value\": 2}", "duplicate-object-key")));
  const mutate = (change) => {
    const candidate = { authority: structuredClone(baseline.authority), config: structuredClone(baseline.config), runbook: baseline.runbook };
    change(candidate);
    return candidate;
  };
  const validate = (candidate) => validateAuthority(candidate.authority) && compareTopology(candidate.authority, candidate.config);
  checks.push(expectFailure("d1-parity", () => validate(
    mutate((candidate) => candidate.config.d1_databases.pop()),
  )));
  checks.push(expectFailure("duplicate-collection-key", () => validate(
    mutate((candidate) => candidate.config.d1_databases.push(
      structuredClone(candidate.config.d1_databases[0]),
    )),
  )));
  checks.push(expectFailure("duplicate-collection-key", () => validate(
    mutate((candidate) => candidate.config.queues.producers.push(
      structuredClone(candidate.config.queues.producers[0]),
    )),
  )));
  checks.push(expectFailure("queue-producer-parity", () => validate(
    mutate((candidate) => candidate.config.queues.producers.push({ binding: "EXTRA_QUEUE", queue: "extra-queue" })),
  )));
  checks.push(expectFailure("durable-object-parity", () => validate(
    mutate((candidate) => { candidate.config.durable_objects.bindings[0].class_name = "Changed"; }),
  )));
  checks.push(expectFailure("d1-parity", () => validate(
    mutate((candidate) => { candidate.config.d1_databases[0].migrations_dir = "migrations/mv"; }),
  )));
  checks.push(expectFailure("duplicate-collection-key", () => validateAuthority(
    mutate((candidate) => candidate.authority.d1.push(structuredClone(candidate.authority.d1[0]))).authority,
  )));
  checks.push(expectFailure("duplicate-collection-key", () => validateAuthority(
    mutate((candidate) => candidate.authority.queues.creation.push(
      structuredClone(candidate.authority.queues.creation[0]),
    )).authority,
  )));
  checks.push(expectFailure("duplicate-collection-key", () => validateAuthority(
    mutate((candidate) => {
      candidate.authority.queues.creation[1].name = candidate.authority.queues.creation[0].name;
    }).authority,
  )));
  checks.push(expectFailure("duplicate-collection-key", () => validateAuthority(
    mutate((candidate) => candidate.authority.durableObjects.migrations.push(
      structuredClone(candidate.authority.durableObjects.migrations[0]),
    )).authority,
  )));
  checks.push(expectFailure("secret-in-vars", () => validateAuthority(
    mutate((candidate) => { candidate.authority.vars[candidate.authority.secrets[0].name] = "bad"; }).authority,
  )));
  checks.push(expectFailure("secret-in-vars", () => validateAuthority(
    mutate((candidate) => { candidate.authority.vars.REPAIR_OPERATOR_TOKEN = "not-a-real-secret"; }).authority,
  )));
  checks.push(expectFailure("authority-repair-entry", () => validateAuthority(
    mutate((candidate) => {
      candidate.authority.secrets = candidate.authority.secrets.filter((entry) => entry.name !== "REPAIR_OPERATOR_TOKEN");
    }).authority,
  )));
  checks.push(expectFailure("authority-repair-entry", () => validateAuthority(
    mutate((candidate) => {
      const repair = candidate.authority.secrets.find((entry) => entry.name === "REPAIR_OPERATOR_TOKEN");
      delete repair.verification;
      delete repair.requiredWhen;
    }).authority,
  )));
  checks.push(expectFailure("authority-secret-fields", () => validateAuthority(
    mutate((candidate) => {
      const repair = candidate.authority.secrets.find((entry) => entry.name === "REPAIR_OPERATOR_TOKEN");
      delete repair.requiredWhen;
    }).authority,
  )));
  checks.push(expectFailure("authority-secret-fields", () => validateAuthority(
    mutate((candidate) => {
      const repair = candidate.authority.secrets.find((entry) => entry.name === "REPAIR_OPERATOR_TOKEN");
      delete repair.verification;
    }).authority,
  )));
  checks.push(expectFailure("authority-secret-verification", () => validateAuthority(
    mutate((candidate) => {
      const repair = candidate.authority.secrets.find((entry) => entry.name === "REPAIR_OPERATOR_TOKEN");
      repair.verification = "remote";
    }).authority,
  )));
  checks.push(expectFailure("authority-secret-conditions", () => validateAuthority(
    mutate((candidate) => {
      const repair = candidate.authority.secrets.find((entry) => entry.name === "REPAIR_OPERATOR_TOKEN");
      repair.requiredWhen = ["operator-route-mounted"];
    }).authority,
  )));
  checks.push(expectFailure("authority-secret-conditions", () => validateAuthority(
    mutate((candidate) => {
      const repair = candidate.authority.secrets.find((entry) => entry.name === "REPAIR_OPERATOR_TOKEN");
      repair.requiredWhen = ["operator-route-mounted", "unknown-condition"];
    }).authority,
  )));
  checks.push(expectFailure("duplicate-collection-key", () => validateAuthority(
    mutate((candidate) => {
      const repair = candidate.authority.secrets.find((entry) => entry.name === "REPAIR_OPERATOR_TOKEN");
      repair.requiredWhen = ["operator-route-mounted", "operator-route-mounted"];
    }).authority,
  )));
  checks.push(expectFailure("authority-key", () => validateAuthority(
    mutate((candidate) => {
      const repair = candidate.authority.secrets.find((entry) => entry.name === "REPAIR_OPERATOR_TOKEN");
      repair.extra = true;
    }).authority,
  )));
  checks.push(expectFailure("authority-key", () => validateAuthority(
    mutate((candidate) => { candidate.authority.account_id = "bad"; }).authority,
  )));
  checks.push(expectFailure("worker-do-exports", () => sourceParity(
    mutate((candidate) => { candidate.authority.durableObjects.bindings[0].className = "Changed"; }).authority,
  )));
  const workerText = readFileSync(join(project, baseline.authority.worker.entrypoint), "utf8");
  checks.push(expectFailure("worker-do-exports", () => {
    const mutant = workerText.replace("  TagStateDurableObject,\n", "");
    const structure = workerStructure(baseline.authority, mutant, "missing-export-mutant.ts");
    assert(canonical(structure.exports) === canonical(structure.expectedClasses), "worker-do-exports");
  }));
  checks.push(expectFailure("worker-do-exports", () => {
    const mutant = workerText.replace("  TagStateDurableObject,\n", "  TagStateDurableObject,\n  ExtraDurableObject,\n");
    const structure = workerStructure(baseline.authority, mutant, "extra-export-mutant.ts");
    assert(canonical(structure.exports) === canonical(structure.expectedClasses), "worker-do-exports");
  }));
  checks.push(expectFailure("worker-handler-registration", () => {
    const mutant = workerText.replace("    scheduled: runtime.scheduled,\n", "");
    const structure = workerStructure(baseline.authority, mutant, "missing-handler-mutant.ts");
    assert(
      structure.handlers.application && structure.handlers.fetch && structure.handlers.queue && structure.handlers.scheduled,
      "worker-handler-registration",
    );
  }));
  checks.push(expectFailure("worker-handler-registration", () => {
    const mutant = workerText.replace("    scheduled: runtime.scheduled,\n", "    scheduled: runtime.fetch,\n");
    const structure = workerStructure(baseline.authority, mutant, "wrong-handler-mutant.ts");
    assert(
      structure.handlers.application && structure.handlers.fetch && structure.handlers.queue && structure.handlers.scheduled,
      "worker-handler-registration",
    );
  }));
  checks.push(expectFailure("durable-migration-parity", () => validate(mutate((candidate) => {
    candidate.config.migrations[0].new_sqlite_classes[0] = "ChangedDurableObject";
  }))));
  checks.push(expectFailure("durable-migration-parity", () => validate(mutate((candidate) => {
    const moved = candidate.config.migrations[2].new_sqlite_classes.pop();
    candidate.config.migrations[1].new_sqlite_classes.push(moved);
  }))));
  checks.push(expectFailure("assets-parity", () => validate(mutate((candidate) => {
    candidate.config.assets.directory = "assets-drift";
  }))));
  checks.push(expectFailure("cron-parity", () => validate(mutate((candidate) => {
    candidate.config.triggers.crons[0] = "*/5 * * * *";
  }))));
  checks.push(expectFailure("var-parity", () => validate(mutate((candidate) => {
    candidate.config.vars.EXTRA_VAR = "unexpected";
  }))));
  checks.push(expectFailure("d1-parity", () => validate(mutate((candidate) => {
    candidate.authority.d1[0].migrationsDir = candidate.authority.d1[1].migrationsDir;
    candidate.authority.d1[1].migrationsDir = "migrations/d1/g32";
  }))));
  checks.push(expectFailure("migration-directory-missing", () => migrationCounts(mutate((candidate) => { candidate.authority.d1[0].migrationsDir = "migrations/nope"; }).authority)));
  checks.push(expectFailure("migration-directory-empty", () => {
    const empty = mkdtempSync(join(project, ".deploy-check-self-test-"));
    try {
      migrationCounts(mutate((candidate) => { candidate.authority.d1[0].migrationsDir = relative(project, empty); }).authority);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  }));
  checks.push(expectFailure("migration-path-escape", () => migrationCounts(mutate((candidate) => { candidate.authority.d1[0].migrationsDir = "../outside"; }).authority)));
  checks.push(expectFailure("runbook-topology-parity", () => compareRunbook(baseline.authority, baseline.runbook.replace("| worker |", "| changed |"))));
  checks.push(expectFailure("runbook-topology-parity", () => compareRunbook(baseline.authority, baseline.runbook.replace("| var | SDT_SERVICE_ID", "| var | removed-SDT_SERVICE_ID"))));
  checks.push(expectFailure("smoke-route-parity", () => compareRunbook(
    baseline.authority,
    baseline.runbook.replace("/api/commands/create-room", "/api/commands/create-room-drift"),
  )));
  checks.push(expectFailure("unknown-placeholder", () => {
    const config = structuredClone(baseline.config);
    config.d1_databases[0].database_id = "REPLACE_WITH_UNKNOWN";
    placeholderEntries(baseline.authority, config);
  }));
  checks.push(expectFailure("placeholder-location", () => {
    const config = structuredClone(baseline.config);
    config.d1_databases[0].database_id = "REPLACE_WITH_PIPELINE_D1_ID";
    config.d1_databases[0].database_name = "REPLACE_WITH_PIPELINE_D1_ID";
    placeholderEntries(baseline.authority, config);
  }));
  checks.push(expectFailure("placeholder-report-missing", () => assertPlaceholderReceipt(
    placeholderEntries(baseline.authority, baseline.config),
    placeholderEntries(baseline.authority, baseline.config).slice(0, 1),
  )));
  checks.push(expectFailure("require-configured-placeholder", () => configuredD1Ids(baseline.authority, structuredClone(baseline.config), true)));
  checks.push(expectFailure("configured-id-shape", () => {
    const config = structuredClone(baseline.config);
    config.d1_databases[0].database_id = "not-a-provider-id";
    config.d1_databases[1].database_id = "not-a-provider-id";
    configuredD1Ids(baseline.authority, config, true);
  }));
  const workerPath = join(project, baseline.authority.worker.entrypoint);
  checks.push(expectFailure("worker-undeclared-read", () => sourceParity(baseline.authority, new Map([
    [workerPath, `${workerText}\nconst envAlias = env; const value = env["NOT_IN_AUTHORITY"];\nconst other = envAlias["NOT_IN_AUTHORITY"];`],
  ]))));
  checks.push(expectFailure("command-without-dry-run", () => safeArgs(["deploy", "--config", "wrangler.jsonc"])));
  checks.push(expectFailure("remote-command-vector", () => safeArgs(["deploy", "--config", "wrangler.jsonc", "--dry-run", "--outdir", "x", "--outfile", "y", "login"])));
  checks.push(expectFailure("cf-dependency", () => validateNoCfDependency({ dependencies: { cf: "1.0.0" } }, "")));
  checks.push(expectFailure("cf-gate-invocation", () => validateNoCfDependency({}, "spawnSync(\"cf\", [])")));
  const green = validateProject(baseline);
  assert(green.placeholders.length === 2, "self-test-green-placeholder-count");
  checks.push(expectFailure("duplicate-collection-key", () => compareRunbook(
    baseline.authority,
    baseline.runbook.replace(
      "<!-- deployment-topology:end -->",
      `| worker | ${baseline.authority.worker.name} | ${baseline.authority.worker.entrypoint} |\n<!-- deployment-topology:end -->`,
    ),
  )));
  checks.push(expectFailure("require-configured-placeholder", () => {
    const config = structuredClone(baseline.config);
    config.d1_databases[1].database_id = "11111111-1111-4111-8111-111111111111";
    configuredD1Ids(baseline.authority, config, true);
  }));
  const stubDir = mkdtempSync(join(project, ".deploy-check-stub-"));
  try {
    const configuredId = "11111111-1111-4111-8111-111111111111";
    const stub = join(stubDir, "wrangler-stub.mjs");
    writeFileSync(
      stub,
      `process.stdout.write(${JSON.stringify(configuredId)}); process.stderr.write(${JSON.stringify(configuredId)}); process.exitCode = 1;`,
    );
    const stubResult = spawnSync(process.execPath, [stub], { encoding: "utf8" });
    const diagnostic = wranglerFailure(stubResult);
    assert(
      !diagnostic.includes(configuredId) && !JSON.stringify({ diagnostic }).includes(configuredId),
      "wrangler-diagnostic-redaction",
    );
    checks.push("wrangler-diagnostic-redaction");
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
  }
  const inherited = {
    CLOUDFLARE_API_TOKEN: "obvious-fake-cloudflare-token",
    CLOUDFLARE_ACCOUNT_ID: "obvious-fake-cloudflare-account",
    REPAIR_OPERATOR_TOKEN: "obvious-fake-repair-token",
    KEEP: "yes",
  };
  const sanitized = sanitizeEnvironment(inherited);
  assert(!Object.hasOwn(sanitized.env, "CLOUDFLARE_API_TOKEN"), "credential-sanitization");
  assert(!Object.hasOwn(sanitized.env, "CLOUDFLARE_ACCOUNT_ID"), "credential-sanitization");
  assert(!Object.hasOwn(sanitized.env, "REPAIR_OPERATOR_TOKEN"), "credential-sanitization");
  assert(sanitized.env.KEEP === "yes", "credential-sanitization");
  assert(canonical(sanitized.removed) === canonical([
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "REPAIR_OPERATOR_TOKEN",
  ]), "credential-sanitization");
  checks.push("fresh-template-control", "credential-sanitization");

  const incident = baseline.authority.secrets.find((entry) => entry.name === "INCIDENT_MAINTAINER_TOKEN");
  assert(canonical(Object.keys(incident).sort()) === canonical(["forbiddenIn", "name", "optional", "ownership"]), "incident-secret-shape");
  assert(incident.optional === true && incident.ownership === "runtime-owned" && incident.forbiddenIn === "vars", "incident-secret-shape");
  checks.push("incident-secret-shape");

  const unchanged = workerStructure(baseline.authority, workerText, baseline.authority.worker.entrypoint);
  assert(unchanged.operatorRoutes === "unmounted", "runtime-exposure");
  assert(unchanged.directRuntimeFetch === false, "runtime-exposure");
  assert(unchanged.triggers.length === 0, "runtime-exposure");
  assert(unchanged.serializedRoutes === "unmounted", "runtime-exposure");
  assert(unchanged.extraPaths === null, "runtime-exposure");
  assert(canonical(unchanged.extraPrefixes) === canonical(["/maintenance"]), "runtime-exposure");
  checks.push("runtime-exposure");

  const maintenanceLine = '    extraPrefixes: ["/maintenance"],';
  const flagLine = "    forwardSerializedRoutes: false,";
  function withMount(text) {
    return workerText.replace(maintenanceLine, text);
  }
  function withFlag(text) {
    return workerText.replace(flagLine, text);
  }
  function replaceSekiban(text) {
    return workerText.replace(/ {2}sekiban: \{[\s\S]*?\n {2}\},/, text);
  }
  checks.push(expectFailure("missing-external-prerequisite", () => prerequisiteFailure(
    () => assertExternalPrerequisite({
      triggers: ["runtime-fetch-direct"],
      source: [{ property: "default", value: "runtime", line: 1 }],
    }),
    { triggers: ["runtime-fetch-direct"], source: [{ property: "default", value: "runtime" }] },
  )));
  checks.push("prerequisite-diagnostic-shape");
  function mountCase(label, mutant) {
    checks.push(expectFailure("generated runtime mount is not maintenance-only", () => {
      try {
        sourceParity(baseline.authority, new Map([[workerPath, mutant]]));
      } catch (error) {
        if (error instanceof Error && error.message.includes("missing-external-prerequisite")) {
          fail("self-test-wrong-failure", `${label}/prerequisite-before-mount-shape`);
        }
        throw error;
      }
      fail("self-test-mount-shape-accepted", label);
    }));
    checks.push(label);
  }
  function unresolvedCase(label, mutant) {
    checks.push(expectFailure("unresolved-source-shape", () => {
      sourceParity(baseline.authority, new Map([[workerPath, mutant]]));
      fail("self-test-unresolved-accepted", label);
    }));
    checks.push(label);
  }
  const operatorRepair = withMount('    extraPaths: ["/operator/repair"],\n    extraPrefixes: ["/maintenance"],');
  const operatorRepairStructure = workerStructure(baseline.authority, operatorRepair, "operator-repair.ts");
  assert(operatorRepairStructure.operatorRoutes === "mounted", "operator-route-classifier");
  assert(
    canonical(operatorRepairStructure.triggers) === canonical(["operator-route-mounted"]),
    "operator-route-classifier",
  );
  assert(
    operatorRepairStructure.source.some((item) => item.property === "extraPaths" && item.value === "/operator/repair"),
    "operator-route-classifier",
  );
  mountCase("operator-repair-mount-shape", operatorRepair);
  const exactOperator = withMount('    extraPaths: ["/operator"],\n    extraPrefixes: ["/maintenance"],');
  const exactOperatorStructure = workerStructure(baseline.authority, exactOperator, "exact-operator.ts");
  assert(exactOperatorStructure.operatorRoutes === "mounted", "operator-route-classifier");
  assert(
    exactOperatorStructure.source.some((item) => item.property === "extraPaths" && item.value === "/operator"),
    "operator-route-classifier",
  );
  mountCase("exact-operator-mount-shape", exactOperator);
  const operatorPrefix = withMount('    extraPrefixes: ["/operator/bootstrap"],');
  const operatorPrefixStructure = workerStructure(baseline.authority, operatorPrefix, "operator-prefix.ts");
  assert(operatorPrefixStructure.operatorRoutes === "mounted", "operator-route-classifier");
  assert(
    operatorPrefixStructure.source.some((item) => (
      item.property === "extraPrefixes" && item.value === "/operator/bootstrap"
    )),
    "operator-route-classifier",
  );
  mountCase("operator-prefix-mount-shape", operatorPrefix);
  const compositionStart = workerText.indexOf(
    "const worker: ExportedHandler<StarterEnvironment> = composeHandlers<StarterEnvironment>({",
  );
  const compositionEnd = workerText.indexOf("export default worker;");
  const conformingComposition = workerText.slice(compositionStart, compositionEnd).replace(
    "const worker:",
    "const decoy:",
  );
  const nonconformingWorker = workerText.replace(flagLine, "    forwardSerializedRoutes: true,");
  const decoyBefore = nonconformingWorker.replace(
    "const worker:",
    `${conformingComposition}const worker:`,
  );
  const decoyAfter = nonconformingWorker.replace(
    "export default worker;",
    `${conformingComposition}export default worker;`,
  );
  unresolvedCase("exported-nonconforming-decoy-before", decoyBefore);
  unresolvedCase("exported-nonconforming-decoy-after", decoyAfter);
  unresolvedCase(
    "multiple-compositions",
    workerText.replace("export default worker;", `${conformingComposition}export default worker;`),
  );
  unresolvedCase(
    "default-export-not-resolvable",
    workerText.replace("export default worker;", "export default runtime;"),
  );
  unresolvedCase(
    "default-export-alias",
    workerText.replace(
      "const worker: ExportedHandler<StarterEnvironment> = composeHandlers<StarterEnvironment>({",
      "const worker = runtime;\nconst composed = composeHandlers<StarterEnvironment>({",
    ),
  );
  unresolvedCase(
    "default-export-object",
    workerText.replace("export default worker;", "export default { fetch: runtime.fetch };"),
  );
  const bindingMemberMutation = workerText.replace(
    "export default worker;",
    "worker.fetch = runtime.fetch;\nexport default worker;",
  );
  const duplicateDefaultExport = workerText.replace(
    "export default worker;",
    "export { worker as default };\nexport default worker;",
  );
  unresolvedCase("binding-member-mutation", bindingMemberMutation);
  unresolvedCase("duplicate-default-export", duplicateDefaultExport);
  unresolvedCase(
    "binding-alias",
    workerText.replace("export default worker;", "const w = worker;\nexport default worker;"),
  );
  unresolvedCase(
    "binding-passed-to-function",
    workerText.replace(
      "export default worker;",
      "function useWorker(value) { return value; }\nuseWorker(worker);\nexport default worker;",
    ),
  );
  unresolvedCase(
    "binding-shadowed-in-nested-scope",
    workerText.replace(
      "export default worker;",
      "function nestedScope() { const worker = 1; }\nexport default worker;",
    ),
  );
  const mixedDefaultSpecifier = workerText.replace(
    "export default worker;",
    "export { worker, worker as default };",
  );
  const defaultFunctionExport = workerText.replace(
    "export default worker;",
    "export default worker;\nexport default function alternateWorker() { return {}; }",
  );
  const defaultClassExport = workerText.replace(
    "export default worker;",
    "export default worker;\nexport default class AlternateWorker {}",
  );
  const reexportedDefault = workerText.replace(
    "export default worker;",
    "export default worker;\nexport { alternate as default } from \"./other\";",
  );
  unresolvedCase("mixed-default-specifier", mixedDefaultSpecifier);
  unresolvedCase("default-function-export", defaultFunctionExport);
  unresolvedCase("default-class-export", defaultClassExport);
  unresolvedCase("reexported-default-specifier", reexportedDefault);
  unresolvedCase(
    "combined-export-not-resolvable",
    operatorRepair.replace("export default worker;", "export default runtime;"),
  );

  const lookalike = workerStructure(
    baseline.authority,
    withMount('    extraPrefixes: ["/operators"],'),
    "operator-lookalike.ts",
  );
  assert(lookalike.operatorRoutes === "unmounted", "operator-lookalike");
  assert(lookalike.directRuntimeFetch === false, "operator-lookalike");
  assert(lookalike.triggers.length === 0, "operator-lookalike");
  mountCase("operator-lookalike", withMount('    extraPrefixes: ["/operators"],'));
  mountCase("operator-bootstrap-lookalike", withMount('    extraPrefixes: ["/operator-bootstrap"],'));

  checks.push(expectFailure("unresolved-source-shape", () => {
    workerStructure(baseline.authority, withMount('    extraPaths: [...["/health"]],\n    extraPrefixes: ["/maintenance"],'), "unresolved-extra-paths.ts");
    fail("self-test-unresolved-accepted", "extraPaths");
  }));
  checks.push("unresolved-extra-paths");
  checks.push(expectFailure("unresolved-source-shape", () => {
    workerStructure(baseline.authority, withMount("    extraPrefixes: configuredPrefixes,"), "unresolved-extra-prefixes.ts");
    fail("self-test-unresolved-accepted", "extraPrefixes");
  }));
  checks.push("unresolved-extra-prefixes");
  checks.push(expectFailure("unresolved-source-shape", () => {
    workerStructure(
      baseline.authority,
      workerText.replace("  sekiban: {\n", "  sekiban: {\n    ...sekibanMount,\n"),
      "unresolved-sekiban-spread.ts",
    );
    fail("self-test-unresolved-accepted", "sekiban");
  }));
  checks.push("unresolved-sekiban-spread");

  mountCase("flag-true", withFlag("    forwardSerializedRoutes: true,"));
  mountCase("flag-omitted", withFlag(""));
  mountCase("extra-paths-empty", workerText.replace(maintenanceLine, `    extraPaths: [],\n${maintenanceLine}`));
  mountCase(
    "extra-paths-added",
    workerText.replace(maintenanceLine, `    extraPaths: ["/health"],\n${maintenanceLine}`),
  );
  mountCase(
    "extra-paths-serialized",
    workerText.replace(maintenanceLine, `    extraPaths: ["/api/sekiban/serialized/commit"],\n${maintenanceLine}`),
  );
  mountCase("maintenance-omitted", withMount("    extraPrefixes: [],"));
  mountCase("maintenance-duplicated", withMount('    extraPrefixes: ["/maintenance", "/maintenance"],'));
  mountCase("maintenance-added", withMount('    extraPrefixes: ["/maintenance", "/health"],'));
  mountCase("serialized-prefix-exact", withMount('    extraPrefixes: ["/api/sekiban/serialized/commit"],'));
  mountCase("serialized-prefix-ancestor", withMount('    extraPrefixes: ["/api/sekiban/serialized"],'));
  unresolvedCase("flag-identifier", withFlag("    forwardSerializedRoutes: configuredFlag,"));
  unresolvedCase("flag-call", withFlag("    forwardSerializedRoutes: configuredFlag(),"));
  unresolvedCase("flag-shorthand", withFlag("    forwardSerializedRoutes,"));
  unresolvedCase("flag-computed", withFlag('    ["forwardSerializedRoutes"]: false,'));
  unresolvedCase("flag-spread", withFlag("    ...routeShape,"));
  unresolvedCase("prefix-identifier", withMount("    extraPrefixes: configuredPrefixes,"));
  unresolvedCase("prefix-call", withMount("    extraPrefixes: configuredPrefixes(),"));
  unresolvedCase("prefix-shorthand", withMount("    extraPrefixes,"));
  unresolvedCase("prefix-computed", withMount('    ["extraPrefixes"]: ["/maintenance"],'));
  unresolvedCase("prefix-spread", withMount('    extraPrefixes: [...["/maintenance"]],'));
  unresolvedCase(
    "flag-duplicate-false-then-true",
    workerText.replace(flagLine, "    forwardSerializedRoutes: false,\n    forwardSerializedRoutes: true,"),
  );
  unresolvedCase(
    "flag-duplicate-true-then-false",
    workerText.replace(flagLine, "    forwardSerializedRoutes: true,\n    forwardSerializedRoutes: false,"),
  );
  unresolvedCase(
    "prefix-duplicate-maintenance-then-other",
    workerText.replace(
      maintenanceLine,
      '    extraPrefixes: ["/maintenance"],\n    extraPrefixes: ["/other"],',
    ),
  );
  unresolvedCase(
    "prefix-duplicate-other-then-maintenance",
    workerText.replace(
      maintenanceLine,
      '    extraPrefixes: ["/other"],\n    extraPrefixes: ["/maintenance"],',
    ),
  );
  unresolvedCase("root-spread-before", workerText.replace("  sekiban: {\n", "  ...rootMount,\n  sekiban: {\n"));
  unresolvedCase(
    "root-spread-after",
    workerText.replace(
      "    scheduled: runtime.scheduled,\n  },\n});",
      "    scheduled: runtime.scheduled,\n  },\n  ...rootMount,\n});",
    ),
  );
  unresolvedCase("sekiban-computed", workerText.replace("  sekiban: {\n", "  [\"sekiban\"]: {\n"));
  unresolvedCase("sekiban-shorthand", replaceSekiban("  sekiban,"));
  unresolvedCase("sekiban-non-object", replaceSekiban("  sekiban: configuredMount,"));
  const duplicateSekiban = [
    "  sekiban: {",
    "    prefix: \"/internal/sekiban\",",
    "    forwardSerializedRoutes: true,",
    "    extraPrefixes: [\"/other\"],",
    "  },",
  ].join("\n");
  unresolvedCase(
    "sekiban-duplicate-maintenance-then-other",
    workerText.replace(
      "    scheduled: runtime.scheduled,\n  },\n});",
      `    scheduled: runtime.scheduled,\n  },\n${duplicateSekiban}\n});`,
    ),
  );
  unresolvedCase(
    "sekiban-duplicate-other-then-maintenance",
    workerText.replace("  sekiban: {\n", `${duplicateSekiban}\n  sekiban: {\n`),
  );

  const gateSource = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert(gateSource.includes("function assertMaintenanceOnlyMount"), "maintenance-only-inspection");
  assert(gateSource.includes("sekibanAssignments.length !== 1"), "maintenance-only-inspection");
  assert(
    gateSource.includes("assertMaintenanceOnlyMount(structure);\n  assertExternalPrerequisite(structure);"),
    "maintenance-only-parity",
  );
  checks.push("maintenance-only-inspection", "maintenance-only-parity");
  assertRepairBindingNameOnly(gateSource);
  checks.push("repair-binding-name-only");
  checks.push(expectFailure("repair-binding-value-inspection", () => assertRepairBindingNameOnly(
    gateSource.replace(
      "function sanitizeEnvironment(source) {",
      "function sanitizeEnvironment(source) { const leaked = source.REPAIR_OPERATOR_TOKEN; void leaked;",
    ),
  )));
  checks.push(expectFailure("repair-binding-value-inspection", () => assertRepairBindingNameOnly(
    gateSource.replace(
      "function sanitizeEnvironment(source) {",
      "function sanitizeEnvironment(source) { const leaked = source[\"REPAIR_OPERATOR_TOKEN\"]; void leaked;",
    ),
  )));
  checks.push(expectFailure("repair-binding-value-inspection", () => assertRepairBindingNameOnly(
    gateSource.replace(
      "delete env[name];",
      "const leaked = env[name]; void leaked; delete env[name];",
    ),
  )));
  checks.push("repair-binding-value-inspection");

  const repairCanary = "obvious-fake-repair-canary";
  const canaryEnv = {
    REPAIR_OPERATOR_TOKEN: repairCanary,
    CLOUDFLARE_API_TOKEN: repairCanary,
    CLOUDFLARE_ACCOUNT_ID: repairCanary,
    UNRELATED_CONTROL: "kept-control",
  };
  function rejectedGate(mutant) {
    let spawnCalls = 0;
    let text = "";
    const output = captureWrites(() => {
      try {
        runGate(false, {
          sourceOverrides: new Map([[workerPath, mutant]]),
          env: canaryEnv,
          spawn() {
            spawnCalls += 1;
            return { status: 0, stdout: "", stderr: "" };
          },
        });
      } catch (error) {
        text = renderFailure(error);
      }
    });
    return { spawnCalls, text, output };
  }
  const operatorGate = rejectedGate(operatorRepair);
  assert(
    operatorGate.text.includes("deploy-check:generated runtime mount is not maintenance-only"),
    "mount-shape-before-wrangler",
  );
  assert(!operatorGate.text.includes("missing-external-prerequisite"), "mount-shape-before-wrangler");
  assert(operatorGate.spawnCalls === 0, "mount-shape-before-wrangler");
  assert(!operatorGate.text.includes(repairCanary), "canary-redaction");
  assert(
    !operatorGate.output.stdout.includes(repairCanary) && !operatorGate.output.stderr.includes(repairCanary),
    "canary-redaction",
  );
  checks.push("mount-shape-before-wrangler");
  const directGate = rejectedGate(workerText.replace("export default worker;", "export default runtime;"));
  assert(directGate.text.includes("deploy-check:unresolved-source-shape"), "unresolved-export-before-wrangler");
  assert(!directGate.text.includes("missing-external-prerequisite"), "unresolved-export-before-wrangler");
  assert(directGate.spawnCalls === 0, "unresolved-export-before-wrangler");
  assert(!directGate.text.includes(repairCanary), "canary-redaction");
  assert(
    !directGate.output.stdout.includes(repairCanary) && !directGate.output.stderr.includes(repairCanary),
    "canary-redaction",
  );
  checks.push("unresolved-export-before-wrangler");
  const decoyGate = rejectedGate(decoyAfter);
  assert(decoyGate.text.includes("deploy-check:unresolved-source-shape"), "decoy-before-wrangler");
  assert(!decoyGate.text.includes("generated runtime mount is not maintenance-only"), "decoy-before-wrangler");
  assert(decoyGate.spawnCalls === 0, "decoy-before-wrangler");
  assert(!decoyGate.text.includes(repairCanary), "canary-redaction");
  assert(
    !decoyGate.output.stdout.includes(repairCanary) && !decoyGate.output.stderr.includes(repairCanary),
    "canary-redaction",
  );
  checks.push("decoy-before-wrangler");
  const memberGate = rejectedGate(bindingMemberMutation);
  assert(memberGate.text.includes("deploy-check:unresolved-source-shape"), "member-mutation-before-wrangler");
  assert(memberGate.spawnCalls === 0, "member-mutation-before-wrangler");
  assert(!memberGate.text.includes(repairCanary), "canary-redaction");
  checks.push("member-mutation-before-wrangler");
  const duplicateDefaultGate = rejectedGate(duplicateDefaultExport);
  assert(
    duplicateDefaultGate.text.includes("deploy-check:unresolved-source-shape"),
    "duplicate-default-before-wrangler",
  );
  assert(duplicateDefaultGate.spawnCalls === 0, "duplicate-default-before-wrangler");
  assert(!duplicateDefaultGate.text.includes(repairCanary), "canary-redaction");
  checks.push("duplicate-default-before-wrangler");
  const mixedGate = rejectedGate(mixedDefaultSpecifier);
  assert(mixedGate.text.includes("deploy-check:unresolved-source-shape"), "mixed-specifier-before-wrangler");
  assert(mixedGate.spawnCalls === 0, "mixed-specifier-before-wrangler");
  assert(!mixedGate.text.includes(repairCanary), "canary-redaction");
  checks.push("mixed-specifier-before-wrangler");
  const defaultFunctionGate = rejectedGate(defaultFunctionExport);
  assert(
    defaultFunctionGate.text.includes("deploy-check:unresolved-source-shape"),
    "default-function-before-wrangler",
  );
  assert(defaultFunctionGate.spawnCalls === 0, "default-function-before-wrangler");
  assert(!defaultFunctionGate.text.includes(repairCanary), "canary-redaction");
  checks.push("default-function-before-wrangler");
  const defaultClassGate = rejectedGate(defaultClassExport);
  assert(defaultClassGate.text.includes("deploy-check:unresolved-source-shape"), "default-class-before-wrangler");
  assert(defaultClassGate.spawnCalls === 0, "default-class-before-wrangler");
  assert(!defaultClassGate.text.includes(repairCanary), "canary-redaction");
  checks.push("default-class-before-wrangler");

  let capturedEnv;
  const successOutput = captureWrites(() => {
    runGate(false, {
      env: canaryEnv,
      spawn(_command, spawnArgs, spawnOptions) {
        capturedEnv = spawnOptions.env;
        const outfile = spawnArgs[spawnArgs.indexOf("--outfile") + 1];
        writeFileSync(outfile, "create-room\nreserve-room\n");
        return { status: 0, stdout: "", stderr: "" };
      },
    });
  });
  assert(capturedEnv !== undefined, "spawn-environment");
  assert(!Object.hasOwn(capturedEnv, "REPAIR_OPERATOR_TOKEN"), "spawn-environment");
  assert(!Object.hasOwn(capturedEnv, "CLOUDFLARE_API_TOKEN"), "spawn-environment");
  assert(!Object.hasOwn(capturedEnv, "CLOUDFLARE_ACCOUNT_ID"), "spawn-environment");
  assert(capturedEnv.UNRELATED_CONTROL === "kept-control", "spawn-environment");
  const successReceipt = JSON.parse(successOutput.stdout);
  assert(successReceipt.runtimeExposure.operatorRoutes === "unmounted", "receipt-shape");
  assert(successReceipt.runtimeExposure.directRuntimeFetch === false, "receipt-shape");
  assert(successReceipt.runtimeExposure.serializedRoutes === "unmounted", "receipt-shape");
  assert(canonical(Object.keys(successReceipt.runtimeExposure).sort()) === canonical([
    "directRuntimeFetch",
    "operatorRoutes",
    "serializedRoutes",
  ]), "receipt-shape");
  assert(canonical(successReceipt.externalPrerequisites) === canonical([{
    name: "REPAIR_OPERATOR_TOKEN",
    required: false,
    verification: "external",
    remoteStateChecked: false,
  }]), "receipt-shape");
  for (const name of removedCredentialVariables) {
    assert(successReceipt.removedCredentialVariables.includes(name), "receipt-shape");
  }
  assert(!successOutput.stdout.includes(repairCanary), "canary-redaction");
  assert(!successOutput.stderr.includes(repairCanary), "canary-redaction");
  assert(!JSON.stringify(successReceipt).includes(repairCanary), "canary-redaction");
  checks.push("spawn-environment", "receipt-shape", "canary-redaction");

  const serialized = JSON.stringify({ result: "deploy-check-self-test-passed", checks });
  assert(!serialized.includes(repairCanary), "canary-redaction");
  process.stdout.write(`${serialized}\n`);
}

try {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    assert(args.length === 1, "usage", "deploy-check --self-test");
    selfTest();
  } else {
    assert(args.every((arg) => arg === "--require-configured"), "usage");
    runGate(args.includes("--require-configured"));
  }
} catch (error) {
  process.stderr.write(renderFailure(error));
  process.exitCode = 1;
}
