#!/usr/bin/env node
/**
 * SDT-G75 source guard for the certificate boundary.
 *
 * The certificate validator is intentionally reachable from one explicit
 * safe-view decision seam.  This guard keeps that boundary visible and makes
 * accidental propagation into materialized-view or diagnostic callers red.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const files = Object.freeze({
  allocatorTypes: "packages/dcb-runtime/src/allocator/types.ts",
  projection: "packages/dcb-runtime/src/projection/ProjectionRuntime.ts",
  live: "packages/dcb-runtime/src/projection/LiveProjectionWorker.ts",
  materializedView: "packages/dcb-runtime/src/mv/MaterializedViewCatchUp.ts",
  index: "packages/dcb-runtime/src/index.ts",
  cloudflare: "packages/dcb-runtime/src/cloudflare.ts",
  evidence: "docs/SDT-G70A-evidence.md",
  test: "test/g75-certificate-scope.spec.ts",
});

function sourceMap(overrides = new Map()) {
  return new Map(Object.values(files).map((file) => [
    file,
    overrides.has(file) ? overrides.get(file) : readFileSync(resolve(root, file), "utf8"),
  ]));
}

function fail(message) {
  throw new Error(`SDT-G75 certificate-scope guard failed: ${message}`);
}

export function checkG75Sources(sources = sourceMap()) {
  const failures = [];
  const requireContains = (file, values, label) => {
    const source = sources.get(file) ?? "";
    for (const value of values) {
      if (!source.includes(value)) failures.push(`${label}: missing ${file}: ${value}`);
    }
  };
  const requireAbsent = (file, values, label) => {
    const source = sources.get(file) ?? "";
    for (const value of values) {
      if (source.includes(value)) failures.push(`${label}: unexpected ${file}: ${value}`);
    }
  };

  requireContains(files.allocatorTypes, [
    "export interface ClosedPrefixCertificate",
    'authority: "allocator-transaction"',
    "closedPrefixSuid: string | null",
    "serviceId: string",
  ], "certificate type");
  requireContains(files.projection, [
    "export function validatedClosedPrefixSuid",
    'throw new Error("ordering_certificate_unavailable")',
    "certificate.authority !== \"allocator-transaction\"",
    "certificate.serviceId !== options.expectedServiceId",
    "certificate.allocatorLineageId !== options.expectedAllocatorLineageId",
    "certifiedClosedPrefixSuid === null",
    "certifiedClosedPrefixSuid !== undefined && compareSuid(event.suid, certifiedClosedPrefixSuid) > 0",
    "options.maximumSuid === null",
    "compareSuid(event.suid, options.maximumSuid) > 0",
  ], "projection gate");
  requireContains(files.live, [
    "const safeViewAdvance = options.safeViewAdvance === true || options.requireClosedPrefixCertificate === true;",
    "validatedClosedPrefixSuid({",
    "closedPrefixCertificate: options.closedPrefixCertificate",
    "requireClosedPrefixCertificate: true",
    "safeViewAdvance ? closedPrefixSuid : undefined",
  ], "safe-view boundary");
  requireAbsent(files.materializedView, [
    "ClosedPrefixCertificate",
    "validatedClosedPrefixSuid",
    "closedPrefixSuid",
    "ordering_certificate_unavailable",
  ], "non-advancing materialized-view caller");
  requireContains(files.live, [
    "await runtime.catchUp(serviceId, parsed.value, Date.now());",
  ], "non-advancing diagnostic caller");
  requireContains(files.index, [
    "await pollLiveProjections(env, { registry: composition.projectors, storeProvider, serviceIdentityProvider: serviceIdentity });",
  ], "ordinary scheduled caller");
  requireContains(files.evidence, [
    "## Complete certificate-reachable call-site classification",
    "AC3 mutant results",
    "omit-g44-settled-frontier",
    "omit-closed-prefix-certificate-gate",
  ], "evidence");
  requireContains(files.test, [
    "ordinary scheduled and diagnostic-style polling does not validate a certificate",
    "the explicit safe-view decision is certificate-gated and consumer-bound",
    "certificate alone cannot replace the existing G44 settled frontier",
    "safe view cannot advance beyond the certificate closed prefix",
  ], "focused oracle");
  return failures;
}

function assertGreen(sources, label) {
  const failures = checkG75Sources(sources);
  if (failures.length > 0) throw new Error(`${label} failed:\n${failures.join("\n")}`);
}

function assertRed(sources, label) {
  if (checkG75Sources(sources).length === 0) throw new Error(`${label} unexpectedly passed`);
}

export function runSelfTest() {
  const original = sourceMap();
  assertGreen(original, "G75 guard baseline");
  const mutations = [
    {
      id: "omit-g44-settled-frontier",
      file: files.projection,
      from: "options.maximumSuid === null",
      to: "false",
    },
    {
      id: "omit-closed-prefix-certificate-gate",
      file: files.projection,
      from: "certifiedClosedPrefixSuid === null",
      to: "false",
    },
  ];
  const results = mutations.map((mutation) => {
    const originalSource = original.get(mutation.file);
    if (originalSource === undefined || !originalSource.includes(mutation.from)) {
      fail(`${mutation.id} anchor missing`);
    }
    const next = new Map(original);
    next.set(mutation.file, originalSource.replace(mutation.from, mutation.to));
    assertRed(next, mutation.id);
    return { id: mutation.id, result: "red" };
  });
  process.stdout.write(`${JSON.stringify({ guard: "g75-certificate-scope", mutants: results, result: "all-g75-static-mutants-red" })}\n`);
}

if (process.argv.includes("--self-test")) {
  runSelfTest();
} else {
  assertGreen(sourceMap(), "G75 guard");
  process.stdout.write(`${JSON.stringify({ guard: "g75-certificate-scope", result: "pass" })}\n`);
}
