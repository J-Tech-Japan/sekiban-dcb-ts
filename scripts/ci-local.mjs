#!/usr/bin/env node
/**
 * SDT-G84's single lane executor.
 *
 * The manifest is the authority for commands.  GitHub CI uses this runner in
 * --ci mode after its checkout/setup steps; a developer uses the same runner
 * locally, where every selected lane is executed from a new detached HEAD
 * worktree and owns fresh Docker services.  Keeping execution here prevents
 * the local and hosted command lists from drifting apart.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = process.cwd();
const DEFAULT_MANIFEST = "ci/lanes.json";

function fail(message) {
  throw new Error(`ci-local:${message}`);
}

function parseArgs(argv) {
  const options = {
    manifest: DEFAULT_MANIFEST,
    lanes: [],
    tiers: [],
    affected: null,
    ci: false,
    all: false,
    skipBootstrap: false,
    selfTest: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--manifest") options.manifest = argv[++index];
    else if (argument === "--lane" || argument === "--lanes") options.lanes.push(...String(argv[++index] ?? "").split(",").filter(Boolean));
    else if (argument === "--tier") options.tiers.push(String(argv[++index] ?? ""));
    else if (argument === "--full") options.all = true;
    else if (argument === "--all") options.all = true;
    else if (argument === "--affected") options.affected = argv[++index];
    else if (argument === "--ci") options.ci = true;
    else if (argument === "--skip-bootstrap") options.skipBootstrap = true;
    else if (argument === "--self-test") options.selfTest = true;
    else fail(`unknown argument ${argument}`);
  }
  if (options.manifest === undefined || options.manifest === "") fail("--manifest requires a path");
  return options;
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function string(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function globRegex(pattern) {
  let result = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      result += ".*";
      index += 1;
    } else if (character === "*") {
      result += "[^/]*";
    } else if (character === "?") {
      result += "[^/]";
    } else {
      result += /[\\^$+?.()|[\]{}]/.test(character) ? `\\${character}` : character;
    }
  }
  return new RegExp(`^${result}$`);
}

function matchesGlob(path, pattern) {
  return globRegex(pattern).test(path);
}

function loadManifest(path) {
  const manifestPath = resolve(ROOT, path);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  object(manifest, "manifest");
  if (manifest.schema !== "sdt-ci-lanes/v1") fail("manifest schema is not sdt-ci-lanes/v1");
  object(manifest.tiers, "manifest.tiers");
  for (const tier of ["pr", "local", "full"]) {
    object(manifest.tiers[tier], `manifest.tiers.${tier}`);
  }
  if (!Array.isArray(manifest.tiers.full.includes) || !manifest.tiers.full.includes.includes("pr") || !manifest.tiers.full.includes.includes("local")) {
    fail("manifest.tiers.full must include pr and local");
  }
  if (!Array.isArray(manifest.lanes) || manifest.lanes.length === 0) fail("manifest.lanes must be non-empty");
  const names = new Set();
  const commandIds = new Set();
  for (const lane of manifest.lanes) {
    object(lane, "manifest.lanes[]");
    string(lane.name, "lane.name");
    if (names.has(lane.name)) fail(`duplicate lane ${lane.name}`);
    names.add(lane.name);
    if (!["pr", "local"].includes(lane.tier)) fail(`${lane.name} has invalid tier ${lane.tier}`);
    if (!Array.isArray(lane.services)) fail(`${lane.name}.services must be an array`);
    if (lane.env !== undefined) object(lane.env, `${lane.name}.env`);
    for (const service of lane.services) {
      if (!Object.hasOwn(manifest.services ?? {}, service)) fail(`${lane.name} references unknown service ${service}`);
    }
    if (!Array.isArray(lane.commands) || lane.commands.length === 0) fail(`${lane.name}.commands must be non-empty`);
    for (const command of lane.commands) {
      object(command, `${lane.name}.commands[]`);
      string(command.id, `${lane.name}.command.id`);
      string(command.command, `${lane.name}.${command.id}.command`);
      if (commandIds.has(command.id)) fail(`duplicate command id ${command.id}`);
      commandIds.add(command.id);
      if (command.expect !== undefined && command.expect !== "red") fail(`${lane.name}.${command.id} has unsupported expect value`);
      if (command.env !== undefined) object(command.env, `${lane.name}.${command.id}.env`);
    }
    if (!Array.isArray(lane.affectedPaths) || lane.affectedPaths.length === 0) fail(`${lane.name}.affectedPaths must be non-empty`);
  }
  return { manifest, manifestPath };
}

function run(command, env, label, cwd = ROOT) {
  const result = spawnSync("bash", ["-lc", command], {
    cwd,
    env,
    stdio: "inherit",
  });
  if (result.error !== undefined) fail(`${label} could not start: ${result.error.message}`);
  return { status: result.status ?? 1, signal: result.signal ?? null };
}

function gitOutput(args, cwd = ROOT) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  } catch (error) {
    fail(`git ${args.join(" ")} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertCleanTree() {
  const status = gitOutput(["status", "--porcelain"]);
  if (status.length > 0) fail("refusing a dirty working tree; commit or stash changes before collecting receipts");
}

function createDetachedWorktree(sha, laneName) {
  const path = mkdtempSync(join(tmpdir(), `sdt-g84-${laneName.replace(/[^a-z0-9-]+/gi, "-")}-`));
  try {
    execFileSync("git", ["worktree", "add", "--detach", "--quiet", path, sha], { cwd: ROOT, stdio: "inherit" });
  } catch (error) {
    rmSync(path, { recursive: true, force: true });
    fail(`could not create detached worktree for ${laneName}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return path;
}

function removeDetachedWorktree(path, laneName) {
  try {
    execFileSync("git", ["worktree", "remove", "--force", path], { cwd: ROOT, stdio: "inherit" });
  } catch (error) {
    fail(`could not remove detached worktree for ${laneName}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}

function workspacePackagePaths(executionRoot) {
  let rootPackage;
  try {
    rootPackage = JSON.parse(readFileSync(resolve(executionRoot, "package.json"), "utf8"));
  } catch (error) {
    fail(`could not read detached package.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  const workspaces = Array.isArray(rootPackage.workspaces)
    ? rootPackage.workspaces
    : rootPackage.workspaces?.packages;
  if (!Array.isArray(workspaces) || workspaces.length === 0) fail("detached package.json has no workspaces");
  const paths = [];
  for (const pattern of workspaces) {
    if (typeof pattern !== "string" || pattern.length === 0) fail("workspace patterns must be non-empty strings");
    if (pattern.endsWith("/*")) {
      const parent = resolve(executionRoot, pattern.slice(0, -2));
      let entries;
      try {
        entries = readdirSync(parent, { withFileTypes: true });
      } catch (error) {
        fail(`could not read workspace directory ${parent}: ${error instanceof Error ? error.message : String(error)}`);
      }
      for (const entry of entries) {
        if (entry.isDirectory()) paths.push(join(parent, entry.name));
      }
    } else {
      paths.push(resolve(executionRoot, pattern));
    }
  }
  return [...new Set(paths)];
}

function assertWorkspaceDependenciesInsideWorktree(executionRoot) {
  const worktree = resolve(executionRoot);
  const checks = [];
  for (const packagePath of workspacePackagePaths(executionRoot)) {
    let packageDocument;
    try {
      packageDocument = JSON.parse(readFileSync(resolve(packagePath, "package.json"), "utf8"));
    } catch (error) {
      fail(`could not read workspace package ${packagePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof packageDocument.name !== "string" || packageDocument.name.length === 0) fail(`workspace ${packagePath} has no package name`);
    const nodeModulesPath = resolve(worktree, "node_modules", ...packageDocument.name.split("/"));
    if (!existsSync(nodeModulesPath)) fail(`npm ci did not link workspace package ${packageDocument.name}`);
    let actualPath;
    try {
      actualPath = realpathSync(nodeModulesPath);
    } catch (error) {
      fail(`could not resolve workspace package ${packageDocument.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const insideWorktree = actualPath === worktree || actualPath.startsWith(`${worktree}${process.platform === "win32" ? "\\" : "/"}`);
    if (!insideWorktree) fail(`workspace package ${packageDocument.name} resolves outside detached worktree: ${actualPath}`);
    checks.push({
      name: packageDocument.name,
      packagePath,
      nodeModulesPath,
      realpath: actualPath,
      insideWorktree,
    });
  }
  if (checks.length === 0) fail("detached package.json has no workspace packages to verify");
  return checks;
}

function prepareDetachedDependencies(executionRoot, options, manifest) {
  const target = resolve(executionRoot, "node_modules");
  if (existsSync(target)) fail("fresh detached worktree unexpectedly contains node_modules");
  if (options.skipBootstrap) fail("--skip-bootstrap is not permitted for a fresh detached worktree");
  const cachePath = mkdtempSync(join(tmpdir(), "sdt-g84-npm-cache-"));
  try {
    const bootstrapEnv = { ...process.env, INIT_CWD: executionRoot, npm_config_cache: cachePath };
    const result = run(manifest.bootstrapCommands.join("\n"), bootstrapEnv, "bootstrap", executionRoot);
    if (result.status !== 0) fail(`bootstrap failed with status ${result.status}`);
    const nodeModulesRealpaths = assertWorkspaceDependenciesInsideWorktree(executionRoot);
    return {
      commands: manifest.bootstrapCommands,
      status: result.status,
      signal: result.signal,
      reason: "fresh-npm-ci-isolated-cache",
      npmConfigCache: cachePath,
      cacheRemoved: true,
      nodeModulesRealpaths,
    };
  } finally {
    rmSync(cachePath, { recursive: true, force: true });
  }
}

function currentSha(cwd = ROOT) {
  return gitOutput(["rev-parse", "HEAD"], cwd);
}

function changedPaths(base) {
  if (base === null) return [];
  const output = gitOutput(["diff", "--name-only", `${base}...HEAD`]);
  return output.length === 0 ? [] : output.split("\n").filter(Boolean);
}

function selectLanes(manifest, options) {
  const byName = new Map(manifest.lanes.map((lane) => [lane.name, lane]));
  const selected = new Set();
  for (const name of options.lanes) {
    const lane = byName.get(name);
    if (lane === undefined) fail(`unknown lane ${name}`);
    selected.add(name);
  }
  const requestedTiers = [...options.tiers, ...(options.all ? ["full"] : [])];
  for (const tier of requestedTiers) {
    if (tier === "full") {
      for (const lane of manifest.lanes) selected.add(lane.name);
    } else {
      if (!["pr", "local"].includes(tier)) fail(`unknown tier ${tier}`);
      for (const lane of manifest.lanes.filter((entry) => entry.tier === tier)) selected.add(lane.name);
    }
  }
  if (options.affected !== null) {
    const paths = changedPaths(options.affected);
    const localLanes = manifest.lanes.filter((lane) => lane.tier === "local");
    if (paths.length === 0) {
      return [];
    }
    const ignored = new Set(manifest.pathsIgnore ?? []);
    const actionable = paths.filter((path) => ![...ignored].some((pattern) => matchesGlob(path, pattern)));
    if (actionable.length === 0) return [];
    const unknown = actionable.some((path) => !localLanes.some((lane) => lane.affectedPaths.some((pattern) => matchesGlob(path, pattern))));
    if (unknown) {
      for (const lane of localLanes) selected.add(lane.name);
    } else {
      for (const lane of localLanes) {
        if (actionable.some((path) => lane.affectedPaths.some((pattern) => matchesGlob(path, pattern)))) selected.add(lane.name);
      }
    }
    for (const name of [...selected]) {
      if (byName.get(name)?.tier === "pr") selected.delete(name);
    }
  }
  if (selected.size === 0 && options.affected === null) fail("select at least one --lane, --tier, --full, or --affected base");
  return manifest.lanes.filter((lane) => selected.has(lane.name));
}

function docker(args, label, allowFailure = false) {
  const result = spawnSync("docker", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error !== undefined && !allowFailure) fail(`${label} could not start: ${result.error.message}`);
  if (!allowFailure && result.status !== 0) {
    process.stderr.write(String(result.stderr ?? ""));
    fail(`${label} failed with status ${result.status}`);
  }
  return result;
}

function mappedPort(container, containerPort) {
  const result = docker(["port", container, `${containerPort}/tcp`], `docker port ${container}`);
  const line = String(result.stdout ?? "").trim().split("\n")[0] ?? "";
  const match = line.match(/:(\d+)$/);
  if (match === null) fail(`could not resolve mapped port for ${container}:${containerPort}`);
  return match[1];
}

function waitForPostgres(container) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = docker(["exec", container, "pg_isready", "-U", "postgres", "-d", "serialized_dcb"], "postgres readiness", true);
    if (result.status === 0) return;
    spawnSync("sleep", ["1"], { stdio: "ignore" });
  }
  fail("postgres did not become ready within 60 seconds");
}

function waitForCosmos(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = spawnSync("curl", ["--fail", "--silent", "--show-error", url], { stdio: "ignore" });
    if (result.status === 0) return;
    spawnSync("sleep", ["2"], { stdio: "ignore" });
  }
  fail("Cosmos emulator did not become ready within 120 seconds");
}

function startServices(manifest, lane, sha, receiptRoot, initialEnv = process.env) {
  const services = new Set(lane.services);
  const cleanup = [];
  const env = { ...initialEnv };
  if (services.has("postgres")) {
    const container = `sdt-g84-${sha.slice(0, 12)}-${process.pid}-${lane.name}-postgres`;
    docker(["run", "--detach", "--rm", "--name", container, "--env", "POSTGRES_DB=serialized_dcb", "--env", "POSTGRES_PASSWORD=postgres", "--env", "POSTGRES_USER=postgres", "--publish", "127.0.0.1::5432", "postgres:16-alpine"], "postgres container");
    cleanup.push(() => docker(["rm", "--force", container], "postgres cleanup", true));
    waitForPostgres(container);
    const postgresPort = mappedPort(container, 5432);
    env.POSTGRES_URL = `postgresql://postgres:postgres@127.0.0.1:${postgresPort}/serialized_dcb`;
    const isolatedDatabase = `sdt_g16_${sha.slice(0, 12)}_${lane.name.replace(/[^a-z0-9_]+/gi, "_")}`;
    let createDatabase;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      createDatabase = docker(["exec", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE "${isolatedDatabase}"`], "G16 isolated database", true);
      if (createDatabase.status === 0 || String(createDatabase.stderr ?? "").includes("already exists")) break;
      spawnSync("sleep", ["1"], { stdio: "ignore" });
    }
    if (createDatabase?.status !== 0 && !String(createDatabase.stderr ?? "").includes("already exists")) {
      fail(`could not create the isolated G16 database: ${String(createDatabase?.stderr ?? "").trim() || "unknown docker/psql error"}`);
    }
    env.G16_POSTGRES_URL = `postgresql://postgres:postgres@127.0.0.1:${postgresPort}/${isolatedDatabase}`;
  }
  if (services.has("cosmos")) {
    mkdirSync(receiptRoot, { recursive: true });
    const keyFile = resolve(receiptRoot, `${lane.name}.cosmos.key`);
    const key = spawnSync("openssl", ["rand", "-base64", "64"], { encoding: "utf8" });
    if (key.status !== 0) fail("openssl could not create the Cosmos credential");
    writeFileSync(keyFile, String(key.stdout).replace(/\n/g, ""), { mode: 0o600 });
    chmodSync(keyFile, 0o600);
    const container = `sdt-g84-${sha.slice(0, 12)}-${process.pid}-${lane.name}-cosmos`;
    const image = manifest.services.cosmos.image;
    docker(["run", "--detach", "--rm", "--name", container, "--publish", "127.0.0.1::8080", "--publish", "127.0.0.1::8081", "--publish", "127.0.0.1::1234", "--volume", `${keyFile}:/cosmos.key:ro`, image, "--key-file", "/cosmos.key"], "Cosmos container");
    cleanup.push(() => docker(["rm", "--force", container], "Cosmos cleanup", true));
    const port8080 = mappedPort(container, 8080);
    const port8081 = mappedPort(container, 8081);
    waitForCosmos(`http://127.0.0.1:${port8080}/ready`);
    env.COSMOS_ENDPOINT = `http://127.0.0.1:${port8081}/`;
    env.COSMOS_DATABASE = `sdt_g12_${sha.slice(0, 12)}_${lane.name.replace(/[^a-z0-9_]+/gi, "_")}`;
    env.COSMOS_KEY_FILE = keyFile;
  }
  return { env, cleanup, services: [...services] };
}

function writeReceipt(root, lane, sha, commands, status, startedAt, forcedRedPassed, execution, bootstrap) {
  mkdirSync(root, { recursive: true });
  const receipt = {
    schema: "sdt-ci-local-receipt/v1",
    lane: lane.name,
    tier: lane.tier,
    commitSha: sha,
    commands,
    services: lane.services,
    exitStatus: status,
    durationMs: Math.max(0, Date.now() - startedAt),
    forcedRed: forcedRedPassed,
    execution,
    bootstrap,
    environment: lane.env ?? {},
    buildSettings: {
      UseSharedCompilation: lane.env?.UseSharedCompilation ?? null,
      MSBUILDDISABLENODEREUSE: lane.env?.MSBUILDDISABLENODEREUSE ?? null,
      DOTNET_CLI_USE_MSBUILD_SERVER: lane.env?.DOTNET_CLI_USE_MSBUILD_SERVER ?? null,
    },
    node: process.version,
    npm: String(spawnSync("npm", ["--version"], { encoding: "utf8" }).stdout ?? "").trim(),
    containerImages: lane.services,
    recordedAt: new Date().toISOString(),
  };
  const path = resolve(root, `${lane.name}.json`);
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
  return { path, receipt };
}

function executeLane(lane, baseEnv, receiptRoot, sha, execution, bootstrap, cwd) {
  const startedAt = Date.now();
  const commandReceipts = [];
  let status = 0;
  let forcedRedPassed = true;
  for (const command of lane.commands) {
    const commandStartedAt = Date.now();
    const result = run(command.command, { ...baseEnv, ...(command.env ?? {}) }, `${lane.name}/${command.id}`, cwd);
    const expectedRed = command.expect === "red";
    const passed = expectedRed ? result.status !== 0 : result.status === 0;
    commandReceipts.push({
      id: command.id,
      command: command.command,
      expected: expectedRed ? "red" : "green",
      status: result.status,
      signal: result.signal,
      passed,
      durationMs: Math.max(0, Date.now() - commandStartedAt),
    });
    if (expectedRed) forcedRedPassed &&= passed;
    if (!passed) {
      status = result.status || 1;
      if (expectedRed) fail(`${lane.name}/${command.id} forced-red command unexpectedly passed`);
      break;
    }
  }
  const { path, receipt } = writeReceipt(receiptRoot, lane, sha, commandReceipts, status, startedAt, forcedRedPassed, execution, bootstrap);
  return { path, receipt };
}

function executeSelectedLane(manifest, lane, options, sha, receiptRoot) {
  const detached = !options.ci;
  const executionRoot = detached ? createDetachedWorktree(sha, lane.name) : ROOT;
  const executionEnv = detached ? { ...process.env, INIT_CWD: executionRoot } : { ...process.env };
  const execution = {
    mode: detached ? "fresh-detached-worktree" : "ci-checkout",
    detachedHead: detached,
    checkoutSha: sha,
    worktreeRemoved: detached,
  };
  let bootstrap = {
    commands: detached ? manifest.bootstrapCommands : [],
    status: "skipped",
    reason: options.ci ? "hosted-checkout-installs-dependencies-before-runner" : "--skip-bootstrap",
  };
  let serviceState = { env: { ...process.env }, cleanup: [], services: [] };
  try {
    if (detached) bootstrap = prepareDetachedDependencies(executionRoot, options, manifest);
    if (detached) serviceState = startServices(manifest, lane, sha, receiptRoot, executionEnv);
    const laneEnv = { ...serviceState.env, ...(lane.env ?? {}) };
    return executeLane(lane, laneEnv, receiptRoot, sha, execution, bootstrap, executionRoot);
  } finally {
    for (const cleanup of serviceState.cleanup.reverse()) cleanup();
    if (detached) removeDetachedWorktree(executionRoot, lane.name);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { manifest } = loadManifest(options.manifest);
  if (options.selfTest) {
    const g84Evidence = ["docs", "SDT-G84-evidence.md"].join("/");
    const globProof = [
      matchesGlob(g84Evidence, g84Evidence),
      matchesGlob("test/g43-tag-sql.spec.ts", "test/g43-*.ts"),
      !matchesGlob("test/g43-tag-sql.spec.ts", "test/g46-*.ts"),
    ];
    if (!globProof.every(Boolean)) fail("glob matcher self-test failed");
    const sha = currentSha();
    const selfTestWorktree = createDetachedWorktree(sha, "self-test");
    let worktreeProof;
    try {
      const detachedSha = currentSha(selfTestWorktree);
      const clean = gitOutput(["status", "--porcelain"], selfTestWorktree) === "";
      worktreeProof = {
        mode: "fresh-detached-worktree",
        detachedSha,
        matchesHead: detachedSha === sha,
        clean,
        dependenciesAreNotImplicitlyCopied: !existsSync(resolve(selfTestWorktree, "node_modules")),
      };
      if (detachedSha !== sha || !clean) fail("detached worktree self-test failed");
    } finally {
      removeDetachedWorktree(selfTestWorktree, "self-test");
    }
    process.stdout.write(`${JSON.stringify({ schema: "sdt-ci-local-self-test/v1", manifest: manifest.lanes.length, globProof, worktreeProof }, null, 2)}\n`);
    return;
  }
  const lanes = selectLanes(manifest, options);
  const sha = currentSha();
  if (!options.ci) assertCleanTree();
  const receiptRoot = resolve(ROOT, ".artifacts/ci-local", sha);
  mkdirSync(receiptRoot, { recursive: true });
  if (lanes.length === 0) {
    process.stdout.write(JSON.stringify({ schema: "sdt-ci-local/v1", commitSha: sha, selectedLanes: [], status: "no-op" }, null, 2) + "\n");
    return;
  }
  const results = [];
  for (const lane of lanes) {
    results.push(executeSelectedLane(manifest, lane, options, sha, receiptRoot));
  }
  const failed = results.filter(({ receipt }) => receipt.exitStatus !== 0);
  process.stdout.write(`${JSON.stringify({
    schema: "sdt-ci-local/v1",
    commitSha: sha,
    selectedLanes: results.map(({ receipt }) => receipt.lane),
    receiptRoot: `.artifacts/ci-local/${sha}`,
    receipts: results.map(({ path }) => path),
    failed: failed.map(({ receipt }) => receipt.lane),
    status: failed.length === 0 ? "green" : "failed",
  }, null, 2)}\n`);
  if (failed.length > 0) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
