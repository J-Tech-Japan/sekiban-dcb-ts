import type { DownstreamOutboxMessage } from "../downstream/types";
import { scopeIdFor } from "../scope/ScopeName";
import {
  G44_SCANNER_VERSION,
  G44_HEALTH_STALE_AFTER_MS,
  type GlobalCompletenessHealth,
  type GlobalCompletenessCoverage,
  type GlobalCompletenessHealthRecord,
  type GlobalCompletenessScanResult,
  type SourceObligationFact,
  type SourceObligationPage,
  type SourcePartitionSnapshot,
} from "./types";

type D1Row = Record<string, unknown>;

const PAGE_SIZE = 64;

interface SettledCursor {
  readonly schema: "sdt-g58-settled-frontier/v1";
  readonly snapshots: readonly SourcePartitionSnapshot[];
  readonly frontierSuid: string | null;
}

function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`G44 ${name} must be a non-empty string`);
  return value;
}

function asNumber(value: unknown, name: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`G44 ${name} must be a non-negative safe integer`);
  return number;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}

/**
 * G44 originally stored only the scanner's vector snapshot in cursor_json.
 * G58 deliberately keeps that historical shape readable while adding the
 * exact high-water SUID that the FULL snapshot proved.  A malformed or
 * pre-G58 cursor never grants a frontier.
 */
function settledFrontierFromCursor(cursorJson: string | null): string | null {
  const cursor = settledCursorFromJson(cursorJson);
  return cursor?.frontierSuid ?? null;
}

function settledCursorFromJson(cursorJson: string | null): SettledCursor | null {
  if (cursorJson === null) return null;
  try {
    const parsed: unknown = JSON.parse(cursorJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const candidate = parsed as Record<string, unknown>;
    if (candidate.schema !== "sdt-g58-settled-frontier/v1" || !Array.isArray(candidate.snapshots)) return null;
    const snapshots: SourcePartitionSnapshot[] = [];
    for (const raw of candidate.snapshots) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
      const snapshot = raw as Record<string, unknown>;
      if (typeof snapshot.serviceId !== "string" || snapshot.serviceId.length === 0 ||
        typeof snapshot.tag !== "string" || snapshot.tag.length === 0 ||
        !Number.isSafeInteger(snapshot.upperBoundSequence) ||
        (snapshot.upperBoundSequence as number) < 0) return null;
      snapshots.push({
        serviceId: snapshot.serviceId,
        tag: snapshot.tag,
        upperBoundSequence: snapshot.upperBoundSequence as number,
      });
    }
    const frontierSuid = candidate.frontierSuid;
    if (frontierSuid !== null && (typeof frontierSuid !== "string" || frontierSuid.length === 0)) return null;
    return {
      schema: "sdt-g58-settled-frontier/v1",
      snapshots,
      frontierSuid: frontierSuid as string | null,
    };
  } catch {
    return null;
  }
}

function cursorIncludesObligation(
  cursorJson: string | null,
  serviceId: string,
  tag: string,
  obligationSequence: number,
): boolean {
  const cursor = settledCursorFromJson(cursorJson);
  return cursor !== null && cursor.snapshots.some((snapshot) =>
    snapshot.serviceId === serviceId && snapshot.tag === tag && obligationSequence <= snapshot.upperBoundSequence);
}

function findingIdentity(serviceId: string, tag: string, obligation: SourceObligationFact): string {
  return `SOURCE_RECEIPT_ABSENT|${serviceId}|${tag}|${obligation.obligationSequence}|${obligation.eventId}|${obligation.eventDigest}`;
}

function sourceUnavailableIdentity(serviceId: string, tag: string): string {
  return `SOURCE_PARTITION_UNAVAILABLE|${serviceId}|${tag}`;
}

function scannerFailureIdentity(serviceId: string): string {
  return `GLOBAL_SCANNER_FAILURE|${serviceId}`;
}

interface CompletenessFindingInput {
  readonly identity: string;
  readonly type: string;
  readonly partitionTag: string | null;
  readonly obligationSequence: number | null;
  readonly eventId: string | null;
  readonly eventDigest: string | null;
}

interface TagSourceStub {
  fetch(request: Request): Promise<Response>;
}

/** Test-only seam for exercising the same receipt-read failure branch. */
export interface GlobalCompletenessReconcilerOptions {
  readonly globalReceiptMatcher?: (
    serviceId: string,
    tag: string,
    obligation: SourceObligationFact,
  ) => Promise<boolean>;
}

function isObligationStatus(value: unknown): value is SourceObligationFact["status"] {
  return value === "pending" || value === "acknowledged" || value === "poison";
}

function sourcePageFrom(value: unknown): SourceObligationPage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("source_page_invalid_response");
  const page = value as Record<string, unknown>;
  if (!Array.isArray(page.rows)) throw new Error("source_page_invalid_rows");
  const rows: SourceObligationFact[] = page.rows.map((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("source_page_invalid_row");
    const row = raw as Record<string, unknown>;
    if (!Array.isArray(row.declaredTagSet) || !row.declaredTagSet.every((entry) => typeof entry === "string") ||
      !Array.isArray(row.localCommittedMembership) || row.localCommittedMembership.length !== 1 ||
      typeof row.canonicalBytesBase64 !== "string" || typeof row.eventDigest !== "string" ||
      !/^[0-9a-f]{64}$/.test(row.eventDigest) || !isObligationStatus(row.status)) {
      throw new Error("source_page_invalid_obligation_fact");
    }
    const membership = row.localCommittedMembership[0];
    if (typeof membership !== "object" || membership === null || Array.isArray(membership)) throw new Error("source_page_invalid_membership");
    const parsedMembership = membership as Record<string, unknown>;
    return {
      obligationSequence: asNumber(row.obligationSequence, "source_page.obligationSequence"),
      eventId: asString(row.eventId, "source_page.eventId"),
      eventDigest: asString(row.eventDigest, "source_page.eventDigest"),
      canonicalBytesBase64: asString(row.canonicalBytesBase64, "source_page.canonicalBytesBase64"),
      declaredTagSet: row.declaredTagSet as string[],
      localCommittedMembership: [{
        serviceId: asString(parsedMembership.serviceId, "source_page.membership.serviceId"),
        eventId: asString(parsedMembership.eventId, "source_page.membership.eventId"),
        tag: asString(parsedMembership.tag, "source_page.membership.tag"),
      }],
      status: row.status,
    };
  });
  if (typeof page.hasMore !== "boolean") throw new Error("source_page.invalid_has_more");
  return {
    serviceId: asString(page.serviceId, "source_page.serviceId"),
    tag: asString(page.tag, "source_page.tag"),
    upperBoundSequence: asNumber(page.upperBoundSequence, "source_page.upperBoundSequence"),
    observedMaxSequence: asNumber(page.observedMaxSequence, "source_page.observedMaxSequence"),
    afterSequence: asNumber(page.afterSequence, "source_page.afterSequence"),
    rows,
    hasMore: page.hasMore,
  };
}

/**
 * An independent source→global reconciliation pass. It never receives a
 * Queue message or an expected test count: its universe is the source-side
 * partition registry captured before paging any Tag DO.
 */
export class GlobalCompletenessReconciler {
  constructor(
    private readonly database: D1Database,
    private readonly tags: DurableObjectNamespace,
    private readonly scannerVersion = G44_SCANNER_VERSION,
    private readonly options: GlobalCompletenessReconcilerOptions = {},
  ) {}

  async reconcile(serviceId: string, nowMs: number): Promise<GlobalCompletenessScanResult> {
    let snapshots: SourcePartitionSnapshot[];
    try {
      snapshots = await this.snapshotPartitions(serviceId);
    } catch (error) {
      const message = errorText(error);
      await this.appendFinding(serviceId, {
        identity: scannerFailureIdentity(serviceId),
        type: "GLOBAL_ARRAY_SCANNER_FAILURE",
        partitionTag: null,
        obligationSequence: null,
        eventId: null,
        eventDigest: null,
      }, nowMs).catch(() => undefined);
      await this.writeHealth(serviceId, "FAILED", null, null, message, nowMs).catch(() => undefined);
      return { kind: "FAILED", error: message };
    }

    try {
      let scanned = 0;
      let findings = 0;
      for (const snapshot of snapshots) {
        try {
          const source = this.tags.get(scopeIdFor(this.tags, {
            serviceId: snapshot.serviceId,
            doClass: "tag",
            identity: snapshot.tag,
          })) as unknown as TagSourceStub;
          let afterSequence = 0;
          let finished = false;
          while (!finished) {
            const page = await this.readSourcePage(source, {
              serviceId: snapshot.serviceId,
              tag: snapshot.tag,
              upperBoundSequence: snapshot.upperBoundSequence,
              afterSequence,
              limit: PAGE_SIZE,
            });
            this.assertPage(snapshot, afterSequence, page);
            for (const obligation of page.rows) {
              // `obligation_sequence` is local to one Tag DO, but it is a
              // durable contiguous range inside that partition.  A gap or a
              // duplicate is therefore not an innocuous pagination detail: it
              // means the source universe cannot be proved complete.
              if (obligation.obligationSequence !== afterSequence + 1 || obligation.obligationSequence > snapshot.upperBoundSequence) {
                throw new Error(`source_page_sequence_outside_snapshot:${snapshot.tag}`);
              }
              afterSequence = obligation.obligationSequence;
              scanned += 1;
              let joined: boolean;
              try {
                joined = this.options.globalReceiptMatcher === undefined
                  ? await this.globalReceiptMatches(snapshot.serviceId, snapshot.tag, obligation)
                  : await this.options.globalReceiptMatcher(snapshot.serviceId, snapshot.tag, obligation);
              } catch (error) {
                await this.appendFinding(snapshot.serviceId, {
                  identity: `GLOBAL_RECEIPT_UNAVAILABLE|${snapshot.serviceId}|${snapshot.tag}|${obligation.obligationSequence}|${obligation.eventId}|${obligation.eventDigest}`,
                  type: "GLOBAL_ARRAY_RECEIPT_UNAVAILABLE",
                  partitionTag: snapshot.tag,
                  obligationSequence: obligation.obligationSequence,
                  eventId: obligation.eventId,
                  eventDigest: obligation.eventDigest,
                }, nowMs).catch(() => undefined);
                throw error;
              }
              if (!joined) {
                await this.appendObligationFinding(snapshot.serviceId, snapshot.tag, obligation, nowMs);
                findings += 1;
              }
            }
            if (!page.hasMore) {
              finished = true;
            } else if (page.rows.length === 0) {
              throw new Error(`source_page_truncated:${snapshot.tag}`);
            }
          }
          // All local sequences are retained under G43, so a non-empty bound
          // that yielded no row is source-unreadable, never a healthy scan.
          if (snapshot.upperBoundSequence > 0 && afterSequence === 0) {
            throw new Error(`source_partition_missing_rows:${snapshot.tag}`);
          }
          if (afterSequence !== snapshot.upperBoundSequence) {
            throw new Error(`source_partition_range_incomplete:${snapshot.tag}`);
          }
        } catch (error) {
          if (errorText(error).startsWith("source_")) {
            await this.appendFinding(snapshot.serviceId, {
              identity: sourceUnavailableIdentity(snapshot.serviceId, snapshot.tag),
              type: "GLOBAL_ARRAY_SOURCE_PARTITION_UNAVAILABLE",
              partitionTag: snapshot.tag,
              obligationSequence: null,
              eventId: null,
              eventDigest: null,
            }, nowMs).catch(() => undefined);
          }
          throw error;
        }
      }
      // The proof domain is the start-of-pass snapshot. A partition added
      // after that snapshot is intentionally left for the next pass; it must
      // not invalidate the proof already established for the partitions that
      // were actually walked. A removed start partition is different because
      // the pass can no longer be said to have covered its proof domain.
      const endSnapshots = await this.snapshotPartitions(serviceId);
      this.assertStartPartitionsRetained(snapshots, endSnapshots);
      if (findings > 0) {
        // Keep the historical G44 diagnostic for an unresolved obligation
        // discovered while the universe was changing. It remains fail-closed
        // and does not grant a frontier; the all-joined case above is the
        // bounded AC2 path that may settle the start-of-pass snapshot.
        this.assertSnapshotUniverseUnchanged(snapshots, endSnapshots);
      }
      const cursor: SettledCursor = {
        schema: "sdt-g58-settled-frontier/v1",
        snapshots,
        frontierSuid: await this.settledFrontierAtSnapshot(serviceId, snapshots),
      };
      if (findings > 0) {
        // An unresolved source obligation is deliberately not a completed
        // frontier. Retaining a vector cursor here would let a later reader
        // mistake partial coverage for a successfully closed range.
        await this.writeHealth(serviceId, "BLOCK", null, null, "source present/global receipt absent", nowMs);
        return { kind: "BLOCK", partitions: snapshots, findingCount: findings };
      }
      await this.writeHealth(serviceId, "HEALTHY", JSON.stringify(cursor), nowMs, null, nowMs);
      return { kind: "FULL", partitions: snapshots, scannedObligations: scanned };
    } catch (error) {
      const message = errorText(error);
      const health: GlobalCompletenessHealth = message.startsWith("source_") ? "UNKNOWN" : "FAILED";
      if (health === "FAILED") {
        await this.appendFinding(serviceId, {
          identity: scannerFailureIdentity(serviceId),
          type: "GLOBAL_ARRAY_SCANNER_FAILURE",
          partitionTag: null,
          obligationSequence: null,
          eventId: null,
          eventDigest: null,
        }, nowMs).catch(() => undefined);
      }
      await this.writeHealth(serviceId, health, null, null, message, nowMs).catch(() => undefined);
      return health === "UNKNOWN" ? { kind: "UNKNOWN", reason: message } : { kind: "FAILED", error: message };
    }
  }

  private async readSourcePage(
    source: TagSourceStub,
    input: Readonly<{
      serviceId: string;
      tag: string;
      upperBoundSequence: number;
      afterSequence: number;
      limit: number;
    }>,
  ): Promise<SourceObligationPage> {
    const url = new URL("https://g44-source.internal/__internal/g44/source-obligations");
    url.searchParams.set("__serviceId", input.serviceId);
    url.searchParams.set("__tag", input.tag);
    const response = await source.fetch(new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-sdt-g44-source-scan": "1" },
      body: JSON.stringify(input),
    }));
    if (!response.ok) {
      throw new Error(`source_partition_unreadable:${response.status}`);
    }
    return sourcePageFrom(await response.json<unknown>());
  }

  /**
   * Read the detector health authority without using findings, delivery, or
   * Queue state as a proxy. A never-run or expired successful scan is never
   * silently healthy.
   */
  async readHealth(
    serviceId: string,
    nowMs: number,
    staleAfterMs = G44_HEALTH_STALE_AFTER_MS,
  ): Promise<GlobalCompletenessHealthRecord> {
    if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(staleAfterMs) || staleAfterMs < 1) {
      throw new Error("g44_health_read_invalid_time");
    }
    const row = await this.database.prepare(
      `SELECT service_id, scanner_version, status, cursor_json, last_full_scan_at, last_error, updated_at
         FROM serialized_dcb_completeness_scanner_health
        WHERE service_id = ?`,
    ).bind(serviceId).first<D1Row>();
    if (row === null || row === undefined) {
      return {
        serviceId,
        scannerVersion: this.scannerVersion,
        status: "UNKNOWN",
        cursorJson: null,
        lastSettledFrontierSuid: null,
        lastFullScanAt: null,
        lastError: "scanner_has_never_run",
        updatedAt: nowMs,
      };
    }
    const status = asString(row.status, "scanner_health.status") as GlobalCompletenessHealth;
    const lastFullScanAt = row.last_full_scan_at === null ? null : asNumber(row.last_full_scan_at, "scanner_health.last_full_scan_at");
    if (status === "HEALTHY" && (lastFullScanAt === null || nowMs - lastFullScanAt > staleAfterMs)) {
      await this.writeHealth(serviceId, "STALE", null, lastFullScanAt, "scanner_full_scan_stale", nowMs);
      return {
        serviceId,
        scannerVersion: asString(row.scanner_version, "scanner_health.scanner_version"),
        status: "STALE",
        cursorJson: row.cursor_json === null ? null : asString(row.cursor_json, "scanner_health.cursor_json"),
        lastSettledFrontierSuid: settledFrontierFromCursor(
          row.cursor_json === null ? null : asString(row.cursor_json, "scanner_health.cursor_json"),
        ),
        lastFullScanAt,
        lastError: "scanner_full_scan_stale",
        updatedAt: nowMs,
      };
    }
    if (!["HEALTHY", "UNKNOWN", "FAILED", "STALE", "BLOCK", "UNSETTLED"].includes(status)) {
      throw new Error("scanner_health_status_invalid");
    }
    return {
      serviceId: asString(row.service_id, "scanner_health.service_id"),
      scannerVersion: asString(row.scanner_version, "scanner_health.scanner_version"),
      status,
      cursorJson: row.cursor_json === null ? null : asString(row.cursor_json, "scanner_health.cursor_json"),
      lastSettledFrontierSuid: settledFrontierFromCursor(
        row.cursor_json === null ? null : asString(row.cursor_json, "scanner_health.cursor_json"),
      ),
      lastFullScanAt,
      lastError: row.last_error === null ? null : asString(row.last_error, "scanner_health.last_error"),
      updatedAt: asNumber(row.updated_at, "scanner_health.updated_at"),
    };
  }

  /**
   * The one interim coverage gate.  It deliberately has no configuration
   * matrix and does not turn a missing finding into a synthetic healthy read.
   */
  async coverage(serviceId: string, nowMs: number): Promise<GlobalCompletenessCoverage> {
    const health = await this.readHealth(serviceId, nowMs);
    if (health.status === "HEALTHY") {
      return {
        kind: "SETTLED",
        health,
        frontierSuid: health.lastSettledFrontierSuid,
        reason: null,
        partitionTag: null,
        observedAt: health.updatedAt,
      };
    }
    return {
      kind: "BLOCK/UNSETTLED",
      health,
      frontierSuid: health.lastSettledFrontierSuid,
      reason: health.lastError ?? `scanner_${health.status.toLowerCase()}`,
      partitionTag: await this.latestFindingPartitionTag(serviceId),
      observedAt: health.updatedAt,
    };
  }

  /**
   * The downstream view gate must consume the same proof domain that the
   * reconciler persisted. A service-level HEALTHY bit is insufficient: a
   * delivery from a partition added after that scan must remain blocked until
   * a later successful cursor includes its exact local obligation sequence.
   */
  async coverageForObligation(
    serviceId: string,
    tag: string,
    obligationSequence: number,
    nowMs: number,
  ): Promise<GlobalCompletenessCoverage> {
    if (serviceId.length === 0 || tag.length === 0 ||
      !Number.isSafeInteger(obligationSequence) || obligationSequence < 1) {
      throw new Error("g44_coverage_obligation_invalid_identity");
    }
    const decision = await this.coverage(serviceId, nowMs);
    if (decision.kind !== "SETTLED" || cursorIncludesObligation(decision.health.cursorJson, serviceId, tag, obligationSequence)) {
      return decision;
    }
    return {
      kind: "BLOCK/UNSETTLED",
      health: decision.health,
      frontierSuid: decision.frontierSuid,
      reason: `obligation_not_in_settled_cursor:${tag}:${obligationSequence}`,
      partitionTag: tag,
      observedAt: decision.observedAt,
    };
  }

  /**
   * DeliveryCore calls this after a detector exception and before it returns
   * without applying views. It shares the scanner's single health/finding
   * authority rather than creating a second incident workflow.
   */
  async recordDetectorFailure(serviceId: string, error: unknown, nowMs: number): Promise<void> {
    const message = `detector_failure:${errorText(error).slice(0, 256)}`;
    await this.appendFinding(serviceId, {
      identity: `GLOBAL_DETECTOR_FAILURE|${serviceId}`,
      type: "GLOBAL_ARRAY_DETECTOR_FAILURE",
      partitionTag: null,
      obligationSequence: null,
      eventId: null,
      eventDigest: null,
    }, nowMs);
    await this.writeHealth(serviceId, "FAILED", null, null, message, nowMs);
  }

  /** D1 receipt join is independent from every projection and transport. */
  async globalReceiptMatches(serviceId: string, tag: string, obligation: SourceObligationFact): Promise<boolean> {
    const membership = obligation.localCommittedMembership[0];
    if (membership === undefined || obligation.localCommittedMembership.length !== 1 ||
      membership.serviceId !== serviceId || membership.eventId !== obligation.eventId || membership.tag !== tag) return false;
    const row = await this.database.prepare(
      `SELECT 1 AS joined
         FROM serialized_dcb_global_receipts AS receipt
         JOIN serialized_dcb_global_memberships AS membership
           ON membership.service_id = receipt.service_id
          AND membership.event_id = receipt.event_id
          AND membership.partition_tag = receipt.membership_tag
          AND membership.event_digest = receipt.event_digest
         JOIN dcb_events AS event
           ON event."ServiceId" = receipt.service_id
          AND event."Id" = receipt.event_id
          AND event."EventDigest" = receipt.event_digest
        WHERE receipt.service_id = ? AND receipt.partition_tag = ?
          AND receipt.obligation_sequence = ? AND receipt.event_id = ?
          AND receipt.event_digest = ? AND receipt.membership_tag = ?`,
    ).bind(serviceId, tag, obligation.obligationSequence, obligation.eventId, obligation.eventDigest, tag).first<D1Row>();
    return row !== null && row !== undefined && row.joined === 1;
  }

  private async snapshotPartitions(serviceId: string): Promise<SourcePartitionSnapshot[]> {
    const result = await this.database.prepare(
      `SELECT service_id, partition_tag, last_obligation_sequence
         FROM serialized_dcb_source_partitions
        WHERE service_id = ?
        ORDER BY partition_tag COLLATE BINARY ASC`,
    ).bind(serviceId).all<D1Row>();
    const snapshots = result.results.map((row) => ({
      serviceId: asString(row.service_id, "source_partition.service_id"),
      tag: asString(row.partition_tag, "source_partition.partition_tag"),
      upperBoundSequence: asNumber(row.last_obligation_sequence, "source_partition.last_obligation_sequence"),
    }));
    const identities = new Set<string>();
    for (const snapshot of snapshots) {
      const identity = `${snapshot.serviceId}\u0000${snapshot.tag}`;
      if (identities.has(identity)) throw new Error(`source_partition_duplicate:${snapshot.tag}`);
      identities.add(identity);
    }
    return snapshots;
  }

  private assertSnapshotUniverseUnchanged(
    start: readonly SourcePartitionSnapshot[],
    end: readonly SourcePartitionSnapshot[],
  ): void {
    const startSet = new Set(start.map((entry) => `${entry.serviceId}\u0000${entry.tag}`));
    const endSet = new Set(end.map((entry) => `${entry.serviceId}\u0000${entry.tag}`));
    if (startSet.size !== endSet.size || [...startSet].some((entry) => !endSet.has(entry))) {
      throw new Error("source_partition_set_changed_during_scan");
    }
  }

  private assertStartPartitionsRetained(
    start: readonly SourcePartitionSnapshot[],
    end: readonly SourcePartitionSnapshot[],
  ): void {
    const endSet = new Set(end.map((entry) => `${entry.serviceId}\u0000${entry.tag}`));
    if (start.some((entry) => !endSet.has(`${entry.serviceId}\u0000${entry.tag}`))) {
      throw new Error("source_partition_set_changed_during_scan");
    }
  }

  private assertPage(snapshot: SourcePartitionSnapshot, afterSequence: number, page: SourceObligationPage): void {
    if (page.serviceId !== snapshot.serviceId || page.tag !== snapshot.tag ||
      page.upperBoundSequence !== snapshot.upperBoundSequence ||
      page.afterSequence !== afterSequence || page.observedMaxSequence < snapshot.upperBoundSequence) {
      throw new Error(`source_page_snapshot_mismatch:${snapshot.tag}`);
    }
  }

  /**
   * The frontier is derived only from receipts inside the immutable source
   * snapshot that just passed every G44 join.  It is not the mutable global
   * table head: a delivery arriving after the snapshot is deliberately left
   * for a later FULL scan.
   */
  private async settledFrontierAtSnapshot(
    serviceId: string,
    snapshots: readonly SourcePartitionSnapshot[],
  ): Promise<string | null> {
    let frontier: string | null = null;
    for (const snapshot of snapshots) {
      const row = await this.database.prepare(
        `SELECT MAX(event."SortableUniqueId" COLLATE BINARY) AS frontier_suid
           FROM serialized_dcb_global_receipts receipt
           JOIN dcb_events event
             ON event."ServiceId" = receipt.service_id
            AND event."Id" = receipt.event_id
          WHERE receipt.service_id = ?
            AND receipt.partition_tag = ?
            AND receipt.obligation_sequence <= ?`,
      ).bind(serviceId, snapshot.tag, snapshot.upperBoundSequence).first<D1Row>();
      const candidate = row?.frontier_suid;
      if (typeof candidate === "string" && candidate.length > 0 && (frontier === null || candidate > frontier)) {
        frontier = candidate;
      }
    }
    return frontier;
  }

  private async latestFindingPartitionTag(serviceId: string): Promise<string | null> {
    const row = await this.database.prepare(
      `SELECT partition_tag
         FROM serialized_dcb_completeness_findings
        WHERE service_id = ? AND partition_tag IS NOT NULL
        ORDER BY last_observed_at DESC, partition_tag COLLATE BINARY ASC
        LIMIT 1`,
    ).bind(serviceId).first<D1Row>();
    return row === null || row === undefined || row.partition_tag === null
      ? null
      : asString(row.partition_tag, "scanner_health.partition_tag");
  }

  private async appendObligationFinding(serviceId: string, tag: string, obligation: SourceObligationFact, nowMs: number): Promise<void> {
    const incidentType = obligation.status === "poison"
      ? "GLOBAL_ARRAY_POISON_OBLIGATION"
      : "GLOBAL_ARRAY_RECEIPT_ABSENT";
    await this.appendFinding(serviceId, {
      identity: findingIdentity(serviceId, tag, obligation),
      type: incidentType,
      partitionTag: tag,
      obligationSequence: obligation.obligationSequence,
      eventId: obligation.eventId,
      eventDigest: obligation.eventDigest,
    }, nowMs);
  }

  private async appendFinding(serviceId: string, finding: CompletenessFindingInput, nowMs: number): Promise<void> {
    await this.database.prepare(
      `INSERT INTO serialized_dcb_completeness_findings
         (service_id, incident_identity, incident_type, partition_tag,
          obligation_sequence, event_id, event_digest, state,
          first_observed_at, last_observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)
       ON CONFLICT (service_id, incident_identity) DO UPDATE SET
         last_observed_at = excluded.last_observed_at`,
    ).bind(
      serviceId,
      finding.identity,
      finding.type,
      finding.partitionTag,
      finding.obligationSequence,
      finding.eventId,
      finding.eventDigest,
      nowMs,
      nowMs,
    ).run();
  }

  private async writeHealth(
    serviceId: string,
    status: GlobalCompletenessHealth,
    cursor: string | null,
    lastFullScanAt: number | null,
    error: string | null,
    nowMs: number,
  ): Promise<void> {
    await this.database.prepare(
      `INSERT INTO serialized_dcb_completeness_scanner_health
         (service_id, scanner_version, status, cursor_json, last_full_scan_at, last_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (service_id) DO UPDATE SET
         scanner_version = excluded.scanner_version,
         status = excluded.status,
         cursor_json = COALESCE(excluded.cursor_json, serialized_dcb_completeness_scanner_health.cursor_json),
         last_full_scan_at = COALESCE(excluded.last_full_scan_at, serialized_dcb_completeness_scanner_health.last_full_scan_at),
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
    ).bind(serviceId, this.scannerVersion, status, cursor, lastFullScanAt, error, nowMs).run();
  }
}

/** The acknowledgement payload carries facts from the same source envelope. */
export function globalReceiptAcknowledgement(message: DownstreamOutboxMessage, receivedAt: number) {
  return {
    deliveries: [{
      attemptId: message.attemptId,
      eventId: message.eventId,
      suid: message.suid,
      payload: message.payload,
      eventType: message.eventType,
      provenance: message.provenance,
      timestamp: message.timestamp,
      allocatorLineageId: message.allocatorLineageId,
      enqueuedAt: message.enqueuedAt,
      completeness: message.completeness,
    }],
    nowMs: receivedAt,
  };
}
