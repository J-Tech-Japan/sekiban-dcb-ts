import { WorkerEntrypoint } from "cloudflare:workers";
import { deliverMeetingRoomDoorbell } from "./worker.cloudflare-receiver-support";
import type { MeetingRoomCloudflareEnv } from "./worker.cloudflare-env";

/**
 * G38 receiver-only public surface. This module intentionally exports only
 * the named service-binding entrypoint; there is no default fetch export.
 */
export class MeetingRoomDownstreamDoorbell extends WorkerEntrypoint<MeetingRoomCloudflareEnv> {
  async deliver(message: unknown) {
    return deliverMeetingRoomDoorbell(this.env, this.ctx, message);
  }
}

// Workers module format requires a default module handler to retain named RPC
// entrypoints. It intentionally has no fetch, queue, or scheduled method, so
// the only invocable receiver surface is MeetingRoomDownstreamDoorbell.deliver.
const receiver: ExportedHandler<MeetingRoomCloudflareEnv> = {};
export default receiver;
