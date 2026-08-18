import type { DownstreamOutboxMessage, PipelineClock } from "./types";
import type {
  DetectorStore,
  InconsistencyClassification,
  InconsistencyFinding,
  PendingArrivalRecord,
} from "../store/types";

export const MIN_STABILITY_HORIZON_MS = 20_000;

export interface ExclusionLedgerInput {
  serviceId: string;
  attemptId: string;
  eventId: string;
  suid: string;
  tag: string;
}

export interface ExclusionLedgerPort {
  isExcludedAudited(input: ExclusionLedgerInput): Promise<boolean>;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function missingPaths(pending: PendingArrivalRecord): string[] {
  const observed = new Set(pending.observedPaths);
  return pending.expectedPaths.filter((path) => !observed.has(path));
}

function finding(
  pending: PendingArrivalRecord,
  path: string,
  classification: InconsistencyClassification,
  observedAt: number,
): InconsistencyFinding {
  return {
    serviceId: pending.serviceId,
    eventId: pending.eventId,
    path,
    classification,
    firstObservedAt: pending.firstObservedAt,
    lagBoundMs: pending.lagBoundMs,
    observedAt,
  };
}

/**
 * This component owns only pending/finding facts. Event rows are written by
 * the adapter before this detector is invoked and are intentionally absent
 * from DetectorStore.
 */
export class InconsistencyDetector {
  constructor(
    private readonly store: DetectorStore,
    private readonly exclusions: ExclusionLedgerPort,
  ) {}

  async observe(message: DownstreamOutboxMessage, arrivedAt: number, dynamicLagBoundMs: number): Promise<void> {
    const pending = await this.store.upsertPending(
      { ...message, eventTags: sortedUnique(message.eventTags) },
      arrivedAt,
      Math.max(MIN_STABILITY_HORIZON_MS, dynamicLagBoundMs),
    );
    const excluded = await this.classifyKnownExclusions(pending, arrivedAt);
    await this.resolveLateArrivals(pending, arrivedAt, excluded);
  }

  async stabilize(clock: PipelineClock, serviceId?: string): Promise<void> {
    const now = clock.now();
    for (const pending of await this.store.listPending(serviceId)) {
      const excluded = await this.classifyKnownExclusions(pending, now);
      const missing = missingPaths(pending);
      if (missing.length === 0) {
        await this.resolveLateArrivals(pending, now, excluded);
        continue;
      }
      if (now < pending.firstObservedAt + Math.max(MIN_STABILITY_HORIZON_MS, pending.lagBoundMs)) {
        continue;
      }
      for (const path of missing) {
        if (!excluded.has(path)) {
          await this.store.appendFinding(finding(pending, path, "MISSING_STABLE", now));
        }
      }
    }
  }

  private async classifyKnownExclusions(pending: PendingArrivalRecord, observedAt: number): Promise<Set<string>> {
    const excluded = new Set<string>();
    for (const path of missingPaths(pending)) {
      if (await this.exclusions.isExcludedAudited({
        serviceId: pending.serviceId,
        attemptId: pending.attemptId,
        eventId: pending.eventId,
        suid: pending.suid,
        tag: path,
      })) {
        excluded.add(path);
        await this.store.appendFinding(finding(pending, path, "EXCLUDED_AUDITED", observedAt));
      }
    }
    return excluded;
  }

  private async resolveLateArrivals(
    pending: PendingArrivalRecord,
    observedAt: number,
    excluded: ReadonlySet<string>,
  ): Promise<void> {
    if (missingPaths(pending).length !== 0) {
      return;
    }
    for (const path of pending.expectedPaths) {
      if (!excluded.has(path) && await this.store.hasFinding(
        pending.serviceId,
        pending.eventId,
        path,
        "MISSING_STABLE",
      )) {
        await this.store.appendFinding(finding(pending, path, "RESOLVED_LATE", observedAt));
      }
    }
  }
}
