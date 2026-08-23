#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  assertCandidateIndependentRecorderSource,
  bindCandidateIdentity,
  runCandidateIndependenceSelfTest,
} from "./deploy/g32-forward-record-evidence.mjs";

const sourcePath = new URL("./deploy/g32-forward-record-evidence.mjs", import.meta.url);
const source = readFileSync(sourcePath, "utf8");
const baseline = runCandidateIndependenceSelfTest(source);
const supplied = "c".repeat(40);
const substituted = "d".repeat(40);

let runtimeHardCodeRed = false;
try { bindCandidateIdentity(supplied, () => substituted); } catch (error) { runtimeHardCodeRed = String(error).includes("candidate-specific substitution"); }
if (!runtimeHardCodeRed) throw new Error("G32 recorder runtime candidate-hard-code mutation unexpectedly passed");

let sourceHardCodeRed = false;
try { assertCandidateIndependentRecorderSource(`${source}\nconst frozenCandidate = "${supplied}";`); } catch (error) { sourceHardCodeRed = String(error).includes("candidate-specific SHA literal"); }
if (!sourceHardCodeRed) throw new Error("G32 recorder source candidate-hard-code mutation unexpectedly passed");

console.log(JSON.stringify({
  oracle: "candidate-independent-forward-evidence-recorder",
  baseline,
  mutations: {
    runtimeCandidateSubstitution: "red",
    sourceCandidateLiteral: "red",
  },
}, null, 2));
