/**
 * Provider-internal port used by SDT-G6 Branch B.  It is intentionally a
 * narrow binding client, not a Queue/Cosmos/Postgres adapter.
 */
export interface ExclusionLookupInput {
  attemptId: string;
  tag: string;
  eventId: string;
  suid: string;
  actor: string;
  repairEpoch: number;
}

export interface ExclusionLookupPort {
  recordExclusion(input: ExclusionLookupInput): Promise<void>;
}

export class BindingExclusionLookupClient implements ExclusionLookupPort {
  constructor(private readonly binding: Fetcher | undefined) {}

  async recordExclusion(input: ExclusionLookupInput): Promise<void> {
    if (this.binding === undefined) {
      throw new Error("Repair exclusion lookup binding is not configured");
    }
    const response = await this.binding.fetch("https://repair-exclusion.internal/exclusions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      throw new Error(`Repair exclusion lookup rejected Branch B with ${response.status}`);
    }
  }
}
