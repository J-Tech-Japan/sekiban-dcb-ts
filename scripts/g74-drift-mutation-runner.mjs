#!/usr/bin/env node
/**
 * SDT-G74 drift proofs against the release artifact.
 *
 * Every mutant edits the declarations or manifest inside a freshly extracted copy
 * of the real `npm pack` tarball, re-runs the real extractor, and must move the
 * public-surface hash away from the committed baseline. Nothing here edits a copy
 * of the baseline JSON: a proof that never touches the artifact proves nothing
 * about the extractor.
 *
 * Three outcomes are kept apart:
 *   RED     the mutant extracted cleanly and the hash moved (the guard would fail)
 *   MISSED  the mutant extracted cleanly and the hash did not move (a real gap)
 *   INVALID the mutant broke extraction, so it proves nothing (a bad mutant)
 * Only RED passes. A positive control first proves that an unmutated extraction
 * reproduces the baseline, so "everything is red" cannot mean "extraction is broken".
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publicSurfaceHash } from "./g74-surface-hash.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extractor = resolve(root, "scripts/g74-release-surface.mjs");
const guard = resolve(root, "scripts/g74-surface-guard.mjs");
const baseline = JSON.parse(readFileSync(resolve(root, "docs/SDT-G74-surface-baseline.json"), "utf8"));

const CLIENT_DTS = "dist/index.d.ts";
const preflight = "export declare function preflightCommit(input: PreflightInput): void;";

/** Each mutant is one or more text edits with an exact expected match count. */
const MUTANTS = [
  { id: "removed-export", category: "removal", edits: [
    { package: "dcb-client", file: CLIENT_DTS, search: `${preflight}\n`, replace: "", expectedMatches: 1 }] },
  { id: "renamed-export", category: "rename", edits: [
    { package: "dcb-client", file: CLIENT_DTS, search: "export declare function preflightCommit(", replace: "export declare function preflightCommitRenamed(", expectedMatches: 1 }] },
  { id: "parameter-change", category: "parameter", edits: [
    { package: "dcb-client", file: CLIENT_DTS, search: preflight, replace: "export declare function preflightCommit(input: PreflightInput, extra: string): void;", expectedMatches: 1 }] },
  { id: "return-change", category: "return", edits: [
    { package: "dcb-client", file: CLIENT_DTS, search: preflight, replace: "export declare function preflightCommit(input: PreflightInput): boolean;", expectedMatches: 1 }] },
  { id: "type-widening", category: "type", edits: [
    { package: "dcb-core", file: CLIENT_DTS, search: "export type JsonPrimitive = null | boolean | number | string;", replace: "export type JsonPrimitive = null | boolean | number | string | undefined;", expectedMatches: 1 }] },
  { id: "type-narrowing", category: "type", edits: [
    { package: "dcb-core", file: CLIENT_DTS, search: "export type JsonPrimitive = null | boolean | number | string;", replace: "export type JsonPrimitive = string;", expectedMatches: 1 }] },
  { id: "public-root-export-addition", category: "export-addition", edits: [
    { package: "dcb-client", file: CLIENT_DTS, search: 'export { ClientError } from "./errors.js";', replace: 'export { ClientError } from "./errors.js";\nexport declare const UnexpectedPublicRootAddition: string;', expectedMatches: 1 }] },
  { id: "adapter-optional-member-required", category: "adapter-contract", edits: [
    { package: "dcb-client", file: CLIENT_DTS, search: "readonly readTagLatestSortable?: (request: {", replace: "readonly readTagLatestSortable: (request: {", expectedMatches: 1 }] },
  { id: "reachable-nonexported-optional-to-required", category: "reachable-type", edits: [
    { package: "dcb-domain", file: "dist/bridge.d.ts", search: "interface LegacyEventDefinition {\n    readonly name?: string;", replace: "interface LegacyEventDefinition {\n    readonly name: string;", expectedMatches: 1 }] },
  { id: "reachable-nonexported-parameter-widening", category: "reachable-type", edits: [
    { package: "dcb-client", file: CLIENT_DTS, search: "| Promise<ClientCommandDecision>) | CommandDefinition;", replace: "| Promise<ClientCommandDecision>) | CommandDefinition<any, any>;", expectedMatches: 1 }] },
  { id: "brand-identity-collapse", category: "brand", edits: [
    { package: "dcb-domain", file: "dist/types.d.ts", search: "declare const parsedBoundaryBrand: unique symbol;", replace: "declare const parsedBoundaryBrand: typeof eventPayloadBrand;", expectedMatches: 1 }] },
  { id: "engine-floor-change", category: "package-fact", edits: [
    { package: "dcb-client", file: "package.json", search: '"node": ">=20"', replace: '"node": ">=18"', expectedMatches: 1 }] },
  { id: "export-condition-addition", category: "package-fact", edits: [
    { package: "dcb-client", file: "package.json", search: '      "import": "./dist/index.js"', replace: '      "import": "./dist/index.js",\n      "require": "./dist/index.js"', expectedMatches: 1 }] },
];


/**
 * Some consumer-visible facts cannot be expressed as a valid drifted artifact.
 * Flipping a package's `type` from module to commonjs makes its declarations
 * CommonJS modules importing an ECMAScript package, which TypeScript rejects under
 * Node16 (TS1479); the extractor then fails loudly, which is the right outcome but
 * yields no hash to compare. For such facts, prove directly that they take part in
 * the surface identity, so that recording them is not decorative.
 */
function hashParticipation(model) {
  const hashMoves = (mutate) => {
    const copy = JSON.parse(JSON.stringify(model));
    mutate(copy);
    return publicSurfaceHash(copy) !== publicSurfaceHash(model);
  };
  const proof = (id, reason, expectedHashMoves, mutate) => {
    const observed = hashMoves(mutate);
    return { id, reason, expectedHashMoves, observedHashMoves: observed, result: observed === expectedHashMoves ? "HOLDS" : "VIOLATED" };
  };
  return [
    proof("package-module-type-participates", "TS1479: a commonjs flip cannot produce a resolvable artifact, so participation is proven on the model", true,
      (copy) => { copy.packages[0].type = copy.packages[0].type === "module" ? "commonjs" : "module"; }),
    proof("version-number-excluded", "a release version bump must not change the surface identity", false,
      (copy) => { for (const pkg of copy.packages) pkg.version = "9.9.9"; for (const entry of copy.entryPoints) entry.version = "9.9.9"; }),
  ];
}

function fail(message) {
  process.stderr.write(`SDT-G74 drift runner: ${message}\n`);
  process.exit(1);
}

function extract(workdir, packDir, spec) {
  const output = join(workdir, `${spec?.id ?? "control"}.json`);
  const args = [extractor, "--pack-dir", packDir, "--output", output];
  if (spec !== undefined) {
    const specPath = join(workdir, `${spec.id}.spec.json`);
    writeFileSync(specPath, JSON.stringify({ edits: spec.edits }));
    args.push("--mutate", specPath);
  }
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", env: process.env });
  if (result.status !== 0) return { ok: false, detail: `${result.stderr}${result.stdout}`.trim().split("\n").slice(-3).join(" | ") };
  return { ok: true, hash: JSON.parse(readFileSync(output, "utf8")).publicSurfaceHash };
}

const workdir = mkdtempSync(join(tmpdir(), "sdt-g74-drift-"));
try {
  const packDir = join(workdir, "packs");
  for (const shortName of ["dcb-core", "dcb-domain", "dcb-client"]) {
    const packed = spawnSync("npm", ["pack", "--pack-destination", packDir], { cwd: resolve(root, "packages", shortName), encoding: "utf8" });
    if (packed.status !== 0) {
      // npm pack needs the destination to exist
      spawnSync("mkdir", ["-p", packDir]);
      const retry = spawnSync("npm", ["pack", "--pack-destination", packDir], { cwd: resolve(root, "packages", shortName), encoding: "utf8" });
      if (retry.status !== 0) fail(`npm pack failed for ${shortName}: ${retry.stderr}`);
    }
  }

  const control = extract(workdir, packDir, undefined);
  if (!control.ok) fail(`positive control could not extract: ${control.detail}`);
  if (control.hash !== baseline.publicSurfaceHash) {
    fail(`positive control does not reproduce the committed baseline (${control.hash} != ${baseline.publicSurfaceHash}); refresh the baseline before trusting any mutant`);
  }

  const results = MUTANTS.map((mutant) => {
    const run = extract(workdir, packDir, mutant);
    if (!run.ok) return { id: mutant.id, category: mutant.category, result: "INVALID", detail: run.detail };
    return { id: mutant.id, category: mutant.category, result: run.hash === baseline.publicSurfaceHash ? "MISSED" : "RED", hash: run.hash };
  });

  const guardSelfTest = spawnSync(process.execPath, [guard, "--self-test"], { cwd: root, encoding: "utf8", env: process.env });
  if (guardSelfTest.status !== 0) fail(`guard self-test failed: ${guardSelfTest.stderr}`);
  const classification = (JSON.parse(guardSelfTest.stdout).comparatorTests ?? []).find((entry) => entry.label === "unclassified-executor-export");
  if (classification?.result !== "RED_DETECTED") fail("source-level unclassified-executor-export check was not red");

  const participation = hashParticipation(baseline);
  const badParticipation = participation.filter((entry) => entry.result !== "HOLDS");
  const bad = results.filter((entry) => entry.result !== "RED");
  const receipt = {
    schema: "sdt-g74-drift-mutation/v2",
    status: bad.length === 0 && badParticipation.length === 0 ? "PASS" : "FAIL",
    baselineHash: baseline.publicSurfaceHash,
    positiveControl: { result: "REPRODUCES_BASELINE", hash: control.hash },
    artifactMutants: results,
    sourceClassification: { id: "unclassified-executor-export", result: classification.result },
    hashParticipation: participation,
  };
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (bad.length > 0) fail(`${bad.length} mutant(s) not red: ${bad.map((entry) => `${entry.id}=${entry.result}`).join(", ")}`);
  if (badParticipation.length > 0) fail(`hash participation failed: ${badParticipation.map((entry) => entry.id).join(", ")}`);
} finally {
  rmSync(workdir, { recursive: true, force: true });
}
