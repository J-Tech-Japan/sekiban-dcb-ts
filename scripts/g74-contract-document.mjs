#!/usr/bin/env node
/** Generate or verify the readable SDT-G74 contract from the reviewed model. */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modelPath = join(root, "docs/SDT-G74-surface-baseline.json");
const classificationPath = join(root, "docs/SDT-G74-export-classification.json");
const classificationPolicyPath = join(root, "docs/SDT-G74-classification-policy.json");
const datedRisksPath = join(root, "docs/SDT-G74-dated-risks.json");
const outputPath = join(root, "docs/SDT-G74-contract.md");

const model = JSON.parse(await readFile(modelPath, "utf8"));
const classification = JSON.parse(await readFile(classificationPath, "utf8"));
const classificationPolicy = JSON.parse(await readFile(classificationPolicyPath, "utf8"));
const datedRisks = JSON.parse(await readFile(datedRisksPath, "utf8"));
const classifiedExecutorExports = Object.keys(classification.exports ?? {}).sort();
if (classifiedExecutorExports.length !== 15 || classifiedExecutorExports.some((name) => classification.exports[name] !== "public")) {
  throw new Error("SDT-G74 classification ledger must contain exactly 15 public executor exports");
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
const hash = model.publicSurfaceHash;
const reachable = model.reachableDeclarations ?? [];
const reachableTypeParameters = reachable.filter((declaration) => declaration.kind === "TypeParameter");
const reachableNamed = reachable.filter((declaration) => declaration.kind !== "TypeParameter");
const conditionsOf = (pkg) => Object.entries(pkg.exports ?? {}).map(([subpath, conditions]) =>
  `${code(subpath)}: ${(Array.isArray(conditions) ? conditions.map(([condition]) => condition) : [String(conditions)]).map(code).join(" then ")}`).join("; ");
const otherFieldsOf = (pkg) => {
  const entries = Object.entries(pkg.otherFields ?? {});
  return entries.length === 0 ? "none" : entries.map(([key, value]) => `${code(key)}=${code(JSON.stringify(value))}`).join(", ");
};
const declarationFiles = model.declarationFiles ?? [];

const lines = [
  "# SDT-G74 — executor facade v1 contract",
  "",
  "> Status: `CANDIDATE, PARKED — all six prerequisites have landed and the release-shaped surface hash below is current for this branch; AC10 consumer consultation is open and the freeze is not declared until acknowledgements arrive.`",
  "",
  "This document is the readable companion to `docs/SDT-G74-surface-baseline.json`. It records the release-shaped candidate rebased onto the six landed prerequisite merges and extracted with schema `sdt-g74-surface/v3`. It does not assert publication, downstream runtime conformance, or consumer agreement. The machine model is authoritative for the complete declaration graph; this document makes the complete exported-name set reviewable.",
  "",
  "## Candidate and prerequisites",
  "",
  "| fact | value |",
  "| --- | --- |",
  `| source candidate | ${code("origin/main 184f6b5d2142a675993f31d22840ddb1f97779b8")} (SDT-G89) plus branch ${code("claude/sdt-g74-implementation-w281")} |`,
  `| SDT-G71 prerequisite | ${code("102d65f545292634cc43022ad4ebb3e0f2adc877")} (#161) |`,
  `| SDT-G78 prerequisite | ${code("a0d6add00fe940dced471fdd5ff14a389c0545df")} (#175) |`,
  `| SDT-G88 prerequisite | ${code("681da42f3b114f8e5f46422f3eff3e01feb3ccff")} (#178) |`,
  `| SDT-G86 prerequisite | ${code("5da349bca99d9e95a67ce9b789d71716b9ded8db")} (#180) |`,
  `| SDT-G87 prerequisite | ${code("2f6b7ddaf62845759333d3e811f6498dcbff4247")} (#182) |`,
  `| SDT-G89 prerequisite | ${code("184f6b5d2142a675993f31d22840ddb1f97779b8")} (#184) |`,
  `| extractor | ${code("scripts/g74-release-surface.mjs")}, model schema ${code(model.schema)}: npm pack with prepack, exports-map resolution, TypeScript ${code(model.generatedBy.typescript)}, ${code("Node16")}, strict declaration checking |`,
  `| public surface hash | ${code(hash)} |`,
  `| contract label | ${code(contractLabel)} |`,
  `| carrying package version | ${code(carryingVersion)} (selected, not published) |`,
  `| model summary | ${summary.symbols} exported symbols, ${summary.declarations} declaration nodes, ${summary.overloaded} overloaded symbols, ${summary.optionalOrRest} optional/rest members or parameters, ${reachableNamed.length} reachable non-exported declarations and ${reachableTypeParameters.length} reachable type parameters |`,
  "",
  "The release candidate is built and packed from the three non-private package roots. Each declared export entry is resolved through the installed package `exports` map, then the resulting `.d.ts` graph is checked with `skipLibCheck: false`. `@sekiban/dcb-runtime` is private, absent from the release workflow, and deliberately excluded. No npm publish, tag, credential, or deployment operation was performed.",
  "",
  "## Package and entry-point inventory",
  "",
  "| package | module type | Node floor | export conditions, in resolution order | other consumer-visible manifest fields | runtime namespace check |",
  "| --- | --- | --- | --- | --- | --- |",
  ...model.packages.map((pkg) => {
    const entries = model.entryPoints.filter((entry) => entry.package === pkg.name);
    return `| ${code(pkg.name)} | ${code(pkg.type)} | ${code(pkg.engines?.node ?? "none")} | ${conditionsOf(pkg)} | ${otherFieldsOf(pkg)} | ${entries.map((entry) => `${code(entry.subpath)} ${entry.runtimeNames.length} names`).join("; ")} |`;
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
  "## Reachable declarations that are not exported",
  "",
  "A public signature exposes the shape of every type it mentions, whether or not that type's name is exported. The extractor walks type references, heritage clauses, type queries, import types and computed member names from every exported declaration and records each declaration it reaches inside the packed `@sekiban` packages. A change to one of these is a surface change even though no exported name moves.",
  "",
  "| package | file | name | kind | declaration |",
  "| --- | --- | --- | --- | --- |",
  ...reachableNamed.map((declaration) => `| ${code(declaration.package)} | ${code(declaration.file)} | ${code(declaration.name)} | ${declaration.kind} | ${code(declaration.text)} |`),
  "",
  `The model also records the ${reachableTypeParameters.length} type parameters of exported generics, with their constraint and default text, as reachable declarations.`,
  "",
  "## Declaration-file facts outside the exports",
  "",
  "A triple-slash directive pulls a lib, a types package or a file into every consumer's program, and a `declare global` or `declare module` augmentation changes types the consumer never imported from these packages. The model records both for every declaration file inside the packed packages that carries one.",
  "",
  declarationFiles.length === 0
    ? "This candidate has none: no packed declaration file carries a triple-slash directive or an augmentation."
    : declarationFiles.map((file) => `- ${code(file.package)} ${code(file.file)}: lib ${list(file.directives.lib.map(code))}; types ${list(file.directives.types.map(code))}; path ${list(file.directives.path.map(code))}; augmentations ${list(file.augmentations.map(code))}`).join("\n"),
  "",
  "## Surface identity and hash normalization",
  "",
  `The public surface hash is the SHA-256 of the JSON projection computed by ${code("scripts/g74-surface-hash.mjs")}; the extractor and the guard share that one function. Three things are removed from the projection, and only these:`,
  "",
  "| removed | why it is not surface |",
  "| --- | --- |",
  "| package and entry-point `version` | the label, the carrying version and a publication are three separate facts; a version bump alone must not change the surface identity |",
  "| the `alias` flag on an exported symbol | whether a name is re-exported through `export *` or an explicit re-export is not an API change; the AC5 proof below shows the two barrels differ only in this flag |",
  "| the numeric suffix of TypeScript's internal symbol names (`__@tagFamilyBrand@40872` becomes `__@tagFamilyBrand`) | the number is assigned per compiler run and changes without any source change |",
  "| comments, including JSDoc on members | documentation is not surface; the extractor removes comment trivia with the TypeScript scanner, so a member's doc edit and a top-level doc edit are treated alike. A `@deprecated` tag is therefore not part of the identity; a deprecation is announced in this document and in release notes |",
  "",
  "An intra-scope dependency (`@sekiban/*`) that pins exactly the package's own version is replaced by one marker, because it moves with every release; any other intra-scope range, such as a caret, is kept as written, so loosening a pin changes the hash. External dependency ranges are kept. Everything else participates in the hash, including the module type, the Node floor, every export condition in resolution order, every other consumer-visible manifest field, every reachable declaration, every declaration-file directive or augmentation, whether a value is exported as a value or only as a type, and every runtime namespace name. The drift runner proves on the model that flipping a package module type moves the hash and that a release version bump does not.",
  "",
  "## Shape dimensions captured by the model",
  "",
  `The model records package/subpath, conditional type/runtime entries, namespace and alias status (a value re-exported with \`export type\` counts as type-only), declaration kind/text/file with comments removed, reachable type text, overload order, call/construct signatures, parameter position/optional/rest/type, generic constraints/defaults/const, return type, class/interface members with required/optional and readonly status, syntax markers, reachable non-exported declarations including the unique-symbol brands, declaration-file directives and augmentations, and every manifest field except package metadata (author, bugs, contributors, description, devDependencies, files, funding, gitHead, homepage, keywords, license, publishConfig, readme, repository, scripts). Across this candidate the marker counts are: ${Object.entries(summary.syntax).map(([name, count]) => `${code(name)}=${count}`).join(", ")}. External package dependencies are retained in the package facts (${code("zod")} is the domain dependency; core has none; client depends exactly on core and domain). Compiler/module floor is TypeScript ${code("5.9.3")}, target ${code("ES2022")}, module and resolution ${code("Node16")}; the package contract is tested under Node16 and Bundler consumer compilation, with strict declaration resolution separately checked.`,
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
  "| `readTagLatestSortable` (optional in the type) | tag request; `{exists,lastSortableUniqueId}` or typed HTTP result | optional signal; tag scopes the read | the durable existence authority; an absent head for an existing tag is valid, a head for an absent tag is `incoherent_read_snapshot` |",
  "| `commit` | `CommitEnvelope`; unknown or HTTP-shaped result is classified by existing commit semantics | optional signal; supplied transport service scope | committed, conflict, partial/unknown and refusal semantics are not collapsed; no blind retry is added |",
  "| `query` | `QueryRequest` to `QueryResponse` | optional signal; no generic head is fabricated | success is `resultJson`; refusal and abort classifications cross the adapter |",
  "| `listQuery` | `ListQueryRequest` to `ListQueryResponse`, including optional durable `readHead` | optional signal; `consistency` arrives inside `queryParamsJson` | safe is the G71 certificate/authority-gated lane; unsafe reports only returned-page reflection |",
  "| `serviceId` (optional property) | the service scope the adapter was built for | compared with the executor's own `serviceId` | a mismatch makes every `execute` return `invalid` with code `scope.mismatch` before any commit |",
  "",
  "**Capability requirement (SDT-G71).** `readTagLatestSortable` is optional in the type, and an adapter that omits it still type-checks. It is operationally required by `readState`, by `exists`, and by a read-through `execute` that has to read a tag its supplied snapshots do not cover. Without it, `readState` and `exists` reject with `ClientError` code `unsupported_capability`, status `501`; `execute` does not reject but resolves to `{ kind: \"invalid\", code: \"unsupported_capability\", status: 501 }` without calling the adapter at all (`test/g71-read-contract.spec.ts`, the read-through capability case). Existence is never inferred from a tag-state payload and no boolean is fabricated. `query`, `listQuery`, `commit` and a snapshot-only `execute` do not use it. The built-in `createHttpTransport` and `createInProcessTransport` both implement it.",
  "",
  "Adding a required adapter method, making an optional method operationally required for a further operation, narrowing accepted response shapes, or adding mandatory routing data is a compatibility break for adapter implementers even if application call sites still compile. The contract does not promise object identity, extra properties, pooling, fetch implementation, scheduling, deep freezing, or private runtime details.",
  "",
  "## Executor operation and option matrix",
  "",
  "Every declared option below is mapped to production implementation and existing behavioural tests, or to an explicitly designated cross-package boundary. Declaration extraction alone does not prove runtime semantics; the cited tests are the authority.",
  "",
  "| public operation/option | behaviour in this candidate | test proof |",
  "| --- | --- | --- |",
  "| `createSekibanExecutor(transport, options?)` | builds the facade over one adapter | `test/g57-executor.spec.ts` AC1–AC3 |",
  "| `options.serviceId` | when both it and `transport.serviceId` are set and differ, every `execute` returns `invalid` / `scope.mismatch` without committing | `test/g57-executor.spec.ts:382` |",
  `| \`options.clock\` | time source for command decisions; defaults to \`Date.now\` | behavioural coverage: none dedicated at surface hash ${code(hash)}; related coverage: used at \`test/g57-executor.spec.ts:193\`; status: documented freeze gap; not designated for removal |`,
  "| `execute(command, input, options?)` | runs the command against snapshots or reads, commits, and returns `ExecuteCommandResult` with nine `kind` values | `test/g57-executor.spec.ts` AC1–AC3; exhaustiveness in the packed consumer fixture |",
  "| `ExecuteCommandOptions.snapshots` | an array of `PortableSnapshot` or a `SnapshotReader`; covered cells are not read | `test/g57-executor.spec.ts:178`, `:269` |",
  "| `ExecuteCommandOptions.readMode` | `read-through` (default) or `snapshot-only`; snapshot-only makes zero reads, fails closed on an uncovered claim and forces zero conflict retries | `test/g57-executor.spec.ts:178` |",
  "| `ExecuteCommandOptions.maxConflictRetries` | default `1`, no cap; invalid values return `invalid_execute_options` before any commit; `0` returns the typed conflict without retrying; exhausted conflict stays typed | `test/g57-executor.spec.ts:362`, `:389`, `:404`, `:775`; snapshot-only validation at `:178` |",
  "| `ExecuteCommandOptions.signal` | forwarded to reads and commit; abort before dispatch returns `timeout` / `aborted`; abort during commit returns the classified outcome | `test/g57-executor.spec.ts:516`, `:537`, `:640`; read-through classification at `test/g71-read-contract.spec.ts:432` |",
  "| `ExecuteCommandOptions.totalBudgetMs` | enforced on reads and commit; invalid values return `invalid_execute_options` before any adapter call; expiry returns `timeout` | `test/g57-executor.spec.ts:446`, `:498`, `:516`, `:537`, `:555` |",
  "| `readState(projector, tag, options?)` | authority read first; payload-dependent existence; bounded reconciliation; requires `readTagLatestSortable` | `test/g71-read-contract.spec.ts:298`, `:327`, `:345`, `:365`, `:383`, `:398` |",
  "| `exists(tag, options?)` | authority read only; requires `readTagLatestSortable` | `test/g71-read-contract.spec.ts:298`, `:383`, `:593`, `:611` |",
  "| `query(request, options?)` | serialized result only; embedded `consistency` refused | `test/g71-read-contract.spec.ts:414`, `:460`, `:576`; `test/g78-error-classification.spec.ts:56` |",
  "| `ReadOptions.signal` | forwarded to `readState`, `exists` and `query` | `test/g78-error-classification.spec.ts:56` |",
  "| `ReadOptions.consistency` | not in the type; runtime refusal `unsupported_consistency_mode` / `400` | `test/g71-read-contract.spec.ts:414`; packed consumer compile rejection |",
  "| `listQuery(request, options?)` | returns the page and durable `readHead` when supplied | `test/g71-read-contract.spec.ts:460`, `:499`, `:543`, `:648`; `test/g71-composition.spec.ts:255` |",
  "| `ListQueryOptions.consistency` | `safe` or `unsafe` written into `queryParamsJson` | `test/g71-read-contract.spec.ts:414`; `test/g71-composition.spec.ts:255` |",
  `| \`ListQueryOptions.signal\` | forwarded to \`transport.listQuery\` | behavioural coverage: none dedicated at surface hash ${code(hash)}; related coverage: \`packages/dcb-client/src/executor.ts:731\`; status: documented freeze gap; not designated for removal |`,
  "| facade HTTP 400/422/500/503 and thrown errors | classified through the shared table (`invalid`, `rejected`, `transport`, `unavailable`, `timeout`, `partial`, `conflict`) | `test/g78-error-classification.spec.ts`; `test/g57-executor.spec.ts:775` |",
  "| code-less commit HTTP 5xx | `timeout` / `unknown_outcome` | `test/g78-error-classification.spec.ts` matrix rows |",
  "| post-dispatch `timeout`, `transport`, commit-side `unavailable` | outcome-unknown; reconcile before retry; no blind reissue | `test/g76-regression-matrix.spec.ts`; policy below |",
  "| adapter-backed live-read `INCOHERENT_SNAPSHOT` | `transport` / `incoherent_read_snapshot`; no automatic retry | `test/g57-executor.spec.ts:888` |",
  "| supplied or snapshot-only `INCOHERENT_SNAPSHOT` | `invalid` / `domain_authoring_error` | `test/g57-executor.spec.ts:921` |",
  "| `ClaimLedgerExecutor.execute` | accepts only function commands; validates options before any call | `test/g13-client.spec.ts`; `test/g78-error-classification.spec.ts` |",
  "| `ClaimLedgerExecutorOptions.maxConflictRetries` | default `0`; cap `1`; invalid values refused; bounded full-jitter backoff before one retry | `test/g13-client.spec.ts:353`, `:363`, `:389` |",
  "| `ExecuteOptions.maxConflictRetries` / `totalBudgetMs` | same validation and budget semantics on the legacy executor path | `test/g13-client.spec.ts:244`, `:260`, `:353` |",
  "| `CommitHttpResult.headers` | populated on every built-in HTTP adapter response; never copied into executor results or `ClientError` | `test/g13-client.spec.ts:441`, `:479`; `packages/dcb-client/src/index.ts` `httpResult` |",
  "| `ExecuteCommandResult.status` including `\"conflict\"` | domain session reports exhausted conflict explicitly | `test/dcb-domain.spec.ts:808`, `:914`; packed consumer exhaustive switch |",
  "| `ExecuteCommitted.value` | done decision value carried on committed facade results | `test/g57-executor.spec.ts:708` |",
  "| `ExecutorRejected.rejectKind` / `.details` | present only for handler reject decisions | `test/g57-executor.spec.ts:708` |",
  "| unified classification table | one code-to-kind mapping shared by facade and ClaimLedgerExecutor | `test/g78-error-classification.spec.ts:318` |",
  "| `deliveryPolicyFromDomain` | new public domain export; default `queued`; rejects undeclared delivery classes and duplicate view ids | `test/dcb-domain.spec.ts:1075` |",
  "| view `deliveryClass` | `immediate-preferred` or `queued`; default `queued` when omitted | `test/dcb-domain.spec.ts:1075`; `test/g29-delivery.spec.ts:146` |",
  "| schema-based restore | restored projector state parsed through `state.parse`; unknown keys stripped by schema | `test/dcb-domain.spec.ts:1049`, `:1072` |",
  "| runtime bridge rejected `reason` / `code` | surfaced from port results, not unwrapped errors | `test/dcb-domain.spec.ts:1270` |",
  "| `RuntimeProjectionEvent.eventTags` | non-empty stored tags used; `[]` throws `RUNTIME_EVENT_TAGS_EMPTY`; absent uses host per-tag legacy routing | `test/g29-meeting-room.spec.ts:181`, `:201`; `test/dcb-domain.spec.ts:1385` |",
  "| `SekibanCloudTransportOptions` (`BaseUrl`, `ServiceId`, `CredentialId`, `CredentialSecret`, `fetch`) | retained type-only boundary; designated implementer `@sekiban/cloud-client`; **not implemented in this repository and not published** | `test/g78-error-classification.spec.ts`; type-only export in packed `@sekiban/dcb-client` |",
  "| `packages/dcb-client/src/classification.ts` | module-internal; not exported from the public root | `docs/SDT-G74-export-classification.json` reviewedModuleInternal; surface guard |",
  "",
  "### Intentional removals recorded by prerequisites (not in v1)",
  "",
  "| removed declaration | removed by | evidence |",
  "| --- | --- | --- |",
  "| `createSekibanCloudTransport` value export | SDT-G78 | `test/g78-error-classification.spec.ts`; 0.1.0 comparison below |",
  "| `CommandDefinition` / `CommandOutcome` re-exports from `@sekiban/dcb-client` | SDT-G87 | explicit dcb-client barrel; packed consumer |",
  "| `ClientCommandDecision.envelope` | SDT-G87 | `test/g13-client.spec.ts:299` |",
  "| `ExecuteCommon.cause`, `ExecuteConflict.response`, `ExecuteCommitted.response` on client execute results | SDT-G87/G88 | `test/g13-client.spec.ts`; `test/g57-executor.spec.ts:708` |",
  "| `cloneAndFreeze` export | SDT-G88 | removed from dcb-domain root |",
  "| `StateUnion.discriminator` / `stateUnion`/`state` discriminator option | SDT-G88 | removed; WasmRuntime impact |",
  "| `CommandDone.state` / `CommandCommitted.state` | SDT-G88 | removed from dcb-core |",
  "| `TState` on defineCommand and command types | SDT-G88 | removed from dcb-core |",
  "| `done()` state parameter | SDT-G88 | removed from dcb-core |",
  "| `RuntimeProjectionEvent.eventId` / `.suid` | SDT-G89 | bridge/runtime tests in `test/dcb-domain.spec.ts` |",
  "",
  "## Compatibility policy",
  "",
  "### Contract identity and the 0.x carrier",
  "",
  `The contract is identified by the pair of its label ${code(contractLabel)} and its public surface hash. The npm version only carries it. Because the carrier is a 0.x version, the following policy is stated independently of the number and is stronger than what semver alone says about 0.x:`,
  "",
  `1. **Patch releases of ${code("0.2.x")}** carry the same label and the same surface hash. A build whose packed surface hash differs is not a valid ${code("0.2.x")} carrier. A patch may fix behaviour only where no documented outcome kind, error code or status, capability requirement or adapter obligation changes.`,
  `2. **Any reviewed surface change, even an additive one,** moves to a new minor version (${code("0.3.0")} and so on), because a caret range on 0.x admits only patches. An additive change keeps the label ${code(contractLabel)}, and this document records the new hash together with its review.`,
  `3. **A breaking change** moves the label to ${code("executor-facade-v2")}, moves the carrier to a new minor while it is 0.x (a new major from 1.0.0 on), records the new hash, and ships a migration note in that release's notes.`,
  "4. **What a consumer observes for a break:** the label changes, the surface hash changes, and the version moves outside a caret range on the previous carrier. None of the three happens silently.",
  "5. **1.0.0:** when a semver-stable carrier is chosen, `1.0.0` carries the label current at that time, and rules 2 and 3 then map to minor and major releases.",
  "",
  "What is enforced mechanically, and what is not: the `foundation-g74` CI lane makes every pull request fail if the packed surface differs from the committed baseline, so the surface cannot change without a reviewed baseline commit. Whether the carrier version moves as rules 1–3 require is not checked by CI; it is checked in the review of that baseline commit and in release preparation, which must run the same guard on the commit it tags. The label and hash are recorded in this repository, not inside the published packages.",
  "",
  "### Additive changes",
  "",
  "A new optional export, optional field, or non-breaking overload is additive only after its declaration shape, runtime namespace, reachable types, inference and exports-map behavior are reviewed. It must not change an existing discriminated result, make a previously optional adapter method operationally required, or alter a documented refusal/abort/unknown outcome. Baseline updates are explicit reviewed decisions; a generator never accepts its own output as the new expectation.",
  "",
  "### Breaking changes",
  "",
  "Removing/renaming an export, changing parameter position or requiredness, changing overload order or generic constraints/defaults, narrowing accepted input, widening a result discriminant or adding a result variant, changing return/member/brand/unique-symbol shape, changing a reachable non-exported declaration, changing a required adapter operation, or changing the module type, Node floor or export conditions is breaking. Known refusal, abort, timeout, partial-write and unknown semantics are part of the behavioural contract, while exact prose, stack traces, logs and telemetry are not unless separately enumerated.",
  "",
  "### Bounded exclusions and post-dispatch policy",
  "",
  "The following are not promised by this facade freeze: backend implementation choice, connection pooling, fetch internals, scheduling, sample/UI/deployment resources, private runtime APIs, undocumented cache/topology, arbitrary lexical arithmetic on opaque SUIDs, internal allocator lineage/attempt encoding, a service-level latency percentile, or schema inside explicitly unknown extension payloads. These exclusions do not waive exposed head round-tripping, empty/null meaning, validation/rejection, service isolation, secret non-disclosure, explicit caller budget/cancellation/wait semantics, or shipped HTTP interoperability. Wire implementations and their independent contracts remain intact; excluding a backend does not change the adapter-level operation contract.",
  "",
  "**Post-dispatch unknown outcomes (AC6).** A code-less commit HTTP response at status 500 or above is classified as `timeout` / `unknown_outcome`. After dispatch, `timeout`, `transport`, and commit-side `unavailable` outcomes do not prove that no write occurred: the commit-path caller reconciles before retrying and never blindly reissues. Read-side fallback semantics are unchanged. A partial result never silently becomes safely retryable. Adapter-backed live-read `INCOHERENT_SNAPSHOT` is `transport` / `incoherent_read_snapshot` with no automatic retry; supplied or snapshot-only incoherence is `invalid` / `domain_authoring_error`.",
  "",
  "### Consumer-visible error classification (AC6)",
  "",
  "The table below is checked against `docs/SDT-G74-classification-policy.json` and `packages/dcb-client/dist/classification.js` `FAILURE_KINDS` (the same runtime map the G78 guard loads). It records separate caller actions for read and commit paths so `projection_unavailable` unambiguously renews the read budget before retrying projection work while a post-dispatch commit-side `unavailable` requires reconciliation.",
  "",
  "| code | result kind | read-path caller action | commit-path caller action |",
  "| --- | --- | --- | --- |",
  ...classificationPolicy.rows.map((row) =>
    `| ${code(row.code)} | ${code(row.kind)} | ${text(row.readPathAction)} | ${text(row.commitPathAction)} |`),
  "",
  `Evidence: ${code(classificationPolicy.evidence)}; generator ${code("scripts/g74-contract-check.mjs")}.`,
  "",
  "## Dated risks and prerequisite status",
  "",
  "Naming these risks authorizes no runtime fix.",
  "",
  "| risk | observed basis and date | contract disposition |",
  "| --- | --- | --- |",
  ...datedRisks.rows.map((row) =>
    `| ${text(row.risk)} | ${text(row.observedBasis)} (${code(row.evidence)}) | ${text(row.disposition)} |`),
  "",
  "These are bounded, dated risks rather than an open-ended exception permitting arbitrary retroactive change. A stable API shape does not make the service production-ready. The first consultation, posted on 2026-09-13, described the ordering gap as owned by G69/G70 with AC4/AC5 open, and dated the latency window 2026-09-08; both were wrong at the time and are corrected here and in the re-consultation.",
  "",
  "## Drift and export-addition proofs",
  "",
  "`node scripts/g74-surface-guard.mjs` re-extracts the packed candidate and compares it with the committed baseline: schema, TypeScript version, both hashes and every drifted section. `node scripts/g74-drift-mutation-runner.mjs` packs the three packages once, proves that an unmutated extraction reproduces the baseline hash, and then edits the extracted release artifact itself for each mutant, re-runs the real extractor, and compares the result with the baseline section by section. A mutant is `RED` only when the hash moves **and** every section it targets is among the drifted ones; one that breaks extraction is `INVALID`, one that leaves the hash unchanged is `MISSED`, and one that moves only unrelated sections is `WRONG_SECTION`. A negative control must leave the hash `UNCHANGED`.",
  "",
  "| mutant | targeted section | artifact edit |",
  "| --- | --- | --- |",
  "| `removed-export` | entryPoints | delete `preflightCommit` from the dcb-client declarations |",
  "| `renamed-export` | entryPoints | rename `preflightCommit` |",
  "| `parameter-change` | entryPoints | add a required parameter to `preflightCommit` |",
  "| `return-change` | entryPoints | change `preflightCommit` to return `boolean` |",
  "| `type-widening` | entryPoints | add `undefined` to core `JsonPrimitive` |",
  "| `type-narrowing` | entryPoints | narrow core `JsonPrimitive` to `string` |",
  "| `public-root-export-addition` | entryPoints | add a declaration through the dcb-client public root |",
  "| `adapter-optional-member-required` | entryPoints | make `readTagLatestSortable` required |",
  "| `type-only-value-reexport` | entryPoints | re-export the `ClientError` class with `export type` |",
  "| `reachable-nonexported-optional-to-required` | reachableDeclarations | make `LegacyEventDefinition.name` required |",
  "| `reachable-nonexported-parameter-widening` | reachableDeclarations | widen the non-exported `CommandLike` to `CommandDefinition<any, any>` |",
  "| `brand-identity-collapse` | reachableDeclarations | declare `parsedBoundaryBrand` as `typeof eventPayloadBrand` |",
  "| `engine-floor-change` | packages | lower the dcb-client Node floor to `>=18` |",
  "| `export-condition-addition` | packages | add a `require` condition to the dcb-client export |",
  "| `export-condition-reorder` | packages | put `import` before `types` |",
  "| `peer-dependency-addition` | packages | add a `peerDependencies` field |",
  "| `side-effects-removal` | packages | remove `sideEffects: false` |",
  "| `internal-dependency-loosened` | packages | change the exact `@sekiban/dcb-core` pin to a caret range |",
  "| `reference-lib-directive` | declarationFiles | add `/// <reference lib=\"dom\" />` at the top of the dcb-client declarations |",
  "| `global-augmentation` | declarationFiles | add a `declare global` augmentation of `Array` |",
  "| `member-jsdoc-only` (negative control) | none; hash must stay unchanged | reword the JSDoc of `ListQueryResponse.readHead` |",
  "",
  "A module-type flip cannot be expressed as a resolvable artifact (TypeScript rejects CommonJS declarations importing an ES module, TS1479), so its participation in the hash is proven on the model instead, together with the proof that a release version bump does not participate. The source classification check takes the executor module's exports from the type checker and requires a newly unclassified `interface`, `enum`, `namespace` and `export *` each to fail. The guard's in-memory JSON cases remain only as comparator unit tests and are not counted as drift proofs.",
  "",
  "The packed consumer check adds compile-time proofs that a declaration diff cannot give. One fixture must compile as written while carrying labelled `@ts-expect-error` rejections; the same file with the directives blanked must fail on exactly those lines with the diagnostic each label names. It covers `consistency` on `readState`, `exists` and `query`; exhaustive switches over the facade result, `ExecuteResult`, and dcb-domain `ExecuteCommandResult.status` including `\"conflict\"`, each with a missing-case negative twin whose `@ts-expect-error` is consumed; the nine-kind discriminant not widening to `string`; and literal inference for `tagFamily`, a tag and an event name. Five declaration mutants applied to the installed packages must each turn that fixture red inside the fixture, and a control proves an unused `@ts-expect-error` is itself an error.",
  "",
  "The client executor barrel is explicit and all 15 source executor exports are classified public in `docs/SDT-G74-export-classification.json`, a proposal accepted only through the independent pull-request review. `packages/dcb-client/src/classification.ts` is recorded module-internal in the ledger's `reviewedModuleInternal` list. `deliveryPolicyFromDomain` is a new public domain export recorded in the routed-items model, not the executor ledger. An internal-only executor export is not allowed to silently enter the public contract, while a deliberate root export addition is independently caught. The domain/core wildcard barrels are followed by the extractor and are not blanket-rewritten.",
  "",
  "### AC5 explicit-barrel equivalence",
  "",
  "`node scripts/g74-barrel-equivalence.mjs` extracts the release-shaped candidate twice: once with the committed explicit executor re-exports and once with the packed `packages/dcb-client/dist/index.d.ts` edited to `export * from \"./executor.js\"` (via `--mutate scripts/fixtures/g74-barrel-wildcard-mutate.json`). The proof passes when the two independently extracted models have identical export name/namespace sets and `publicSurfaceHash` matches — only the alias flag differs. A self-test removes one explicit export and requires RED. A ledger-root cross-check in `node scripts/g74-surface-guard.mjs` requires every ledger-public executor export to reach the client root.",
  "",
  "## Version designation and migration from 0.1.0",
  "",
  `The candidate graph is \`@sekiban/dcb-core@0.2.0\`, \`@sekiban/dcb-domain@0.2.0\`, and \`@sekiban/dcb-client@0.2.0\`. The contract label is ${code(contractLabel)}; the carrying package version selected for it is ${code(carryingVersion)}; no npm publication has been observed or performed. Source \`0.1.1\` was never published and is not a migration target.`,
  "",
  `The comparison baseline is tag ${code("dcb-v0.1.0")} at ${code("7353b987e94a999d60ec6b41b1df2387efb11ac5")}. Installable registry tarballs ${code("@sekiban/dcb-core@0.1.0")}, ${code("@sekiban/dcb-domain@0.1.0")} and ${code("@sekiban/dcb-client@0.1.0")} were extracted with the same extractor after the TS2835 specifier normalization disclosed in ${code("docs/SDT-G74-0.1.0-receipt.json")}. Each row below is one contract or informational marker; informational sample-worker rows do not enter the v1 enumeration or baseline hash. The mechanical diff item list is ${code("docs/SDT-G74-diff-items.json")}; routed rows keyed to those ids live in ${code("docs/SDT-G74-routed-items.json")}; ${code("scripts/g74-contract-check.mjs")} fails when a committed diff item lacks a routed row or when a routed row is absent from the contract prose.`,
  "",
  "| routed item | marker | 0.1.0 | 0.2.0 candidate | migration instruction |",
  "| --- | --- | --- | --- | --- |",
  "| cloud transport factory | contract | `@sekiban/dcb-client` exported `createSekibanCloudTransport` as a value | removed from dcb-client root/runtime; `SekibanCloudTransportOptions` type retained | import from `@sekiban/cloud-client` when published |",
  "| read consistency placement | contract | `ReadOptions.consistency` on every read; no wire effect (`test/g71-read-contract.spec.ts:414`) | only `ListQueryOptions.consistency` reaches the wire | move `consistency` to `listQuery` only |",
  "| existence authority | contract | tag-state payload sentinel inferred existence (`test/g71-read-contract.spec.ts:298`) | durable authority via `readTagLatestSortable` | implement authority read on adapters |",
  "| facade 400/422/500/503 classification | contract | ad hoc / partial (`test/g78-error-classification.spec.ts:304`) | unified table | reclassify handlers against table |",
  "| thrown read/commit errors | contract | mixed throw/return | classified into execute result union where applicable | update error handling |",
  "| ClaimLedgerExecutor malformed codes | contract | inconsistent | unified table via shared classification | same as facade table |",
  "| handler/domain-authoring errors | contract | partially surfaced | `invalid` / `domain_authoring_error` | handle new codes |",
  "| exhausted conflict | contract | often ambiguous | explicit `conflict` kind/status | handle exhaustive `conflict` |",
  "| unrecognised commit replies | contract | silent/unknown | `unknown_outcome` / classified transport | reconcile before retry |",
  "| `ExecuteCommandResult.status: \"conflict\"` | contract | absent | present in domain session | update exhaustive switches |",
  "| `ExecuteCommitted.value` | contract | not carried | done value on committed results | read optional `value` |",
  "| `ExecutorRejected.rejectKind` / `.details` | contract | absent (type added at G86) | present for handler rejects | optional fields on reject path |",
  "| `deliveryPolicyFromDomain` export | contract | absent | new public domain export | adopt when configuring delivery |",
  "| schema-validated restore | contract | accepted invalid/unknown keys in some paths | fails closed; unknown keys stripped (G88 N5) | validate persisted state bytes |",
  "| undeclared delivery classes / duplicate view ids | contract | accepted silently | `DomainRegistrationError` at registration | fix view declarations |",
  "| runtime bridge rejected `reason`/`code` | contract | dropped in some paths | preserved from port results (G89) | read rejection fields |",
  "| `eventTags: []` | contract | accepted/ignored | throws `RUNTIME_EVENT_TAGS_EMPTY` (G89) | omit tags or extend ABI |",
  "| live vs supplied `INCOHERENT_SNAPSHOT` | contract | undifferentiated | transport vs domain_authoring_error split (G89) | classify by read path |",
  "| `CommitHttpResult.headers` | contract | optional field present; population varied | populated on every built-in HTTP adapter response | optional field; not copied into executor results |",
  "| facade `totalBudgetMs` / `signal` | contract | declared, partially enforced | enforced on reads and commit (G86) | pass valid budgets/signals |",
  "| ClaimLedger retry/backoff | contract | incorrect/uncapped | default 0, cap 1, full-jitter backoff (G87) | adjust retry expectations |",
  "| removed `CommandDefinition`/`CommandOutcome` client re-exports | contract | exported | removed (G87) | import from domain/core directly |",
  "| removed `ClientCommandDecision.envelope` | contract | present | removed (G87) | stop reading envelope |",
  "| removed execute result fields (`cause`, `response`) | contract | present on some variants | removed (G87/G88) | use typed fields only |",
  "| `cloneAndFreeze` export | contract | exported from dcb-domain | removed (G88) | stop importing |",
  "| `StateUnion.discriminator` / discriminator option | contract | present on union and factories | removed (G88) | update domain authoring |",
  "| `CommandDone.state` / `CommandCommitted.state` | contract | present | removed (G88) | stop reading state members |",
  "| `TState` on defineCommand and command types | contract | present | removed (G88) | simplify command definitions |",
  "| `done()` state parameter | contract | present | removed (G88) | use projector initial state only |",
  "| `ClaimLedgerExecutor.execute` parameter | contract | `CommandLike` | narrowed to `ClientCommand` (G87) | pass function commands |",
  "| `RuntimeCommandPortResult` | contract | single union type | split into `RuntimePort*Result` variants (G89) | read variant fields |",
  "| `RuntimeProjectionEvent.eventId` / `.suid` | contract | present | removed (G89) | stop reading removed fields |",
  "| `ListQueryOptions` / `ReadConsistency` / `ViewDeliveryClass` | contract | absent | new exports (G71/G88) | adopt when needed |",
  "| `CommitAttemptResult.consistency-conflict.error?` | contract | absent | optional member (G89) | read when present |",
  "| `SerializedDcbClient.httpResult` | contract | absent | member added (G87) | optional HTTP trace |",
  "| `ClaimLedgerExecutor.defaultRetries` optionality | contract | required with default | optional with default 0 (G87) | adjust construction |",
  "| Node16 `./index.js` resolution | contract | TS2835 without normalization (receipt) | explicit `.js` imports | narrow on discriminant before fields |",
  "| `createHttpTransport.serviceId` / `ListQueryResponse.readHead` | contract | absent | optional additive fields | none required |",
  "| sample worker HTTP status/body changes | informational | older sample responses | G86 sample worker status/value/rejectKind/details changes | sample-only; not v1 hash |",
  "",
  "## Consumer consultation (AC10)",
  "",
  `AC10 requires each consuming team's named owner to acknowledge receipt of the exact surface hash and the contract label and carrying version, together with the compatibility and risk statement, and to record either no interface-level blocker or a specific objection. Silence past a design-set review window is recorded as an explicit design waiver listing the unanswered items, and is never translated into agreement.`,
  "",
  "The first consultation was posted on 2026-09-13 to SekibanWasmRuntime #283, SekibanAsAService #1914 and Sekiban #1172. All three were silent through its window, and explicit design waivers were recorded at 2026-09-14 08:15 UTC. Those waivers were **withdrawn** at 2026-09-14 09:15 UTC, because the consultation they rested on was defective in three independent ways: the surface hash it quoted is not the hash being frozen (fixing the extractor changed it), it described the ordering-gap risk wrongly, and Sekiban #1172 had been closed since 2026-09-02, so it was not a watched channel. A waiver cannot be issued against silence on a consultation that did not carry the right content through a channel that reaches its owner.",
  "",
  `The consumers are re-consulted on ${code(hash)}, with the corrected risks and capability statement, through open and watched issues and with a new review window. The consultation locations, the window, and the separate received, no-objection, agreed and adopted statuses are recorded in \`docs/SDT-G74-evidence.md\` as they actually arrive. The freeze is not declared until AC10 is decided again after that window.`,
  "",
  "After landing, all three consumers are notified with the immutable enumeration, the package and release status, the migration instructions and the risks, including the note that the first consultation carried the earlier ordering-gap wording.",
  "",
  "## Verification and process disposition",
  "",
  "The issue claim was acquired before source edits and the dedicated branch is `claude/sdt-g74-implementation-w281` rebased onto `origin/main` at `184f6b5d2142a675993f31d22840ddb1f97779b8`. Focused local proof commands are wired as `test:g74:surface`, `test:g74:consumer`, and `test:g74:contract`, and the `foundation-g74` CI lane runs them; the local and hosted results are recorded in the companion evidence document.",
  "",
  "No merge is claimed before approval, and no Full CI run, manual rerun, npm publication or release operation is part of this unit.",
  "",
  `Generated from ${code("docs/SDT-G74-surface-baseline.json")} by ${code("scripts/g74-contract-document.mjs")}; the declaration surface was extracted after the six prerequisite merges on 2026-09-15.`,
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
