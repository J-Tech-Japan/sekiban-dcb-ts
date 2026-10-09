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

function stripJsonc(source) {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (inString) {
      result += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      result += current;
    } else if (current === "/" && next === "/") {
      const newline = source.indexOf("\n", index + 2);
      if (newline < 0) break;
      result += "\n";
      index = newline;
    } else if (current === "/" && next === "*") {
      const closing = source.indexOf("*/", index + 2);
      assert(closing >= 0, "jsonc-parse", "unterminated block comment");
      result += " ";
      index = closing + 1;
    } else {
      result += current;
    }
  }
  return result;
}

function scanDuplicateKeys(source, label) {
  const text = stripJsonc(source);
  let index = 0;

  function whitespace() {
    while (/\s/.test(text[index] ?? "")) index += 1;
  }

  function string() {
    const start = index;
    index += 1;
    let escaped = false;
    while (index < text.length) {
      const current = text[index++];
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') return JSON.parse(text.slice(start, index));
    }
    fail("jsonc-parse", `${label} has an unterminated string`);
  }

  function value(path) {
    whitespace();
    const current = text[index];
    if (current === "{") {
      index += 1;
      const keys = new Set();
      whitespace();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      while (index < text.length) {
        whitespace();
        assert(text[index] === '"', "jsonc-parse", `${label}${path} expected an object key`);
        const key = string();
        const keyPath = `${path}.${key}`;
        if (keys.has(key)) fail("duplicate-collection-key", path);
        keys.add(key);
        whitespace();
        assert(text[index] === ":", "jsonc-parse", `${keyPath} is missing a colon`);
        index += 1;
        value(keyPath);
        whitespace();
        if (text[index] === "}") {
          index += 1;
          return;
        }
        assert(text[index] === ",", "jsonc-parse", `${path} expected a comma`);
        index += 1;
      }
    } else if (current === "[") {
      index += 1;
      let item = 0;
      whitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      while (index < text.length) {
        value(`${path}[${item}]`);
        item += 1;
        whitespace();
        if (text[index] === "]") {
          index += 1;
          return;
        }
        assert(text[index] === ",", "jsonc-parse", `${path} expected a comma`);
        index += 1;
      }
    } else if (current === '"') {
      string();
    } else {
      const start = index;
      while (index < text.length && !/[\s,}\]]/.test(text[index])) index += 1;
      assert(index > start, "jsonc-parse", `${path} has an empty value`);
    }
  }

  value("$");
  whitespace();
  assert(index === text.length, "jsonc-parse", `${label} has trailing content`);
}

function parseJsonc(source, label) {
  scanDuplicateKeys(source, label);
  try {
    return JSON.parse(stripJsonc(source).replace(/,\s*([}\]])/g, "$1"));
  } catch (error) {
    fail("jsonc-parse", `${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function object(value, path, keys) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "authority-shape", `${path} must be an object`);
  const actual = Object.keys(value).sort();
  const allowed = [...keys].sort();
  assert(JSON.stringify(actual) === JSON.stringify(allowed), "authority-key", `${path} keys are ${actual.join(",")}`);
  return value;
}

function string(value, path) {
  assert(typeof value === "string" && value.length > 0, "authority-shape", `${path} must be a non-empty string`);
  return value;
}

function array(value, path) {
  assert(Array.isArray(value), "authority-shape", `${path} must be an array`);
  return value;
}

function unique(values, path) {
  const seen = new Set();
  values.forEach((value, index) => {
    if (seen.has(value)) fail("duplicate-collection-key", `${path}[${index}]`);
    seen.add(value);
  });
}

function uniqueEntries(entries, identity, path) {
  unique(entries.map(identity), path);
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
  const secrets = array(authority.secrets, "$.secrets");
  for (const [index, entry] of secrets.entries()) {
    object(entry, `$.secrets[${index}]`, ["name", "optional", "ownership", "forbiddenIn"]);
    string(entry.name, `$.secrets[${index}].name`);
    assert(typeof entry.optional === "boolean", "authority-shape", `$.secrets[${index}].optional`);
    string(entry.ownership, `$.secrets[${index}].ownership`);
    assert(entry.forbiddenIn === "vars", "authority-secret-boundary", `$.secrets[${index}].forbiddenIn`);
    assert(!Object.hasOwn(vars, entry.name), "secret-in-vars");
  }
  return authority;
}

function canonical(value) {
  return JSON.stringify(value);
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
  for (const [kind, reason] of kinds) {
    const expectedRows = expected.filter((row) => row.kind === kind).sort((a, b) => canonical(a).localeCompare(canonical(b)));
    const actualRows = actual.filter((row) => row.kind === kind).sort((a, b) => canonical(a).localeCompare(canonical(b)));
    assert(canonical(expectedRows) === canonical(actualRows), reason);
  }
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

function workerStructure(authority, source, label) {
  const worker = sourceFile(label, source);
  const expectedClasses = authority.durableObjects.bindings.map((entry) => entry.className).sort();
  const exports = [];
  let composedWorker = null;
  let exportedWorker = false;
  const runtimeDeclarations = new Map();
  const handlers = { application: false, fetch: false, queue: false, scheduled: false };
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
  function visit(node) {
    if (ts.isExportDeclaration(node) && node.moduleSpecifier?.text === "@sekiban/dcb-cloudflare" && ts.isNamedExports(node.exportClause)) {
      for (const specifier of node.exportClause.elements) exports.push((specifier.propertyName ?? specifier.name).text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.name.text === "worker" && node.initializer && ts.isCallExpression(node.initializer) &&
          ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === "composeHandlers") {
        composedWorker = node.initializer;
      }
      if (node.initializer && containsCall(node.initializer, "createCloudflareOnlyRuntimeWorker")) {
        runtimeDeclarations.set(node.name.text, node.initializer);
      }
    }
    if (ts.isExportAssignment(node) && !node.isExportEquals && ts.isIdentifier(node.expression) &&
        node.expression.text === "worker") {
      exportedWorker = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(worker);
  const runtimeNames = new Set(runtimeDeclarations.keys());
  const root = composedWorker?.arguments[0];
  const properties = root && ts.isObjectLiteralExpression(root) ? root.properties : [];
  for (const property of properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
    if (property.name.text === "application") {
      handlers.application = true;
      handlers.fetch = propertyNames(property.initializer).includes("fetch");
    }
    if (property.name.text === "sekiban" && ts.isObjectLiteralExpression(property.initializer)) {
      for (const entry of property.initializer.properties) {
        if (!ts.isPropertyAssignment(entry) || !ts.isIdentifier(entry.name)) continue;
        if (entry.name.text === "fetch") handlers.fetch = runtimeProperty(entry.initializer, runtimeNames, "fetch");
        if (entry.name.text === "queue") handlers.queue = runtimeProperty(entry.initializer, runtimeNames, "queue");
        if (entry.name.text === "scheduled") {
          handlers.scheduled = runtimeProperty(entry.initializer, runtimeNames, "scheduled");
        }
      }
    }
  }
  let composedUsesRuntime = false;
  function inspectComposed(node) {
    if (ts.isIdentifier(node) && runtimeNames.has(node.text)) composedUsesRuntime = true;
    if (!composedUsesRuntime) ts.forEachChild(node, inspectComposed);
  }
  if (composedWorker) inspectComposed(composedWorker);
  const composition = exportedWorker && composedWorker !== null && composedUsesRuntime;
  return { exports: exports.sort(), expectedClasses, composition, handlers };
}

function sourceParity(authority, overrides = new Map()) {
  const workerPath = join(project, authority.worker.entrypoint);
  assert(existsSync(workerPath), "worker-source-missing", authority.worker.entrypoint);
  const readSource = (path) => overrides.get(path) ?? readFileSync(path, "utf8");
  const structure = workerStructure(authority, readSource(workerPath), authority.worker.entrypoint);
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

function validateProject({ authority, config, runbook, requireConfigured = false }) {
  validateAuthority(authority);
  compareTopology(authority, config);
  const migrations = migrationCounts(authority);
  const placeholders = configuredD1Ids(authority, config, requireConfigured);
  const source = sourceParity(authority);
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
  for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
    if (name in env) removed.push(name);
    delete env[name];
  }
  return { env, removed };
}

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
  return {
    command: ["deploy", "--config", "wrangler.jsonc", "--dry-run", "--outdir", "<owned-temp-dir>", "--outfile", "<owned-temp-dir>/worker.js"],
    topology: expectedTopology(readProject().authority).sort((a, b) => canonical(a).localeCompare(canonical(b))),
    migrationFileCounts: validation.migrations,
    placeholders: {
      status: placeholders.length === 0 ? "configured" : "fresh-template",
      locations,
    },
    bundle: { projectLocalWrangler: true, dryRun: true, createRoom: true, reserveRoom: true },
    removedCredentialVariables: removedCredentials,
  };
}

function runGate(requireConfigured) {
  const validation = validateProject({ ...readProject(), requireConfigured });
  const outdir = mkdtempSync(join(tmpdir(), "create-dcb-deploy-check-"));
  const outfile = join(outdir, "worker.js");
  const args = ["deploy", "--config", "wrangler.jsonc", "--dry-run", "--outdir", outdir, "--outfile", outfile];
  try {
    safeArgs(args);
    const wrangler = join(project, "node_modules/wrangler/bin/wrangler.js");
    assert(existsSync(wrangler), "project-local-wrangler-missing");
    const sanitized = sanitizeEnvironment({ ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" });
    const env = sanitized.env;
    const removedCredentials = sanitized.removed;
    const result = spawnSync(process.execPath, [wrangler, ...args], { cwd: project, env, encoding: "utf8", shell: false, maxBuffer: 64 * 1024 * 1024 });
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
  const inherited = { CLOUDFLARE_API_TOKEN: "canary", CLOUDFLARE_ACCOUNT_ID: "canary", KEEP: "yes" };
  const sanitized = sanitizeEnvironment(inherited);
  assert(!Object.hasOwn(sanitized.env, "CLOUDFLARE_API_TOKEN") && !Object.hasOwn(sanitized.env, "CLOUDFLARE_ACCOUNT_ID") && sanitized.env.KEEP === "yes", "credential-sanitization");
  assert(canonical(sanitized.removed) === canonical(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]), "credential-sanitization");
  checks.push("fresh-template-control", "credential-sanitization");
  process.stdout.write(`${JSON.stringify({ result: "deploy-check-self-test-passed", checks }, null, 2)}\n`);
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
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
