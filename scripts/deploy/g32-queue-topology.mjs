#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function required(name, value) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function consumerScript(consumer) {
  const value = consumer?.script ?? consumer?.worker ?? consumer?.name;
  return typeof value === "string" ? value : null;
}

/** The final receiver is service-binding-only; primary exclusively owns Queue delivery. */
export function assertFinalQueueTopology(consumers, { queue, primary, receiver }) {
  if (!Array.isArray(consumers)) throw new Error("G32 Queue consumer list is not an array");
  const scripts = consumers.map(consumerScript);
  if (scripts.some((script) => script === null)) throw new Error("G32 Queue consumer has no Worker script identity");
  const primaryConsumers = consumers.filter((consumer) => consumerScript(consumer) === primary);
  const receiverConsumers = consumers.filter((consumer) => consumerScript(consumer) === receiver);
  if (receiverConsumers.length !== 0) throw new Error("G32 receiver must not be a Queue consumer");
  if (primaryConsumers.length !== 1 || consumers.length !== 1) throw new Error("G32 primary must be the sole Queue consumer");
  return Object.freeze({
    task: "SDT-G32",
    queue,
    primary,
    receiver,
    consumers,
    primaryExclusive: true,
    receiverServiceBindingOnly: true,
  });
}

export function runSelfTest() {
  const identity = {
    queue: "g32-queue",
    primary: "g32-primary",
    receiver: "g32-receiver",
  };
  const baseline = assertFinalQueueTopology([{ script: identity.primary, batch_size: 10 }], identity);
  let receiverRed = false;
  try { assertFinalQueueTopology([{ script: identity.receiver }], identity); } catch (error) { receiverRed = String(error).includes("receiver"); }
  if (!receiverRed) throw new Error("G32 receiver Queue-consumer mutation unexpectedly passed");
  let extraRed = false;
  try { assertFinalQueueTopology([{ script: identity.primary }, { script: "other" }], identity); } catch (error) { extraRed = String(error).includes("sole"); }
  if (!extraRed) throw new Error("G32 extra Queue-consumer mutation unexpectedly passed");
  return { ...baseline, mutations: ["receiver-consumer", "extra-consumer"] };
}

function main() {
  if (process.argv.includes("--self-test")) {
    console.log(JSON.stringify(runSelfTest(), null, 2));
    return;
  }
  const contract = readJson(argument("--contract", "contracts/g32-cutover.json"));
  const final = contract?.final;
  const input = readJson(required("--input", argument("--input")));
  const evidence = assertFinalQueueTopology(input, {
    queue: required("final.queue", final?.queue),
    primary: required("final.worker", final?.worker),
    receiver: required("final.receiver", final?.receiver),
  });
  const output = argument("--output", ".artifacts/g32-queue-topology.json");
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ queue: evidence.queue, primaryExclusive: evidence.primaryExclusive }, null, 2));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
