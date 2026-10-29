#!/usr/bin/env node
/**
 * Three-layer zero-external-database gate for the named G20 variant.
 *
 * The mutation checks below intentionally exercise the gate predicates in
 * memory. They are not a green grep: each representative forbidden change is
 * required to make its layer fail.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const configPath = join(root, "samples/meeting-room/wrangler.cloudflare-only.jsonc");
const buildDir = join(root, ".artifacts/g20-cloudflare-build");
const metaPath = join(buildDir, "bundle-meta.json");
const forbidden = [
  "PostgresEventStore",
  "CosmosRestClient",
  "@sekiban/dcb-runtime/cosmos",
  "HYPERDRIVE",
  "POSTGRES_URL",
  "COSMOS_ENDPOINT",
  "COSMOS_KEY",
  "postgres",
];

function requireGate(condition, message) {
  if (!condition) throw new Error(message);
}

function checkVariantConfig(source) {
  const lowered = source.toLowerCase();
  requireGate(!lowered.includes("hyperdrive"), "cloudflare-only config contains Hyperdrive");
  requireGate(!lowered.includes("postgres"), "cloudflare-only config contains Postgres identifiers");
  requireGate(!lowered.includes("cosmos"), "cloudflare-only config contains Cosmos identifiers");
  requireGate(/"binding"\s*:\s*"D1"/.test(source), "cloudflare-only config lacks D1 pipeline binding");
  requireGate(/"binding"\s*:\s*"D1_MV"/.test(source), "cloudflare-only config lacks D1_MV binding");
  requireGate(/"queues"\s*:/.test(source), "cloudflare-only config lacks Queues");
  requireGate(/"durable_objects"\s*:/.test(source), "cloudflare-only config lacks Durable Objects");
}

function checkMetafile(meta) {
  const serialized = JSON.stringify(meta);
  for (const value of forbidden) {
    requireGate(!serialized.includes(value), `cloudflare-only import graph contains ${value}`);
  }
}

function checkBuiltOutput(output) {
  for (const value of forbidden) {
    requireGate(!output.includes(value), `cloudflare-only built output contains ${value}`);
  }
}

function expectMutationToFail(label, callback) {
  let failed = false;
  try {
    callback();
  } catch {
    failed = true;
  }
  requireGate(failed, `${label} mutation unexpectedly passed the zero-external-DB gate`);
}

const FAKE_REPAIR = "fake-repair-token";
const FAKE_CONFORMANCE = "fake-conformance-token";
const provisionPath = join(root, "scripts/deploy/provision-meeting-room-secrets.sh");
const sampleDeployPath = join(root, "samples/meeting-room/scripts/deploy.sh");
const cloudflareDeployPath = join(root, "scripts/deploy/cloudflare-only-deploy.sh");
const packedDeployPath = join(root, "scripts/deploy/npm-consumer-deploy.sh");
const BUNDLE_ARGV = ["deploy", "--config", "samples/meeting-room/wrangler.cloudflare-only.jsonc", "--dry-run"];

function assertSharedProvision(source) {
  requireGate(!source.includes("set -x") && !source.includes("set -o xtrace"), "provision enables shell tracing");
  requireGate(source.includes("grep -q '[^[:space:]]'"), "provision must reject a whitespace-only file");
  requireGate(source.includes("! -f ") && source.includes("! -r "), "provision must require a readable regular file");
  requireGate(
    source.includes('secret put REPAIR_OPERATOR_TOKEN --name "${WORKER_NAME}" < "${REPAIR_FILE}"'),
    "repair secret must be written from stdin",
  );
  requireGate(
    source.includes('secret put CONFORMANCE_TOKEN --name "${WORKER_NAME}" < "${CONFORMANCE_FILE}"'),
    "conformance secret must be written from stdin",
  );
  const conformanceCheck = source.indexOf('require_secret_file "CONFORMANCE_TOKEN"');
  const repairWrite = source.indexOf("secret put REPAIR_OPERATOR_TOKEN");
  requireGate(
    conformanceCheck >= 0 && repairWrite >= 0 && conformanceCheck < repairWrite,
    "provision must validate a supplied conformance file before any secret write",
  );
  requireGate(!source.includes("$(<") && !/\bcat\b/.test(source), "provision must not print or capture a secret");
  requireGate(!source.includes("--var"), "provision must not place a secret in a Wrangler var");
}

function assertProvisionBeforeDeploy(source, label, deployMarker) {
  const provisionAt = source.indexOf('"${PROVISION}"');
  const deployAt = source.indexOf(deployMarker);
  requireGate(provisionAt >= 0, `${label} must call the shared provisioning script`);
  requireGate(deployAt >= 0, `${label} must keep its live deploy command`);
  requireGate(provisionAt < deployAt, `${label} must provision before live deploy`);
  requireGate(source.includes("REPAIR_OPERATOR_TOKEN_FILE is required"), `${label} must require the repair token file`);
  requireGate(source.includes("CONFORMANCE_TOKEN_FILE"), `${label} must accept the optional conformance file`);
  requireGate(!source.includes("$(<") && !/\bcat\b/.test(source), `${label} must not print a secret file`);
}

function assertSampleDryRunSource(source) {
  const exitAt = source.indexOf("  exit 0\n");
  const provisionAt = source.indexOf('"${PROVISION}"');
  const helperAt = source.indexOf('node "$CLI" deploy');
  requireGate(source.includes('"$1" == "--dry-run"') && source.includes('"$2" == "--dry-run"'), "sample wrapper must accept both dry-run spellings");
  requireGate(source.includes('deploy --config "${DRY_CONFIG}" --dry-run'), "dry-run must call bundle-only wrangler");
  requireGate(source.includes('DRY_CONFIG="samples/meeting-room/wrangler.cloudflare-only.jsonc"'), "dry-run config path is required");
  requireGate(exitAt >= 0 && exitAt < provisionAt && exitAt < helperAt, "dry-run must return before provisioning and the helper");
  requireGate(source.includes("dry-run cannot be combined"), "mixed dry-run arguments must be rejected");
}

function assertPackedDryRunSource(source) {
  const dryAt = source.indexOf('"${G99_DRY_RUN:-}" == "1"');
  const exitAt = source.indexOf("  exit 0\n");
  const provisionAt = source.indexOf("provision-meeting-room-secrets.sh");
  const deployAt = source.indexOf("npx wrangler deploy");
  requireGate(dryAt >= 0 && exitAt > dryAt, "packed consumer must exit on G99_DRY_RUN");
  requireGate(provisionAt > exitAt, "packed consumer dry-run must exit before provisioning");
  requireGate(deployAt > exitAt && provisionAt < deployAt, "packed consumer must provision only on the live branch, before deploy");
  requireGate(source.includes("REPAIR_OPERATOR_TOKEN_FILE is required"), "packed consumer live branch must require the repair token file");
}

function expectGateFailure(label, callback) {
  let failed = false;
  try {
    callback();
  } catch {
    failed = true;
  }
  requireGate(failed, `${label} mutant unexpectedly passed`);
}

function moveAllAfter(source, snippet, anchor) {
  const without = source.split(snippet).join("");
  const at = without.indexOf(anchor);
  requireGate(at >= 0, `order mutant could not find ${anchor}`);
  return `${without.slice(0, at + anchor.length)}\n${snippet}${without.slice(at + anchor.length)}`;
}

function writeExecutable(path, body) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function recordedArgv(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").split("\n").filter((line) => line.length > 0).map((line) => line.split("\0").filter((part) => part.length > 0));
}

function rejectingWrangler(logPath) {
  return `#!/usr/bin/env bash
set +x
printf '%s\\0' "$@" >> ${JSON.stringify(logPath)}
printf '\\n' >> ${JSON.stringify(logPath)}
if [[ "$1" == "secret" ]]; then exit 91; fi
if [[ "$1" == "d1" || "$1" == "deployments" ]]; then exit 92; fi
if [[ "$1" == "deploy" ]]; then
  dry=0
  for arg in "$@"; do
    if [[ "$arg" == "--dry-run" ]]; then dry=1; fi
  done
  if [[ "$dry" -eq 0 ]]; then exit 94; fi
fi
exit 0
`;
}

function acceptingSecretWrangler(logPath, captureDir) {
  return `#!/usr/bin/env bash
set +x
printf '%s\\0' "$@" >> ${JSON.stringify(logPath)}
printf '\\n' >> ${JSON.stringify(logPath)}
if [[ "$1" == "secret" && "$2" == "put" ]]; then
  cat > "${captureDir}/$3"
  exit 0
fi
exit 95
`;
}

function runSampleDryRun(args) {
  const dir = mkdtempSync(join(tmpdir(), "sdt-g134-dry-run-"));
  try {
    const bin = join(dir, "bin");
    const logPath = join(dir, "wrangler-argv");
    const failPath = join(dir, "fail-fast");
    mkdirSync(bin, { recursive: true });
    const wrangler = join(bin, "wrangler");
    writeExecutable(wrangler, rejectingWrangler(logPath));
    for (const name of ["node", "npm", "npx"]) {
      writeExecutable(join(bin, name), `#!/usr/bin/env bash
printf '%s %s\\n' ${JSON.stringify(name)} "$*" >> ${JSON.stringify(failPath)}
exit 97
`);
    }
    const relative = "samples/meeting-room/scripts/deploy.sh";
    mkdirSync(join(dir, "samples/meeting-room/scripts"), { recursive: true });
    cpSync(sampleDeployPath, join(dir, relative));
    chmodSync(join(dir, relative), 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, WRANGLER_BIN: wrangler };
    delete env.CLOUDFLARE_API_TOKEN;
    delete env.CLOUDFLARE_ACCOUNT_ID;
    delete env.REPAIR_OPERATOR_TOKEN_FILE;
    delete env.CONFORMANCE_TOKEN_FILE;
    const result = spawnSync(join(dir, relative), args, { cwd: dir, env, encoding: "utf8" });
    return {
      status: result.status,
      stderr: result.stderr ?? "",
      recorded: recordedArgv(logPath),
      failFast: existsSync(failPath) ? readFileSync(failPath, "utf8") : "",
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runProvision(files) {
  const dir = mkdtempSync(join(tmpdir(), "sdt-g134-provision-"));
  try {
    const bin = join(dir, "bin");
    const capture = join(dir, "capture");
    const logPath = join(dir, "wrangler-argv");
    mkdirSync(bin, { recursive: true });
    mkdirSync(capture, { recursive: true });
    const wrangler = join(bin, "wrangler");
    writeExecutable(wrangler, acceptingSecretWrangler(logPath, capture));
    const args = [provisionPath, wrangler, "sekiban-dcb-meeting-room-cloudflare-only", files.repair];
    if (files.conformance !== undefined) args.push(files.conformance);
    const result = spawnSync("bash", args, {
      cwd: dir,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      encoding: "utf8",
    });
    const readCaptured = (name) => {
      const path = join(capture, name);
      return existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
    };
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      recorded: recordedArgv(logPath),
      stdin: {
        REPAIR_OPERATOR_TOKEN: readCaptured("REPAIR_OPERATOR_TOKEN"),
        CONFORMANCE_TOKEN: readCaptured("CONFORMANCE_TOKEN"),
      },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function proveProtectedProvisioning() {
  const provision = readFileSync(provisionPath, "utf8");
  const sample = readFileSync(sampleDeployPath, "utf8");
  const cloudflare = readFileSync(cloudflareDeployPath, "utf8");
  const packed = readFileSync(packedDeployPath, "utf8");
  assertSharedProvision(provision);
  assertProvisionBeforeDeploy(sample, "sample wrapper", 'node "$CLI" deploy');
  assertProvisionBeforeDeploy(cloudflare, "cloudflare-only wrapper", 'node "${CLI}" deploy');
  assertSampleDryRunSource(sample);
  assertPackedDryRunSource(packed);
  requireGate(!cloudflare.includes("G20_CONFORMANCE_TOKEN_FILE"), "cloudflare-only wrapper must use the shared conformance file variable");

  expectGateFailure("omit whitespace check", () => assertSharedProvision(provision.replace("grep -q '[^[:space:]]'", "true")));
  expectGateFailure("omit readable-file check", () => assertSharedProvision(provision.replace("! -r ", "")));
  expectGateFailure("omit repair stdin", () => assertSharedProvision(provision.replace(' < "${REPAIR_FILE}"', "")));
  expectGateFailure("print the repair file", () => assertSharedProvision(`${provision}\ncat "\${REPAIR_FILE}"\n`));
  expectGateFailure("omit sample provisioning", () => assertProvisionBeforeDeploy(sample.replaceAll('"${PROVISION}"', '"missing"'), "sample wrapper", 'node "$CLI" deploy'));
  expectGateFailure("sample provision after deploy", () => assertProvisionBeforeDeploy(
    moveAllAfter(sample, '"${PROVISION}"', 'node "$CLI" deploy'),
    "sample wrapper",
    'node "$CLI" deploy',
  ));
  expectGateFailure("omit cloudflare-only provisioning", () => assertProvisionBeforeDeploy(cloudflare.replaceAll('"${PROVISION}"', '"missing"'), "cloudflare-only wrapper", 'node "${CLI}" deploy'));
  expectGateFailure("cloudflare-only provision after deploy", () => assertProvisionBeforeDeploy(
    moveAllAfter(cloudflare, '"${PROVISION}"', 'node "${CLI}" deploy'),
    "cloudflare-only wrapper",
    'node "${CLI}" deploy',
  ));
  expectGateFailure("omit packed-consumer exit", () => assertPackedDryRunSource(packed.replace("  exit 0\n", "\n")));
  expectGateFailure("packed-consumer provision after deploy", () => assertPackedDryRunSource(
    moveAllAfter(packed, "provision-meeting-room-secrets.sh", "npx wrangler deploy"),
  ));
  expectGateFailure("omit packed-consumer provisioning", () => assertPackedDryRunSource(packed.replaceAll("provision-meeting-room-secrets.sh", "missing-provision.sh")));
  expectGateFailure("omit conformance file check", () => assertSharedProvision(
    provision.replace('  require_secret_file "CONFORMANCE_TOKEN" "${CONFORMANCE_FILE}"\n', "  :\n"),
  ));

  for (const args of [["--dry-run"], ["--", "--dry-run"]]) {
    const run = runSampleDryRun(args);
    requireGate(run.status === 0, `dry-run ${args.join(" ")} exited ${run.status}: ${run.stderr}`);
    requireGate(run.failFast === "", `dry-run ${args.join(" ")} invoked node or npm: ${run.failFast}`);
    requireGate(run.recorded.length === 1, `dry-run ${args.join(" ")} recorded ${JSON.stringify(run.recorded)}`);
    requireGate(JSON.stringify(run.recorded[0]) === JSON.stringify(BUNDLE_ARGV), `dry-run argv was ${JSON.stringify(run.recorded[0])}`);
  }
  for (const args of [["--dry-run", "--keep-vars"], ["--", "--dry-run", "--keep-vars"]]) {
    const mixed = runSampleDryRun(args);
    requireGate(mixed.status !== 0, `mixed dry-run ${args.join(" ")} must fail`);
    requireGate(mixed.recorded.length === 0, "mixed dry-run must not call wrangler");
    requireGate(mixed.failFast === "", "mixed dry-run must not build the composition helper");
  }

  const scratch = mkdtempSync(join(tmpdir(), "sdt-g134-token-files-"));
  try {
    const repairFile = join(scratch, "repair");
    const conformanceFile = join(scratch, "conformance");
    const blankFile = join(scratch, "blank");
    const emptyFile = join(scratch, "empty");
    writeFileSync(repairFile, FAKE_REPAIR);
    writeFileSync(conformanceFile, FAKE_CONFORMANCE);
    writeFileSync(blankFile, " \n\t");
    writeFileSync(emptyFile, "");
    const blank = runProvision({ repair: blankFile });
    requireGate(blank.status !== 0, "whitespace-only repair file must fail");
    requireGate(blank.recorded.length === 0, "whitespace-only repair file must not call wrangler");
    const empty = runProvision({ repair: emptyFile });
    requireGate(empty.status !== 0, "empty repair file must fail");
    requireGate(empty.recorded.length === 0, "empty repair file must not call wrangler");
    const missing = runProvision({ repair: join(scratch, "missing-file") });
    requireGate(missing.status !== 0, "missing repair file must fail");
    requireGate(missing.recorded.length === 0, "missing repair file must not call wrangler");
    const repairOnly = runProvision({ repair: repairFile });
    requireGate(repairOnly.status === 0, `repair provisioning failed: ${repairOnly.stderr}`);
    requireGate(repairOnly.recorded.length === 1, "repair provisioning must call wrangler once");
    requireGate(
      JSON.stringify(repairOnly.recorded[0]) === JSON.stringify(["secret", "put", "REPAIR_OPERATOR_TOKEN", "--name", "sekiban-dcb-meeting-room-cloudflare-only"]),
      "repair secret argv drifted",
    );
    assertSecretNotDisclosed(repairOnly, [FAKE_REPAIR]);
    const both = runProvision({ repair: repairFile, conformance: conformanceFile });
    requireGate(both.status === 0, `optional conformance provisioning failed: ${both.stderr}`);
    requireGate(both.recorded.length === 2, "optional conformance provisioning must call wrangler twice");
    requireGate(JSON.stringify(both.recorded[1]) === JSON.stringify(["secret", "put", "CONFORMANCE_TOKEN", "--name", "sekiban-dcb-meeting-room-cloudflare-only"]), "conformance secret argv drifted");
    assertSecretNotDisclosed(both, [FAKE_REPAIR, FAKE_CONFORMANCE]);
    const badConformance = [
      ["missing conformance file", join(scratch, "missing-conformance")],
      ["empty conformance file", emptyFile],
      ["whitespace-only conformance file", blankFile],
    ];
    for (const [label, conformance] of badConformance) {
      const rejected = runProvision({ repair: repairFile, conformance });
      requireGate(rejected.status !== 0, `${label} must fail`);
      requireGate(rejected.recorded.length === 0, `${label} must not call wrangler`);
      const rendered = `${rejected.stdout}\n${rejected.stderr}\n${JSON.stringify(rejected.recorded)}`;
      requireGate(!rendered.includes(FAKE_REPAIR), `${label} printed the repair secret`);
      requireGate(!rendered.includes(FAKE_CONFORMANCE), `${label} printed the conformance secret`);
      requireGate(
        !rejected.recorded.some((argv) => argv.includes("CONFORMANCE_TOKEN") || argv.includes("REPAIR_OPERATOR_TOKEN")),
        `${label} invoked secret put`,
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function assertSecretNotDisclosed(run, secrets) {
  const rendered = `${run.stdout}\n${run.stderr}\n${JSON.stringify(run.recorded)}`;
  for (const secret of secrets) {
    requireGate(!rendered.includes(secret), "provisioning disclosed a secret in argv or output");
    const name = secret === FAKE_REPAIR ? "REPAIR_OPERATOR_TOKEN" : "CONFORMANCE_TOKEN";
    requireGate(run.stdin[name].equals(Buffer.from(secret)), "secret stdin did not match the protected file");
  }
}

function buildVariant() {
  mkdirSync(buildDir, { recursive: true });
  const result = spawnSync(
    join(root, "node_modules/.bin/wrangler"),
    ["deploy", "--config", "samples/meeting-room/wrangler.cloudflare-only.jsonc", "--dry-run", "--outdir", ".artifacts/g20-cloudflare-build", "--outfile", ".artifacts/g20-cloudflare-build/worker.js", "--metafile", ".artifacts/g20-cloudflare-build/bundle-meta.json"],
    { cwd: root, encoding: "utf8", stdio: "pipe" },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`cloudflare-only dry-run failed with exit ${result.status}`);
  }
}

proveProtectedProvisioning();

const config = readFileSync(configPath, "utf8");
checkVariantConfig(config);
expectMutationToFail("binding-config", () => checkVariantConfig(`${config}\n  "hyperdrive": [{"binding":"HYPERDRIVE"}]`));

buildVariant();
requireGate(existsSync(metaPath), "cloudflare-only Wrangler dry-run did not emit a bundle metafile");
const meta = JSON.parse(readFileSync(metaPath, "utf8"));
checkMetafile(meta);
expectMutationToFail("import-graph", () => checkMetafile({ ...meta, inputs: { ...meta.inputs, "packages/dcb-runtime/src/store/PostgresEventStore.ts": {} } }));

const outputs = readdirSync(buildDir).filter((name) => name.endsWith(".js"));
requireGate(outputs.length > 0, "cloudflare-only Wrangler dry-run emitted no JavaScript worker output");
const built = outputs.map((name) => readFileSync(join(buildDir, name), "utf8")).join("\n");
checkBuiltOutput(built);
expectMutationToFail("built-output", () => checkBuiltOutput(`${built}\nPostgresEventStore`));

console.log(JSON.stringify({
  variant: "samples/meeting-room/wrangler.cloudflare-only.jsonc",
  layers: {
    bindingConfig: "pass",
    importGraphMetafile: "pass",
    builtOutput: "pass",
    protectedProvisioning: "pass",
  },
  mutationProof: {
    bindingConfig: "fail-as-required",
    importGraphMetafile: "fail-as-required",
    builtOutput: "fail-as-required",
  },
  outputFiles: outputs,
}, null, 2));
