#!/usr/bin/env node

/**
 * Apply the committed G32/G44 D1 DDL to one remote database without replaying
 * already-present objects. This is deliberately a migration applicator, not a
 * replacement sampler: it reads the repository SQL and uses sqlite_master plus
 * table-valued PRAGMA metadata as the idempotence boundary.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

function fail(message) {
  throw new Error(`g37-d1-migrations: ${message}`);
}

function parseArgs(argv) {
  const options = { migrations: [], dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (argument === "--migration") {
      options.migrations.push(requiredValue(argv, ++index, argument));
      continue;
    }
    if (["--wrangler", "--config", "--database", "--output"].includes(argument)) {
      options[argument.slice(2).replaceAll("-", "_")] = requiredValue(argv, ++index, argument);
      continue;
    }
    fail(`unknown argument ${JSON.stringify(argument)}`);
  }
  for (const key of ["wrangler", "config", "database", "output"]) {
    if (!options[key]) fail(`${key} is required`);
  }
  if (options.migrations.length === 0) fail("at least one --migration is required");
  return options;
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) fail(`${option} requires a value`);
  return value;
}

function splitStatements(sql) {
  return sql
    .replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function unquote(identifier) {
  if (identifier.startsWith('"') && identifier.endsWith('"')) {
    return identifier.slice(1, -1).replaceAll('""', '"');
  }
  if (identifier.startsWith("`") && identifier.endsWith("`")) {
    return identifier.slice(1, -1).replaceAll("``", "`");
  }
  if (identifier.startsWith("[") && identifier.endsWith("]")) return identifier.slice(1, -1);
  return identifier;
}

function objectName(value) {
  return unquote(value.trim());
}

function classify(statement, migration) {
  let match = statement.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)/i);
  if (match) return { kind: "table", name: objectName(match[1]), migration, statement };

  match = statement.match(/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)/i);
  if (match) return { kind: "index", name: objectName(match[1]), migration, statement };

  match = statement.match(/^ALTER\s+TABLE\s+([^\s]+)\s+ADD\s+COLUMN\s+([^\s]+)/i);
  if (match) {
    return {
      kind: "column",
      table: objectName(match[1]),
      name: objectName(match[2]),
      migration,
      statement,
    };
  }

  fail(`unsupported DDL in ${migration}: ${statement}`);
}

function runWrangler(options, args, label) {
  const result = spawnSync(options.wrangler, args, {
    cwd: resolve(process.cwd()),
    encoding: "utf8",
    env: { ...process.env, WRANGLER_WRITE_LOGS: "false" },
  });
  if (result.error) fail(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    fail(`${label} exited ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

function parseJson(stdout, label) {
  const cleaned = stdout.replace(ANSI_ESCAPE, "").trim();
  if (!cleaned) fail(`${label} returned no JSON`);
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    fail(`${label} returned invalid JSON: ${error.message}`);
  }
}

function rows(stdout, label) {
  const payload = parseJson(stdout, label);
  if (!Array.isArray(payload)) fail(`${label} JSON was not a result array`);
  return payload.flatMap((result) => {
    if (result?.success !== true) fail(`${label} reported unsuccessful result`);
    return Array.isArray(result.results) ? result.results : [];
  });
}

function executeJson(options, command, label) {
  return rows(
    runWrangler(
      options,
      [
        "d1",
        "execute",
        options.database,
        "--remote",
        "--json",
        "--yes",
        "--config",
        resolve(options.config),
        "--command",
        command,
      ],
      label,
    ),
    label,
  );
}

function readSchema(options) {
  const catalog = executeJson(
    options,
    "SELECT type, name, tbl_name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY type, name",
    `${options.database} catalog read`,
  );
  const columns = executeJson(
    options,
    "SELECT name FROM pragma_table_info('dcb_events') ORDER BY cid",
    `${options.database} dcb_events columns read`,
  );
  return {
    objects: new Set(catalog.map((row) => `${row.type}:${row.name}`)),
    columns: new Set(columns.map((row) => row.name)),
  };
}

function isPresent(schema, requirement) {
  if (requirement.kind === "column") {
    return schema.columns.has(requirement.name);
  }
  return schema.objects.has(`${requirement.kind}:${requirement.name}`);
}

function requirementLabel(requirement) {
  return requirement.kind === "column"
    ? `column ${requirement.table}.${requirement.name}`
    : `${requirement.kind} ${requirement.name}`;
}

function migrationPath(path) {
  return resolve(path);
}

function apply(options) {
  const before = readSchema(options);
  const pending = [];
  const migrationResults = [];
  const planned = {
    objects: new Set(before.objects),
    columns: new Set(before.columns),
  };

  for (const path of options.migrations) {
    const absolutePath = migrationPath(path);
    const source = readFileSync(absolutePath, "utf8");
    const statements = splitStatements(source).map((statement) => classify(statement, path));
    const applied = [];
    const skipped = [];
    for (const requirement of statements) {
      if (isPresent(planned, requirement)) {
        skipped.push(requirementLabel(requirement));
        continue;
      }
      pending.push(requirement);
      applied.push(requirementLabel(requirement));
      if (requirement.kind === "column") planned.columns.add(requirement.name);
      else planned.objects.add(`${requirement.kind}:${requirement.name}`);
    }
    migrationResults.push({
      path,
      statementCount: statements.length,
      pendingStatements: applied.length,
      skippedStatements: skipped.length,
      pending: applied,
      skipped,
    });
  }

  let executed = false;
  if (pending.length > 0 && !options.dryRun) {
    const tempRoot = mkdtempSync(join(tmpdir(), "sdt-g37-d1-migrations-"));
    const sqlPath = join(tempRoot, "pending.sql");
    try {
      writeFileSync(sqlPath, `${pending.map((requirement) => `${requirement.statement};`).join("\n")}\n`, { mode: 0o600 });
      runWrangler(
        options,
        [
          "d1",
          "execute",
          options.database,
          "--remote",
          "--json",
          "--yes",
          "--config",
          resolve(options.config),
          "--file",
          sqlPath,
        ],
        `${options.database} migration apply`,
      );
      executed = true;
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  const after = options.dryRun ? before : readSchema(options);
  const missingAfterApply = [];
  for (const requirement of pending) {
    if (!isPresent(after, requirement)) missingAfterApply.push(requirementLabel(requirement));
  }
  if (missingAfterApply.length > 0 && !options.dryRun) {
    fail(`${options.database} post-apply verification is missing ${missingAfterApply.join(", ")}`);
  }

  const requiredObjects = [...new Set([...before.objects, ...planned.objects])]
    .filter((value) => value.startsWith("table:") || value.startsWith("index:"))
    .sort();
  const requiredColumns = [...planned.columns].sort();
  return {
    schema: "sdt-g37-d1-migrations/v1",
    database: options.database,
    remote: true,
    dryRun: options.dryRun,
    executed,
    migrations: migrationResults,
    verification: {
      requiredObjectCount: requiredObjects.length,
      requiredColumnCount: requiredColumns.length,
      pendingVerified: options.dryRun ? "not-run" : missingAfterApply.length === 0,
      pendingMissing: missingAfterApply,
      relevantObjects: requiredObjects.filter((value) =>
        value.includes("dcb_events")
        || value.includes("serialized_dcb_")
        || value === "table:d1_migrations",
      ),
      dcbEventsColumns: requiredColumns,
    },
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = apply(options);
  writeFileSync(resolve(options.output), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
