import { scopeIdFor } from "../scope/ScopeName";
import type {
  IssuanceEnvelope,
  IssuanceRecoverySchedule,
  TargetClosureRecord,
  TargetResolutionEvidence,
} from "./IssuanceLedger";
import {
  DEFAULT_WRITER_EPOCH,
  ISSUANCE_RECOVERY_KEY,
  UNRESOLVED_INDEX_PREFIX,
  envelopeKey,
  parseIndexEntry,
  targetKey,
} from "./IssuanceLedger";

export interface TagInspectResult {
  readonly terminalStatus: "installed-and-covered" | "absent-and-irrevocably-fenced";
  readonly eventId?: string;
  readonly tombstoneEpoch?: number;
}

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
): Promise<TagInspectResult | undefined> {
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
  if (response.status !== 200) return undefined;
  const body = await response.json<TagInspectResult>();
  if (
    body.terminalStatus !== "installed-and-covered" &&
    body.terminalStatus !== "absent-and-irrevocably-fenced"
  ) {
    return undefined;
  }
  return body;
}

export async function fenceAbsentTarget(
  env: TagReconciliationEnv,
  serviceId: string,
  tag: string,
  envelope: IssuanceEnvelope,
): Promise<boolean> {
  const url = new URL("https://tag.internal/cancel");
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
      forceTombstone: true,
    }),
  }));
  return response.status >= 200 && response.status < 300;
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

export async function reconcileIssuanceBatch(
  storage: DurableObjectStorage,
  env: Pick<IssuanceReconcilerEnv, "TAG">,
  serviceId: string,
  resolveTarget?: (evidence: TargetResolutionEvidence) => Promise<boolean>,
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
      let inspect = await inspectTagTarget(env, serviceId, tag, envelope);
      if (inspect === undefined) {
        const fenced = await fenceAbsentTarget(env, serviceId, tag, envelope);
        if (!fenced) continue;
        inspect = await inspectTagTarget(env, serviceId, tag, envelope);
      }
      if (inspect === undefined) continue;
      const evidence: TargetResolutionEvidence = {
        serviceId: envelope.serviceId,
        allocatorLineageId: envelope.allocatorLineageId,
        attemptId: envelope.attemptId,
        candidateIndex: envelope.candidateIndex,
        suid: envelope.suid,
        tag,
        identityDigest: envelope.identityDigest,
        pinnedWriterEpoch: envelope.pinnedWriterEpoch,
        terminalStatus: inspect.terminalStatus,
      };
      const submitted = resolveTarget !== undefined
        ? await resolveTarget(evidence)
        : "ALLOCATOR" in env && env.ALLOCATOR !== undefined
          ? await submitTargetResolution(env as IssuanceReconcilerEnv, serviceId, evidence)
          : false;
      if (submitted) processed += 1;
    }
  }
  const rearmAt = now + RECONCILE_RETRY_MS;
  await storage.put(ISSUANCE_RECOVERY_KEY, {
    nextDueAt: rearmAt,
    cursor: null,
    attempts: ((await storage.get<IssuanceRecoverySchedule>(ISSUANCE_RECOVERY_KEY))?.attempts ?? 0) + 1,
  } satisfies IssuanceRecoverySchedule);
  await storage.setAlarm(rearmAt);
  return { processed, rearmAt };
}
