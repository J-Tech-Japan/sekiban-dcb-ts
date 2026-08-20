import { expect } from "vitest";

import {
  BootstrapIdentityConflictError,
  type BootstrapStoreAdapter,
  createBootstrapStoreAdapter,
} from "../../packages/dcb-runtime/src/bootstrap/BootstrapStoreAdapter";
import type { PipelineStore, StoredEvent } from "../../packages/dcb-runtime/src/store/types";
import type { DownstreamOutboxMessage } from "../../packages/dcb-runtime/src/downstream/types";

const suid = (value: number) => `suid-${String(value).padStart(32, "0")}`;

function message(serviceId: string, eventId: string, value: number, tags: string[]): DownstreamOutboxMessage {
  return {
    version: 1,
    serviceId,
    allocatorLineageId: "g22-bootstrap-provider-lineage",
    tag: tags[0]!,
    attemptId: `g22-bootstrap:${eventId}`,
    eventId,
    suid: suid(value),
    payload: value === 1 ? "AQ==" : "Ag==",
    eventTags: tags,
    enqueuedAt: 0,
  };
}

async function durableSnapshot(store: PipelineStore, serviceId: string): Promise<unknown> {
  return {
    events: await store.readAllEvents(serviceId, ""),
    projectionTags: await store.listProjectionTags(serviceId),
    lag: await store.currentLagBound(serviceId, 0),
    pending: await store.listPending(serviceId),
    findings: await store.listFindings(serviceId),
    incidents: await store.listDeliveryIncidents(serviceId),
  };
}

/**
 * The same provider contract is intentionally run against each concrete
 * PipelineStore: PG container, D1 Miniflare, and the Cosmos emulator.  It
 * asserts the durable event, metadata, detector and lag surfaces, rather
 * than a label on a hand-written in-memory fake.
 */
export async function runG22BootstrapProviderContract(
  provider: "postgres" | "cosmos" | "d1",
  store: PipelineStore,
  createAdapter: (store: PipelineStore) => BootstrapStoreAdapter = (target) => createBootstrapStoreAdapter(provider, target),
): Promise<void> {
  const suffix = crypto.randomUUID();
  const sourceServiceId = `g22-${provider}-source-${suffix}`;
  const targetServiceId = `g22-${provider}-target-${suffix}`;
  const tags = [`g22:${provider}:orders`, `g22:${provider}:audit`].sort();
  await store.initialize();

  await store.recordDelivery(message(sourceServiceId, "first", 1, tags), 0);
  await store.recordDelivery(message(sourceServiceId, "second", 2, tags), 0);
  const sourceAdapter = createAdapter(store);
  const first = await sourceAdapter.exportPage({
    sourceServiceId,
    targetServiceId,
    allocatorLineageId: "g22-bootstrap-provider-lineage",
    pageSize: 1,
  });
  await store.recordDelivery(message(sourceServiceId, "late-after-watermark", 3, tags), 0);
  const resumed = await sourceAdapter.exportPage({
    sourceServiceId,
    targetServiceId,
    allocatorLineageId: "g22-bootstrap-provider-lineage",
    pageSize: 1,
    cursor: first.cursor,
  });
  expect(resumed.dump.manifest.contentDigest).toBe(first.dump.manifest.contentDigest);
  expect(resumed.dump.events.map((row) => row.eventId)).toEqual(["first", "second"]);
  expect(resumed.page.map((row) => row.eventId)).toEqual(["second"]);

  await store.recordDelivery(message(targetServiceId, "same", 1, tags), 0);
  const targetAdapter = createAdapter(store);
  const targetDump = (await targetAdapter.exportPage({
    sourceServiceId: targetServiceId,
    targetServiceId,
    allocatorLineageId: "g22-bootstrap-provider-lineage",
    pageSize: 8,
  })).dump;
  await expect(targetAdapter.admitBootstrap({
    importId: `g22-${provider}-replay`,
    leaseEpoch: 1,
    manifest: targetDump.manifest,
    events: targetDump.events,
  })).resolves.toBeUndefined();
  const before = await durableSnapshot(store, targetServiceId);
  await expect(targetAdapter.admitBootstrap({
    importId: `g22-${provider}-conflict`,
    leaseEpoch: 2,
    manifest: targetDump.manifest,
    events: [{ ...targetDump.events[0]!, payload: "Aw==" }],
  })).rejects.toBeInstanceOf(BootstrapIdentityConflictError);
  expect(await durableSnapshot(store, targetServiceId)).toEqual(before);
}

export function g22StoredEventIdentity(event: StoredEvent): Pick<StoredEvent, "eventId" | "suid" | "payload" | "eventTags"> {
  return { eventId: event.eventId, suid: event.suid, payload: event.payload, eventTags: event.eventTags };
}
