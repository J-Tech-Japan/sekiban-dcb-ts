#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();

const TARGETS = Object.freeze([
  Object.freeze({ relativePath: "samples/meeting-room/src/worker.cloudflare-only.ts", expectedCalls: 4 }),
  Object.freeze({ relativePath: "samples/meeting-room/src/worker.cloudflare-receiver-support.ts", expectedCalls: 1 }),
]);

const CALL_NAME = "readDirectDoorbellConfig";
const POLICY_PREFIX = "deliveryPolicyFromDomain(";

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function splitTopLevelArgs(argsSource) {
  const args = [];
  let current = "";
  let depth = 0;
  let angleDepth = 0;
  let quote = null;
  for (let index = 0; index < argsSource.length; index += 1) {
    const character = argsSource[index];
    if (quote !== null) {
      current += character;
      if (character === quote && argsSource[index - 1] !== "\\") quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "<") {
      angleDepth += 1;
      current += character;
      continue;
    }
    if (character === ">") {
      angleDepth = Math.max(0, angleDepth - 1);
      current += character;
      continue;
    }
    if (character === "(" || character === "{" || character === "[") {
      depth += 1;
      current += character;
      continue;
    }
    if (character === ")" || character === "}" || character === "]") {
      depth -= 1;
      current += character;
      continue;
    }
    if (character === "," && depth === 0 && angleDepth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim().length > 0) args.push(current.trim());
  return args;
}

function findCallSites(source) {
  const sites = [];
  let searchFrom = 0;
  while (searchFrom < source.length) {
    const start = source.indexOf(CALL_NAME, searchFrom);
    if (start === -1) break;
    let index = start + CALL_NAME.length;
    while (index < source.length && /\s/.test(source[index])) index += 1;
    if (source[index] !== "(") {
      searchFrom = start + CALL_NAME.length;
      continue;
    }
    let depth = 0;
    let end = index;
    for (; end < source.length; end += 1) {
      const character = source[end];
      if (character === "(") depth += 1;
      else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }
    if (depth !== 0) throw new Error(`${CALL_NAME} call at ${start} has unbalanced parentheses`);
    const callText = source.slice(start, end);
    const argsSource = callText.slice(callText.indexOf("(") + 1, callText.lastIndexOf(")"));
    sites.push({ start, callText, args: splitTopLevelArgs(argsSource) });
    searchFrom = end;
  }
  return sites;
}

function policyArgFromCall(call) {
  if (call.args.length < 3) {
    throw new Error(`${CALL_NAME} requires a per-view policy as the third argument; got ${call.args.length}`);
  }
  return call.args[2].trim();
}

function assertPolicyFromDomain(relativePath, source) {
  const sites = findCallSites(source);
  const expected = TARGETS.find((target) => target.relativePath === relativePath)?.expectedCalls;
  if (expected === undefined) throw new Error(`unexpected guard target ${relativePath}`);
  if (sites.length !== expected) {
    throw new Error(`${relativePath} must contain exactly ${expected} ${CALL_NAME} calls; found ${sites.length}`);
  }
  for (const [index, site] of sites.entries()) {
    const policyArg = policyArgFromCall(site);
    if (!policyArg.startsWith(POLICY_PREFIX)) {
      throw new Error(`${relativePath} ${CALL_NAME} #${index + 1} policy must be ${POLICY_PREFIX}…); got ${policyArg.slice(0, 80)}`);
    }
  }
}

function checkSources(entries) {
  const missing = [];
  for (const [relativePath, source] of entries) {
    try {
      assertPolicyFromDomain(relativePath, source);
    } catch (error) {
      missing.push(String(error));
    }
  }
  if (missing.length > 0) throw new Error(missing.join("; "));
}

function assertRed(label, operation) {
  try {
    operation();
    return { label, status: "green", detail: "expected failure did not occur" };
  } catch (error) {
    return { label, status: "red", detail: String(error) };
  }
}

function mutantEntries(mutator) {
  return TARGETS.map(({ relativePath }) => [relativePath, mutator(read(relativePath), relativePath)]);
}

checkSources(TARGETS.map(({ relativePath }) => [relativePath, read(relativePath)]));

const HAND_KEPT_MAP = '{ RoomProjector: "immediate-preferred", ReservationProjector: "immediate-preferred" }';

function replacePolicyArgs(source) {
  return source.replace(/deliveryPolicyFromDomain\([^)]*\)/g, "__g89HandKeptPolicy");
}

const mutants = [
  assertRed("variable-held policy map", () => {
    checkSources(mutantEntries((source) =>
      `const __g89HandKeptPolicy = ${HAND_KEPT_MAP};\n${replacePolicyArgs(source)}`,
    ));
  }),
  assertRed("Object.freeze literal policy map", () => {
    checkSources(mutantEntries((source) =>
      source.replace(/deliveryPolicyFromDomain\([^)]*\)/g, `Object.freeze(${HAND_KEPT_MAP})`),
    ));
  }),
  assertRed("one call site replaced with hand-kept map", () => {
    checkSources(mutantEntries((source, relativePath) => {
      const sites = findCallSites(source);
      if (sites.length === 0) throw new Error(`${relativePath} has no call sites to mutate`);
      const target = sites[0];
      const args = [...target.args];
      args[2] = HAND_KEPT_MAP;
      const replacement = `${CALL_NAME}(${args.join(", ")})`;
      return source.slice(0, target.start) + replacement + source.slice(target.start + target.callText.length);
    }));
  }),
];

const receipt = {
  status: mutants.every((mutant) => mutant.status === "red") ? "pass" : "fail",
  positive: "deliveryPolicyFromDomain required on every readDirectDoorbellConfig policy argument",
  mutants,
};

if (receipt.status !== "pass") {
  console.error(JSON.stringify(receipt, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(receipt, null, 2));
