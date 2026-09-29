import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface D1Declaration {
  binding: string;
  databaseName: string;
  databaseId?: string;
  migrationsDir?: string;
  migrationsTable?: string;
}

export interface WranglerConfig {
  d1: D1Declaration[];
  accountId?: string;
}

export interface CloudflareSpawnRequest {
  command: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface CloudflareCommandPlan extends CloudflareSpawnRequest {
  backend: "wrangler" | "cf";
  plannedCommand: readonly string[];
}

interface PlanOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const CF_HELPER_MARKER = "d1-migrations";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CF_INSTALL_HINT = "cf executable not found; install cf with `npm i -g cf` or `npm i -D cf` (cf needs node >=22)";

export function parseWranglerConfig(text: string): WranglerConfig {
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const parsed = JSON.parse(stripped) as {
    account_id?: unknown;
    d1_databases?: unknown;
  };
  if (!Array.isArray(parsed.d1_databases) || parsed.d1_databases.length === 0) {
    throw new Error("no-d1");
  }
  if (parsed.account_id !== undefined && typeof parsed.account_id !== "string") {
    throw new Error("invalid-account-id");
  }
  const d1: D1Declaration[] = [];
  for (const entry of parsed.d1_databases) {
    if (typeof entry !== "object" || entry === null) throw new Error("no-d1");
    const record = entry as {
      binding?: unknown;
      database_name?: unknown;
      database_id?: unknown;
      migrations_dir?: unknown;
      migrations_table?: unknown;
    };
    if (typeof record.binding !== "string" || record.binding.length === 0) throw new Error("no-d1");
    if (typeof record.database_name !== "string" || record.database_name.length === 0) throw new Error("no-d1");
    if (record.database_id !== undefined && typeof record.database_id !== "string") throw new Error("invalid-database-id");
    if (record.migrations_dir !== undefined && typeof record.migrations_dir !== "string") throw new Error("invalid-migrations-dir");
    if (record.migrations_table !== undefined && typeof record.migrations_table !== "string") throw new Error("invalid-migrations-table");
    d1.push({
      binding: record.binding,
      databaseName: record.database_name,
      ...(record.database_id === undefined ? {} : { databaseId: record.database_id }),
      ...(record.migrations_dir === undefined ? {} : { migrationsDir: record.migrations_dir }),
      ...(record.migrations_table === undefined ? {} : { migrationsTable: record.migrations_table }),
    });
  }
  return {
    d1,
    ...(parsed.account_id === undefined ? {} : { accountId: parsed.account_id }),
  };
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${name}`);
  return value;
}

interface ParsedArguments {
  backend: "wrangler" | "cf";
  command: string | undefined;
  flags: string[];
  extra: string[];
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const split = argv.indexOf("--");
  const before = split < 0 ? [...argv] : [...argv.slice(0, split)];
  const extra = split < 0 ? [] : [...argv.slice(split + 1)];
  let backend: "wrangler" | "cf" = "wrangler";
  let cliSeen = false;
  const flags: string[] = [];
  for (let index = 0; index < before.length; index += 1) {
    const argument = before[index];
    if (argument !== "--cli") {
      flags.push(argument);
      continue;
    }
    if (cliSeen) throw new Error("repeated --cli is not allowed");
    cliSeen = true;
    const value = before[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error("--cli requires a value: use --cli wrangler or --cli cf");
    if (value !== "wrangler" && value !== "cf") throw new Error(`unsupported --cli value ${value}; use wrangler or cf`);
    backend = value;
    index += 1;
  }
  return { backend, command: flags[0], flags, extra };
}

function validateCfArguments(parsed: ParsedArguments, configPath: string | undefined): asserts parsed is ParsedArguments & { command: "migrate" } {
  if (parsed.command !== "migrate") throw new Error("--cli cf is supported only for migrate; deploy remains a Wrangler operation");
  if (configPath === undefined) throw new Error("--cli cf requires --config <path>");
  if (parsed.extra.length > 0) throw new Error("--cli cf refuses arguments after --");
  const seen = new Set<string>();
  for (let index = 1; index < parsed.flags.length; index += 1) {
    const argument = parsed.flags[index];
    if (!argument.startsWith("--")) throw new Error(`--cli cf refuses unexpected argument ${argument}`);
    if (seen.has(argument)) throw new Error(`--cli cf refuses repeated flag ${argument}`);
    seen.add(argument);
    if (argument !== "--config") {
      if (argument === "--keep-vars") throw new Error("--cli cf refuses --keep-vars");
      if (argument === "--local") throw new Error("--cli cf refuses --local; cf local state is not Wrangler's .wrangler/state");
      if (argument === "--env") throw new Error("--cli cf refuses --env because env blocks can swap databases");
      throw new Error(`--cli cf refuses ${argument}; only --config and --cli are supported`);
    }
    const value = parsed.flags[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error("--config requires a value");
    index += 1;
  }
}

function migrationDirectory(database: D1Declaration): string {
  if (database.migrationsDir !== undefined && isAbsolute(database.migrationsDir)) return database.migrationsDir;
  return normalize(database.migrationsDir ?? "migrations");
}

function cfDatabaseId(database: D1Declaration): string {
  if (database.databaseId === undefined || !UUID_PATTERN.test(database.databaseId)) {
    const detail = database.databaseId === undefined
      ? "is missing"
      : `is not a UUID (${database.databaseId})`;
    throw new Error(`--cli cf requires a real UUID database_id for ${database.binding}; database_id ${detail}; paste the real Cloudflare database ID`);
  }
  return database.databaseId;
}

function childEnvironment(base: NodeJS.ProcessEnv, backend: "wrangler" | "cf", accountId?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, CI: "true" };
  if (backend === "cf") {
    if (accountId !== undefined && base.CLOUDFLARE_ACCOUNT_ID !== undefined && base.CLOUDFLARE_ACCOUNT_ID !== accountId) {
      throw new Error("--cli cf refuses a different pre-set CLOUDFLARE_ACCOUNT_ID than the config account_id");
    }
    if (accountId !== undefined) env.CLOUDFLARE_ACCOUNT_ID = accountId;
    env.SEKIBAN_DCB_CF_HELPER = CF_HELPER_MARKER;
  } else {
    delete env.SEKIBAN_DCB_CF_HELPER;
  }
  return env;
}

function wranglerPlans(config: WranglerConfig, command: "migrate" | "deploy", flags: readonly string[], extra: readonly string[]): string[][] {
  const configPath = option(flags, "--config");
  if (configPath === undefined) throw new Error("missing-config");
  const envName = option(flags, "--env");
  const local = flags.includes("--local");
  const keepVars = flags.includes("--keep-vars");
  if (command === "deploy" && local) throw new Error("deploy-local");
  const remoteFlag = command === "migrate" && local ? "--local" : "--remote";
  const envArgs = envName === undefined ? [] : ["--env", envName];
  const migrations = config.d1.map((database) => [
    "wrangler",
    "d1",
    "migrations",
    "apply",
    database.databaseName,
    "--config",
    configPath,
    remoteFlag,
    ...envArgs,
  ]);
  if (command === "migrate") return migrations;
  return [
    ...migrations,
    ["wrangler", "deploy", "--config", configPath, ...envArgs, ...(keepVars ? ["--keep-vars"] : []), ...extra],
  ];
}

function cfPlans(config: WranglerConfig): string[][] {
  return config.d1.map((database) => [
    "cf",
    "d1",
    "migrations",
    "apply",
    cfDatabaseId(database),
    "--dir",
    migrationDirectory(database),
    ...(database.migrationsTable === undefined ? [] : ["--table", database.migrationsTable]),
  ]);
}

export function planCloudflareOperations(
  argv: readonly string[],
  configText: string,
  options: PlanOptions = {},
): CloudflareCommandPlan[] {
  const parsed = parseArguments(argv);
  const command = parsed.command;
  if (command !== "migrate" && command !== "deploy") throw new Error("usage");
  const configPath = option(parsed.flags, "--config");
  if (parsed.backend === "cf") validateCfArguments(parsed, configPath);
  if (configPath === undefined) throw new Error("missing-config");
  const config = parseWranglerConfig(configText);
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  if (parsed.backend === "cf") {
    const configDir = dirname(resolve(cwd, configPath));
    const childEnv = childEnvironment(env, "cf", config.accountId);
    const commands = cfPlans(config);
    return commands.map((plannedCommand) => ({
      backend: "cf",
      plannedCommand,
      command: plannedCommand,
      cwd: configDir,
      env: childEnv,
    }));
  }
  const commands = wranglerPlans(config, command, parsed.flags, parsed.extra);
  const childEnv = childEnvironment(env, "wrangler");
  return commands.map((plannedCommand) => ({
    backend: "wrangler",
    plannedCommand,
    command: plannedCommand,
    cwd,
    env: childEnv,
  }));
}

export function planCloudflareCommands(argv: readonly string[], configText: string, options: PlanOptions = {}): string[][] {
  return planCloudflareOperations(argv, configText, options).map((plan) => [...plan.plannedCommand]);
}

function executableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathExecutable(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const pathValue = env.PATH ?? "";
  for (const directory of pathValue.split(":").filter((value) => value.length > 0)) {
    const candidate = join(directory, name);
    if (executableFile(candidate)) return candidate;
  }
  return undefined;
}

export function resolveCfExecutable(configDir: string, env: NodeJS.ProcessEnv): string {
  if (env.CF_BIN !== undefined && env.CF_BIN.length > 0) return env.CF_BIN;
  const local = join(configDir, "node_modules", ".bin", "cf");
  if (existsSync(local)) return local;
  const fromPath = pathExecutable("cf", env);
  if (fromPath !== undefined) return fromPath;
  throw new Error(CF_INSTALL_HINT);
}

function oneLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

export async function executeCloudflareCli(
  argv: readonly string[],
  deps: {
    readText: (path: string) => string;
    spawn: (request: CloudflareSpawnRequest, backend: CloudflareCommandPlan["backend"]) => Promise<number>;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stderr?: (message: string) => void;
  },
): Promise<{ exitCode: number; commands: string[][] }> {
  let configPath: string | undefined;
  try {
    configPath = option(parseArguments(argv).flags, "--config");
  } catch (error) {
    const message = oneLine(error);
    (deps.stderr ?? ((value) => process.stderr.write(`${value}\n`)))(message);
    return { exitCode: 1, commands: [] };
  }
  if (configPath === undefined) {
    const message = "missing-config";
    (deps.stderr ?? ((value) => process.stderr.write(`${value}\n`)))(message);
    return { exitCode: 1, commands: [] };
  }
  let configText: string;
  try {
    configText = deps.readText(configPath);
  } catch {
    const message = `unable to read config ${configPath}`;
    (deps.stderr ?? ((value) => process.stderr.write(`${value}\n`)))(message);
    return { exitCode: 1, commands: [] };
  }
  let plans: CloudflareCommandPlan[];
  try {
    plans = planCloudflareOperations(argv, configText, { cwd: deps.cwd, env: deps.env });
  } catch (error) {
    const message = oneLine(error);
    (deps.stderr ?? ((value) => process.stderr.write(`${value}\n`)))(message);
    return { exitCode: 1, commands: [] };
  }
  const commands = plans.map((plan) => [...plan.plannedCommand]);
  for (const plan of plans) {
    let request: CloudflareSpawnRequest;
    try {
      request = plan.backend === "cf"
        ? { command: [resolveCfExecutable(plan.cwd, plan.env), ...plan.command.slice(1)], cwd: plan.cwd, env: plan.env }
        : { command: plan.command, cwd: plan.cwd, env: plan.env };
    } catch (error) {
      const message = oneLine(error);
      (deps.stderr ?? ((value) => process.stderr.write(`${value}\n`)))(message);
      return { exitCode: 1, commands };
    }
    let status: number;
    try {
      status = await deps.spawn(request, plan.backend);
    } catch (error) {
      const message = oneLine(error);
      (deps.stderr ?? ((value) => process.stderr.write(`${value}\n`)))(message);
      return { exitCode: 1, commands };
    }
    if (status !== 0) return { exitCode: status, commands };
  }
  return { exitCode: 0, commands };
}

function spawnWrangler(request: CloudflareSpawnRequest): Promise<number> {
  const bin = request.env.WRANGLER_BIN;
  const executable = bin !== undefined && bin.length > 0 ? bin : "npx";
  const args = bin !== undefined && bin.length > 0 ? request.command.slice(1) : ["--no-install", ...request.command];
  return new Promise((resolveExit) => {
    const child = spawn(executable, args, {
      cwd: request.cwd,
      stdio: "inherit",
      env: request.env,
    });
    child.on("close", (code: number | null) => resolveExit(code ?? 1));
    child.on("error", () => resolveExit(1));
  });
}

function spawnCf(request: CloudflareSpawnRequest): Promise<number> {
  return new Promise((resolveExit) => {
    const child = spawn(request.command[0], request.command.slice(1), {
      cwd: request.cwd,
      stdio: "inherit",
      env: request.env,
    });
    child.on("close", (code: number | null) => resolveExit(code ?? 1));
    child.on("error", () => {
      process.stderr.write(`${CF_INSTALL_HINT}\n`);
      resolveExit(1);
    });
  });
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const runner = async (request: CloudflareSpawnRequest, backend: CloudflareCommandPlan["backend"]) => backend === "wrangler" ? spawnWrangler(request) : spawnCf(request);
  const result = await executeCloudflareCli(process.argv.slice(2), {
    readText: (path) => readFileSync(path, "utf8"),
    spawn: runner,
  });
  process.exit(result.exitCode);
}
