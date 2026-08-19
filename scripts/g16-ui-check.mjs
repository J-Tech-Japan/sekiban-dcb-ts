import { readFile } from "node:fs/promises";

const html = await readFile("samples/meeting-room/public/index.html", "utf8");
const app = await readFile("samples/meeting-room/public/app.js", "utf8");
const samplePackage = JSON.parse(await readFile("samples/meeting-room/package.json", "utf8"));
const wranglerConfig = await readFile("samples/meeting-room/wrangler.jsonc", "utf8");

function requireContract(condition, message) {
  if (!condition) throw new Error(message);
}

for (const marker of [
  'id="reservation-list-panel"',
  'id="reservations-refresh"',
  'id="reservations-body"',
  'id="room-query-panel"',
  'id="room-query-form"',
  'id="room-query-result"',
  'src="/app.js"',
]) {
  requireContract(html.includes(marker), `missing static UI marker: ${marker}`);
}
for (const marker of [
  '"/api/read/reservations"',
  '/api/read/room-query?roomId=',
  '"#reservations-refresh"',
  '"#room-query-form"',
  'reservationListView',
  'roomQueryView',
]) {
  requireContract(app.includes(marker), `missing query UI behavior: ${marker}`);
}
requireContract(!/\b(react|vue|svelte|next)\b/i.test(html + app), "framework marker found in plain HTML sample");
requireContract(Object.keys(samplePackage.dependencies).sort().join(",") === "@sekiban/dcb-client,@sekiban/dcb-core,@sekiban/dcb-runtime", "frontend added a runtime dependency");
requireContract(wranglerConfig.includes('"SDT_SERVICE_ID": "serialized-dcb-v1"'), "sample Wrangler config lacks the local SDT_SERVICE_ID default");
console.log("SDT-G16 static UI contract: PASS");
