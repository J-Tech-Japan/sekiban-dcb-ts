export interface DcbLogicalEventForTagDerivation {
  readonly serviceId: string;
  readonly id: string;
  readonly sortableUniqueId: string;
  readonly eventType: string;
  readonly payload?: string;
  readonly tags: readonly string[];
  readonly timestamp: string;
  readonly causationId?: string | null;
  readonly correlationId?: string | null;
  readonly executedUser?: string | null;
}

export interface ParsedSortableUniqueId {
  readonly value: string;
  readonly ticks: bigint;
}

export interface PostgresOrSqliteDcbTagRow {
  readonly id: number;
  readonly serviceId: string;
  readonly tag: string;
  readonly tagGroup: string;
  readonly eventType: string;
  readonly sortableUniqueId: string;
  readonly eventId: string;
  readonly createdAt: string;
}

export interface CosmosDcbTagRow {
  readonly pk: string;
  readonly id: string;
  readonly serviceId: string;
  readonly tag: string;
  readonly tagGroup: string;
  readonly eventType: string;
  readonly sortableUniqueId: string;
  readonly eventId: string;
  readonly createdAt: string;
}

export function parseSortableUniqueId(value: string): ParsedSortableUniqueId;
export function tagGroup(tag: string): string;
export function csharpSortableUniqueIdDateTime(suid: string): string;
export function deriveDcbTags(
  value: readonly DcbLogicalEventForTagDerivation[] | { readonly events: readonly DcbLogicalEventForTagDerivation[] },
  provider: "postgres" | "sqlite",
): readonly PostgresOrSqliteDcbTagRow[];
export function deriveDcbTags(
  value: readonly DcbLogicalEventForTagDerivation[] | { readonly events: readonly DcbLogicalEventForTagDerivation[] },
  provider: "cosmos",
): readonly CosmosDcbTagRow[];

export function expectedDcbTagRows(
  value: readonly DcbLogicalEventForTagDerivation[] | { readonly events: readonly DcbLogicalEventForTagDerivation[] },
  provider: "postgres" | "sqlite",
  manifest?: unknown,
): readonly PostgresOrSqliteDcbTagRow[];
export function expectedDcbTagRows(
  value: readonly DcbLogicalEventForTagDerivation[] | { readonly events: readonly DcbLogicalEventForTagDerivation[] },
  provider: "cosmos",
  manifest?: unknown,
): readonly CosmosDcbTagRow[];
export function assertDcbTagRowsAgainstManifest(
  value: readonly DcbLogicalEventForTagDerivation[] | { readonly events: readonly DcbLogicalEventForTagDerivation[] },
  provider: "postgres" | "sqlite",
  actual: readonly PostgresOrSqliteDcbTagRow[],
  manifest?: unknown,
): readonly PostgresOrSqliteDcbTagRow[];
export function assertDcbTagRowsAgainstManifest(
  value: readonly DcbLogicalEventForTagDerivation[] | { readonly events: readonly DcbLogicalEventForTagDerivation[] },
  provider: "cosmos",
  actual: readonly CosmosDcbTagRow[],
  manifest?: unknown,
): readonly CosmosDcbTagRow[];
