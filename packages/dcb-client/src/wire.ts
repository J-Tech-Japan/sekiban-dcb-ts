import type { CommitEnvelope } from "./index.js";

function base64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Internal V1 wire adapter shared by both HTTP client implementations. */
export function v1Envelope(request: CommitEnvelope): Record<string, unknown> {
  return {
    version: 1,
    eventCandidates: request.candidates.map((candidate) => ({
      payload: base64Json(candidate.payload),
      eventPayloadName: candidate.eventPayloadName,
      tags: [...candidate.tags],
    })),
    consistencyTags: request.consistency.map((entry) => ({
      tag: entry.tag,
      lastSortableUniqueId: entry.lastSortableUniqueId,
    })),
  };
}
