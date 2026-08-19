import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { bootstrapDigest, parseBootstrapDump } from "../packages/dcb-runtime/src/bootstrap/manifest";
import type { BootstrapDump, BootstrapManifest } from "../packages/dcb-runtime/src/bootstrap/types";

const suid = (n: number) => `suid-${String(n).padStart(32, "0")}`;
function dumpFor(serviceId: string): BootstrapDump {
  const events = [
    { eventId: "event-a", suid: suid(1), payload: "AQ==", eventTags: ["orders", "users"] },
    { eventId: "event-b", suid: suid(2), payload: "Ag==", eventTags: ["orders"] },
  ];
  const draft: Omit<BootstrapManifest, "contentDigest"> = { format: "sekiban-dcb-bootstrap", version: 1, source: { serviceId: "source", lineageId: "unknown-legacy" }, target: { serviceId, allocatorLineageId: "bootstrap-lineage" }, highWatermark: suid(2), eventCount: 2, tagCounts: { orders: 2, users: 1 }, canonicalization: "utf8-json-sorted-keys-v1" };
  return { manifest: { ...draft, contentDigest: bootstrapDigest({ manifest: { ...draft, contentDigest: "" }, events }) }, events };
}
async function post(serviceId: string, path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://bootstrap.test/bootstrap/${encodeURIComponent(serviceId)}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("SDT-G21 bootstrap core", () => {
  it("fails parser preflight before target admission on unknown, duplicate, and digest-invalid dumps", async () => {
    const valid = dumpFor("parser-target");
    expect(parseBootstrapDump(valid)).toEqual(valid);
    expect(() => parseBootstrapDump({ ...valid, extra: true })).toThrow(/unknown/i);
    expect(() => parseBootstrapDump({ ...valid, events: [valid.events[0], valid.events[0]] })).toThrow();
    expect(() => parseBootstrapDump({ ...valid, manifest: { ...valid.manifest, contentDigest: "fnv1a32:00000000" } })).toThrow(/digest/i);
    expect((await SELF.fetch("https://bootstrap.test/bootstrap/parser-target/state")).status).toBe(200);
  });

  it("uses the coordinator transaction as the plan/command gate and permanently closes tag admission at READY", async () => {
    const serviceId = `bootstrap-${crypto.randomUUID()}`; const dump = dumpFor(serviceId);
    const command = await post(serviceId, "/command/admit", { commandId: "stalled-command" }); expect(command.status).toBe(200);
    const blocked = await post(serviceId, "/plan", { importId: "import-1", dump, targetEvidence: { bindingExists: false, eventsExist: false } }); expect(blocked.status).toBe(409);
    await post(serviceId, "/command/release", { commandId: "stalled-command" });
    const planned = await post(serviceId, "/plan", { importId: "import-1", dump, targetEvidence: { bindingExists: false, eventsExist: false } }); expect(planned.status).toBe(201);
    const control = await planned.json<{ leaseEpoch: number }>();
    expect((await post(serviceId, "/command/admit", { commandId: "after-planned" })).status).toBe(409);
    expect((await post(serviceId, "/import", { importId: "import-1", leaseEpoch: control.leaseEpoch })).status).toBe(200);
    expect((await post(serviceId, "/ready", { importId: "import-1", leaseEpoch: control.leaseEpoch })).status).toBe(200);
    const tag = await SELF.fetch(`https://bootstrap.test/tags/${encodeURIComponent(serviceId)}/orders/bootstrap/admit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ importId: "import-1", leaseEpoch: control.leaseEpoch, manifestDigest: dump.manifest.contentDigest, targetServiceId: serviceId, candidates: [{ ...dump.events[0], allocatorLineageId: "bootstrap-lineage" }] }) });
    expect(tag.status).toBe(409);
  });

  it("isolates fresh-target guards and allocator empty-only seed guard", async () => {
    const binding = await post(`binding-${crypto.randomUUID()}`, "/plan", { importId: "x", dump: dumpFor("binding-placeholder"), targetEvidence: { bindingExists: true, eventsExist: false } }); expect(binding.status).toBe(409);
    const events = await post(`events-${crypto.randomUUID()}`, "/plan", { importId: "x", dump: dumpFor("events-placeholder"), targetEvidence: { bindingExists: false, eventsExist: true } }); expect(events.status).toBe(409);
    const allocator = await SELF.fetch("https://bootstrap.test/allocator/seed-after", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ importId: "seed", leaseEpoch: 1, highWatermark: suid(9) }) }); expect(allocator.status).toBe(201);
    const second = await SELF.fetch("https://bootstrap.test/allocator/seed-after", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ importId: "other", leaseEpoch: 2, highWatermark: suid(10) }) }); expect(second.status).toBe(409);
  });
});
