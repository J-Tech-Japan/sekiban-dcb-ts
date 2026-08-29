#!/usr/bin/env node
/**
 * SDT-G44's contract guard intentionally checks the source authorities rather
 * than an expected delivery count.  In particular it proves that the source
 * partition registry, D1 receipt join, and detector gate are all present in
 * the implementation that CI exercises.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();

function fail(message) {
  throw new Error(`G44 contract check failed: ${message}`);
}

function read(relative) {
  return readFileSync(resolve(root, relative), "utf8");
}

function requireContains(source, token, context) {
  if (!source.includes(token)) fail(`${context} is missing ${JSON.stringify(token)}`);
}

function requireAbsent(source, token, context) {
  if (source.includes(token)) fail(`${context} must not contain ${JSON.stringify(token)}`);
}

function between(source, begin, end, context) {
  const start = source.indexOf(begin);
  const finish = source.indexOf(end, start + begin.length);
  if (start < 0 || finish < 0) fail(`${context} boundaries are missing`);
  return source.slice(start, finish);
}

function snapshot() {
  const configs = readdirSync(resolve(root, "samples/meeting-room"))
    .filter((name) => /^wrangler\..+\.jsonc$/.test(name))
    .map((name) => [name, read(`samples/meeting-room/${name}`)]);
  return {
    migration: read("migrations/d1/g32/0002_g44_global_completeness.sql"),
    store: read("packages/dcb-runtime/src/store/D1EventStore.ts"),
    tag: read("packages/dcb-runtime/src/tag/TagDurableObject.ts"),
    drain: read("packages/dcb-runtime/src/downstream/OutboxDrain.ts"),
    core: read("packages/dcb-runtime/src/downstream/DeliveryCore.ts"),
    adapter: read("packages/dcb-runtime/src/downstream/DownstreamAdapter.ts"),
    reconciler: read("packages/dcb-runtime/src/completeness/GlobalCompletenessReconciler.ts"),
    cloudflare: read("packages/dcb-runtime/src/cloudflare.ts"),
    sampleWorker: read("samples/meeting-room/src/worker.cloudflare-only.ts"),
    test: read("test/g44-global-completeness.spec.ts"),
    configs,
    rootFiles: readdirSync(root),
  };
}

export function assertG44Contract(value) {
  const { migration, store, tag, drain, core, adapter, reconciler, cloudflare, sampleWorker, test, configs, rootFiles } = value;

  // AC1: D1 has one explicit event/membership/receipt receipt identity and
  // the receiver writes/reads it as a single authority.
  for (const token of [
    'ALTER TABLE dcb_events ADD COLUMN "EventDigest" TEXT;',
    "CREATE TABLE serialized_dcb_source_partitions",
    "CREATE TABLE serialized_dcb_global_memberships",
    "CREATE TABLE serialized_dcb_global_receipts",
    "CREATE TABLE serialized_dcb_completeness_scanner_health",
    "CREATE TABLE serialized_dcb_completeness_findings",
    "UNIQUE (service_id, event_id, event_digest, membership_tag)",
    "CHECK (state IN ('OPEN', 'UNRESOLVED'))",
  ]) requireContains(migration, token, "G44 migration");
  // The explanatory comment is allowed to say which workflow columns do not
  // exist; look for actual DDL column declarations instead.
  for (const forbiddenColumn of ["owner", "acknowledged_by", "corrected_at", "closed_at"]) {
    if (new RegExp(`\\n\\s*${forbiddenColumn}\\s+`, "i").test(migration)) {
      fail(`G44 incident lifecycle contains prohibited column ${forbiddenColumn}`);
    }
  }

  const recordDelivery = between(store, "async recordDelivery(", "async readGlobalReceiptJoin(", "D1 recordDelivery");
  for (const token of [
    'INSERT INTO dcb_events',
    'INSERT INTO serialized_dcb_global_memberships',
    'INSERT INTO serialized_dcb_global_receipts',
    'await this.batch("recordDelivery", statements)',
    "has no readable global receipt/membership join",
  ]) requireContains(recordDelivery, token, "atomic D1 receipt admission");
  requireContains(store, "JOIN serialized_dcb_global_memberships AS membership", "D1 receipt readback");

  // AC2/AC3: only a receipt join can acknowledge a source obligation; its
  // universe is registered on source commit, never observed Queue arrivals.
  const registration = between(tag, "private async registerSourcePartition", "private async appendSql", "source partition registration");
  requireContains(registration, "serialized_dcb_source_partitions", "source registry");
  requireContains(registration, "MAX(obligation_sequence)", "source registry upper bound");
  for (const forbidden of ["DOWNSTREAM_QUEUE", "global_receipts", "planned", "arrival"]) requireAbsent(registration, forbidden, "source registry derivation");
  const sourceAck = between(tag, "private async globalReceiptMatches", "private async registerSourcePartition", "source acknowledgement");
  requireContains(sourceAck, "serialized_dcb_global_receipts", "source receipt readback");
  const mark = between(tag, "async markOutboxDelivered", "private async markSqlOutboxDelivered", "source mark delivered");
  requireContains(mark, "this.globalReceiptMatches", "source mark receipt guard");
  const g44Handoff = between(drain, 'if (options.acknowledgement === "global-receipt")', "const mark", "G44 Queue handoff");
  requireAbsent(g44Handoff, "/outbox/mark-delivered", "G44 Queue handoff");
  requireContains(cloudflare, 'handleOutboxDrainRequest(request, env, { acknowledgement: "global-receipt" })', "Cloudflare G44 drain mode");
  requireContains(adapter, "afterGlobalReceipt", "receiver acknowledgement callback");

  // AC3/AC4/AC5: scanner takes a compound source snapshot, rejects a changed
  // universe, and never lets a finding/health failure silently advance views.
  for (const token of [
    "snapshots = await this.snapshotPartitions(serviceId)",
    "upperBoundSequence",
    "source_partition_set_changed_during_scan",
    "source_page_sequence_outside_snapshot",
    "source_partition_range_incomplete",
    "GLOBAL_ARRAY_RECEIPT_ABSENT",
    "GLOBAL_ARRAY_RECEIPT_UNAVAILABLE",
    "GLOBAL_ARRAY_POISON_OBLIGATION",
    "GLOBAL_ARRAY_SOURCE_PARTITION_UNAVAILABLE",
    "GLOBAL_ARRAY_SCANNER_FAILURE",
    "GLOBAL_ARRAY_DETECTOR_FAILURE",
    "'OPEN'",
    'kind: "BLOCK/UNSETTLED"',
  ]) requireContains(reconciler, token, "source-driven reconciler");
  for (const forbidden of ["DOWNSTREAM_QUEUE", "runnerPlanned", "sinkArrival"]) requireAbsent(reconciler, forbidden, "scanner universe");
  requireContains(tag, 'request.headers.get("x-sdt-g44-source-scan") !== "1"', "private source scan capability");
  requireContains(core, "A detector failure makes global completeness unknown", "detector failure gate");
  const detector = between(core, "// Normative step 3", "const views", "detector phase");
  requireContains(detector, "return result(", "detector failure early return");
  requireContains(detector, "options.onDetectorFailure", "detector health persistence callback");
  requireContains(adapter, "recordDetectorFailure", "D1 detector health authority");
  requireContains(core, "phase: \"completeness\"", "coverage failure classification");
  requireContains(cloudflare, 'scan.kind !== "FULL"', "scheduled scanner gate");
  requireContains(sampleWorker, "globalCoverage", "sample scheduled coverage gate");

  // AC6/AC8: no separate worker/public route and no mixed-version rollout
  // flag. A D1 binding is the global-array authority; a G44 config switch
  // would make normal source commits silently omit their partition.
  if (rootFiles.some((name) => /^wrangler\.g44(?:[.-]|$)/.test(name))) fail("a separate G44 Worker configuration exists");
  for (const [name, config] of configs) {
    if (config.includes("G44_SOURCE_REGISTRY_REQUIRED")) fail(`${name} retains a prohibited G44 rollout flag`);
  }

  // The fixture names are deliberately semantic: this makes removing one of
  // the independent or zero-delivery oracles an observable contract break.
  for (const token of [
    "atomically writes event, tag-local committed membership, and receipt",
    "zero delivery",
    "unreadable, truncated, and mid-scan changed source partitions",
    "g44_fixture_receipt_join_unavailable",
    "detector failure or BLOCK/UNSETTLED coverage blocks every view",
    "GLOBAL_ARRAY_POISON_OBLIGATION\", state: \"OPEN\"",
    "retry-exhausted Queue/DLQ handoff remains an actual enumerable source obligation",
  ]) requireContains(test, token, "G44 fixture inventory");
}

function expectRed(mutator, label) {
  const value = snapshot();
  mutator(value);
  try {
    assertG44Contract(value);
  } catch {
    return;
  }
  fail(`forced-red mutation was accepted: ${label}`);
}

function selfTest() {
  assertG44Contract(snapshot());
  expectRed((value) => { value.store = value.store.replace("INSERT INTO serialized_dcb_global_memberships", "INSERT INTO g44_mutant_memberships"); }, "membership no longer atomic");
  expectRed((value) => { value.tag = value.tag.replace("this.globalReceiptMatches", "this.g44MutantReceiptMatches"); }, "source acknowledgement no longer joins receipt");
  expectRed((value) => { value.reconciler = value.reconciler.replace("snapshots = await this.snapshotPartitions(serviceId)", "snapshots = await this.snapshotArrivals(serviceId)"); }, "arrival-derived scanner universe");
  expectRed((value) => { value.reconciler = `${value.reconciler}\n// DOWNSTREAM_QUEUE`; }, "Queue-derived scanner universe");
  expectRed((value) => { value.reconciler = `${value.reconciler}\n// runnerPlanned`; }, "planned-count scanner universe");
  expectRed((value) => { value.reconciler = value.reconciler.replace("GLOBAL_ARRAY_SOURCE_PARTITION_UNAVAILABLE", "GLOBAL_ARRAY_SOURCE_MUTANT"); }, "source scan failure loses its stable incident type");
  expectRed((value) => { value.core = value.core.replace("A detector failure makes global completeness unknown", "detector warning only"); }, "detector can fall through to views");
  expectRed((value) => { value.adapter = value.adapter.replace("recordDetectorFailure", "recordDetectorHealthMutation"); }, "detector failure does not reach health authority");
  process.stdout.write(`${JSON.stringify({ selfTest: "g44-authority-and-isolation-mutations-red" })}\n`);
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  assertG44Contract(snapshot());
  process.stdout.write(`${JSON.stringify({ result: "g44-global-completeness-contract-passed", separateG44Worker: existsSync(resolve(root, "wrangler.g44-spike.jsonc")) })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
