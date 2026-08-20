import { bootstrapDigest } from "./manifest";
import type { BootstrapDump, BootstrapEventRecord, BootstrapManifest, BootstrapStoreAdmissionPort } from "./types";
import type { PipelineStore, StoredEvent } from "../store/types";

export interface BootstrapExportCursor {
  readonly highWatermark: string | null;
  readonly nextEventId: string | null;
}

export interface BootstrapExportPage {
  readonly dump: BootstrapDump;
  readonly page: readonly BootstrapEventRecord[];
  readonly cursor: BootstrapExportCursor;
  readonly complete: boolean;
}

export class BootstrapIdentityConflictError extends Error {
  readonly code = "BOOTSTRAP_EVENT_IDENTITY_CONFLICT" as const;
  constructor(readonly provider: string, readonly eventId: string) {
    super(`${provider} bootstrap EventId ${eventId} conflicts with the target identity`);
    this.name = "BootstrapIdentityConflictError";
  }
}

function compareOpaque(left: string, right: string): number {
  const a = new TextEncoder().encode(left); const b = new TextEncoder().encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) return a[index]! - b[index]!;
  return a.length - b.length;
}
function sameEvent(event: StoredEvent, record: BootstrapEventRecord): boolean {
  return event.suid === record.suid && event.payload === record.payload && JSON.stringify([...event.eventTags].sort(compareOpaque)) === JSON.stringify([...record.eventTags].sort(compareOpaque));
}
function toRecord(event: StoredEvent): BootstrapEventRecord {
  return { eventId: event.eventId, suid: event.suid, payload: event.payload, eventTags: [...event.eventTags].sort(compareOpaque) };
}

/**
 * Provider-neutral operator adapter.  A snapshot is anchored at the first
 * observed high watermark; later pages always re-apply that predicate, so an
 * append after a crash/resume cannot enter the export.
 */
export class BootstrapStoreAdapter implements BootstrapStoreAdmissionPort {
  constructor(readonly provider: string, private readonly store: PipelineStore) {}

  async exportPage(input: {
    readonly sourceServiceId: string;
    readonly targetServiceId: string;
    readonly allocatorLineageId: string;
    readonly pageSize: number;
    readonly cursor?: BootstrapExportCursor;
  }): Promise<BootstrapExportPage> {
    if (!Number.isSafeInteger(input.pageSize) || input.pageSize <= 0) throw new Error("bootstrap export pageSize must be positive");
    await this.store.initialize();
    const observed = await this.store.readAllEvents(input.sourceServiceId, "");
    const highWatermark = input.cursor?.highWatermark ?? observed.at(-1)?.suid ?? null;
    // This predicate is the snapshot boundary. Do not replace it with a cursor-only page query.
    const snapshot = observed.filter((event) => highWatermark === null || compareOpaque(event.suid, highWatermark) <= 0).map(toRecord);
    const start = input.cursor?.nextEventId === null || input.cursor?.nextEventId === undefined ? 0 : snapshot.findIndex((event) => event.eventId === input.cursor!.nextEventId) + 1;
    const page = snapshot.slice(Math.max(0, start), Math.max(0, start) + input.pageSize);
    const tagCounts: Record<string, number> = {};
    for (const event of snapshot) for (const tag of event.eventTags) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
    const draft: Omit<BootstrapManifest, "contentDigest"> = {
      format: "sekiban-dcb-bootstrap", version: 1,
      source: { serviceId: input.sourceServiceId, lineageId: "unknown-legacy" },
      target: { serviceId: input.targetServiceId, allocatorLineageId: input.allocatorLineageId },
      highWatermark, eventCount: snapshot.length, tagCounts,
      canonicalization: "utf8-json-sorted-keys-v1",
    };
    const fullDump = { manifest: { ...draft, contentDigest: "" }, events: snapshot };
    const manifest: BootstrapManifest = { ...draft, contentDigest: bootstrapDigest(fullDump) };
    const pageEnd = Math.max(0, start) + page.length;
    return {
      dump: { manifest, events: snapshot }, page,
      cursor: { highWatermark, nextEventId: pageEnd >= snapshot.length ? null : snapshot[pageEnd - 1]!.eventId },
      complete: pageEnd >= snapshot.length,
    };
  }

  async admitBootstrap(input: { readonly importId: string; readonly leaseEpoch: number; readonly manifest: BootstrapManifest; readonly events: readonly BootstrapEventRecord[] }): Promise<void> {
    await this.store.initialize();
    const existing = new Map((await this.store.readAllEvents(input.manifest.target.serviceId, "")).map((event) => [event.eventId, event]));
    for (const record of input.events) {
      const prior = existing.get(record.eventId);
      // The provider-level identity guard deliberately fires before any write.
      if (prior !== undefined && !sameEvent(prior, record)) throw new BootstrapIdentityConflictError(this.provider, record.eventId);
      for (const tag of record.eventTags) {
        const delivered = await this.store.recordDelivery({ version: 1, serviceId: input.manifest.target.serviceId, allocatorLineageId: input.manifest.target.allocatorLineageId, tag, attemptId: `bootstrap:${input.importId}:${input.leaseEpoch}`, eventId: record.eventId, suid: record.suid, payload: record.payload, eventTags: [...record.eventTags], enqueuedAt: 0 }, 0);
        if (delivered.outcome !== "stored") throw new Error(`${this.provider} bootstrap admission rejected ${record.eventId}`);
      }
    }
  }

  async verifyBootstrap(input: { readonly importId: string; readonly manifest: BootstrapManifest }): Promise<void> {
    await this.store.initialize();
    const actual = await this.store.readAllEvents(input.manifest.target.serviceId, "");
    if (actual.length !== input.manifest.eventCount) throw new Error(`${this.provider} bootstrap store count differs for ${input.importId}`);
  }
}

export function createBootstrapStoreAdapter(provider: string, store: PipelineStore): BootstrapStoreAdapter {
  return new BootstrapStoreAdapter(provider, store);
}
