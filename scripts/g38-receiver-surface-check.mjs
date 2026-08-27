import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const configPath = `${root}/samples/meeting-room/wrangler.g38-receiver.jsonc`;
const sourcePath = `${root}/samples/meeting-room/src/worker.g38-receiver.ts`;

function verify(config, source) {
  assert.equal(config.name, "sekiban-dcb-meeting-room-doorbell-g38", "G38 receiver Worker name must be exact");
  assert.equal(config.main, "src/worker.g38-receiver.ts", "G38 receiver must use the receiver-only entry module");
  assert.equal(config.workers_dev, false, "G38 receiver workers.dev must be disabled from first deploy");
  assert.equal(config.preview_urls, false, "G38 receiver previews must be disabled from first deploy");
  assert.equal(config.vars?.G32_COMPONENT, "receiver", "G38 receiver must declare component=receiver");
  assert.equal(config.vars?.G38_DOORBELL_DELIVERY_ROLE, "receiver", "G38 receiver must declare the doorbell delivery role");
  assert.equal(Object.hasOwn(config, "migrations"), false, "G38 receiver must not declare migrations");
  for (const forbidden of ["queues", "services", "triggers", "assets"]) {
    assert.equal(Object.hasOwn(config, forbidden), false, `G38 receiver must not declare ${forbidden}`);
  }
  assert.deepEqual(config.durable_objects?.bindings, [{
    name: "BOOTSTRAP",
    class_name: "BootstrapCoordinatorDurableObject",
    script_name: "sekiban-dcb-meeting-room-cloudflare-only",
  }], "G38 receiver must declare only the external primary BOOTSTRAP binding");
  assert.match(source, /export class MeetingRoomDownstreamDoorbell extends WorkerEntrypoint<MeetingRoomCloudflareEnv>/, "G38 receiver must export its named entrypoint");
  assert.equal((source.match(/export class /g) ?? []).length, 1, "G38 receiver must not export another named class");
  assert.doesNotMatch(source, /export (?:async )?function |export const |export let |export \{/, "G38 receiver must not expose another named surface");
  assert.match(source, /const receiver: ExportedHandler<MeetingRoomCloudflareEnv> = \{\};\s*export default receiver;/s, "G38 receiver default module handler must be empty");
  assert.doesNotMatch(source, /(?:async )?fetch\s*\(/, "G38 receiver module must not export or implement fetch");
  assert.doesNotMatch(source, /(?:async )?queue\s*\(/, "G38 receiver module must not export or implement queue");
  assert.doesNotMatch(source, /(?:async )?scheduled\s*\(/, "G38 receiver module must not export or implement scheduled");
}

function expectFailure(action, label) {
  assert.throws(action, undefined, `G38 receiver surface mutation must fail: ${label}`);
}

const config = JSON.parse(await readFile(configPath, "utf8"));
const source = await readFile(sourcePath, "utf8");
verify(config, source);

if (process.argv.includes("--self-test")) {
  const localBinding = structuredClone(config);
  delete localBinding.durable_objects.bindings[0].script_name;
  expectFailure(() => verify(localBinding, source), "external BOOTSTRAP becomes local");
  const publicReceiver = structuredClone(config);
  publicReceiver.workers_dev = true;
  expectFailure(() => verify(publicReceiver, source), "workers.dev exposure");
  const migratedReceiver = structuredClone(config);
  migratedReceiver.migrations = [];
  expectFailure(() => verify(migratedReceiver, source), "migrations key");
  expectFailure(() => verify(config, source.replace("const receiver: ExportedHandler<MeetingRoomCloudflareEnv> = {};", "const receiver: ExportedHandler<MeetingRoomCloudflareEnv> = { fetch() { return new Response(); } };")), "default fetch restoration");
  console.log("G38 receiver surface self-test passed");
} else {
  console.log("G38 receiver surface verified");
}
