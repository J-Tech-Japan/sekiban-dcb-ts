import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const configPath = `${root}/samples/meeting-room/wrangler.g38-old-receiver-tombstone.jsonc`;
const sourcePath = `${root}/samples/meeting-room/src/worker.g38-tombstone.ts`;
const classNames = ["AllocatorDurableObject", "JournalDurableObject", "TagDurableObject", "BootstrapCoordinatorDurableObject"];
const bindings = [
  { name: "ALLOCATOR", class_name: "AllocatorDurableObject" },
  { name: "JOURNAL", class_name: "JournalDurableObject" },
  { name: "TAG", class_name: "TagDurableObject" },
  { name: "BOOTSTRAP", class_name: "BootstrapCoordinatorDurableObject" },
];

function verify(config, source) {
  assert.equal(config.name, "sekiban-dcb-meeting-room-doorbell", "G38 tombstone must retain the old receiver identity");
  assert.equal(config.main, "src/worker.g38-tombstone.ts", "G38 tombstone must use its frozen module");
  assert.equal(config.workers_dev, false, "G38 tombstone workers.dev must remain disabled");
  assert.equal(config.preview_urls, false, "G38 tombstone preview URLs must remain disabled");
  assert.equal(Object.hasOwn(config, "migrations"), false, "G38 tombstone must not declare a migration");
  for (const forbidden of ["d1_databases", "queues", "services", "triggers", "assets"]) {
    assert.equal(Object.hasOwn(config, forbidden), false, `G38 tombstone must not declare ${forbidden}`);
  }
  assert.deepEqual(config.durable_objects?.bindings, bindings, "G38 tombstone must preserve exactly the four original DO classes");
  assert.deepEqual(config.exports, Object.fromEntries(classNames.map((className) => [className, { type: "durable-object", storage: "sqlite" }])), "G38 tombstone must retain the four namespace exports as SQLite Durable Objects");
  for (const className of classNames) {
    assert.match(source, new RegExp(`export class ${className} extends TombstoneDurableObject`), `G38 tombstone must export ${className}`);
  }
  assert.match(source, /export class MeetingRoomDownstreamDoorbell extends WorkerEntrypoint<Record<string, never>>/, "G38 tombstone must retain the named entrypoint");
  assert.match(source, /throw new Error\("G38_RECEIVER_FROZEN"\)/, "G38 tombstone doorbell must fail typed-frozen");
  assert.match(source, /await this\.state\.storage\.deleteAlarm\(\);/, "G38 tombstone alarms must delete themselves");
  assert.doesNotMatch(source, /setAlarm\(|\.fetch\(|\.prepare\(|\.send\(|\.deliver\(/, "G38 tombstone must not reschedule or call an external surface");
  assert.match(source, /const tombstone: ExportedHandler<Record<string, never>> = \{\};\s*export default tombstone;/s, "G38 tombstone default module handler must be empty");
}

function expectFailure(action, label) {
  assert.throws(action, undefined, `G38 tombstone mutation must fail: ${label}`);
}

const config = JSON.parse(await readFile(configPath, "utf8"));
const source = await readFile(sourcePath, "utf8");
verify(config, source);

if (process.argv.includes("--self-test")) {
  const fewerClasses = structuredClone(config);
  fewerClasses.durable_objects.bindings.pop();
  expectFailure(() => verify(fewerClasses, source), "missing retained namespace class");
  const localTrigger = structuredClone(config);
  localTrigger.queues = { consumers: [] };
  expectFailure(() => verify(localTrigger, source), "queue trigger");
  expectFailure(() => verify(config, source.replace("deleteAlarm()", "setAlarm(1)")), "alarm reschedule");
  expectFailure(() => verify(config, source.replace("G38_RECEIVER_FROZEN", "G38_RECEIVER_OPEN")), "doorbell thaw");
  console.log("G38 tombstone self-test passed");
} else {
  console.log("G38 tombstone verified");
}
