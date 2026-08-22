/**
 * SDT-G32 cutover policy for the sample. The final worker owns a new D1
 * database and service identity, so there is intentionally no old-record
 * reader, replay shim, downgrade path, or payload discriminator fallback.
 */
export type CutoverLane = "bridge-freeze" | "fresh-g32";
export type CutoverOutcome = "frozen" | "accepted" | "typed-rejected";

export interface G32FinalFence {
  readonly phase?: string;
  readonly release?: string;
  readonly token?: string;
  readonly tokenFingerprint?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cutoverOutcome(lane: CutoverLane): CutoverOutcome {
  return lane === "bridge-freeze" ? "frozen" : "accepted";
}

/** Fail closed before a store/dispatch call when a non-G32 record reaches it. */
export function assertG32StoredIdentity(value: unknown): void {
  if (!isRecord(value)) throw new Error("G32_STORED_RECORD_INVALID");
  if (
    typeof value.eventType !== "string" || value.eventType.length === 0 || value.eventType.includes(":") ||
    value.provenance !== "g32" ||
    typeof value.suid !== "string" || !/^[0-9]{30}$/.test(value.suid) ||
    typeof value.eventId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.eventId)
  ) {
    throw new Error("G32_STORED_RECORD_INVALID");
  }
}

/** The bridge admits only its freeze token; final G32 accepts no bridge wire. */
export function cutoverAdmission(lane: CutoverLane, value: unknown): CutoverOutcome {
  if (!isRecord(value)) return "typed-rejected";
  if (lane === "bridge-freeze") return value.freezeToken === true ? "frozen" : "typed-rejected";
  try {
    assertG32StoredIdentity(value);
    return "accepted";
  } catch {
    return "typed-rejected";
  }
}

export function cutoverLaneIds(): readonly CutoverLane[] {
  return Object.freeze(["bridge-freeze", "fresh-g32"]);
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The final Worker cannot become writable merely because the bridge was
 * removed. It must carry the final phase marker plus the same deployment
 * fence secret/fingerprint pair on every primary and receiver version.
 */
export async function assertG32FinalFence(value: G32FinalFence): Promise<void> {
  if (value.phase !== "final-g32" || value.release !== "after-new-bindings") {
    throw new Error("G32_CUTOVER_FENCE_PHASE_INVALID");
  }
  if (typeof value.token !== "string" || value.token.length === 0 || typeof value.tokenFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.tokenFingerprint)) {
    throw new Error("G32_CUTOVER_FENCE_INVALID");
  }
  const encoded = new TextEncoder().encode(value.token);
  const observed = hex(await crypto.subtle.digest("SHA-256", encoded));
  if (observed !== value.tokenFingerprint) throw new Error("G32_CUTOVER_FENCE_INVALID");
}
