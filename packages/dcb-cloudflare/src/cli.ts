import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export interface D1Declaration {
  binding: string;
  databaseName: string;
}

export function parseWranglerConfig(text: string): { d1: D1Declaration[] } {
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const parsed = JSON.parse(stripped) as { d1_databases?: unknown };
  if (!Array.isArray(parsed.d1_databases) || parsed.d1_databases.length === 0) {
    throw new Error("no-d1");
  }
  const d1: D1Declaration[] = [];
  for (const entry of parsed.d1_databases) {
    if (typeof entry !== "object" || entry === null) throw new Error("no-d1");
    const record = entry as { binding?: unknown; database_name?: unknown };
    if (typeof record.binding !== "string" || record.binding.length === 0) throw new Error("no-d1");
    if (typeof record.database_name !== "string" || record.database_name.length === 0) throw new Error("no-d1");
    d1.push({ binding: record.binding, databaseName: record.database_name });
  }
  return { d1 };
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${name}`);
  return value;
}

export function planCloudflareCommands(argv: readonly string[], configText: string): string[][] {
  const split = argv.indexOf("--");
  const flags = split < 0 ? argv : argv.slice(0, split);
  const extra = split < 0 ? [] : [...argv.slice(split + 1)];
  const command = flags[0];
  if (command !== "migrate" && command !== "deploy") throw new Error("usage");
  const configPath = option(flags, "--config");
  if (configPath === undefined) throw new Error("missing-config");
  const envName = option(flags, "--env");
  const local = flags.includes("--local");
  const keepVars = flags.includes("--keep-vars");
  if (command === "deploy" && local) throw new Error("deploy-local");
  const config = parseWranglerConfig(configText);
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

export async function executeCloudflareCli(
  argv: readonly string[],
  deps: {
    readText: (path: string) => string;
    spawn: (command: readonly string[]) => Promise<number>;
  },
): Promise<{ exitCode: number; commands: string[][] }> {
  const flags = argv.includes("--") ? argv.slice(0, argv.indexOf("--")) : argv;
  let configPath: string | undefined;
  try {
    configPath = option(flags, "--config");
  } catch {
    return { exitCode: 1, commands: [] };
  }
  if (configPath === undefined) return { exitCode: 1, commands: [] };
  let configText: string;
  try {
    configText = deps.readText(configPath);
  } catch {
    return { exitCode: 1, commands: [] };
  }
  let commands: string[][];
  try {
    commands = planCloudflareCommands(argv, configText);
  } catch {
    return { exitCode: 1, commands: [] };
  }
  for (const command of commands) {
    const status = await deps.spawn(command);
    if (status !== 0) return { exitCode: status, commands };
  }
  return { exitCode: 0, commands };
}

function spawnWrangler(command: readonly string[]): Promise<number> {
  const bin = process.env.WRANGLER_BIN;
  const executable = bin !== undefined && bin.length > 0 ? bin : "npx";
  const args = bin !== undefined && bin.length > 0 ? command.slice(1) : ["--no-install", ...command];
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      stdio: "inherit",
      env: { ...process.env, CI: "true" },
    });
    child.on("close", (code: number | null) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const result = await executeCloudflareCli(process.argv.slice(2), {
    readText: (path) => readFileSync(path, "utf8"),
    spawn: spawnWrangler,
  });
  process.exit(result.exitCode);
}
