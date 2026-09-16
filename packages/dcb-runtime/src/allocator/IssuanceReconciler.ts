import { scopeIdFor } from "../scope/ScopeName";
import type {
  IssuanceEnvelope,
  IssuanceRecoverySchedule,
  TagResolutionObservation,
  TargetClosureRecord,
  TargetResolutionEvidence,
} from "./IssuanceLedger";
import {
  DEFAULT_WRITER_EPOCH,
  ISSUANCE_NEVER_CONTACTED_GRACE_MS,
  ISSUANCE_RECOVERY_KEY,
  UNRESOLVED_INDEX_PREFIX,
  countUnresolvedEntries,
  envelopeKey,
  parseIndexEntry,
  syncIssuanceRecoveryAlarm,
  targetKey,
} from "./IssuanceLedger";

export interface TagInspectResult {
  readonly terminalStatus: "installed-and-covered" | "absent-and-irrevocably-fenced";
  readonly eventId?: string;
  readonly obligationDigest?: string;
  readonly tombstoneEpoch?: number;
}

export type TagInspectOutcome =
  | { readonly kind: "terminal"; readonly result: TagInspectResult }
  | { readonly kind: "absent-never-contacted" }
  | { readonly kind: "absent-but-unfenced" }
  | { readonly kind: "not-terminal-yet" }
  | { readonly kind: "unreachable" };

export interface IssuanceReconcilerEnv {
  readonly TAG: DurableObjectNamespace;
  readonly ALLOCATOR: DurableObjectNamespace;
}

type TagReconciliationEnv = Pick<IssuanceReconcilerEnv, "TAG">;

const RECONCILE_BATCH_LIMIT = 8;
const RECONCILE_RETRY_MS = 1_000;

export async function inspectTagTarget(
  env: TagReconciliationEnv,
  serviceId: string,
  tag: string,
  envelope: IssuanceEnvelope,
): Promise<TagInspectOutcome> {
  const url = new URL("https://tag.internal/__internal/g77/inspect-target");
  url.searchParams.set("__serviceId", serviceId);
  url.searchParams.set("__tag", tag);
  const response = await env.TAG.get(scopeIdFor(env.TAG, {
    serviceId,
    doClass: "tag",
    identity: tag,
  })).fetch(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      eventId: envelope.eventId,
      suid: envelope.suid,
      canonicalTargetTags: envelope.canonicalTargetTags,
      pinnedWriterEpoch: envelope.pinnedWriterEpoch,
      attemptId: envelope.attemptId,
    }),
  }));
  if (response.status === 503) return { kind: "unreachable" };
  if (response.status === 409) return { kind: "not-terminal-yet" };
  if (response.status !== 200) return { kind: "unreachable" };
  const body = await response.json<TagInspectResult & { inspectionStatus?: string }>();
  if (body.inspectionStatus === "absent-never-contacted") {
    return { kind: "absent-never-contacted" };
  }
  if (body.inspectionStatus === "absent-but-unfenced") {
    return { kind: "absent-but-unfenced" };
  }
  if (
    body.terminalStatus !== "installed-and-covered" &&
    body.terminalStatus !== "absent-and-irrevocably-fenced"
  ) {
    return { kind: "not-terminal-yet" };
  }
  return { kind: "terminal", result: body };
}

export async function fenceAbsentTarget(
  env: TagReconciliationEnv,
  serviceId: string,
  tag: string,
  envelope: IssuanceEnvelope,
): Promise<boolean> {
  const url = new URL("https://tag.internal/__internal/g77/fence-absent-target");
  url.searchParams.set("__serviceId", serviceId);
  url.searchParams.set("__tag", tag);
  const response = await env.TAG.get(scopeIdFor(env.TAG, {
    serviceId,
    doClass: "tag",
    identity: tag,
  })).fetch(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      attemptId: envelope.attemptId,
      epoch: envelope.pinnedWriterEpoch ?? DEFAULT_WRITER_EPOCH,
    }),
  }));
  return response.status >= 200 && response.status < 300;
}

function tagObservationFromInspect(result: TagInspectResult): TagResolutionObservation {
  if (result.terminalStatus === "installed-and-covered") {
    return {
      terminalStatus: "installed-and-covered",
      ...(result.obligationDigest !== undefined ? { obligationDigest: result.obligationDigest } : {}),
    };
  }
  return {
    terminalStatus: "absent-and-irrevocably-fenced",
    ...(result.tombstoneEpoch !== undefined ? { tombstoneEpoch: result.tombstoneEpoch } : {}),
  };
}

export function tagObservationMatchesInspect(
  submitted: TagResolutionObservation,
  result: TagInspectResult,
): boolean {
  if (submitted.terminalStatus !== result.terminalStatus) return false;
  if (submitted.terminalStatus === "installed-and-covered") {
    return submitted.obligationDigest === result.obligationDigest;
  }
  return submitted.tombstoneEpoch === result.tombstoneEpoch;
}

export async function verifyTargetResolutionEvidence(
  env: TagReconciliationEnv,
  serviceId: string,
  evidence: TargetResolutionEvidence,
  envelope: IssuanceEnvelope,
): Promise<void> {
  if (evidence.pinnedWriterEpoch !== envelope.pinnedWriterEpoch) {
    throw new Error("resolution evidence pinned writer epoch does not match envelope");
  }
  const outcome = await inspectTagTarget(env, serviceId, evidence.tag, envelope);
  if (outcome.kind !== "terminal") {
    throw new Error("tag observation is not verified by live inspect");
  }
  if (!tagObservationMatchesInspect(evidence.tagObservation, outcome.result)) {
    throw new Error("tag observation does not match live inspect");
  }
  if (
    evidence.tagObservation.terminalStatus === "absent-and-irrevocably-fenced" &&
    envelope.pinnedWriterEpoch > (evidence.tagObservation.tombstoneEpoch ?? -1)
  ) {
    throw new Error("fenced observation violates writer epoch rule");
  }
}

export async function submitTargetResolution(
  env: IssuanceReconcilerEnv,
  serviceId: string,
  evidence: TargetResolutionEvidence,
): Promise<boolean> {
  const response = await env.ALLOCATOR.get(scopeIdFor(env.ALLOCATOR, {
    serviceId,
    doClass: "allocator",
    identity: "allocator",
  })).fetch(new Request("https://allocator.internal/__internal/g77/resolve-target", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(evidence),
  }));
  return response.status >= 200 && response.status < 300;
}

export interface ReconcileIssuanceBatchOptions {
  /**
   * Test/admin `/__internal/g77/reconcile-now` bypasses never-contacted grace so
   * bounded-reconciliation oracles can fence immediately without advancing DO time.
   */
  readonly bypassNeverContactedGrace?: boolean;
}

export async function reconcileIssuanceBatch(
  storage: DurableObjectStorage,
  env: Pick<IssuanceReconcilerEnv, "TAG">,
  serviceId: string,
  resolveTarget?: (evidence: TargetResolutionEvidence) => Promise<boolean>,
  options?: ReconcileIssuanceBatchOptions,
): Promise<{ processed: number; rearmAt: number }> {
  let processed = 0;
  const now = Date.now();
  const listed = await storage.list<{ attemptId: string; candidateIndex: number; suid: string }>({
    prefix: UNRESOLVED_INDEX_PREFIX,
    limit: RECONCILE_BATCH_LIMIT,
  });
  for (const [key] of listed) {
    const parsed = parseIndexEntry(key, UNRESOLVED_INDEX_PREFIX);
    if (parsed === undefined) continue;
    const envelope = await storage.get<IssuanceEnvelope>(
      envelopeKey(parsed.attemptId, parsed.candidateIndex),
    );
    if (envelope === undefined) continue;
    for (const tag of envelope.canonicalTargetTags) {
      const target = await storage.get<TargetClosureRecord>(
        targetKey(parsed.attemptId, parsed.candidateIndex, tag),
      );
      if (target === undefined || target.status !== "pending") continue;
      let outcome = await inspectTagTarget(env, serviceId, tag, envelope);
      if (outcome.kind === "unreachable" || outcome.kind === "not-terminal-yet") {
        continue;
      }
      if (outcome.kind === "absent-never-contacted") {
        const issuedAtMs = envelope.issuedAtMs ?? 0;
        if (
          options?.bypassNeverContactedGrace !== true
          && now - issuedAtMs < ISSUANCE_NEVER_CONTACTED_GRACE_MS
        ) {
          continue;
        }
      }
      if (outcome.kind === "absent-never-contacted" || outcome.kind === "absent-but-unfenced") {
        const fenced = await fenceAbsentTarget(env, serviceId, tag, envelope);
        if (!fenced) continue;
        outcome = await inspectTagTarget(env, serviceId, tag, envelope);
      }
      if (outcome.kind !== "terminal") continue;
      const evidence: TargetResolutionEvidence = {
        serviceId: envelope.serviceId,
        allocatorLineageId: envelope.allocatorLineageId,
        attemptId: envelope.attemptId,
        candidateIndex: envelope.candidateIndex,
        suid: envelope.suid,
        tag,
        identityDigest: envelope.identityDigest,
        pinnedWriterEpoch: envelope.pinnedWriterEpoch,
        tagObservation: tagObservationFromInspect(outcome.result),
      };
      const submitted = resolveTarget !== undefined
        ? await resolveTarget(evidence)
        : "ALLOCATOR" in env && env.ALLOCATOR !== undefined
          ? await submitTargetResolution(env as IssuanceReconcilerEnv, serviceId, evidence)
          : false;
      if (submitted) processed += 1;
    }
  }
  const existingSchedule = await storage.get<IssuanceRecoverySchedule>(ISSUANCE_RECOVERY_KEY);
  const attempts = (existingSchedule?.attempts ?? 0) + 1;
  const unresolvedCount = await countUnresolvedEntries(storage);
  if (unresolvedCount === 0) {
    if (existingSchedule !== undefined) {
      await storage.put(ISSUANCE_RECOVERY_KEY, {
        ...existingSchedule,
        attempts,
      } satisfies IssuanceRecoverySchedule);
    }
    await storage.deleteAlarm();
    return { processed, rearmAt: now };
  }
  const retryAt = now + RECONCILE_RETRY_MS;
  const nextDueAt = existingSchedule?.nextDueAt === undefined
    ? retryAt
    : Math.min(existingSchedule.nextDueAt, retryAt);
  await storage.put(ISSUANCE_RECOVERY_KEY, {
    nextDueAt,
    cursor: null,
    attempts,
  } satisfies IssuanceRecoverySchedule);
  await syncIssuanceRecoveryAlarm(storage, now);
  return { processed, rearmAt: nextDueAt };
}
