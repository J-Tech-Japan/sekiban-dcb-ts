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
  "> Status: `CANDIDATE, BLOCKED — prerequisite units SDT-G88, SDT-G86, SDT-G87 and SDT-G89 must land first; the surface hash below will change; AC10 consultation waits for the final hash; the freeze is not declared.`",
  "",
  "This document is the readable companion to `docs/SDT-G74-surface-baseline.json`. It records the release-shaped candidate as extracted on 2026-09-14 with the second version of the extractor. It does not assert publication, downstream runtime conformance, or consumer agreement. The machine model is authoritative for the complete declaration graph; this document makes the complete exported-name set reviewable.",
  "",
  "## Candidate and prerequisites",
  "",
  "| fact | value |",
  "| --- | --- |",
  `| source candidate | ${code("origin/main a0d6add00fe940dced471fdd5ff14a389c0545df")} plus this branch; origin/main had not moved when the model was regenerated |`,
  `| SDT-G71 prerequisite | ${code("102d65f545292634cc43022ad4ebb3e0f2adc877")} (#161, 2026-09-10) |`,
  `| SDT-G78 prerequisite | ${code("a0d6add00fe940dced471fdd5ff14a389c0545df")} (#175, 2026-09-12; source head ${code("8fd8598dfec0b820d1d44669bc2bb5a2e1cd8940")}) |`,
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
  "Every declared option is listed. A test path is cited only where the test exercises that option; where none does, the row says so.",
  "",
  "| public operation/option | behaviour in this candidate | test proof |",
  "| --- | --- | --- |",
  "| `createSekibanExecutor(transport, options?)` | builds the facade over one adapter | `test/g57-executor.spec.ts` AC1–AC3 |",
  "| `options.serviceId` | when both it and `transport.serviceId` are set and differ, every `execute` returns `invalid` / `scope.mismatch` without committing | `test/g57-executor.spec.ts:379` |",
  "| `options.clock` | time source for command decisions; defaults to `Date.now` | used at `test/g57-executor.spec.ts:190`; no test asserts its value |",
  "| `execute(command, input, options?)` | runs the command against snapshots or reads, commits, and returns `ExecuteCommandResult` with nine `kind` values | `test/g57-executor.spec.ts` AC1–AC3; exhaustiveness and inference in the packed consumer fixture |",
  "| `ExecuteCommandOptions.snapshots` | an array of `PortableSnapshot` or a `SnapshotReader`; covered cells are not read | `test/g57-executor.spec.ts:178`, `:269` |",
  "| `ExecuteCommandOptions.readMode` | `read-through` (default) or `snapshot-only`; snapshot-only makes zero reads, fails closed on an uncovered claim and forces zero conflict retries | `test/g57-executor.spec.ts:178` |",
  "| `ExecuteCommandOptions.maxConflictRetries` | default `1`; `0` returns the typed conflict without retrying | `test/g57-executor.spec.ts:362` |",
  "| `ExecuteCommandOptions.signal` | **partial at this head:** passed to `transport.commit` only; the reads a read-through `execute` makes do not receive it. SDT-G86 makes it reach reads and be checked before each commit, before the freeze | no executor-level test yet |",
  "| `ExecuteCommandOptions.totalBudgetMs` | **not implemented at this head:** declared but not read by `SekibanExecutor.execute`, exactly as in 0.1.0. SDT-G86 implements it before the freeze | no executor-level test yet; `ClaimLedgerExecutor` budget at `test/g78-error-classification.spec.ts:87` |",
  "| `readState(projector, tag, options?)` | authority read first; an authoritative absence returns `exists: false` without a tag-state read; a bounded two-observation reconciliation otherwise, failing `read_unavailable` / `503`; requires the capability above | `test/g71-read-contract.spec.ts:298`, `:327`, `:345`, `:365`, `:383`, `:398` |",
  "| `exists(tag, options?)` | authority read only; requires the capability above | `test/g71-read-contract.spec.ts:298`, `:383`, `:593`, `:611` |",
  "| `query(request, options?)` | serialized result only, no head; a `consistency` member embedded in `queryParamsJson` is refused with `unsupported_consistency_mode` | `test/g71-read-contract.spec.ts:414`, `:460`, `:576`; abort and refusal at `test/g78-error-classification.spec.ts:56` |",
  "| `ReadOptions.signal` | forwarded to the adapter call of `readState`, `exists` and `query` | `test/g78-error-classification.spec.ts:56` (query) |",
  "| `ReadOptions` with `consistency` | not in the type; a JavaScript caller that passes it gets `unsupported_consistency_mode` / `400` | `test/g71-read-contract.spec.ts:414`; compile-time rejection in the packed consumer fixture |",
  "| `listQuery(request, options?)` | returns the page and its durable `readHead` when supplied | `test/g71-read-contract.spec.ts:460`, `:499`, `:543`, `:648`; `test/g71-composition.spec.ts:255` |",
  "| `ListQueryOptions.consistency` | `safe` or `unsafe`, written into `queryParamsJson`; omitted leaves the request unchanged; a different embedded value is `consistency_conflict` / `400`; an invalid embedded value is `invalid_consistency` / `400`; non-JSON parameters are `invalid_query_request` | `test/g71-read-contract.spec.ts:414`; `test/g71-composition.spec.ts:255` |",
  "| `ListQueryOptions.signal` | forwarded to `transport.listQuery` | no dedicated test |",
  "| `createHttpTransport({ baseUrl, headers?, fetch?, serviceId? })` | POSTs to the serialized V1 paths under `baseUrl` with a trailing slash removed; `headers` are merged after `content-type`; `fetch` defaults to the global fetch; `serviceId` is recorded on the adapter | `test/g57-executor.spec.ts:141` (baseUrl, headers, fetch); `test/g71-read-contract.spec.ts:83` |",
  "| `createInProcessTransport(bindings, { serviceId? })` | uses base URL `https://runtime.internal` over the first of `bindings.fetch`, `bindings.RUNTIME.fetch`, `bindings.runtime.fetch`; none present is `ClientError` code `transport` | `test/g57-executor.spec.ts:144` (fetch, serviceId); `test/g71-read-contract.spec.ts:83`, `:675`; the `RUNTIME` form through the sample transport in `test/g31-sample.spec.ts:77`; the lower-case `runtime` form has no dedicated test |",
  "| `RuntimeBindings` | the three binding shapes above | as `createInProcessTransport` |",
  "",
  "The matrix reuses prerequisite behavioural evidence; declaration extraction alone does not prove a declared option works. **This matrix is not final.** An audit of every option in the three packages (2026-09-14) found 21 declared options that nothing implements, 7 partially implemented and 4 unclear, together with defects in `executeCommand`, `ClaimLedgerExecutor` and the facade's result classification. By design ruling they are all implemented or removed by the prerequisite units SDT-G88, SDT-G86, SDT-G87 and SDT-G89 before this contract is frozen, and this matrix is rewritten against the head that results.",
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
  "### Bounded exclusions",
  "",
  "The following are not promised by this facade freeze: backend implementation choice, connection pooling, fetch internals, scheduling, sample/UI/deployment resources, private runtime APIs, undocumented cache/topology, arbitrary lexical arithmetic on opaque SUIDs, internal allocator lineage/attempt encoding, a service-level latency percentile, or schema inside explicitly unknown extension payloads. These exclusions do not waive exposed head round-tripping, empty/null meaning, validation/rejection, service isolation, secret non-disclosure, explicit caller budget/cancellation/wait semantics, or shipped HTTP interoperability. Wire implementations and their independent contracts remain intact; excluding a backend does not change the adapter-level operation contract.",
  "",
  "## Dated risks and prerequisite status",
  "",
  "| risk | observed basis and date | contract disposition |",
  "| --- | --- | --- |",
  "| allocator-to-source ordering gap | SDT-G69 [#133](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/133) was closed `not_planned` on 2026-09-10T09:22:54Z by design ruling: its AC1 was negative (the G44/G62 gate does not close the allocation-to-durable-arrival gap), so AC4 and AC5 were ruled out rather than left undone. SDT-G70 [#137](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/137) was closed `not_planned` on 2026-09-09T09:27:56Z and split into ordered parts. The remaining gap is carried by SDT-G77 [#154](https://github.com/J-Tech-Japan/sekiban-dcb-ts/issues/154), open when checked at 2026-09-14T09:23:55Z | open; v1 adds no ordering guarantee. If closing the gap needs a change to this facade surface or to a documented outcome, that change is reviewed under the policy above and is not absorbed silently |",
  "| safe-lane latency | SDT-G66 run `sdtg66w164-8042cfc`, 2026-09-07T19:17:49.862Z to 19:20:30.920Z, source `8042cfcbc7cd5ea207473e62d12aa478b2afc990`, Worker version `f9b2b714-53e5-4b8c-bda9-6c4d35c6389e` at 100% traffic, receipt `.artifacts/sdt-g66-w164-production-corrected.json`, published by #135 on 2026-09-07. Cohort paced at 10,000 ms (actual spacings 11,965–12,959 ms); safe response-relative p50/p95 `45,355/55,942 ms`, 10/10 within the unchanged 180,000 ms bound | an observed figure with its run identity, not an SLA and not a changed timeout. It was not re-measured at this candidate; G71, G75, G76 and G78 landed after it |",
  "| cloud transport migration target unpublished | `@sekiban/cloud-client` returned E404 from the npm registry at 2026-09-14T09:23:55Z; its implementation and publication belong to SekibanCloud | a 0.1.0 consumer of `createSekibanCloudTransport` cannot complete the migration below until that package is published |",
  "| prerequisite surface | G71 merge `102d65f545292634cc43022ad4ebb3e0f2adc877`; G78 merge `a0d6add00fe940dced471fdd5ff14a389c0545df`, source head `8fd8598dfec0b820d1d44669bc2bb5a2e1cd8940` | both landed before extraction; their semantics are enumerated, not changed |",
  "| published graph | registry check at 2026-09-14T09:23:55Z: `@sekiban/dcb-core`, `@sekiban/dcb-domain` and `@sekiban/dcb-client` list only `0.1.0`; `@sekiban/dcb-runtime` is E404; the candidate source packages are `0.2.0` | comparison facts; no publication is claimed |",
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
  "The packed consumer check adds compile-time proofs that a declaration diff cannot give. One fixture must compile as written while carrying eleven labelled `@ts-expect-error` rejections; the same file with the directives blanked must fail on exactly those lines with the diagnostic each label names. It covers `consistency` on `readState`, `exists` and `query`; exhaustive switches over the facade result and `ExecuteResult`, each with a missing-case rejection; the nine-kind discriminant not widening to `string`; and literal inference for `tagFamily`, a tag and an event name. Five declaration mutants applied to the installed packages must each turn that fixture red inside the fixture, and a control proves an unused `@ts-expect-error` is itself an error.",
  "",
  "The client executor barrel is explicit and all 14 source executor exports are classified public in `docs/SDT-G74-export-classification.json`, a proposal accepted only through the independent pull-request review. An internal-only executor export is not allowed to silently enter the public contract, while a deliberate root export addition is independently caught. The domain/core wildcard barrels are followed by the extractor and are not blanket-rewritten.",
  "",
  "## Version designation and migration from 0.1.0",
  "",
  `The candidate graph is \`@sekiban/dcb-core@0.2.0\`, \`@sekiban/dcb-domain@0.2.0\`, and \`@sekiban/dcb-client@0.2.0\`. The contract label is ${code(contractLabel)}; the carrying package version selected for it is ${code(carryingVersion)}; no npm publication has been observed or performed. Source \`0.1.1\` was never published and is not a migration target.`,
  "",
  "The comparison baseline is tag `dcb-v0.1.0` at `7353b987e94a999d60ec6b41b1df2387efb11ac5`, the commit the matched 0.1.0 release was published from according to `docs/SDT-G64-evidence.md`. It was built from source and extracted with the same extractor and the same normalization; the published tarballs themselves were not downloaded. The differences are:",
  "",
  "| difference | 0.1.0 | 0.2.0 candidate | migration instruction |",
  "| --- | --- | --- | --- |",
  "| cloud transport factory | `@sekiban/dcb-client` exports `createSekibanCloudTransport(options: SekibanCloudTransportOptions): SerializedDcbTransport` as a value | removed from the dcb-client root and runtime namespace; the `SekibanCloudTransportOptions` type stays with an unchanged shape | import `createSekibanCloudTransport` from `@sekiban/cloud-client@0.2.0`, the designated target of the 2026-09-12 G78 ruling. That package was not yet published at 2026-09-14T09:23:55Z |",
  "| read consistency option | `ReadOptions.consistency?: \"safe\" \\| \"unsafe\"` on every read, and `listQuery` took `ReadOptions`; the value was forwarded nowhere, so it had no effect | `ReadOptions` has only `signal`; `listQuery` takes `ListQueryOptions` with `consistency`, and `ReadConsistency` is exported | remove `consistency` from `readState`, `exists` and `query` calls (it is now a compile error, and a runtime `unsupported_consistency_mode` for JavaScript callers); pass it to `listQuery`, where it now selects the lane |",
  "| existence and the capability requirement | `readState` read tag-state only and derived `exists` from a payload `status: \"empty\"` sentinel; `exists` alone needed `readTagLatestSortable` and failed with code `transport` without it | `readState`, `exists` and read-through `execute` use the durable authority and fail with `unsupported_capability` / `501` without `readTagLatestSortable`; an existing tag with an empty or sentinel-looking state is reported as existing | a custom adapter implements `readTagLatestSortable` (the built-in transports already do); code that matched `transport` for the missing capability matches `unsupported_capability` |",
  "| Node16 declaration resolution | `dist/executor.d.ts` in dcb-client and `dist/materializedView.d.ts` in dcb-core import `./index` without an extension, which is TS2835 under Node16. With `skipLibCheck`, the names imported there degrade to `any`: `ExecuteCommandResult` and `ListQueryRequest` were both `any` in a Node16 consumer, and fully typed under Bundler | both import `./index.js` and resolve under Node16 | a Node16 consumer whose code compiled only because those types were `any` now narrows on `kind` before reading variant fields; Bundler consumers see no change from this item |",
  "| additive fields | not present | `createHttpTransport` accepts `serviceId?`; `ListQueryResponse` has `readHead?` | none required; both are optional |",
  "| dcb-core, dcb-domain and dcb-domain/testing | — | no surface difference after normalization; dcb-client now depends on core and domain at exactly `0.2.0` | upgrade the three packages together |",
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
  "The issue claim was acquired before source edits and the dedicated branch is `claude/sdt-g74-implementation-w281` from `origin/main` at `a0d6add00fe940dced471fdd5ff14a389c0545df`. Focused local proof commands are wired as `test:g74:surface`, `test:g74:consumer`, and `test:g74:contract`, and the `foundation-g74` CI lane runs them; the local and hosted results are recorded in the companion evidence document.",
  "",
  "No merge is claimed before approval, and no Full CI run, manual rerun, npm publication or release operation is part of this unit.",
  "",
  `Generated from ${code("docs/SDT-G74-surface-baseline.json")} by ${code("scripts/g74-contract-document.mjs")}; the declaration surface was extracted on 2026-09-14.`,
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
