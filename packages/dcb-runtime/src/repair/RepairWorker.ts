import type { RepairBranch, RepairFacts, RepairScopeItem, TagFence } from "../tag/types";
import type { ExclusionLookupPort } from "../downstream/ExclusionLookup";
import { requireConfiguredServiceId } from "../http/testServiceId";

type JsonObject = Record<string, unknown>;

export type RepairMode = "dry-run" | "execute";
/** Private repair.test interruption points, one for each durable saga boundary. */
export type RepairFault =
  | "after-lease-before-prepare"
  | "after-prepare-before-apply"
  | "after-apply-before-observation"
  | "after-verify-before-audit"
  | "after-audit-before-clear"
  | "after-clear-before-final-observation";

export interface RepairWorkerEnv {
  JOURNAL: DurableObjectNamespace;
  TAG: DurableObjectNamespace;
  SDT_SERVICE_ID?: string;
}

export interface RepairExecutionInput {
  attemptIds: string[];
  tags: string[];
  actor: string;
  owner: string;
  mode: RepairMode;
  maxItems: number;
  checkpoint?: string;
  fault?: RepairFault;
}

export interface RepairExecutionResult {
  mode: RepairMode;
  dryRun: boolean;
  checkpoint: string | null;
  processed: number;
  rolledForward: number;
  excludedAudited: number;
  failedClosed: number;
  cleared: number;
  interrupted?: RepairFault;
  pending: number;
}

interface JournalCandidate {
  eventId: string;
  payload: string;
  tags: string[];
  suid: string;
  allocatorLineageId?: string;
}

interface JournalWorkset {
  attemptId?: string;
  missingTags: string[];
  candidates: JournalCandidate[];
}

interface TagRepairFacts {
  tag: string;
  head: string;
  version: number;
  events: Array<{ attemptId: string; eventId: string; suid: string; payload: string; allocatorLineageId?: string }>;
  outbox: Array<{ attemptId: string; eventId: string; suid: string; payload: string; allocatorLineageId?: string }>;
  fences: TagFence[];
  clearedFences: TagFence[];
  repairOwner: string | null;
  repairLeaseUntil: number | null;
  highestRepairEpoch: number;
  repairScope: RepairScopeItem[];
  repairScopeVersion: number;
  facts: RepairFacts;
}

interface TaggedItem {
  tag: string;
  item: RepairScopeItem;
}

interface LeaseContext {
  owner: string;
  epoch: number;
}

class RepairWorkerFailure extends Error {}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseBody<T>(response: Response): Promise<T | undefined> {
  return response.headers.get("content-type")?.includes("application/json") === true
    ? response.json<T>()
    : Promise.resolve(undefined);
}

function itemKey(item: RepairScopeItem): string {
  return `${item.attemptId}\u0000${item.eventId}\u0000${item.suid}`;
}

function hasPartialFence(facts: TagRepairFacts, attemptId: string): boolean {
  return facts.fences.some((fence) => fence.reason === "partial_write" && fence.attemptId === attemptId);
}

function resolutionFor(facts: TagRepairFacts, item: RepairScopeItem) {
  return facts.facts.resolutions.find((resolution) =>
    resolution.attemptId === item.attemptId &&
    resolution.eventId === item.eventId &&
    resolution.suid === item.suid,
  );
}

function auditFor(facts: TagRepairFacts, item: RepairScopeItem): boolean {
  return facts.facts.audits.some((audit) =>
    audit.attemptId === item.attemptId && audit.eventId === item.eventId && audit.suid === item.suid,
  );
}

function sortTaggedItems(items: TaggedItem[]): TaggedItem[] {
  return [...items].sort((left, right) => {
    if (left.item.suid !== right.item.suid) {
      return left.item.suid < right.item.suid ? -1 : 1;
    }
    const leftKey = `${left.tag}\u0000${itemKey(left.item)}`;
    const rightKey = `${right.tag}\u0000${itemKey(right.item)}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

/**
 * Per-request repair coordinator.  The only authority it trusts is a fresh
 * Tag DO fact read; Journal records are append-only observations.
 */
export class RepairWorker {
  constructor(
    private readonly env: RepairWorkerEnv,
    private readonly exclusions: ExclusionLookupPort,
    private readonly serviceId = requireConfiguredServiceId(env.SDT_SERVICE_ID),
  ) {}

  async execute(input: RepairExecutionInput): Promise<RepairExecutionResult> {
    const workset = await this.enumerate(input.attemptIds, input.tags);
    const filtered = workset.filter((entry) => input.checkpoint === undefined || entry.item.suid > input.checkpoint);
    const bounded = filtered.slice(0, input.maxItems);
    const checkpoint = bounded.length === 0 ? input.checkpoint ?? null : bounded[bounded.length - 1]!.item.suid;

    if (input.mode === "dry-run") {
      // Facts are intentionally read during planning so an operator can see
      // which exact fences remain, while no mutation call is made.
      await Promise.all([...new Set(workset.map((entry) => entry.tag))].map((tag) => this.tagFacts(tag)));
      return {
        mode: input.mode,
        dryRun: true,
        checkpoint,
        processed: 0,
        rolledForward: 0,
        excludedAudited: 0,
        failedClosed: 0,
        cleared: 0,
        pending: filtered.length,
      };
    }

    const result: RepairExecutionResult = {
      mode: input.mode,
      dryRun: false,
      checkpoint,
      processed: 0,
      rolledForward: 0,
      excludedAudited: 0,
      failedClosed: 0,
      cleared: 0,
      pending: Math.max(0, filtered.length - bounded.length),
    };
    const leases = new Map<string, LeaseContext>();

    for (const entry of bounded) {
      const before = await this.tagFacts(entry.tag);
      // Resume after clear-before-final-observation: no mutation is needed,
      // and the current Tag fact is sufficient to reconstruct completion.
      if (!hasPartialFence(before, entry.item.attemptId) && resolutionFor(before, entry.item) !== undefined && auditFor(before, entry.item)) {
        continue;
      }
      const lease = await this.ensureLease(entry.tag, input, workset, leases);
      if (input.fault === "after-lease-before-prepare") {
        return { ...result, interrupted: input.fault, pending: filtered.length };
      }
      await this.observe(entry.tag, entry.item, lease, "PREPARED");
      if (input.fault === "after-prepare-before-apply") {
        return { ...result, interrupted: input.fault, pending: filtered.length };
      }
      let applied = await this.apply(entry.tag, entry.item, lease);
      if (applied.status === 409 && applied.reason === "repair_scope_required") {
        // F3 discovered after the first scan: the failed call has no side
        // effect, then a fresh union makes the new work item eligible.
        const refreshed = await this.enumerate(input.attemptIds, input.tags);
        await this.unionScope(entry.tag, lease, refreshed.filter((candidate) => candidate.tag === entry.tag));
        applied = await this.apply(entry.tag, entry.item, lease);
      }
      if (applied.status !== 200 || applied.branch === undefined) {
        throw new RepairWorkerFailure(`Tag repair apply rejected: ${applied.reason ?? applied.status}`);
      }
      if (input.fault === "after-apply-before-observation") {
        return { ...result, interrupted: input.fault, pending: filtered.length };
      }

      const facts = await this.tagFacts(entry.tag);
      const durable = resolutionFor(facts, entry.item);
      if (durable === undefined) {
        throw new RepairWorkerFailure("Tag repair apply did not leave a durable resolution fact");
      }
      await this.observe(entry.tag, entry.item, lease, "VERIFIED", durable.branch);
      if (input.fault === "after-verify-before-audit") {
        return { ...result, interrupted: input.fault, pending: filtered.length };
      }
      if (durable.branch === "FAILED_CLOSED") {
        result.failedClosed += 1;
        result.processed += 1;
        continue;
      }
      const alreadyAudited = auditFor(facts, entry.item);
      if (durable.branch === "EXCLUDED_AUDITED") {
        if (!alreadyAudited) {
          await this.exclusions.recordExclusion({
            attemptId: entry.item.attemptId,
            tag: entry.tag,
            eventId: entry.item.eventId,
            suid: entry.item.suid,
            actor: input.actor,
            repairEpoch: lease.epoch,
          });
        }
        result.excludedAudited += 1;
      } else {
        result.rolledForward += 1;
      }
      if (!alreadyAudited) {
        await this.audit(entry.tag, entry.item, lease, input.actor);
      }
      if (input.fault === "after-audit-before-clear") {
        return { ...result, interrupted: input.fault, pending: filtered.length };
      }
      result.processed += 1;
    }

    // A clear can happen only against a fresh, stable scope snapshot.  The
    // Tag DO rechecks every item/audit in the transaction that removes exactly
    // one partial_write fence.
    for (const tag of [...new Set(workset.map((entry) => entry.tag))]) {
      const lease = leases.get(tag);
      if (lease === undefined) {
        continue;
      }
      const facts = await this.tagFacts(tag);
      // A concurrently joined F2 must remain in the durable scope, but it
      // must not block this bounded invocation from clearing its own exact
      // F1 fence.  Its later workset will use the same unioned authority.
      const activeAttempts = [...new Set(
        workset
          .filter((entry) => entry.tag === tag && hasPartialFence(facts, entry.item.attemptId))
          .map((entry) => entry.item.attemptId),
      )];
      for (const attemptId of activeAttempts) {
        const attemptScope = facts.repairScope.filter((item) => item.attemptId === attemptId);
        // A bounded invocation returns its checkpoint with the fence still
        // held until every item in the stable durable scope has a Tag-side
        // resolution and audit.  This is what makes resume safe.
        if (attemptScope.some((item) => {
          const resolution = resolutionFor(facts, item);
          return resolution === undefined || resolution.branch === "FAILED_CLOSED" || !auditFor(facts, item);
        })) {
          continue;
        }
        const response = await this.tagPost(tag, "/repair/clear", {
          owner: lease.owner,
          epoch: lease.epoch,
          attemptId,
          scopeVersion: facts.repairScopeVersion,
        });
        if (!response.ok) {
          const body = await responseBody<{ error?: string }>(response);
          throw new RepairWorkerFailure(`Tag repair clear rejected: ${body?.error ?? response.status}`);
        }
        result.cleared += 1;
      }
    }

    if (input.fault === "after-clear-before-final-observation") {
      return { ...result, interrupted: input.fault, pending: filtered.length };
    }

    // Completion display is likewise reconstructed from current Tag facts;
    // an interrupted final Journal write cannot resurrect a cleared fence.
    await this.recordClearedObservations(workset, leases);
    return result;
  }

  private async enumerate(attemptIds: string[], tags: string[]): Promise<TaggedItem[]> {
    const result: TaggedItem[] = [];
    for (const attemptId of attemptIds) {
      const response = await this.journalGet(attemptId, "/repair/workset");
      if (!response.ok) {
        const body = await responseBody<{ error?: string }>(response);
        throw new RepairWorkerFailure(`Repair workset rejected for ${attemptId}: ${body?.error ?? response.status}`);
      }
      const workset = await responseBody<JournalWorkset>(response);
      if (workset === undefined || !Array.isArray(workset.candidates) || !Array.isArray(workset.missingTags)) {
        throw new RepairWorkerFailure(`Repair workset for ${attemptId} was malformed`);
      }
      for (const tag of tags) {
        if (!workset.missingTags.includes(tag)) {
          continue;
        }
        for (const candidate of workset.candidates) {
          if (!candidate.tags.includes(tag)) {
            continue;
          }
          result.push({
            tag,
            item: {
              attemptId,
              eventId: candidate.eventId,
              suid: candidate.suid,
              payload: candidate.payload,
              eventTags: candidate.tags,
              allocatorLineageId: candidate.allocatorLineageId,
            },
          });
        }
      }
    }
    return sortTaggedItems(result);
  }

  private async ensureLease(
    tag: string,
    input: RepairExecutionInput,
    workset: TaggedItem[],
    leases: Map<string, LeaseContext>,
  ): Promise<LeaseContext> {
    const current = leases.get(tag);
    if (current !== undefined) {
      return current;
    }
    const scope = await this.activeScope(tag, workset);
    if (scope.length === 0) {
      throw new RepairWorkerFailure(`No durable partial_write fence remains for ${tag}`);
    }
    const acquire = await this.tagPost(tag, "/repair/acquire", { owner: input.owner, scope });
    const body = await responseBody<{ epoch?: number; error?: string }>(acquire);
    let lease: LeaseContext;
    if (acquire.status === 201 && typeof body?.epoch === "number") {
      lease = { owner: input.owner, epoch: body.epoch };
    } else {
      const facts = await this.tagFacts(tag);
      if (facts.repairOwner !== input.owner || facts.repairLeaseUntil === null) {
        throw new RepairWorkerFailure(`Repair lease is held by another owner for ${tag}: ${body?.error ?? acquire.status}`);
      }
      const renewed = await this.tagPost(tag, "/repair/renew", {
        owner: input.owner,
        epoch: facts.highestRepairEpoch,
      });
      if (!renewed.ok) {
        const rejected = await responseBody<{ error?: string }>(renewed);
        throw new RepairWorkerFailure(`Repair lease cannot be renewed for ${tag}: ${rejected?.error ?? renewed.status}`);
      }
      lease = { owner: input.owner, epoch: facts.highestRepairEpoch };
    }
    await this.unionScope(tag, lease, workset.filter((entry) => entry.tag === tag));
    leases.set(tag, lease);
    return lease;
  }

  private async activeScope(tag: string, workset: TaggedItem[]): Promise<RepairScopeItem[]> {
    const facts = await this.tagFacts(tag);
    const items = workset
      .filter((entry) => entry.tag === tag && hasPartialFence(facts, entry.item.attemptId))
      .map((entry) => entry.item);
    return [...new Map(items.map((item) => [itemKey(item), item])).values()];
  }

  private async unionScope(tag: string, lease: LeaseContext, workset: TaggedItem[]): Promise<void> {
    const scope = await this.activeScope(tag, workset);
    if (scope.length === 0) {
      return;
    }
    const response = await this.tagPost(tag, "/repair/scope-union", { ...lease, scope });
    if (!response.ok) {
      const body = await responseBody<{ error?: string }>(response);
      throw new RepairWorkerFailure(`Repair scope union rejected: ${body?.error ?? response.status}`);
    }
  }

  private async apply(tag: string, item: RepairScopeItem, lease: LeaseContext): Promise<{
    status: number;
    reason?: string;
    branch?: RepairBranch;
  }> {
    const response = await this.tagPost(tag, "/repair/apply", { ...lease, item });
    const body = await responseBody<{ status?: RepairBranch; reason?: string; error?: string }>(response);
    return { status: response.status, reason: body?.reason ?? body?.error, branch: body?.status };
  }

  private async audit(tag: string, item: RepairScopeItem, lease: LeaseContext, actor: string): Promise<void> {
    const response = await this.tagPost(tag, "/repair/audit", { ...lease, item, actor });
    if (!response.ok) {
      const body = await responseBody<{ error?: string }>(response);
      throw new RepairWorkerFailure(`Repair audit rejected: ${body?.error ?? response.status}`);
    }
  }

  private async observe(
    tag: string,
    item: RepairScopeItem,
    lease: LeaseContext,
    phase: "PREPARED" | "VERIFIED" | "CLEARED",
    branch?: RepairBranch,
  ): Promise<void> {
    const response = await this.journalPost(item.attemptId, "/repair/observation", {
      owner: lease.owner,
      epoch: lease.epoch,
      tag,
      attemptId: item.attemptId,
      eventId: item.eventId,
      suid: item.suid,
      phase,
      ...(branch === undefined ? {} : { branch }),
    });
    if (!response.ok) {
      const body = await responseBody<{ error?: string }>(response);
      throw new RepairWorkerFailure(`Repair observation rejected: ${body?.error ?? response.status}`);
    }
  }

  private async recordClearedObservations(workset: TaggedItem[], leases: Map<string, LeaseContext>): Promise<void> {
    for (const entry of workset) {
      const facts = await this.tagFacts(entry.tag);
      const durable = resolutionFor(facts, entry.item);
      if (durable !== undefined && durable.branch !== "FAILED_CLOSED" && auditFor(facts, entry.item) && !hasPartialFence(facts, entry.item.attemptId)) {
        const lease = leases.get(entry.tag) ?? { owner: durable.owner, epoch: durable.epoch };
        await this.observe(entry.tag, entry.item, lease, "CLEARED", durable.branch);
      }
    }
  }

  private journalFor(attemptId: string): DurableObjectStub {
    return this.env.JOURNAL.get(this.env.JOURNAL.idFromName(attemptId));
  }

  private tagFor(tag: string): DurableObjectStub {
    return this.env.TAG.get(this.env.TAG.idFromName(`${this.serviceId}|${tag}`));
  }

  private journalGet(attemptId: string, path: string): Promise<Response> {
    return this.journalFor(attemptId).fetch(`https://repair.internal${path}`);
  }

  private journalPost(attemptId: string, path: string, body: unknown): Promise<Response> {
    return this.journalFor(attemptId).fetch(`https://repair.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async tagFacts(tag: string): Promise<TagRepairFacts> {
    const response = await this.tagFor(tag).fetch(`https://repair.internal/repair/facts?__tag=${encodeURIComponent(tag)}`);
    if (!response.ok) {
      const body = await responseBody<{ error?: string }>(response);
      throw new RepairWorkerFailure(`Tag facts rejected for ${tag}: ${body?.error ?? response.status}`);
    }
    const facts = await responseBody<TagRepairFacts>(response);
    if (facts === undefined || facts.tag !== tag || !isObject(facts)) {
      throw new RepairWorkerFailure(`Tag facts were malformed for ${tag}`);
    }
    return facts;
  }

  private tagPost(tag: string, path: string, body: unknown): Promise<Response> {
    return this.tagFor(tag).fetch(`https://repair.internal${path}?__tag=${encodeURIComponent(tag)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
}

export { RepairWorkerFailure };
