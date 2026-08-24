import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  AllocatorDurableObject,
  BootstrapCoordinatorDurableObject,
  JournalDurableObject,
  MeetingRoomDownstreamDoorbell,
  TagDurableObject,
} from "../samples/meeting-room/src/worker.g38-tombstone";

function stateWithAlarmSpy() {
  let deleted = 0;
  return {
    state: { storage: { deleteAlarm: async () => { deleted += 1; } } } as unknown as DurableObjectState,
    deleted: () => deleted,
  };
}

describe("SDT-G38 old receiver tombstone", () => {
  it.each([AllocatorDurableObject, JournalDurableObject, TagDurableObject, BootstrapCoordinatorDurableObject])("neutralizes a pending alarm without an external call", async (DurableClass) => {
    const fixture = stateWithAlarmSpy();
    const instance = new DurableClass(fixture.state);
    await instance.alarm();
    expect(fixture.deleted()).toBe(1);
  });

  it("fails an at-least-once service-binding delivery with the frozen typed outcome", async () => {
    const receiver = new MeetingRoomDownstreamDoorbell(createExecutionContext(), {});
    await expect(receiver.deliver()).rejects.toThrow("G38_RECEIVER_FROZEN");
  });
});
