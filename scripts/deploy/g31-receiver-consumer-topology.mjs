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

function readConsumers(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(value)) throw new Error(`G31 Queue consumer list is not an array: ${path}`);
  return value;
}

export function receiverConsumerState(consumers, receiver, primary) {
  if (!Array.isArray(consumers)) throw new Error("G31 Queue consumers must be an array");
  return {
    receiver: consumers.filter((consumer) => consumer?.script === receiver),
    primary: consumers.filter((consumer) => consumer?.script === primary),
  };
}

export function assertPrimaryConsumerExclusive(consumers, receiver, primary) {
  const state = receiverConsumerState(consumers, receiver, primary);
  if (state.receiver.length > 0) throw new Error(`G31 receiver ${receiver} must not be a Queue consumer`);
  if (state.primary.length !== 1) throw new Error(`G31 primary ${primary} must be the sole Queue consumer`);
  if (consumers.length !== 1) throw new Error("G31 Queue must have exactly one Worker consumer");
  return { primaryConsumer: state.primary[0], consumerCount: consumers.length };
}

export function needsReceiverConsumerRemoval(consumers, receiver, primary) {
  return receiverConsumerState(consumers, receiver, primary).receiver.length > 0;
}

function main() {
  const mode = argument("--mode", "record");
  const receiver = required("--receiver", argument("--receiver"));
  const primary = required("--primary", argument("--primary"));
  if (mode === "needs-removal") {
    const needed = needsReceiverConsumerRemoval(readConsumers(required("--input", argument("--input"))), receiver, primary);
    console.log(JSON.stringify({ receiver, primary, removalRequired: needed }, null, 2));
    process.exitCode = needed ? 0 : 1;
    return;
  }
  if (mode !== "record") throw new Error(`G31 Queue consumer topology mode is invalid: ${mode}`);
  const queue = required("--queue", argument("--queue"));
  const before = readConsumers(required("--before", argument("--before")));
  const after = readConsumers(required("--after", argument("--after")));
  const removed = argument("--removed", "false") === "true";
  const beforeState = receiverConsumerState(before, receiver, primary);
  if (beforeState.receiver.length > 0 && !removed) throw new Error("G31 receiver consumer was present but not removed");
  if (beforeState.receiver.length === 0 && removed) throw new Error("G31 receiver consumer removal was claimed without a receiver consumer");
  const finalState = assertPrimaryConsumerExclusive(after, receiver, primary);
  const evidence = {
    task: "SDT-G31",
    queue,
    receiver,
    primary,
    receiverConsumerRemoved: removed,
    before,
    after,
    primaryExclusive: true,
    primaryConsumer: finalState.primaryConsumer,
  };
  const output = required("--output", argument("--output"));
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(evidence, null, 2));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
