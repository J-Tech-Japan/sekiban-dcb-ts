#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Vitest evaluates source modules from a bundle directory; npm preserves the
// project directory in INIT_CWD, while direct CI/script execution uses cwd.
const root = process.env.INIT_CWD ?? process.cwd();

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function filesUnder(path) {
  const directory = resolve(root, path);
  const entries = [];
  for (const entry of readdirSync(directory)) {
    if (["node_modules", ".git", ".artifacts", ".wrangler", "dist", "bin", "obj"].includes(entry)) continue;
    const absolute = join(directory, entry);
    const stat = statSync(absolute);
    if (stat.isDirectory()) entries.push(...filesUnder(relative(root, absolute)));
    else if (stat.isFile()) entries.push(relative(root, absolute));
  }
  return entries;
}

function occurrences(paths, expression) {
  return paths.filter((path) => expression.test(read(path))).sort();
}

const LEGACY_INPUT = /\bsuid-[0-9]|pre-g27|eventPayloadVersion/;

/**
 * The positive block is deliberately separated from the retained historical
 * negatives in the real-Cosmos contract. This lets the audit prove that a
 * future fixture cannot quietly make an old format successful again.
 */
export function positiveEnvelopeBlock(source) {
  const start = source.indexOf("function message(");
  const end = source.indexOf("function zeroCallClient(");
  if (start < 0 || end < 0 || end <= start) throw new Error("G32 Cosmos fixture positive-envelope block is missing");
  return source.slice(start, end);
}

export function assertNoLegacyPositiveFixtureText(text, label = "G32 positive fixture", eventPayloadName = "OrderPlaced") {
  const forbidden = [
    ["prefixed SUID", /suid-[0-9]/],
    ["legacy provenance", /pre-g27|provenance\s*:\s*["']g27["']/],
    ["caller-selected eventPayloadVersion", /eventPayloadVersion/],
    ["versioned EventType", /OrderPlaced:[0-9]/],
  ];
  for (const [name, expression] of forbidden) {
    if (expression.test(text)) throw new Error(`${label} contains ${name}`);
  }
  if (!/provenance\s*:\s*["']g32["']/.test(text)) {
    throw new Error(`${label} must carry the fixed internal g32 provenance`);
  }
  if (!new RegExp(`eventType\\s*:\\s*["']${eventPayloadName}["']`).test(text)) {
    throw new Error(`${label} must carry EventType equal to eventPayloadName`);
  }
  if (!/g32Suid\(/.test(text) || !/g32EventId\(/.test(text)) {
    throw new Error(`${label} must construct 30-digit SUID and UUIDv7 through the G32 fixture helpers`);
  }
}

export function auditG32LegacyIngress() {
  const cosmosScript = read("scripts/g22-bootstrap-cosmos-contract.mjs");
  assertNoLegacyPositiveFixtureText(positiveEnvelopeBlock(cosmosScript), "real-Cosmos positive fixture");

  const providerHelper = read("test/helpers/g22-bootstrap-provider-contract.ts");
  if (/pre-g27|eventPayloadVersion|OrderPlaced:[0-9]/.test(providerHelper) ||
    !providerHelper.includes("g32Message({") || !providerHelper.includes("g32SuidAt(") ||
    !/eventType:\s*"OrderPlaced"/.test(providerHelper)) {
    throw new Error("provider-contract positive fixture is not an unversioned G32 helper delegation");
  }
  assertNoLegacyPositiveFixtureText(read("scripts/store-contract.mjs"), "store-contract positive fixture", "StoreContractEvent");

  // All remaining V1 version-property references are rejection/documentation
  // oracles. A new positive fixture, CI helper, or script must update this
  // explicit list rather than silently depending on a caller-selected version.
  const sourceFiles = [...filesUnder("packages"), ...filesUnder("samples"), ...filesUnder("test")];
  const versionReferences = occurrences(sourceFiles, /eventPayloadVersion/);
  const expectedVersionReferences = [
    "packages/dcb-runtime/src/commit/CommitWorker.ts",
    "samples/meeting-room/src/mapping-observation.ts",
    "test/g27-identity.spec.ts",
    "test/g29-compatibility.spec.ts",
    "test/g29-mapping.spec.ts",
    "test/g32-parity.spec.ts",
  ];
  if (JSON.stringify(versionReferences) !== JSON.stringify(expectedVersionReferences)) {
    throw new Error(`G32 eventPayloadVersion references changed: ${versionReferences.join(",")}`);
  }

  // This is the seal-before-C2 inventory requested by the ruling. It covers
  // every executable script plus every checked-in test fixture that still
  // mentions an old ingress form. The entries are retained historical
  // regression/negative lanes; no executable positive G32 fixture may use
  // them (the positive-envelope checks above are separate and stricter).
  const legacyScriptReferences = occurrences(
    filesUnder("scripts").filter((path) => !["scripts/g32-legacy-ingress-audit.mjs", "scripts/g32-legacy-ingress-audit.d.mts"].includes(path)),
    LEGACY_INPUT,
  );
  const expectedLegacyScriptReferences = [
    "scripts/deploy/g15-e2e.py",
    "scripts/deploy/g32-measure.mjs",
    "scripts/g22-bootstrap-cosmos-contract.mjs",
    "scripts/g32-candidate-check.mjs",
  ];
  if (JSON.stringify(legacyScriptReferences) !== JSON.stringify(expectedLegacyScriptReferences)) {
    throw new Error(`G32 legacy script inventory changed: ${legacyScriptReferences.join(",")}`);
  }
  const legacyFixtureReferences = occurrences(filesUnder("test"), LEGACY_INPUT);
  const expectedLegacyFixtureReferences = [
    "test/d1-mv.spec.ts",
    "test/dcb-domain.spec.ts",
    "test/downstream.spec.ts",
    "test/fixtures/g13-pre-g27-outbox.json",
    "test/fixtures/g22-csharp-fixture.generated.json",
    "test/fixtures/g22-csharp-reference/Program.cs",
    "test/fixtures/g23-csharp-fixture.generated.json",
    "test/fixtures/g23-csharp-reference/Program.cs",
    "test/g13-wire-invariance.spec.ts",
    "test/g15-frontend.spec.ts",
    "test/g16-frontend.spec.ts",
    "test/g17-lineage.spec.ts",
    "test/g19-materializer.spec.ts",
    "test/g23-unsafe-window.spec.ts",
    "test/g24-hardening.spec.ts",
    "test/g26-fanout.spec.ts",
    "test/g27-identity.spec.ts",
    "test/g29-compatibility.spec.ts",
    "test/g29-diagnostics.spec.ts",
    "test/g29-mapping.spec.ts",
    "test/g29-meeting-room.spec.ts",
    "test/g31-sample.spec.ts",
    "test/g31-waitfor.spec.ts",
    "test/g32-cutover.spec.ts",
    "test/g32-parity.spec.ts",
    // M6/M9 use the retired raw form only as an observable typed, zero-write
    // negative. Keeping it in this explicit inventory prevents a future
    // fixture from silently turning the production retirement branch green.
    "test/g32-suid-rows.spec.ts",
    "test/g65-admission.spec.ts",
    "test/meeting-room.spec.ts",
    "test/mv.spec.ts",
    "test/projection.spec.ts",
    "test/repair.spec.ts",
    "test/tag.spec.ts",
  ];
  if (JSON.stringify(legacyFixtureReferences) !== JSON.stringify(expectedLegacyFixtureReferences)) {
    throw new Error(`G32 legacy fixture inventory changed: ${legacyFixtureReferences.join(",")}`);
  }
  const packageJson = JSON.parse(read("package.json"));
  const manifest = JSON.parse(read("ci/lanes.json"));
  const cosmosLane = manifest?.lanes?.find((lane) => lane?.name === "cosmos");
  const g22Cosmos = cosmosLane?.commands?.find((command) => command?.id === "g22-cosmos");
  const manifestWiring = g22Cosmos?.command === "npm run test:g22:cosmos" && cosmosLane?.tier === "local";
  if (
    !String(packageJson?.scripts?.["test:g22:cosmos"] ?? "").includes("scripts/g22-bootstrap-cosmos-contract.mjs --require-real-cosmos") ||
    !String(packageJson?.scripts?.["test:g32"] ?? "").includes("scripts/g22-bootstrap-cosmos-contract.mjs --self-test") ||
    !manifestWiring
  ) throw new Error("G32 real-Cosmos CI lane is not wired through the G32 positive/negative audit");

  const requiredNegativeMarkers = [
    "old-37-character-suid",
    "legacy-provenance",
    "identity-less",
    "pre-g27-queue",
    "must be rejected before a Cosmos client call",
  ];
  for (const marker of requiredNegativeMarkers) {
    if (!cosmosScript.includes(marker)) throw new Error(`G32 real-Cosmos negative marker missing: ${marker}`);
  }
  const parity = read("test/g32-parity.spec.ts");
  if (!parity.includes("eventPayloadVersion") || !parity.includes("before store initialization")) {
    throw new Error("G32 commit/queue/doorbell version and zero-call negative oracle is missing");
  }

  return {
    task: "SDT-G32",
    positiveIngresses: [
      "scripts/g22-bootstrap-cosmos-contract.mjs#message",
      "test/helpers/g22-bootstrap-provider-contract.ts#g32Message",
      "scripts/store-contract.mjs#message",
    ],
    legacyNegative: ["old-37-character-suid", "legacy-provenance", "identity-less", "eventPayloadVersion"],
    eventPayloadVersionReferences: versionReferences,
    legacyScriptReferences,
    legacyFixtureReferences,
    ciLane: "cosmos-emulator:test:g22:cosmos",
    conclusion: "all executable positive G32 ingress fixtures are 30-digit/UUIDv7/fixed-g32; legacy forms are retained only as typed zero-call negatives",
  };
}

export function runSelfTest({ includeAudit = true } = {}) {
  const clean = "function message(){ return { suid: g32Suid(1), eventId: g32EventId('one'), eventType: 'OrderPlaced', provenance: 'g32' }; }";
  assertNoLegacyPositiveFixtureText(clean, "self-test positive fixture");
  let versionMutationRed = false;
  try { assertNoLegacyPositiveFixtureText(`${clean}\nconst eventPayloadVersion = 2;`, "self-test mutation"); } catch (error) { versionMutationRed = String(error).includes("eventPayloadVersion"); }
  if (!versionMutationRed) throw new Error("G32 positive eventPayloadVersion mutation unexpectedly passed");
  let provenanceMutationRed = false;
  try { assertNoLegacyPositiveFixtureText(clean.replace("'g32'", "'pre-g27-queue'"), "self-test mutation"); } catch (error) { provenanceMutationRed = String(error).includes("legacy provenance"); }
  if (!provenanceMutationRed) throw new Error("G32 positive legacy-provenance mutation unexpectedly passed");
  return {
    mutations: ["eventPayloadVersion", "legacy-provenance"],
    ...(includeAudit ? auditG32LegacyIngress() : {}),
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const output = process.argv.includes("--self-test") ? runSelfTest() : auditG32LegacyIngress();
  console.log(JSON.stringify(output, null, 2));
}
