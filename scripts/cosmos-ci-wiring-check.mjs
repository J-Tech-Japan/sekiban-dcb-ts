import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("..", import.meta.url).pathname;
const workflowPath = process.env.CI_WORKFLOW_PATH ?? `${root}.github/workflows/ci.yml`;
const workflow = await readFile(workflowPath, "utf8");

assert.match(workflow, /cosmos-emulator:/, "CI must define a required Cosmos emulator job");
assert.match(workflow, /mcr\.microsoft\.com\/cosmosdb\/linux\/azure-cosmos-emulator:vnext-preview/, "CI must pin the Linux vNext emulator image");
assert.match(workflow, /http:\/\/127\.0\.0\.1:8080\/ready/, "CI must fail closed on the emulator readiness endpoint");
assert.match(workflow, /COSMOS_ENDPOINT:/, "CI must pass the emulator endpoint explicitly");
assert.match(workflow, /COSMOS_KEY:/, "CI must source the emulator key through an environment secret boundary");
assert.match(workflow, /^\s+run:\s+npm run test:cosmos\s*$/m, "CI must execute the real Cosmos contract lane");
assert.match(workflow, /npm run test:store-contract/, "CI must execute the shared Postgres/Cosmos contract lane");

console.log("SDT-G12 CI wiring fixture passed: required emulator, readiness, secret boundary, shared contract, and real Cosmos lane are reachable");
