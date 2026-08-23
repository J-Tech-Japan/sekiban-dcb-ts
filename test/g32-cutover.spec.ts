import { describe, expect, it } from "vitest";
import {
  assertG32FinalFence,
  cutoverAdmission,
} from "../samples/meeting-room/src/compatibility";
import { g32EventId, g32Suid } from "./helpers/g32-fixtures";

async function fingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("SDT-G32 final cutover fence", () => {
  it("opens only after the new-binding final phase carries its matching fence secret", async () => {
    const token = "g32-final-fence-fixture";
    await expect(assertG32FinalFence({
      phase: "final-g32",
      release: "after-new-bindings",
      token,
      tokenFingerprint: await fingerprint(token),
    })).resolves.toBeUndefined();
    await expect(assertG32FinalFence({
      phase: "final-g32",
      release: "before-new-bindings",
      token,
      tokenFingerprint: await fingerprint(token),
    })).rejects.toThrow("G32_CUTOVER_FENCE_PHASE_INVALID");
    await expect(assertG32FinalFence({
      phase: "final-g32",
      release: "after-new-bindings",
      token,
      tokenFingerprint: await fingerprint("different-token"),
    })).rejects.toThrow("G32_CUTOVER_FENCE_INVALID");
  });

  it("rejects every stale bridge/old-SUID delivery before the fresh G32 lane", () => {
    const accepted = {
      eventType: "RoomCreated",
      provenance: "g32",
      eventId: g32EventId("g32-cutover"),
      suid: g32Suid("g32-cutover"),
    };
    expect(cutoverAdmission("fresh-g32", accepted)).toBe("accepted");
    expect(cutoverAdmission("fresh-g32", { ...accepted, suid: "suid-00000000000000000001787414836102" })).toBe("typed-rejected");
    expect(cutoverAdmission("fresh-g32", { ...accepted, eventType: "RoomCreated:1" })).toBe("typed-rejected");
    expect(cutoverAdmission("fresh-g32", { freezeToken: true })).toBe("typed-rejected");
  });
});
