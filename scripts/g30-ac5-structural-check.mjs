#!/usr/bin/env node
/** Structural oracle for the current G30 bounded-loss contract and exporter. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const BUNDLE_PATH = "contracts/commit-trace-bundle.json";
const NORMATIVE_PATH = "contracts/commit-trace-normative.md";
const CONTRACT_PATH = "scripts/g30-b0-contract.mjs";
const EXPORTER_PATH = "scripts/g30-trace-export.mjs";

export const G30_AC5_NORMATIVE_SURFACES = Object.freeze([
  BUNDLE_PATH,
  NORMATIVE_PATH,
  CONTRACT_PATH,
  EXPORTER_PATH,
]);
const G30_AC5_ACTIVE_ASSERTION_SURFACES = Object.freeze([
  NORMATIVE_PATH,
  CONTRACT_PATH,
  EXPORTER_PATH,
]);

function readTarget(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function fail(message) {
  throw new Error(`g30-ac5-structural:${message}`);
}

function requireText(texts, path, expression, description) {
  if (!expression.test(texts.get(path))) fail(`${path} lacks ${description}`);
}

function forbidText(texts, path, expression, description) {
  if (expression.test(texts.get(path))) fail(`${path} retains stale ${description}`);
}

function withoutComments(source) {
  let result = "";
  let state = "code";
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (state === "code") {
      if (current === "/" && next === "/") {
        result += "  ";
        index += 1;
        state = "line-comment";
      } else if (current === "/" && next === "*") {
        result += "  ";
        index += 1;
        state = "block-comment";
      } else if (current === "'" || current === '"' || current === "`") {
        result += current;
        state = current;
      } else {
        result += current;
      }
      continue;
    }
    if (state === "line-comment") {
      if (current === "\n") {
        result += current;
        state = "code";
      } else {
        result += " ";
      }
      continue;
    }
    if (state === "block-comment") {
      if (current === "*" && next === "/") {
        result += "  ";
        index += 1;
        state = "code";
      } else {
        result += current === "\n" ? "\n" : " ";
      }
      continue;
    }
    result += current;
    if (current === "\\") {
      if (index + 1 < source.length) {
        result += source[index + 1];
        index += 1;
      }
    } else if (current === state) {
      state = "code";
    }
  }
  return result;
}

function queryBlock(source, name) {
  const code = withoutComments(source);
  const expression = new RegExp(`\\bconst\\s+${name}\\s*=\\s*await\\s+queryByValues\\(\\{([\\s\\S]*?)\\n\\s*\\}\\);`, "g");
  const matches = [...code.matchAll(expression)];
  if (matches.length !== 1) fail(`${EXPORTER_PATH} must contain one executable ${name} query`);
  return matches[0][1];
}

function hasRootIdentity(block) {
  return [
    /key:\s*"\$metadata\.rayId"/,
    /values:\s*platformRayIds/,
    /queryFilter\(\s*"schema\.version"\s*,\s*"sdt\.commit\/v1"\s*\)/,
    /queryFilter\(\s*"\$metadata\.spanName"\s*,\s*"sdt\.commit"\s*\)/,
  ].every((expression) => expression.test(block));
}

function assertRootQueryIdentity(texts) {
  const exporter = texts.get(EXPORTER_PATH);
  const rootBlock = queryBlock(exporter, "rootRaws");
  if (!hasRootIdentity(rootBlock)) fail(`${EXPORTER_PATH} lacks the executable root-first provider identity query`);
  for (const name of ["workerRaws", "snapshotRaws"]) {
    if (hasRootIdentity(queryBlock(exporter, name))) fail(`${EXPORTER_PATH} ${name} query incorrectly satisfies root-first provider identity`);
  }
}

/** Reads only current code, the normative contract and the sealed bundle. */
export function assertAc5StructuralContract(read = readTarget, { requiredWordingPaths = [NORMATIVE_PATH] } = {}) {
  const texts = new Map(G30_AC5_NORMATIVE_SURFACES.map((path) => [path, read(path)]));
  for (const path of G30_AC5_ACTIVE_ASSERTION_SURFACES) {
    if (typeof texts.get(path) !== "string" || texts.get(path).length === 0) fail(`${path} is unavailable`);
  }
  requireText(texts, CONTRACT_PATH, /G30_MIN_SCHEMA_COMPLETE_COUNT\s*=\s*85/, "the frozen 85/100 delivery budget");
  requireText(texts, CONTRACT_PATH, /G30_TAIL_RANK_COUNT\s*=\s*5/, "the exact rank-1..5 tail size");
  requireText(texts, CONTRACT_PATH, /nearest-rank\/full-client-ledger\/v1/, "the sealed full-ledger estimator");
  requireText(texts, CONTRACT_PATH, /stage === "root-absent" \? entry\.clientLatency : rootDurationMs/, "the root-absent sensitivity envelope");
  requireText(texts, CONTRACT_PATH, /ranking\.ranked\.slice\(0, G30_TAIL_RANK_COUNT\)/, "the exact rank-set tail selector");
  assertRootQueryIdentity(texts);
  let bundle;
  try {
    bundle = JSON.parse(texts.get(BUNDLE_PATH));
  } catch {
    fail(`${BUNDLE_PATH} is not valid JSON`);
  }
  const normativeEntry = Array.isArray(bundle?.authorityFiles)
    ? bundle.authorityFiles.find((entry) => entry?.path === NORMATIVE_PATH)
    : undefined;
  const normativeDigest = `sha256:${createHash("sha256").update(texts.get(NORMATIVE_PATH), "utf8").digest("hex")}`;
  if (normativeEntry?.digest !== normativeDigest) fail("normative digest differs from its bundle entry");
  for (const path of requiredWordingPaths) {
    requireText(texts, path, /schemaCompleteCount\s*>=\s*85|85\/100/, "the bounded-loss delivery contract");
    requireText(texts, path, /rank-1\.\.5/, "the exact rank-1..5 tail contract");
    requireText(texts, path, /root-absent/, "the root-absent UNKNOWN stage");
    requireText(texts, path, /nearest-rank/, "the sealed latency estimator");
  }
  for (const expression of [
    [/zero[- ]loss/i, "zero-loss wording"],
    [/exactly 100 complete (?:schemas|traces)/i, "100-complete join wording"],
    [/p95(?:-threshold| threshold)[^\n]{0,80}tail/i, "p95-threshold tail wording"],
    [/schemaCompleteCount\s*>=\s*95|95\/100|95-of-100/, "superseded 95/100 delivery wording"],
  ]) {
    forbidText(texts, NORMATIVE_PATH, expression[0], expression[1]);
  }
  return Object.freeze({ surfaces: G30_AC5_NORMATIVE_SURFACES, result: "bounded-loss-contract-active" });
}

function mutateRootQueryIdentity(source) {
  const marker = "const rootRaws = await queryByValues({";
  const start = source.indexOf(marker);
  const end = source.indexOf("\n  });", start);
  if (start < 0 || end < 0 || source.indexOf(marker, start + marker.length) >= 0) fail("self-test root-query anchor is not unique");
  const block = source.slice(start, end);
  const altered = block.replace('key: "$metadata.rayId"', 'key: "request.id"');
  if (altered === block) fail("self-test root-query identity anchor is missing");
  return `${source.slice(0, start)}${altered}${source.slice(end)}`;
}

export function selfTest() {
  const baseline = new Map(G30_AC5_NORMATIVE_SURFACES.map((path) => [path, readTarget(path)]));
  assertAc5StructuralContract((path) => baseline.get(path));
  const baselineBundle = JSON.parse(baseline.get(BUNDLE_PATH));
  const baselineNormativeDigest = baselineBundle.authorityFiles.find((entry) => entry.path === NORMATIVE_PATH)?.digest;
  const mutations = [
    {
      id: "contract-floor",
      path: CONTRACT_PATH,
      from: "G30_MIN_SCHEMA_COMPLETE_COUNT = 85",
      to: "G30_MIN_SCHEMA_COMPLETE_COUNT = 84",
    },
    {
      id: "normative-bundle-digest",
      path: BUNDLE_PATH,
      from: baselineNormativeDigest,
      to: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    },
    {
      id: "normative-required-wording",
      path: NORMATIVE_PATH,
      from: "schemaCompleteCount >= 85",
      to: "schemaCompleteCount >= 84",
      after: (altered) => {
        const alteredBundle = JSON.parse(altered.get(BUNDLE_PATH));
        const entry = alteredBundle.authorityFiles.find((candidate) => candidate.path === NORMATIVE_PATH);
        if (entry === undefined) fail("self-test normative entry is missing");
        entry.digest = `sha256:${createHash("sha256").update(altered.get(NORMATIVE_PATH), "utf8").digest("hex")}`;
        altered.set(BUNDLE_PATH, JSON.stringify(alteredBundle, null, 2) + "\n");
      },
    },
    {
      id: "root-query-identity",
      path: EXPORTER_PATH,
      apply: (source) => mutateRootQueryIdentity(source),
    },
  ];
  const runMutations = (requiredWordingPaths) => {
    for (const mutation of mutations) {
      const altered = new Map(baseline);
      if (mutation.apply !== undefined) {
        altered.set(mutation.path, mutation.apply(altered.get(mutation.path)));
      } else {
        const source = altered.get(mutation.path);
        if (source?.split(mutation.from).length !== 2) fail(`self-test mutation anchor is not unique: ${mutation.path}`);
        altered.set(mutation.path, source.replace(mutation.from, mutation.to));
      }
      mutation.after?.(altered);
      let red = false;
      try {
        assertAc5StructuralContract((path) => altered.get(path), { requiredWordingPaths });
      } catch {
        red = true;
      }
      if (!red) fail(`self-test mutation stayed green: ${mutation.id}`);
    }
  };
  const requiredWordingPaths = [NORMATIVE_PATH];
  runMutations(requiredWordingPaths);
  let missingNormativeProof = false;
  try {
    runMutations([]);
  } catch (error) {
    missingNormativeProof = String(error).includes("normative-required-wording");
  }
  if (!missingNormativeProof) fail("self-test removing the normative required-wording check stayed green");
  return Object.freeze({
    surfaces: G30_AC5_NORMATIVE_SURFACES.length,
    mutations: mutations.map(({ id }) => id),
    proof: "normative-required-wording-is-covered",
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--self-test")) console.log(JSON.stringify(selfTest(), null, 2));
  else console.log(JSON.stringify(assertAc5StructuralContract(), null, 2));
}
