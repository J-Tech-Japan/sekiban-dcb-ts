#!/usr/bin/env node
import ts from "typescript";
import { resolve, relative } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const fixtureRoot = resolve(root, "packages/dcb-domain/diagnostic-fixtures");

const expected = Object.freeze([
  Object.freeze({ file: "decision-log-event-id.ts", code: 2339, message: "Property 'eventId' does not exist" }),
  Object.freeze({ file: "decision-log-suid.ts", code: 2339, message: "Property 'suid' does not exist" }),
  Object.freeze({ file: "missing-schema.ts", code: 2554, message: "Expected 3 arguments, but got 2" }),
  Object.freeze({ file: "missing-tags.ts", code: 2345, message: "Property 'tags' is missing" }),
  Object.freeze({ file: "unbranded-payload.ts", code: 2345, message: "eventPayloadBrand" }),
  Object.freeze({ file: "wrong-family.ts", code: 2345, message: "projectorFamilyInvariant" }),
]);

if (process.env.SDT_G28_COMPILE_FAIL_FORCE_FAILURE === "1") {
  throw new Error("SDT-G28 compile-fail forced-red probe");
}

const configPath = resolve(root, "packages/dcb-domain/tsconfig.typecheck.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(root, "packages/dcb-domain"));
const files = expected.map(({ file }) => resolve(fixtureRoot, file));
const program = ts.createProgram(files, {
  ...parsed.options,
  noEmit: true,
  noUnusedLocals: false,
  noUnusedParameters: false,
});
const diagnostics = ts.getPreEmitDiagnostics(program);
const byFile = new Map();
for (const diagnostic of diagnostics) {
  if (diagnostic.file === undefined) throw new Error(`compile-fail checker found a global diagnostic: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
  const file = relative(fixtureRoot, diagnostic.file.fileName);
  const values = byFile.get(file) ?? [];
  values.push({ code: diagnostic.code, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " ") });
  byFile.set(file, values);
}

for (const fixture of expected) {
  const actual = byFile.get(fixture.file) ?? [];
  if (actual.length !== 1 || actual[0].code !== fixture.code || !actual[0].message.includes(fixture.message)) {
    throw new Error(`pinned diagnostic mismatch for ${fixture.file}: expected TS${fixture.code} containing ${fixture.message}; actual ${JSON.stringify(actual)}`);
  }
}
const unexpected = [...byFile.keys()].filter((file) => !expected.some((fixture) => fixture.file === file));
if (unexpected.length > 0) throw new Error(`unexpected diagnostic fixtures: ${unexpected.join(",")}`);

console.log(JSON.stringify({
  status: "PASS",
  fixtures: expected.map(({ file, code }) => ({ file, code })),
  pinned: true,
}));
