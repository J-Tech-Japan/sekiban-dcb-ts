#!/usr/bin/env node
/* global process, structuredClone */

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
        if (keys.has(key)) fail("duplicate-key", keyPath);
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
  for (const value of values) {
    if (seen.has(value)) fail("duplicate-collection-key", `${path}[${value}]`);
    seen.add(value);
  }
}

function validateAuthority(authority) {
  object(authority, "$", ["schema", "worker", "d1", "queues", "durableObjects", "assets", "triggers", "vars", "secrets"]);
  assert(authority.schema === "sekiban-create-dcb/deployment-topology/v1", "authority-schema", authority.schema);
  const worker = object(authority.worker, "$.worker", ["name", "entrypoint"]);
  string(worker.name, "$.worker.name");
  string(worker.entrypoint, "$.worker.entrypoint");

  const d1 = array(authority.d1, "$.d1");
  unique(d1.map((entry) => entry?.binding), "$.d1.binding");
  for (const [index, entry] of d1.entries()) {
    object(entry, `$.d1[${index}]`, ["binding", "databaseName", "idPlaceholder", "placeholderPath", "migrationsDir", "creationCommand", "replacement"]);
    for (const key of ["binding", "databaseName", "idPlaceholder", "placeholderPath", "migrationsDir", "creationCommand", "replacement"]) {
      string(entry[key], `$.d1[${index}].${key}`);
    }
  }
  assert(d1.length === 2, "authority-d1-count", String(d1.length));

  const queues = object(authority.queues, "$.queues", ["producers", "consumers", "creation"]);
  const producers = array(queues.producers, "$.queues.producers");
  unique(producers.map((entry) => entry?.binding), "$.queues.producers.binding");
  for (const [index, entry] of producers.entries()) {
    object(entry, `$.queues.producers[${index}]`, ["binding", "queue"]);
    string(entry.binding, `$.queues.producers[${index}].binding`);
    string(entry.queue, `$.queues.producers[${index}].queue`);
  }
  const consumers = array(queues.consumers, "$.queues.consumers");
  unique(consumers.map((entry) => entry?.queue), "$.queues.consumers.queue");
  for (const [index, entry] of consumers.entries()) {
    object(entry, `$.queues.consumers[${index}]`, ["queue", "maxBatchTimeout", "maxRetries", "deadLetterQueue"]);
    string(entry.queue, `$.queues.consumers[${index}].queue`);
    assert(Number.isInteger(entry.maxBatchTimeout), "authority-shape", `$.queues.consumers[${index}].maxBatchTimeout`);
    assert(Number.isInteger(entry.maxRetries), "authority-shape", `$.queues.consumers[${index}].maxRetries`);
    string(entry.deadLetterQueue, `$.queues.consumers[${index}].deadLetterQueue`);
  }
  const creation = array(queues.creation, "$.queues.creation");
  unique(creation.map((entry) => entry?.kind), "$.queues.creation.kind");
  for (const [index, entry] of creation.entries()) {
    object(entry, `$.queues.creation[${index}]`, ["kind", "name", "command"]);
    string(entry.kind, `$.queues.creation[${index}].kind`);
    string(entry.name, `$.queues.creation[${index}].name`);
    string(entry.command, `$.queues.creation[${index}].command`);
  }
  assert(producers.length === 1 && consumers.length === 1 && creation.length === 2, "authority-queue-count");

  const durableObjects = object(authority.durableObjects, "$.durableObjects", ["bindings", "migrations"]);
  const bindings = array(durableObjects.bindings, "$.durableObjects.bindings");
  unique(bindings.map((entry) => entry?.name), "$.durableObjects.bindings.name");
  for (const [index, entry] of bindings.entries()) {
    object(entry, `$.durableObjects.bindings[${index}]`, ["name", "className"]);
    string(entry.name, `$.durableObjects.bindings[${index}].name`);
    string(entry.className, `$.durableObjects.bindings[${index}].className`);
  }
  const migrations = array(durableObjects.migrations, "$.durableObjects.migrations");
  unique(migrations.map((entry) => entry?.tag), "$.durableObjects.migrations.tag");
  for (const [index, entry] of migrations.entries()) {
    object(entry, `$.durableObjects.migrations[${index}]`, ["tag", "newSqliteClasses"]);
    string(entry.tag, `$.durableObjects.migrations[${index}].tag`);
    const classes = array(entry.newSqliteClasses, `$.durableObjects.migrations[${index}].newSqliteClasses`);
    assert(classes.length > 0, "authority-shape", `$.durableObjects.migrations[${index}].newSqliteClasses`);
    classes.forEach((value, classIndex) => string(value, `$.durableObjects.migrations[${index}].newSqliteClasses[${classIndex}]`));
    unique(classes, `$.durableObjects.migrations[${index}].newSqliteClasses`);
  }
  assert(bindings.length === 5 && migrations.length === 3, "authority-do-count");

  const assets = object(authority.assets, "$.assets", ["directory", "binding", "bindingStatus"]);
  string(assets.directory, "$.assets.directory");
  string(assets.binding, "$.assets.binding");
  assert(assets.bindingStatus === "unused", "authority-assets-status", assets.bindingStatus);
  const triggers = object(authority.triggers, "$.triggers", ["crons"]);
  const crons = array(triggers.crons, "$.triggers.crons");
  crons.forEach((value, index) => string(value, `$.triggers.crons[${index}]`));
  unique(crons, "$.triggers.crons");
  assert(crons.length > 0, "authority-cron-count");
  for (const secret of authority.secrets ?? []) {
    if (secret?.name && Object.hasOwn(authority.vars ?? {}, secret.name)) fail("secret-in-vars", secret.name);
  }
  const vars = object(authority.vars, "$.vars", ["DOMAIN_DELIVERY_CLASS", "SDT_SERVICE_ID"]);
  for (const [key, value] of Object.entries(vars)) string(value, `$.vars.${key}`);
  const secrets = array(authority.secrets, "$.secrets");
  unique(secrets.map((entry) => entry?.name), "$.secrets.name");
  for (const [index, entry] of secrets.entries()) {
    object(entry, `$.secrets[${index}]`, ["name", "optional", "ownership", "forbiddenIn"]);
    string(entry.name, `$.secrets[${index}].name`);
    assert(typeof entry.optional === "boolean", "authority-shape", `$.secrets[${index}].optional`);
    string(entry.ownership, `$.secrets[${index}].ownership`);
    assert(entry.forbiddenIn === "vars", "authority-secret-boundary", `$.secrets[${index}].forbiddenIn`);
    assert(!Object.hasOwn(vars, entry.name), "secret-in-vars", entry.name);
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
  const expectedSecrets = new Set(authority.secrets.map((entry) => entry.name));
  for (const name of Object.keys(config.vars ?? {})) assert(!expectedSecrets.has(name), "secret-in-vars", name);
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

function placeholderEntries(authority, config, allowConfigured = false) {
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
  if (allowConfigured && found.length === 0) return found;
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
  let composition = false;
  const handlers = { application: false, fetch: false, queue: false, scheduled: false };
  function visit(node) {
    if (ts.isExportDeclaration(node) && node.moduleSpecifier?.text === "@sekiban/dcb-cloudflare" && ts.isNamedExports(node.exportClause)) {
      for (const specifier of node.exportClause.elements) exports.push((specifier.propertyName ?? specifier.name).text);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === "createCloudflareOnlyRuntimeWorker") composition = true;
      if (node.expression.text === "composeHandlers") {
        const root = node.arguments[0];
        const properties = root && ts.isObjectLiteralExpression(root) ? root.properties : [];
        for (const property of properties) {
          if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
          if (property.name.text === "application") {
            handlers.application = true;
            handlers.fetch = propertyNames(property.initializer).includes("fetch");
          }
          if (property.name.text === "sekiban") {
            for (const name of propertyNames(property.initializer)) {
              if (name === "fetch") handlers.fetch = true;
              if (name === "queue") handlers.queue = true;
              if (name === "scheduled") handlers.scheduled = true;
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(worker);
  return { exports: exports.sort(), expectedClasses, composition, handlers };
}

function sourceParity(authority) {
  const workerPath = join(project, authority.worker.entrypoint);
  assert(existsSync(workerPath), "worker-source-missing", authority.worker.entrypoint);
  const structure = workerStructure(authority, readFileSync(workerPath, "utf8"), authority.worker.entrypoint);
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
    const parsed = sourceFile(name, readFileSync(path, "utf8"));
    function inspect(node) {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "env") reads.add(node.name.text);
      ts.forEachChild(node, inspect);
    }
    inspect(parsed);
  }
  for (const name of reads) assert(declared.has(name) || optionalUnused.has(name), "worker-undeclared-read", name);
  return { exportedClasses: structure.expectedClasses, runtimeComposition: true, handlers: ["fetch", "queue", "scheduled"], optionalAssets: "unused" };
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
  unique(rows.map((row) => `${row.kind}|${row.key}`), "runbook.rows");
  return rows;
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
  return { rows: actual.length, creationCommands: commands.length };
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
    assert(result.status === 0, "wrangler-dry-run", `${result.stdout ?? ""}${result.stderr ?? ""}`.trim());
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
  checks.push(expectFailure("queue-producer-parity", () => validate(
    mutate((candidate) => candidate.config.queues.producers.push(
      structuredClone(candidate.config.queues.producers[0]),
    )),
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
    mutate((candidate) => candidate.authority.durableObjects.migrations.push(
      structuredClone(candidate.authority.durableObjects.migrations[0]),
    )).authority,
  )));
  checks.push(expectFailure("secret-in-vars", () => validateAuthority(
    mutate((candidate) => { candidate.authority.vars.INCIDENT_MAINTAINER_TOKEN = "bad"; }).authority,
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
    assert(structure.handlers.application && structure.handlers.fetch && structure.handlers.queue && structure.handlers.scheduled, "worker-handler-registration");
  }));
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
  checks.push(expectFailure("worker-undeclared-read", () => {
    const source = sourceFile("mutant.ts", "const value = env.NOT_IN_AUTHORITY;");
    const reads = [];
    function visit(node) { if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "env") reads.push(node.name.text); ts.forEachChild(node, visit); }
    visit(source);
    assert(reads.every((name) => Object.hasOwn(baseline.authority.vars, name)), "worker-undeclared-read", reads[0]);
  }));
  checks.push(expectFailure("command-without-dry-run", () => safeArgs(["deploy", "--config", "wrangler.jsonc"])));
  checks.push(expectFailure("remote-command-vector", () => safeArgs(["deploy", "--config", "wrangler.jsonc", "--dry-run", "--outdir", "x", "--outfile", "y", "login"])));
  checks.push(expectFailure("cf-dependency", () => validateNoCfDependency({ dependencies: { cf: "1.0.0" } }, "")));
  checks.push(expectFailure("cf-gate-invocation", () => validateNoCfDependency({}, "spawnSync(\"cf\", [])")));
  const green = validateProject(baseline);
  assert(green.placeholders.length === 2, "self-test-green-placeholder-count");
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
