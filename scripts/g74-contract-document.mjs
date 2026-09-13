#!/usr/bin/env node
/** Generate or verify the readable SDT-G74 contract from the reviewed model. */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modelPath = join(root, "docs/SDT-G74-surface-baseline.json");
const classificationPath = join(root, "docs/SDT-G74-export-classification.json");
const outputPath = join(root, "docs/SDT-G74-contract.md");

const model = JSON.parse(await readFile(modelPath, "utf8"));
const classification = JSON.parse(await readFile(classificationPath, "utf8"));
const classifiedExecutorExports = Object.keys(classification.exports ?? {}).sort();
if (classifiedExecutorExports.length !== 14 || classifiedExecutorExports.some((name) => classification.exports[name] !== "public")) {
  throw new Error("SDT-G74 classification ledger must contain exactly 14 public executor exports");
}
const packageVersions = [...new Set(model.packages.map((pkg) => pkg.version))];
if (packageVersions.length !== 1 || packageVersions[0] !== "0.2.0") {
  throw new Error("SDT-G74 carrying version must be the operator-selected 0.2.0 package graph");
}
const carryingVersion = packageVersions[0];
const contractLabel = "executor-facade-v1";

const text = (value) => String(value).replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
const code = (value) => `\`${text(value)}\``;
const list = (values) => values.length === 0 ? "none" : values.join(", ");

function signatureText(signature) {
  const typeParameters = signature.typeParameters?.length === 0
    ? ""
    : `<${signature.typeParameters.map((parameter) => {
      const constraint = parameter.constraint === null ? "" : ` extends ${text(parameter.constraint)}`;
      const defaultValue = parameter.default === null ? "" : ` = ${text(parameter.default)}`;
      return `${parameter.name}${constraint}${defaultValue}`;
    }).join(", ")}>`;
  const parameters = signature.parameters.map((parameter) =>
    `${parameter.name}${parameter.rest ? "..." : ""}${parameter.optional ? "?" : ""}: ${text(parameter.type)}`,
  ).join(", ");
  return `${typeParameters}(${parameters}) => ${text(signature.returnType)}`;
}

function declarationText(symbol) {
  return symbol.declarations.map((declaration) => `${declaration.kind} ${declaration.file}`).join("; ");
}

function symbolRow(symbol) {
  const namespace = [symbol.namespace.value ? "value" : "", symbol.namespace.type ? "type" : ""].filter(Boolean).join("+") || "none";
  const calls = symbol.signatures.call.map(signatureText);
  const constructors = symbol.signatures.construct.map((signature) => `new ${signatureText(signature)}`);
  const signatures = [...calls, ...constructors];
  const members = symbol.members.map((member) =>
    `${member.readonly ? "readonly " : ""}${member.name}${member.optional ? "?" : ""}: ${text(member.type)}`,
  );
  const syntax = Object.entries(symbol.syntax).filter(([, present]) => present).map(([name]) => name);
  const detail = [
    `namespace=${namespace}`,
    `declaration=${declarationText(symbol)}`,
    signatures.length === 0 ? null : `signatures=${list(signatures)}`,
    members.length === 0 ? null : `members=${list(members)}`,
    symbol.type === null ? null : `type=${text(symbol.type)}`,
    syntax.length === 0 ? null : `syntax=${list(syntax)}`,
  ].filter(Boolean).join("; ");
  return `| ${code(symbol.name)} | ${text(detail)} |`;
}

function featureSummary() {
  const symbols = model.entryPoints.flatMap((entry) => entry.symbols);
  const declarations = symbols.flatMap((symbol) => symbol.declarations);
  const syntax = Object.fromEntries(Object.keys(symbols[0]?.syntax ?? {}).map((key) => [
    key,
    symbols.filter((symbol) => symbol.syntax[key]).length,
  ]));
  const overloaded = symbols.filter((symbol) => symbol.signatures.call.length > 1 || symbol.signatures.construct.length > 1).length;
  const optionalOrRest = symbols.flatMap((symbol) => [
    ...symbol.signatures.call.flatMap((signature) => signature.parameters),
    ...symbol.signatures.construct.flatMap((signature) => signature.parameters),
    ...symbol.members,
  ]).filter((member) => member.optional || member.rest).length;
  return { symbols: symbols.length, declarations: declarations.length, overloaded, optionalOrRest, syntax };
}

function entrySection(entry) {
  const lines = [];
  lines.push(`### ${entry.package} ${entry.subpath}`);
  lines.push("");
  lines.push(`Resolved declaration ${code(entry.declaration)}; runtime entry ${code(entry.import)}; ${entry.symbols.length} exported names; ${entry.runtimeNames.length} runtime names.`);
  lines.push("");
  lines.push("| exported name | declaration and reachable shape |");
  lines.push("| --- | --- |");
  for (const symbol of entry.symbols) lines.push(symbolRow(symbol));
  lines.push("");
  lines.push(`Runtime namespace: ${list(entry.runtimeNames.map(code))}.`);
  lines.push("");
  return lines;
}

const summary = featureSummary();
const lines = [
  "# SDT-G74 — executor facade v1 contract",
  "",
  "> Status: `QUESTION — contract freeze is not declared because AC10 exact consumer acknowledgements or an explicit design waiver are not present in the available records.`",
  "",
  "This document is the readable companion to `docs/SDT-G74-surface-baseline.json`. It records the release-shaped candidate inspected on 2026-09-12; it does not assert publication, downstream runtime conformance, or consumer agreement. The machine model is authoritative for the complete declaration graph and this document makes the complete exported-name set reviewable.",
  "",
  "## Candidate and prerequisites",
  "",
  "| fact | value |",
  "| --- | --- |",
  `| source candidate | ${code("origin/main a0d6add00fe940dced471fdd5ff14a389c0545df")} |`,
  `| SDT-G71 prerequisite | ${code("102d65f545292634cc43022ad4ebb3e0f2adc877")} |`,
  `| SDT-G78 prerequisite | ${code("a0d6add00fe940dced471fdd5ff14a389c0545df")} (source head ${code("8fd8598dfec0b820d1d44669bc2bb5a2e1cd8940")}) |`,
  `| extractor | ${code("scripts/g74-release-surface.mjs")} using npm pack/prepack, exports-map resolution, TypeScript ${code(model.generatedBy.typescript)}, ${code("Node16")}, strict declaration checking |`,
  `| public surface hash | ${code(model.publicSurfaceHash)} |`,
  `| model summary | ${summary.symbols} exported symbols, ${summary.declarations} declaration nodes, ${summary.overloaded} overloaded symbols, ${summary.optionalOrRest} optional/rest members or parameters |`,
  "",
  "The release candidate is built and packed from the three non-private package roots. Each declared export entry is resolved through the installed package `exports` map, then the resulting `.d.ts` graph is checked with `skipLibCheck: false`. `@sekiban/dcb-runtime` is private, absent from the release workflow, and deliberately excluded. No npm publish, tag, credential, or deployment operation was performed.",
  "",
  "## Package and entry-point inventory",
  "",
  "| package | version | entry points | runtime namespace check |",
  "| --- | --- | --- | --- |",
  ...model.packages.map((pkg) => {
    const entries = model.entryPoints.filter((entry) => entry.package === pkg.name);
    return `| ${code(pkg.name)} | ${code(pkg.version)} | ${entries.map((entry) => code(entry.subpath)).join(", ")} | ${entries.map((entry) => `${entry.runtimeNames.length} names`).join("; ")} |`;
  }),
  "",
  "The published scope is exactly `@sekiban/dcb-core`, `@sekiban/dcb-domain`, and `@sekiban/dcb-client`. The domain `./testing` entry point is public and included. The runtime package is not silently omitted; it is explicitly out of scope because its manifest is private and the release workflow does not build it.",
  "",
  "## Complete public declaration surface",
  "",
  "Each row below is derived from the packed, exports-map-resolved declaration. `namespace`, declaration file/kind, signatures, members, reachable type text, and syntax markers are retained in the machine model; the row is a readable index rather than a lossy replacement for that model.",
  "",
];
for (const entry of model.entryPoints) lines.push(...entrySection(entry));

lines.push(
  "## Shape dimensions captured by the model",
  "",
  `The model records package/subpath, conditional type/runtime entries, namespace and alias status, declaration kind/text/file, reachable type text, overload order, call/construct signatures, parameter position/optional/rest/type, generic constraints/defaults/const, return type, class/interface members with required/optional and readonly status, and syntax markers. Across this candidate the marker counts are: ${Object.entries(summary.syntax).map(([name, count]) => `${code(name)}=${count}`).join(", ")}. External package dependencies are retained in the package facts (${code("zod")} is the domain dependency; core has none; client depends exactly on core and domain at ${code("0.2.0")}). Compiler/module floor is TypeScript ${code("5.9.3")}, target ${code("ES2022")}, module and resolution ${code("Node16")}; the package contract is tested under Node16 and Bundler consumer compilation, with strict declaration resolution separately checked.`,
  "",
  "A bidirectional assignability check is intentionally not substituted for this model: assignability can hide overload order, literal/inference changes, discriminant additions, brands, `unknown`/`any`/`never`, and module-resolution failures.",
  "",
  "## Transport adapter contract (inside v1)",
  "",
  "`SekibanExecutor.transport` remains public because the constructor requires the same adapter boundary. The promise is the adapter contract, not object identity or undocumented implementation details.",
  "",
  "| operation | request and response promise | signals/service scope | outcome/refusal meaning |",
  "| --- | --- | --- | --- |",
  "| `readTagState` | tag-state identity request; validated `ReadonlyTagStateResponse` or typed HTTP result | optional `AbortSignal`; tag-state ID scopes the read | successful body is decoded only after HTTP success; malformed body is `invalid_read_snapshot`; typed refusal is preserved |",
  "| `readTagLatestSortable` (optional) | tag request; `{exists,lastSortableUniqueId}` or typed HTTP result | optional signal; tag and optional transport `serviceId` scope | absence is a capability boundary, not a fabricated boolean; refusal/abort/unknown remain typed |",
  "| `commit` | `CommitEnvelope`; unknown or HTTP-shaped result is classified by existing commit semantics | optional signal; supplied transport service scope | committed, conflict, partial/unknown and refusal semantics are not collapsed; no blind retry is added |",
  "| `query` | `QueryRequest` to `QueryResponse` | optional signal; no generic head is fabricated | success is `resultJson`; refusal and abort classifications cross the adapter |",
  "| `listQuery` | `ListQueryRequest` to `ListQueryResponse`, including optional durable `readHead` | optional signal; `consistency` is an executor option, safe/unsafe only here | safe is the G71 certificate/authority-gated lane; unsafe reports only returned-page reflection; unsupported modes are refused |",
  "",
  "The optional `readTagLatestSortable` policy is the SDT-G71 decision: an adapter may omit it, and an existence read then returns the documented typed unsupported-capability outcome rather than inventing `exists`. Adding a required adapter method, making an optional method operationally required, narrowing accepted response shapes, or adding mandatory routing data is a compatibility break for adapter implementers even if application call sites still compile. The contract does not promise object identity, extra properties, pooling, fetch implementation, scheduling, deep freezing, or private runtime details.",
  "",
  "## Executor operation and option matrix",
  "",
  "| public operation/option | implementation/source | capability and test proof |",
  "| --- | --- | --- |",
  "| `execute(command,input,options?)` | `createSekibanExecutor` and existing `executeCommand` composition in `packages/dcb-client/src/executor.ts` | `test:g78` command/error contract plus packed consumer inference; commit/conflict/partial boundaries retained |",
  "| `readState(projector,tag,options?)` | executor read path plus `readTagState`; authority is used for existence where available | `test:g71-read-contract.spec.ts`; `ReadOptions.signal` only, no consistency option |",
  "| `exists(tag,options?)` | shared validated authority read; no payload sentinel and no fabricated boolean when capability is absent | `test:g71-read-contract.spec.ts` existence/refusal/unsupported tests and eight red mutants |",
  "| `query(request,options?)` | generic serialized query adapter | `test:g71-read-contract.spec.ts` forwarding and error classification; no generic head is fabricated |",
  "| `listQuery(request,{consistency,signal}?)` | only operation with `safe`/`unsafe` consistency lane | `test:g71-read-contract.spec.ts` and `test:g71-composition.spec.ts`; safe reads authoritative checkpoint and unsafe reads page reflection |",
  "| `ExecuteCommandOptions` | snapshots/read mode/retry/signal/total budget | existing executor tests and packed positive compile; no timeout/retry semantics changed here |",
  "| `ReadOptions` | optional `signal` | public reader tests; no unsupported consistency accepted |",
  "| `ListQueryOptions` | optional `consistency: safe \\| unsafe` and `signal` | safe/unsafe composition test plus packed negative calls to `readState`, `exists`, and `query` |",
  "",
  "The matrix reuses prerequisite behavioural evidence; declaration extraction alone does not prove a declared option works. The sample and existing G16/G31/G71 tests are implementation evidence for composition, not evidence of downstream cloud runtime publication.",
  "",
  "## Compatibility policy",
  "",
  "### Additive changes",
  "",
  "A new optional export, optional field, or non-breaking overload is additive only after its declaration shape, runtime namespace, reachable types, inference and exports-map behavior are reviewed. It must not change an existing discriminated result, make a previously optional adapter method operationally required, or alter a documented refusal/abort/unknown outcome. Baseline updates are explicit reviewed decisions; a generator never accepts its own output as the new expectation.",
  "",
  "### Breaking changes and signals",
  "",
  "Removing/renaming an export, changing parameter position or requiredness, changing overload order or generic constraints/defaults, narrowing accepted input, widening a result discriminant, changing return/member/brand/unique-symbol shape, changing a required adapter operation, or changing supported module/export resolution is breaking. Breaking work receives a new reviewed surface baseline and a migration note before release; the v1 label and package version are not silently refreshed. Known refusal, abort, timeout, partial-write and unknown semantics are part of the behavioural contract, while exact prose, stack traces, logs and telemetry are not unless separately enumerated.",
  "",
  "### Bounded exclusions",
  "",
  "The following are not promised by this facade freeze: backend implementation choice, connection pooling, fetch internals, scheduling, sample/UI/deployment resources, private runtime APIs, undocumented cache/topology, arbitrary lexical arithmetic on opaque SUIDs, internal allocator lineage/attempt encoding, a service-level latency percentile, or schema inside explicitly unknown extension payloads. These exclusions do not waive exposed head round-tripping, empty/null meaning, validation/rejection, service isolation, secret non-disclosure, explicit caller budget/cancellation/wait semantics, or shipped HTTP interoperability. Wire implementations and their independent contracts remain intact; excluding a backend does not change the adapter-level operation contract.",
  "",
  "## Dated risks and prerequisite status",
  "",
  "| risk | observed basis/date | contract disposition |",
  "| --- | --- | --- |",
  "| allocator-to-source ordering gap | SDT-G69 evidence, W169/W168 local proof, recorded 2026-09-08 history; first-arrival fence is not implemented and AC4/AC5 remain open | explicitly open; no ordering guarantee is added and G69/G70 owns the design/repair boundary |",
  "| safe-lane latency | SDT-G66 W164 corrected production window: source `8042cfcbc7cd5ea207473e62d12aa478b2afc990`, 100% traffic, paced cohort 10,000 ms, actual spacing 11,965–12,959 ms, dated evidence section; safe response-relative p50/p95 `45,355/55,942 ms`, 10/10 within unchanged 180,000 ms | observed figure with arm/window identity, not an SLA or a changed timeout |",
  "| prerequisite surface | G71 merge `102d65f545292634cc43022ad4ebb3e0f2adc877`; G78 merge `a0d6add00fe940dced471fdd5ff14a389c0545df`, source head `8fd8598dfec0b820d1d44669bc2bb5a2e1cd8940` | both landed before extraction; their semantics are enumerated, not changed |",
  "| published graph | registry check dated 2026-09-10 recorded core/domain/client `0.1.0` installable, no `0.1.1`, runtime private; candidate source packages are `0.2.0` | retained as comparison facts; no publication is claimed |",
  "",
  "These are bounded, dated risks rather than an open-ended exception permitting arbitrary retroactive change. A stable API shape does not make the service production-ready.",
  "",
  "## Drift and export-addition proofs",
  "",
  "`node scripts/g74-surface-guard.mjs` compares the committed release-shaped model, all four entry points, runtime namespaces and public hash. `node scripts/g74-drift-mutation-runner.mjs` requires these red results against the untouched baseline:",
  "",
  "| proof | expected result |",
  "| --- | --- |",
  "| remove export | `RED_DETECTED` |",
  "| rename export | `RED_DETECTED` |",
  "| parameter type/position | `RED_DETECTED` |",
  "| return type | `RED_DETECTED` |",
  "| type widening | `RED_DETECTED` |",
  "| type narrowing | `RED_DETECTED` |",
  "| public-root export addition | `RED_DETECTED` |",
  "| newly unclassified executor-module export | `RED_DETECTED` until ledger review |",
  "",
  "The client executor barrel is explicit and mechanically preserves the prior value/type names and signatures; all 14 source executor exports are classified public in `docs/SDT-G74-export-classification.json`. An internal-only executor export is not allowed to silently enter the public contract, while a deliberate root export addition is independently caught. The domain/core wildcard barrels are followed by the extractor and are not blanket-rewritten.",
  "",
  "## Version designation and migration facts",
  "",
  `The candidate graph is \`@sekiban/dcb-core@0.2.0\`, \`@sekiban/dcb-domain@0.2.0\`, and \`@sekiban/dcb-client@0.2.0\`; the installable comparison graph recorded in the packet is the matched \`0.1.0\` set. Source \`0.1.1\` was never published and is not a migration target. The designated v1 label for this contract is \`${contractLabel}\`, with operator-selected carrying package version \`${carryingVersion}\`. This is the selected contract version, not an observed npm publication. No package was published here. Any future package release must be separately approved and published by its release process.`,
  "",
  "## Consumer consultation (AC10 gate)",
  "",
  `The required acknowledgement is exact: a named owner must acknowledge the immutable surface hash ${code(model.publicSurfaceHash)}, designated version ${code(contractLabel)}/carrying ${code(carryingVersion)}, the compatibility policy, and the dated risks, with either no interface blocker or a specific objection. The available issue comments do not meet that requirement:`,
  "",
  "| consumer | available comment/status | missing AC10 fact |",
  "| --- | --- | --- |",
  "| [SekibanWasmRuntime #283](https://github.com/J-Tech-Japan/SekibanWasmRuntime/issues/283) | shape/G57/G64 discussion; no exact G74 acknowledgement | named owner, exact hash, designated version, policy/risk acknowledgement |",
  "| [SekibanAsAService #1914](https://github.com/J-Tech-Japan/SekibanAsAService/issues/1914) | AGREE to cloud/API shape; no exact G74 acknowledgement | named owner, exact hash, designated version, policy/risk acknowledgement |",
  "| [Sekiban #1172](https://github.com/J-Tech-Japan/sekiban/issues/1172) | G57 facade no-objection comment; no exact G74 acknowledgement | named owner, exact hash, designated version, policy/risk acknowledgement |",
  "",
  "These are recorded as `missing-exact-acknowledgement`, not `received`, `no-objection`, `agreed`, or `adopted`. No explicit design-waiver receipt with unanswered items is present in the available dispatch/issue records. This is a concrete AC10 readiness question, not a declaration that the consumers disagree; rollout unreadiness would not itself block a freeze, but the required acknowledgement or waiver is currently absent.",
  "",
  "## Verification and process disposition",
  "",
  "The issue claim was acquired before source edits and the dedicated branch is `claude/sdt-g74-implementation-w281` from `origin/main` at `a0d6add00fe940dced471fdd5ff14a389c0545df`. Focused local proof commands are wired as `test:g74:surface`, `test:g74:consumer`, and `test:g74:contract`; the final local results are recorded in the companion evidence document. No PR was created and no worker `pr-created` completion was emitted because AC10's missing exact acknowledgement/waiver is a concrete design gate. Therefore no hosted exact-head CI result exists for this delegation; reporting a PR or green hosted CI would be unsupported.",
  "",
  "The next review step is design disposition of the three missing acknowledgements: obtain the exact acknowledgements, or record an explicit waiver listing each unanswered item. If a concrete interface contradiction is raised, resolve it before declaring the freeze; if no contradiction is raised and the waiver is authorized, the branch can be packaged into a PR and ordinary exact-head CI can run.",
  "",
  `Generated from ${code("docs/SDT-G74-surface-baseline.json")} by ${code("scripts/g74-contract-document.mjs")} on 2026-09-12.`,
);

const output = `${lines.join("\n")}\n`;
if (process.argv.includes("--check")) {
  const existing = await readFile(outputPath, "utf8");
  if (existing !== output) {
    throw new Error(`SDT-G74 contract is stale: regenerate ${outputPath}`);
  }
  process.stdout.write(JSON.stringify({ status: "PASS", output: outputPath, publicSurfaceHash: model.publicSurfaceHash }) + "\n");
} else {
  await writeFile(outputPath, output);
  process.stdout.write(JSON.stringify({ status: "WROTE", output: outputPath, publicSurfaceHash: model.publicSurfaceHash }) + "\n");
}
