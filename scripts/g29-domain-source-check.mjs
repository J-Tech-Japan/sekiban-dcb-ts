#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const sourcePath = join(root, "samples/meeting-room/src/domain.ts");
const source = readFileSync(sourcePath, "utf8");

function lint(path) {
  return execFileSync(process.execPath, [join(root, "node_modules/eslint/bin/eslint.js"), "--format", "json", path], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const baseline = JSON.parse(lint(sourcePath));
const baselineErrors = baseline.flatMap((file) => file.messages ?? []).filter((message) => message.severity === 2);
if (baselineErrors.length !== 0) throw new Error(`G29 domain source baseline lint failed: ${JSON.stringify(baselineErrors)}`);

// Keep the generated fixture outside the repository's ignored .artifacts
// tree: ESLint must actually load the flat-config source rule for it.
const tempRoot = mkdtempSync(join(root, ".g29-domain-source-"));
const mutatedDirectory = join(tempRoot, "src");
const mutatedPath = join(mutatedDirectory, "domain.ts");
try {
  // This is the exact review mutation: the typed tag value is hidden behind
  // an `as` assertion.  The probe must enter the source rule and fail there.
  const mutated = source.replace("room.of(roomId)", "room.of(roomId as string)");
  if (mutated === source) throw new Error("G29 domain source mutation anchor was not found");
  mkdirSync(mutatedDirectory, { recursive: true });
  writeFileSync(mutatedPath, mutated, "utf8");
  let failed = false;
  try {
    lint(mutatedPath);
  } catch (error) {
    failed = true;
    const stdout = error?.stdout?.toString?.() ?? "";
    const parsed = stdout.length === 0 ? [] : JSON.parse(stdout);
    const messages = parsed.flatMap((file) => file.messages ?? []);
    if (!messages.some((message) => message.ruleId === "no-restricted-syntax" && String(message.message).includes("must not use `as` casts"))) {
      throw new Error(`G29 domain source mutation failed for the wrong reason: ${stdout}`);
    }
  }
  if (!failed) throw new Error("G29 domain source `as` mutation unexpectedly passed lint");
  console.log(JSON.stringify({ baseline: "passed", mutation: "room.of(roomId as string)", mutationOutcome: "red" }, null, 2));
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
