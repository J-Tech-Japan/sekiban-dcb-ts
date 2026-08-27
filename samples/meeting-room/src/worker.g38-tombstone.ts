import { WorkerEntrypoint } from "cloudflare:workers";

/**
 * The retained old receiver has no operational surface after G38 cutover.
 * Each legacy Durable Object alarm is allowed exactly one mutation: deleting
 * itself. No handler can re-arm an alarm or reach a business dependency.
 */
class TombstoneDurableObject {
  constructor(protected readonly state: DurableObjectState) {}

  async alarm(): Promise<void> {
    await this.state.storage.deleteAlarm();
  }
}

export class AllocatorDurableObject extends TombstoneDurableObject {}
export class JournalDurableObject extends TombstoneDurableObject {}
export class TagDurableObject extends TombstoneDurableObject {}
export class BootstrapCoordinatorDurableObject extends TombstoneDurableObject {}

/** Any at-least-once delivery to the retired receiver fails closed. */
export class MeetingRoomDownstreamDoorbell extends WorkerEntrypoint<Record<string, never>> {
  async deliver(): Promise<never> {
    throw new Error("G38_RECEIVER_FROZEN");
  }
}

// A default module export is required to retain named RPC/DO module exports;
// it deliberately implements no fetch, queue, or scheduled handler.
const tombstone: ExportedHandler<Record<string, never>> = {};
export default tombstone;
