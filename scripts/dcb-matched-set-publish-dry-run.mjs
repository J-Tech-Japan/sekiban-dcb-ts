#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyPublishFailure } from "./npm-publish-dry-run-classifier.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packages = [
  ["@sekiban/dcb-core", "packages/dcb-core"],
  ["@sekiban/dcb-domain", "packages/dcb-domain"],
  ["@sekiban/dcb-client", "packages/dcb-client"],
];

export function publishArguments({ privateRepository, dryRun = true }) {
  return [
    "publish",
    ...(dryRun ? ["--dry-run"] : []),
    ...(privateRepository ? [] : ["--provenance"]),
    "--access",
    "public",
  ];
}

export function commandFor(options) {
  return ["npm", ...publishArguments(options)].join(" ");
}

export function publishEnvironment({ privateRepository }) {
  return privateRepository ? { NPM_CONFIG_PROVENANCE: "false" } : {};
}

function parseRepositoryVisibility(argv, env) {
  const privateRequested = argv.includes("--repository-private");
  const publicRequested = argv.includes("--repository-public");
  if (privateRequested && publicRequested) {
    throw new Error("repository visibility flags are mutually exclusive");
  }
  if (privateRequested) return true;
  if (publicRequested) return false;

  const value = env.REPO_IS_PRIVATE ?? env.SDT_G64_REPOSITORY_PRIVATE;
  if (value === "true") return true;
  if (value === "false") return false;
  return false;
}

function assertCommandShape() {
  const publicDryRun = publishArguments({ privateRepository: false });
  const privateDryRun = publishArguments({ privateRepository: true });
  const publicPublish = publishArguments({ privateRepository: false, dryRun: false });
  const privatePublish = publishArguments({ privateRepository: true, dryRun: false });

  const assertPublicCommand = (args) => {
    assert(args.includes("--provenance"), "public publish must request provenance");
  };
  const assertPrivateCommand = (args) => {
    assert(!args.includes("--provenance"), "private publish must omit provenance");
  };

  assertPublicCommand(publicDryRun);
  assertPublicCommand(publicPublish);
  assertPrivateCommand(privateDryRun);
  assertPrivateCommand(privatePublish);
  assert.equal(publicDryRun.at(-2), "--access");
  assert.equal(publicDryRun.at(-1), "public");
  assert.equal(privateDryRun.at(-2), "--access");
  assert.equal(privateDryRun.at(-1), "public");
  assert.deepEqual(publishEnvironment({ privateRepository: false }), {});
  assert.deepEqual(publishEnvironment({ privateRepository: true }), {
    NPM_CONFIG_PROVENANCE: "false",
  });

  const privateProvenanceMutation = [...privatePublish, "--provenance"];
  assert(
    !privateProvenanceMutation
      .slice(0, -1)
      .includes("--provenance"),
    "mutation fixture must start from the private no-provenance command",
  );
  assert.throws(
    () => assertPrivateCommand(privateProvenanceMutation),
    /private publish must omit provenance/,
    "private provenance mutation must be red",
  );

  const workflow = readFileSync(resolve(root, ".github/workflows/release-dcb-matched-set.yml"), "utf8");
  assert.match(workflow, /publish_args\+=\(--provenance\)/, "public workflow branch must add provenance");
  assert.match(workflow, /publish_env\+=\(NPM_CONFIG_PROVENANCE=false\)/, "private workflow branch must disable implicit provenance");
  assert.match(
    workflow,
    /npm pkg delete publishConfig\.provenance/,
    "private workflow branch must remove static manifest provenance before publish",
  );

  return {
    public: commandFor({ privateRepository: false }),
    private: commandFor({ privateRepository: true }),
    publicMutation: "npm publish --provenance --access public",
    privateEnvironment: "NPM_CONFIG_PROVENANCE=false",
    privateManifestPreparation: "npm pkg delete publishConfig.provenance",
    privateMutationRejected: true,
  };
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
  console.log(JSON.stringify({ status: "PASS", guard: "publish-command-shape", ...assertCommandShape() }, null, 2));
  process.exit(0);
}

const privateRepository = parseRepositoryVisibility(argv, process.env);
const publishArgs = publishArguments({ privateRepository });
const command = commandFor({ privateRepository });
const receipts = [];

for (const [name, relativeDirectory] of packages) {
  const env = { ...process.env };
  Object.assign(env, publishEnvironment({ privateRepository }));
  if (env.NPM_CONFIG_CACHE !== undefined) env.npm_config_cache = env.NPM_CONFIG_CACHE;
  const manifest = JSON.parse(readFileSync(resolve(root, relativeDirectory, "package.json"), "utf8"));
  const result = spawnSync(
    "npm",
    publishArgs,
    { cwd: resolve(root, relativeDirectory), env, encoding: "utf8" },
  );
  const receipt = {
    package: name,
    cwd: relativeDirectory,
    command,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
  receipts.push(receipt);
  if (result.status !== 0) {
    const failure = classifyPublishFailure(result, { packageName: name, version: manifest.version });
    // After a matched-set version is on the registry, dry-run correctly exits
    // nonzero with a version collision. That is an expected gate outcome, not a
    // packaging failure (see classifier module header). Other kinds stay fail-closed.
    if (failure.kind === "version-collision") {
      receipt.classification = failure;
      console.log(JSON.stringify({
        status: "PASS",
        guard: "dcb-matched-set-publish-dry-run",
        outcome: "version-already-published",
        failure,
        receipt,
      }, null, 2));
      continue;
    }
    console.error(JSON.stringify({ status: "FAIL", failure, receipt }, null, 2));
    process.exit(result.status ?? 1);
  }
}

console.log(JSON.stringify({
  status: "PASS",
  repositoryPrivate: privateRepository,
  order: packages.map(([name]) => name),
  command,
  receipts,
}, null, 2));
