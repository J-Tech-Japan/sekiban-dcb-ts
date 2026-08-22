#!/usr/bin/env node
import { readFileSync } from "node:fs";

const contract = JSON.parse(readFileSync("contracts/g32-cutover.json", "utf8"));
const bridgeEvidence = JSON.parse(readFileSync(contract.bridge.evidencePath, "utf8"));
const primary = JSON.parse(readFileSync("samples/meeting-room/wrangler.g32-final-primary.jsonc", "utf8"));
const receiver = JSON.parse(readFileSync("samples/meeting-room/wrangler.g32-final-receiver.jsonc", "utf8"));

function arraysEqual(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function database(config, binding) {
  const found = config?.d1_databases?.find((entry) => entry?.binding === binding);
  if (found === undefined) throw new Error(`G32 final config lacks D1 binding ${binding}`);
  return found;
}

function assertComponentConfig(config, component, expected) {
  if (config?.name !== (component === "primary" ? expected.worker : expected.receiver)) throw new Error(`G32 ${component} worker name is invalid`);
  if (config?.main !== "src/worker.cloudflare-only.ts") throw new Error(`G32 ${component} must deploy the final runtime worker`);
  if (config?.vars?.G32_COMPONENT !== component || config?.vars?.G32_CUTOVER_PHASE !== expected.phase || config?.vars?.G32_FREEZE_RELEASE !== expected.freezeRelease) {
    throw new Error(`G32 ${component} cutover phase/fence config is invalid`);
  }
  if (config?.vars?.G32_PIPELINE_DATABASE_ID !== expected.pipelineDatabase.id || config?.vars?.G32_MATERIALIZED_VIEW_DATABASE_ID !== expected.materializedViewDatabase.id || config?.vars?.G32_QUEUE_NAME !== expected.queue) {
    throw new Error(`G32 ${component} final binding identity is invalid`);
  }
  const pipeline = database(config, "D1");
  const mv = database(config, "D1_MV");
  if (pipeline.database_id !== expected.pipelineDatabase.id || pipeline.database_name !== expected.pipelineDatabase.name || pipeline.migrations_dir !== expected.pipelineDatabase.migrationsDir) throw new Error(`G32 ${component} pipeline D1 config is invalid`);
  if (mv.database_id !== expected.materializedViewDatabase.id || mv.database_name !== expected.materializedViewDatabase.name || mv.migrations_dir !== expected.materializedViewDatabase.migrationsDir) throw new Error(`G32 ${component} MV D1 config is invalid`);
  const classes = (config?.durable_objects?.bindings ?? []).map((entry) => entry?.class_name);
  if (!arraysEqual(classes, expected.durableObjectNamespaces)) throw new Error(`G32 ${component} Durable Object namespaces changed`);
  if (component === "primary") {
    const consumer = config?.queues?.consumers?.[0];
    if (config?.queues?.producers?.[0]?.queue !== expected.queue || consumer?.queue !== expected.queue || consumer?.dead_letter_queue !== expected.deadLetterQueue) {
      throw new Error("G32 primary Queue binding is invalid");
    }
  } else if (config?.queues !== undefined) {
    throw new Error("G32 receiver must remain service-binding-only and have no Queue consumer");
  }
}

export function assertBridgeEvidence(evidence, cutover) {
  if (evidence?.candidateCommit !== cutover.bridge.candidateCommit || evidence?.sourceCommit !== cutover.bridge.candidateCommit || evidence?.protocol?.oldFormatOnly !== true || evidence?.protocol?.freezeOnly !== true) {
    throw new Error("G32 sealed bridge identity/evidence is invalid");
  }
  if (!arraysEqual(evidence?.freezeAcknowledgements?.componentSet ?? [], cutover.final.requiredComponents)) throw new Error("G32 bridge component acknowledgements are incomplete");
  if (!arraysEqual(evidence?.freezeAcknowledgements?.writerEntrypointSet ?? [], cutover.final.requiredWriterEntrypoints)) throw new Error("G32 bridge writer coverage is incomplete");
  if (evidence?.freezePreconditions?.inFlight !== 0 || evidence?.freezePreconditions?.pendingOutbox?.disposition !== "explicitly-discarded") {
    throw new Error("G32 bridge freeze preconditions are incomplete");
  }
  return { bridgeCandidate: evidence.candidateCommit, bridgeCoverage: evidence.freezeAcknowledgements.writerEntrypointSet.length };
}

export function assertCutoverContract(cutover, configs = { primary, receiver }, evidence = bridgeEvidence) {
  if (cutover?.schemaVersion !== 1 || cutover?.task !== "SDT-G32") throw new Error("G32 cutover contract identity is invalid");
  const final = cutover.final;
  if (
    final?.serviceId === cutover.bridge?.oldServiceId ||
    final?.pipelineDatabase?.id === cutover.bridge?.oldPipelineDatabaseId ||
    final?.materializedViewDatabase?.id === cutover.bridge?.oldMaterializedViewDatabaseId ||
    final?.queue === cutover.bridge?.oldQueue
  ) throw new Error("G32 final cutover must use new service, D1 bindings, and Queue");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(final?.serviceId ?? "")) throw new Error("G32 final serviceId is invalid");
  assertBridgeEvidence(evidence, cutover);
  assertComponentConfig(configs.primary, "primary", final);
  assertComponentConfig(configs.receiver, "receiver", final);
  return { serviceId: final.serviceId, queue: final.queue, newDatabaseBindings: 2 };
}

export function runSelfTest() {
  const baseline = assertCutoverContract(contract);
  let wrongDbRed = false;
  try { assertCutoverContract(contract, { primary: { ...primary, vars: { ...primary.vars, G32_PIPELINE_DATABASE_ID: contract.bridge.oldPipelineDatabaseId } }, receiver }); } catch (error) { wrongDbRed = String(error).includes("final binding identity"); }
  if (!wrongDbRed) throw new Error("G32 wrong-DB-binding mutation unexpectedly passed");
  let earlyReleaseRed = false;
  try { assertCutoverContract(contract, { primary: { ...primary, vars: { ...primary.vars, G32_FREEZE_RELEASE: "before-new-bindings" } }, receiver }); } catch (error) { earlyReleaseRed = String(error).includes("phase/fence"); }
  if (!earlyReleaseRed) throw new Error("G32 early-freeze-release mutation unexpectedly passed");
  let partialReceiverRed = false;
  try { assertCutoverContract(contract, { primary, receiver: { ...receiver, queues: { consumers: [{ queue: contract.final.queue }] } } }); } catch (error) { partialReceiverRed = String(error).includes("service-binding-only"); }
  if (!partialReceiverRed) throw new Error("G32 partial-receiver mutation unexpectedly passed");
  let bridgeRed = false;
  try { assertBridgeEvidence({ ...bridgeEvidence, freezeAcknowledgements: { ...bridgeEvidence.freezeAcknowledgements, writerEntrypointSet: [] } }, contract); } catch (error) { bridgeRed = String(error).includes("writer coverage"); }
  if (!bridgeRed) throw new Error("G32 bridge coverage mutation unexpectedly passed");
  return { ...baseline, mutations: ["wrong-db-binding", "early-freeze-release", "partial-receiver", "bridge-entrypoint-missing"] };
}

if (process.env.SDT_G32_CUTOVER_FORCE_FAILURE === "1") throw new Error("SDT-G32 cutover forced failure");
console.log(JSON.stringify(runSelfTest(), null, 2));
