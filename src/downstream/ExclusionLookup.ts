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

export interface ExclusionLedgerLookupInput {
  serviceId: string;
  attemptId: string;
  tag: string;
  eventId: string;
  suid: string;
}

/**
 * Reads the same provider-internal exclusion ledger that SDT-G6 writes. A
 * missing binding is an unknown path, never an invented exclusion.
 */
export class BindingExclusionLedgerClient {
  constructor(private readonly binding: Fetcher | undefined) {}

  async isExcludedAudited(input: ExclusionLedgerLookupInput): Promise<boolean> {
    if (this.binding === undefined) {
      return false;
    }
    const response = await this.binding.fetch("https://repair-exclusion.internal/exclusions/lookup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (response.status === 404) {
      return false;
    }
    if (!response.ok) {
      throw new Error(`Repair exclusion lookup rejected detector with ${response.status}`);
    }
    const body = await response.json<unknown>();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new Error("Repair exclusion lookup returned an invalid response");
    }
    return (body as Record<string, unknown>).classification === "EXCLUDED_AUDITED";
  }
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
