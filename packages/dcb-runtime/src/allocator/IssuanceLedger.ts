import type { AllocatedCandidate, AllocationCandidate, ClosedPrefixCertificate } from "./types";
import { assertSortableUniqueId } from "./SortableUniqueId";

export const ISSUANCE_LEDGER_VERSION = 1;
export const ATTEMPT_KEY_PREFIX = "attempt:";
export const ISSUANCE_COUNT_KEY = "issuance:unresolved-count";
export const ISSUANCE_RECOVERY_KEY = "issuance:recovery-schedule";
export const ISSUANCE_MIGRATION_KEY = "issuance:migration";
export const ISSUANCE_MIGRATION_PROOF_PREFIX = "issuance:migration-proof:";
export const ISSUANCE_PREFIX_KEY = "issuance:closed-prefix";
export const LEGACY_INVENTORIED_PREFIX = "issuance:legacy-inventoried:";
export const ENVELOPE_PREFIX = "issuance:envelope:";
export const TARGET_PREFIX = "issuance:target:";
export const ISSUED_INDEX_PREFIX = "issuance:issued:";
export const UNRESOLVED_INDEX_PREFIX = "issuance:unresolved:";

export const DEFAULT_WRITER_EPOCH = 0;
export const MAX_TARGET_TAGS = 32;
export const MAX_TAG_LENGTH = 256;

export type TargetClosureStatus = "pending" | "installed-and-covered" | "absent-and-irrevocably-fenced";

export interface IssuanceEnvelope {
  readonly ledgerVersion: typeof ISSUANCE_LEDGER_VERSION;
  readonly serviceId: string;
  readonly allocatorLineageId: string;
  readonly attemptId: string;
  readonly candidateIndex: number;
  readonly eventId: string;
  readonly suid: string;
  readonly canonicalTargetTags: readonly string[];
  readonly pinnedWriterEpoch: number;
  readonly identityDigest: string;
}

export interface TargetClosureRecord {
  readonly tag: string;
  status: TargetClosureStatus;
  readonly envelopeDigest: string;
}

export interface IssuanceMigrationState {
  readonly cutInstalledAt: number;
  readonly legacyInventoryCursor: string | null;
  readonly inventoryComplete: boolean;
  readonly migrationProofId: string | null;
  readonly legacyInventorySummary?: LegacyInventorySummary;
}

export interface IssuanceRecoverySchedule {
  readonly nextDueAt: number;
  readonly cursor: string | null;
  readonly attempts: number;
}

export interface AllocationCandidateWithMembership extends AllocationCandidate {
  readonly targetTags?: readonly string[];
  readonly pinnedWriterEpoch?: number;
}

export interface TagResolutionObservation {
  readonly terminalStatus: Exclude<TargetClosureStatus, "pending">;
  readonly obligationDigest?: string;
  readonly tombstoneEpoch?: number;
}

export interface TargetResolutionEvidence {
  readonly serviceId: string;
  readonly allocatorLineageId: string;
  readonly attemptId: string;
  readonly candidateIndex: number;
  readonly suid: string;
  readonly tag: string;
  readonly identityDigest: string;
  readonly pinnedWriterEpoch: number;
  readonly tagObservation: TagResolutionObservation;
}

export type LegacyAttemptClassification =
  | "legacy-vector-only"
  | "legacy-resolved-registration"
  | "legacy-unresolved-registration"
  | "legacy-unclassifiable-blocking";

export interface LegacyInventoryRecord {
  readonly inventoriedAt: number;
  readonly classification: LegacyAttemptClassification;
  readonly reason: string;
}

export interface LegacyInventorySummary {
  readonly vectorOnly: number;
  readonly resolvedRegistration: number;
  readonly unresolvedRegistration: number;
  readonly unclassifiableBlocking: number;
}

export class IssuanceLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssuanceLedgerError";
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function canonicalizeTargetTags(tags: readonly string[]): readonly string[] {
  const unique = [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))];
  if (unique.length === 0) throw new IssuanceLedgerError("at least one target tag is required");
  if (unique.length > MAX_TARGET_TAGS) throw new IssuanceLedgerError("target tag count exceeds bound");
  for (const tag of unique) {
    if (tag.length > MAX_TAG_LENGTH) throw new IssuanceLedgerError("target tag exceeds length bound");
  }
  return unique.sort((left, right) => left.localeCompare(right));
}

export function identityDigest(input: {
  serviceId: string;
  allocatorLineageId: string;
  attemptId: string;
  candidateIndex: number;
  eventId: string;
  suid: string;
  canonicalTargetTags: readonly string[];
  pinnedWriterEpoch: number;
}): string {
  const payload = JSON.stringify(input);
  let hash = 0;
  for (let index = 0; index < payload.length; index += 1) {
    hash = ((hash << 5) - hash + payload.charCodeAt(index)) | 0;
  }
  return `g77:${Math.abs(hash).toString(16)}:${payload.length}`;
}

export function envelopeKey(attemptId: string, candidateIndex: number): string {
  return `${ENVELOPE_PREFIX}${attemptId}:${candidateIndex}`;
}

export function targetKey(attemptId: string, candidateIndex: number, tag: string): string {
  return `${TARGET_PREFIX}${attemptId}:${candidateIndex}:${tag}`;
}

export function issuedIndexKey(suid: string, attemptId: string, candidateIndex: number): string {
  assertSortableUniqueId(suid);
  return `${ISSUED_INDEX_PREFIX}${suid}:${attemptId}:${candidateIndex}`;
}

export function unresolvedIndexKey(suid: string, attemptId: string, candidateIndex: number): string {
  assertSortableUniqueId(suid);
  return `${UNRESOLVED_INDEX_PREFIX}${suid}:${attemptId}:${candidateIndex}`;
}

export function parseIndexEntry(key: string, prefix: string): { suid: string; attemptId: string; candidateIndex: number } | undefined {
  if (!key.startsWith(prefix)) return undefined;
  const rest = key.slice(prefix.length);
  const suidEnd = rest.indexOf(":");
  if (suidEnd <= 0) return undefined;
  const suid = rest.slice(0, suidEnd);
  const tail = rest.slice(suidEnd + 1);
  const lastColon = tail.lastIndexOf(":");
  if (lastColon <= 0) return undefined;
  const attemptId = tail.slice(0, lastColon);
  const candidateIndex = Number(tail.slice(lastColon + 1));
  if (!Number.isInteger(candidateIndex) || candidateIndex < 0) return undefined;
  return { suid, attemptId, candidateIndex };
}

export function buildEnvelope(input: {
  serviceId: string;
  allocatorLineageId: string;
  attemptId: string;
  candidate: AllocatedCandidate;
  targetTags: readonly string[];
  pinnedWriterEpoch: number;
}): IssuanceEnvelope {
  const canonicalTargetTags = canonicalizeTargetTags(input.targetTags);
  assertSortableUniqueId(input.candidate.suid);
  return {
    ledgerVersion: ISSUANCE_LEDGER_VERSION,
    serviceId: input.serviceId,
    allocatorLineageId: input.allocatorLineageId,
    attemptId: input.attemptId,
    candidateIndex: input.candidate.candidateIndex,
    eventId: input.candidate.eventId,
    suid: input.candidate.suid,
    canonicalTargetTags,
    pinnedWriterEpoch: input.pinnedWriterEpoch,
    identityDigest: identityDigest({
      serviceId: input.serviceId,
      allocatorLineageId: input.allocatorLineageId,
      attemptId: input.attemptId,
      candidateIndex: input.candidate.candidateIndex,
      eventId: input.candidate.eventId,
      suid: input.candidate.suid,
      canonicalTargetTags,
      pinnedWriterEpoch: input.pinnedWriterEpoch,
    }),
  };
}

export function membershipMatches(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const canonicalLeft = canonicalizeTargetTags(left);
  const canonicalRight = canonicalizeTargetTags(right);
  return canonicalLeft.every((tag, index) => tag === canonicalRight[index]);
}

export async function registerIssuanceInTransaction(
  txn: DurableObjectTransaction,
  input: {
    serviceId: string;
    allocatorLineageId: string;
    attemptId: string;
    candidates: readonly AllocatedCandidate[];
    candidateMembership: ReadonlyMap<number, { tags: readonly string[]; pinnedWriterEpoch: number }>;
    migration: IssuanceMigrationState | undefined;
  },
): Promise<void> {
  if (input.migration !== undefined && input.candidateMembership.size === 0) {
    throw new IssuanceLedgerError("post-cut allocation requires canonical target membership");
  }
  let count = await txn.get<number>(ISSUANCE_COUNT_KEY) ?? 0;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new IssuanceLedgerError("corrupt unresolved issuance count");
  }
  const now = Date.now();
  for (const candidate of input.candidates) {
    const membership = input.candidateMembership.get(candidate.candidateIndex);
    if (input.migration !== undefined && membership === undefined) {
      throw new IssuanceLedgerError("post-cut allocation requires membership for every candidate");
    }
    if (membership === undefined) continue;
    const envelope = buildEnvelope({
      serviceId: input.serviceId,
      allocatorLineageId: input.allocatorLineageId,
      attemptId: input.attemptId,
      candidate,
      targetTags: membership.tags,
      pinnedWriterEpoch: membership.pinnedWriterEpoch,
    });
    const existing = await txn.get<IssuanceEnvelope>(envelopeKey(input.attemptId, candidate.candidateIndex));
    if (existing !== undefined) {
      if (!membershipMatches(existing.canonicalTargetTags, envelope.canonicalTargetTags)) {
        throw new IssuanceLedgerError("divergent membership on allocation replay");
      }
      continue;
    }
    await txn.put(envelopeKey(input.attemptId, candidate.candidateIndex), envelope);
    for (const tag of envelope.canonicalTargetTags) {
      await txn.put(targetKey(input.attemptId, candidate.candidateIndex, tag), {
        tag,
        status: "pending",
        envelopeDigest: envelope.identityDigest,
      } satisfies TargetClosureRecord);
    }
    await txn.put(issuedIndexKey(candidate.suid, input.attemptId, candidate.candidateIndex), {
      attemptId: input.attemptId,
      candidateIndex: candidate.candidateIndex,
      suid: candidate.suid,
    });
    await txn.put(unresolvedIndexKey(candidate.suid, input.attemptId, candidate.candidateIndex), {
      attemptId: input.attemptId,
      candidateIndex: candidate.candidateIndex,
      suid: candidate.suid,
    });
    count += 1;
  }
  await txn.put(ISSUANCE_COUNT_KEY, count);
  const prefix = await computeClosedPrefixSuid(
    txn,
    txn,
    await readWatermarkFromState(txn),
    input.migration,
  );
  await txn.put(ISSUANCE_PREFIX_KEY, prefix.closedPrefixSuid);
  const schedule = await txn.get<IssuanceRecoverySchedule>(ISSUANCE_RECOVERY_KEY);
  if (schedule === undefined || schedule.nextDueAt > now) {
    await txn.put(ISSUANCE_RECOVERY_KEY, {
      nextDueAt: now,
      cursor: schedule?.cursor ?? null,
      attempts: schedule?.attempts ?? 0,
    });
  }
}

/** Arm when a recovery schedule exists and reconciliation is due (or overdue). */
export function shouldArmIssuanceRecovery(
  schedule: IssuanceRecoverySchedule | undefined,
  now: number,
): boolean {
  return schedule !== undefined && schedule.nextDueAt <= now;
}

type IssuanceIndexReader = Pick<DurableObjectStorage, "list">;

export async function countUnresolvedEntries(reader: IssuanceIndexReader): Promise<number> {
  const listed = await reader.list({ prefix: UNRESOLVED_INDEX_PREFIX, limit: 256 });
  return [...listed.keys()].length;
}

export async function leastUnresolvedEntry(
  reader: IssuanceIndexReader,
): Promise<{ suid: string; attemptId: string; candidateIndex: number } | undefined> {
  const listed = await reader.list<{ attemptId: string; candidateIndex: number; suid: string }>({
    prefix: UNRESOLVED_INDEX_PREFIX,
    limit: 1,
  });
  for (const [key] of listed) {
    const parsed = parseIndexEntry(key, UNRESOLVED_INDEX_PREFIX);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

export async function predecessorIssuedSuid(
  reader: IssuanceIndexReader,
  exclusiveSuid: string,
): Promise<string | null> {
  assertSortableUniqueId(exclusiveSuid);
  const endKey = `${ISSUED_INDEX_PREFIX}${exclusiveSuid}:`;
  const listed = await reader.list<{ suid: string }>({
    prefix: ISSUED_INDEX_PREFIX,
    end: endKey,
    reverse: true,
    limit: 1,
  });
  for (const [key, value] of listed) {
    const suid = value?.suid ?? parseIndexEntry(key, ISSUED_INDEX_PREFIX)?.suid;
    if (suid !== undefined && suid < exclusiveSuid) return suid;
  }
  return null;
}

export async function computeClosedPrefixSuid(
  reader: IssuanceIndexReader,
  txn: DurableObjectTransaction,
  allocatedWatermark: string | null,
  migration: IssuanceMigrationState | undefined,
): Promise<{ closedPrefixSuid: string | null; unresolvedCount: number; status: "ready" | "unreconciled" }> {
  const storedCount = await txn.get<number>(ISSUANCE_COUNT_KEY);
  const indexedCount = await countUnresolvedEntries(reader);
  const count = Math.max(storedCount ?? 0, indexedCount);
  if (!Number.isSafeInteger(storedCount ?? 0) || (storedCount ?? 0) < 0) {
    throw new IssuanceLedgerError("missing or corrupt unresolved count");
  }
  if (migration !== undefined && (!migration.inventoryComplete || legacyMigrationBlocks(migration))) {
    return { closedPrefixSuid: null, unresolvedCount: count, status: "unreconciled" };
  }
  if (count > 0) {
    const least = await leastUnresolvedEntry(reader);
    if (least === undefined) {
      throw new IssuanceLedgerError("corrupt unresolved index");
    }
    const predecessor = await predecessorIssuedSuid(reader, least.suid);
    // AC3: the least unresolved hole is an exclusive boundary — never the hole or raw watermark.
    let closedPrefixSuid = predecessor;
    if (
      closedPrefixSuid === least.suid ||
      (allocatedWatermark !== null &&
        least.suid === allocatedWatermark &&
        closedPrefixSuid === allocatedWatermark)
    ) {
      closedPrefixSuid = null;
    }
    return { closedPrefixSuid, unresolvedCount: count, status: "ready" };
  }
  if (migration !== undefined && migration.migrationProofId === null) {
    return { closedPrefixSuid: null, unresolvedCount: count, status: "unreconciled" };
  }
  if (allocatedWatermark === null) {
    return { closedPrefixSuid: null, unresolvedCount: 0, status: "ready" };
  }
  return { closedPrefixSuid: allocatedWatermark, unresolvedCount: 0, status: "ready" };
}

export async function buildCertificateSnapshot(
  reader: IssuanceIndexReader,
  txn: DurableObjectTransaction,
  input: {
    serviceId: string;
    allocatorLineageId: string;
    allocatedWatermark: string | null;
    generatedAt: number;
  },
): Promise<ClosedPrefixCertificate> {
  const migration = await txn.get<IssuanceMigrationState>(ISSUANCE_MIGRATION_KEY);
  const prefix = await computeClosedPrefixSuid(reader, txn, input.allocatedWatermark, migration);
  return {
    certificateVersion: 1,
    authority: "allocator-transaction",
    status: prefix.status,
    allocatorLineageId: input.allocatorLineageId,
    serviceId: input.serviceId,
    closedPrefixSuid: prefix.closedPrefixSuid,
    unresolvedCount: prefix.unresolvedCount,
    generatedAt: input.generatedAt,
    migrationProofId: migration?.migrationProofId ?? null,
  };
}

function terminalStatusFromTagObservation(
  observation: TagResolutionObservation,
): Exclude<TargetClosureStatus, "pending"> {
  if (observation.terminalStatus === "installed-and-covered") {
    if (!isNonEmptyString(observation.obligationDigest)) {
      throw new IssuanceLedgerError("installed resolution requires tag obligation digest");
    }
    return "installed-and-covered";
  }
  if (observation.terminalStatus === "absent-and-irrevocably-fenced") {
    if (!isNonNegativeInteger(observation.tombstoneEpoch)) {
      throw new IssuanceLedgerError("fenced resolution requires tag tombstone epoch");
    }
    return "absent-and-irrevocably-fenced";
  }
  throw new IssuanceLedgerError("tag observation terminal status is invalid");
}

export function parseTargetResolutionEvidence(raw: unknown): TargetResolutionEvidence {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new IssuanceLedgerError("resolution evidence body is invalid");
  }
  const value = raw as Record<string, unknown>;
  const observationRaw = value.tagObservation;
  if (typeof observationRaw !== "object" || observationRaw === null || Array.isArray(observationRaw)) {
    throw new IssuanceLedgerError("tag observation artefact is required");
  }
  const observationValue = observationRaw as Record<string, unknown>;
  const terminalStatus = observationValue.terminalStatus;
  if (
    terminalStatus !== "installed-and-covered" &&
    terminalStatus !== "absent-and-irrevocably-fenced"
  ) {
    throw new IssuanceLedgerError("tag observation terminal status is invalid");
  }
  const tagObservation: TagResolutionObservation = {
    terminalStatus,
    ...(isNonEmptyString(observationValue.obligationDigest)
      ? { obligationDigest: observationValue.obligationDigest }
      : {}),
    ...(isNonNegativeInteger(observationValue.tombstoneEpoch)
      ? { tombstoneEpoch: observationValue.tombstoneEpoch }
      : {}),
  };
  terminalStatusFromTagObservation(tagObservation);
  if (
    !isNonEmptyString(value.serviceId) ||
    !isNonEmptyString(value.allocatorLineageId) ||
    !isNonEmptyString(value.attemptId) ||
    !isNonNegativeInteger(value.candidateIndex) ||
    !isNonEmptyString(value.suid) ||
    !isNonEmptyString(value.tag) ||
    !isNonEmptyString(value.identityDigest) ||
    !isNonNegativeInteger(value.pinnedWriterEpoch)
  ) {
    throw new IssuanceLedgerError("resolution evidence fields are incomplete");
  }
  return {
    serviceId: value.serviceId,
    allocatorLineageId: value.allocatorLineageId,
    attemptId: value.attemptId,
    candidateIndex: value.candidateIndex,
    suid: value.suid,
    tag: value.tag,
    identityDigest: value.identityDigest,
    pinnedWriterEpoch: value.pinnedWriterEpoch,
    tagObservation,
  };
}

export async function applyTargetResolution(
  txn: DurableObjectTransaction,
  evidence: TargetResolutionEvidence,
): Promise<{ candidateResolved: boolean; duplicate: boolean }> {
  const terminalStatus = terminalStatusFromTagObservation(evidence.tagObservation);
  const envelope = await txn.get<IssuanceEnvelope>(
    envelopeKey(evidence.attemptId, evidence.candidateIndex),
  );
  if (envelope === undefined) throw new IssuanceLedgerError("unknown issuance envelope");
  if (
    envelope.serviceId !== evidence.serviceId ||
    envelope.allocatorLineageId !== evidence.allocatorLineageId ||
    envelope.suid !== evidence.suid ||
    envelope.identityDigest !== evidence.identityDigest
  ) {
    throw new IssuanceLedgerError("resolution evidence does not match immutable envelope");
  }
  if (!envelope.canonicalTargetTags.includes(evidence.tag)) {
    throw new IssuanceLedgerError("resolution tag is not in canonical membership");
  }
  const target = await txn.get<TargetClosureRecord>(
    targetKey(evidence.attemptId, evidence.candidateIndex, evidence.tag),
  );
  if (target === undefined) throw new IssuanceLedgerError("unknown target closure record");
  if (target.status !== "pending") {
    return { candidateResolved: await allTargetsTerminal(txn, evidence.attemptId, evidence.candidateIndex, envelope), duplicate: true };
  }
  await txn.put(targetKey(evidence.attemptId, evidence.candidateIndex, evidence.tag), {
    ...target,
    status: terminalStatus,
  });
  const resolved = await allTargetsTerminal(txn, evidence.attemptId, evidence.candidateIndex, envelope);
  if (!resolved) return { candidateResolved: false, duplicate: false };
  const unresolvedKey = unresolvedIndexKey(evidence.suid, evidence.attemptId, evidence.candidateIndex);
  const hadUnresolved = await txn.get(unresolvedKey);
  if (hadUnresolved === undefined) return { candidateResolved: true, duplicate: true };
  await txn.delete(unresolvedKey);
  const count = await txn.get<number>(ISSUANCE_COUNT_KEY) ?? 0;
  if (count <= 0) throw new IssuanceLedgerError("corrupt unresolved count on resolution");
  await txn.put(ISSUANCE_COUNT_KEY, count - 1);
  const prefix = await computeClosedPrefixSuid(
    txn,
    txn,
    await readWatermarkFromState(txn),
    await txn.get<IssuanceMigrationState>(ISSUANCE_MIGRATION_KEY),
  );
  await txn.put(ISSUANCE_PREFIX_KEY, prefix.closedPrefixSuid);
  return { candidateResolved: true, duplicate: false };
}

async function allTargetsTerminal(
  txn: DurableObjectTransaction,
  attemptId: string,
  candidateIndex: number,
  envelope: IssuanceEnvelope,
): Promise<boolean> {
  for (const tag of envelope.canonicalTargetTags) {
    const record = await txn.get<TargetClosureRecord>(targetKey(attemptId, candidateIndex, tag));
    if (record === undefined || record.status === "pending") return false;
  }
  return true;
}

async function readWatermarkFromState(txn: DurableObjectTransaction): Promise<string | null> {
  const state = await txn.get<{ allocatedWatermark?: string | null }>("allocator-state");
  return state?.allocatedWatermark ?? null;
}

export async function registrationProbe(
  txn: DurableObjectTransaction,
  attemptId: string,
  candidateIndex: number,
): Promise<{
  envelope: boolean;
  unresolvedIndex: boolean;
  issuedIndex: boolean;
  exactCount: boolean;
  recoverySchedule: boolean;
}> {
  const envelope = await txn.get<IssuanceEnvelope>(envelopeKey(attemptId, candidateIndex));
  const suid = envelope?.suid;
  const count = await txn.get<number>(ISSUANCE_COUNT_KEY);
  const schedule = await txn.get(ISSUANCE_RECOVERY_KEY);
  let unresolvedIndex = false;
  let issuedIndex = false;
  if (suid !== undefined) {
    unresolvedIndex = await txn.get(unresolvedIndexKey(suid, attemptId, candidateIndex)) !== undefined;
    issuedIndex = await txn.get(issuedIndexKey(suid, attemptId, candidateIndex)) !== undefined;
  }
  return {
    envelope: envelope !== undefined,
    unresolvedIndex,
    issuedIndex,
    exactCount: count !== undefined && Number.isSafeInteger(count),
    recoverySchedule: schedule !== undefined,
  };
}

type StorageListReader = Pick<DurableObjectStorage, "list">;

async function listAllAttemptKeys(reader: StorageListReader): Promise<string[]> {
  const keys: string[] = [];
  let start: string | undefined;
  const scanLimit = 16;
  while (true) {
    const batch = await reader.list({
      prefix: ATTEMPT_KEY_PREFIX,
      limit: scanLimit,
      ...(start !== undefined ? { start } : {}),
    });
    const rawKeys = [...batch.keys()];
    const cursor = start;
    const batchKeys = cursor === undefined
      ? rawKeys
      : rawKeys.filter((key) => key > cursor);
    if (batchKeys.length === 0) break;
    keys.push(...batchKeys);
    if (rawKeys.length < scanLimit) break;
    start = batchKeys[batchKeys.length - 1];
  }
  return keys.sort((left, right) => left.localeCompare(right));
}

function emptyLegacyInventorySummary(): LegacyInventorySummary {
  return {
    vectorOnly: 0,
    resolvedRegistration: 0,
    unresolvedRegistration: 0,
    unclassifiableBlocking: 0,
  };
}

function legacyMigrationBlocks(migration: IssuanceMigrationState): boolean {
  const summary = migration.legacyInventorySummary;
  if (summary === undefined) return false;
  return summary.unclassifiableBlocking > 0 || summary.unresolvedRegistration > 0;
}

async function classifyLegacyAttempt(
  txn: DurableObjectTransaction,
  attemptKey: string,
): Promise<{ classification: LegacyAttemptClassification; reason: string }> {
  const attemptId = attemptKey.slice(ATTEMPT_KEY_PREFIX.length);
  if (!isNonEmptyString(attemptId)) {
    return {
      classification: "legacy-unclassifiable-blocking",
      reason: "attempt key is malformed",
    };
  }
  const envelopes = await txn.list<IssuanceEnvelope>({ prefix: `${ENVELOPE_PREFIX}${attemptId}:` });
  if ([...envelopes.keys()].length === 0) {
    return {
      classification: "legacy-vector-only",
      reason: "pre-cut vector without issuance registration",
    };
  }
  let sawPending = false;
  let sawTerminal = false;
  for (const [, envelope] of envelopes) {
    if (envelope === undefined) {
      return {
        classification: "legacy-unclassifiable-blocking",
        reason: "legacy envelope record is missing",
      };
    }
    for (const tag of envelope.canonicalTargetTags) {
      const target = await txn.get<TargetClosureRecord>(
        targetKey(envelope.attemptId, envelope.candidateIndex, tag),
      );
      if (target === undefined) {
        return {
          classification: "legacy-unclassifiable-blocking",
          reason: "legacy target closure record is missing",
        };
      }
      if (target.status === "pending") sawPending = true;
      else sawTerminal = true;
    }
  }
  if (sawPending) {
    return {
      classification: "legacy-unresolved-registration",
      reason: "legacy issuance registration remains unresolved",
    };
  }
  if (sawTerminal) {
    return {
      classification: "legacy-resolved-registration",
      reason: "legacy issuance registration is terminal",
    };
  }
  return {
    classification: "legacy-unclassifiable-blocking",
    reason: "legacy attempt has no classifiable target facts",
  };
}

function incrementLegacySummary(
  summary: LegacyInventorySummary,
  classification: LegacyAttemptClassification,
): LegacyInventorySummary {
  switch (classification) {
    case "legacy-vector-only":
      return { ...summary, vectorOnly: summary.vectorOnly + 1 };
    case "legacy-resolved-registration":
      return { ...summary, resolvedRegistration: summary.resolvedRegistration + 1 };
    case "legacy-unresolved-registration":
      return { ...summary, unresolvedRegistration: summary.unresolvedRegistration + 1 };
    case "legacy-unclassifiable-blocking":
      return { ...summary, unclassifiableBlocking: summary.unclassifiableBlocking + 1 };
  }
}

export async function pageLegacyInventoryInTransaction(
  txn: DurableObjectTransaction,
  input: { pageSize: number; faultInjection?: "after-cursor-persist" },
  reader: StorageListReader = txn,
): Promise<{
  pageCount: number;
  nextCursor: string | null;
  inventoryComplete: boolean;
}> {
  const migration = await txn.get<IssuanceMigrationState>(ISSUANCE_MIGRATION_KEY);
  if (migration === undefined) throw new IssuanceLedgerError("migration cut is required");
  if (migration.inventoryComplete) {
    return { pageCount: 0, nextCursor: migration.legacyInventoryCursor, inventoryComplete: true };
  }
  if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1) {
    throw new IssuanceLedgerError("inventory page size must be a positive integer");
  }
  const allAttemptKeys = await listAllAttemptKeys(reader);
  const pendingKeys: string[] = [];
  for (const key of allAttemptKeys) {
    if (await txn.get(`${LEGACY_INVENTORIED_PREFIX}${key}`) === undefined) {
      pendingKeys.push(key);
    }
  }
  const keysToProcess = pendingKeys.slice(0, input.pageSize);
  let lastProcessed: string | null = migration.legacyInventoryCursor;
  let summary = migration.legacyInventorySummary ?? emptyLegacyInventorySummary();
  for (const key of keysToProcess) {
    lastProcessed = key;
    const classified = await classifyLegacyAttempt(txn, key);
    summary = incrementLegacySummary(summary, classified.classification);
    await txn.put(`${LEGACY_INVENTORIED_PREFIX}${key}`, {
      inventoriedAt: Date.now(),
      classification: classified.classification,
      reason: classified.reason,
    } satisfies LegacyInventoryRecord);
  }
  const inventoryComplete = pendingKeys.length <= input.pageSize;
  const updated: IssuanceMigrationState = {
    ...migration,
    legacyInventoryCursor: lastProcessed,
    inventoryComplete,
    legacyInventorySummary: summary,
  };
  await txn.put(ISSUANCE_MIGRATION_KEY, updated);
  if (input.faultInjection === "after-cursor-persist") {
    throw new IssuanceLedgerError("simulated inventory page crash");
  }
  return { pageCount: keysToProcess.length, nextCursor: lastProcessed, inventoryComplete };
}

export async function completeMigrationProofInTransaction(
  txn: DurableObjectTransaction,
  input: { migrationProofId: string; boundEvidence: Record<string, unknown> },
): Promise<void> {
  const migration = await txn.get<IssuanceMigrationState>(ISSUANCE_MIGRATION_KEY);
  if (migration === undefined) throw new IssuanceLedgerError("migration cut is required");
  if (!migration.inventoryComplete) throw new IssuanceLedgerError("legacy inventory is incomplete");
  if (legacyMigrationBlocks(migration)) {
    throw new IssuanceLedgerError("legacy inventory contains blocking classifications");
  }
  if (!isNonEmptyString(input.migrationProofId)) {
    throw new IssuanceLedgerError("migration proof id is required");
  }
  await txn.put(ISSUANCE_MIGRATION_KEY, {
    ...migration,
    migrationProofId: input.migrationProofId,
  });
  await txn.put(`${ISSUANCE_MIGRATION_PROOF_PREFIX}${input.migrationProofId}`, input.boundEvidence);
}

export function parseCandidateMembership(
  raw: unknown,
): { tags: readonly string[]; pinnedWriterEpoch: number } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const tags = value.targetTags;
  if (!Array.isArray(tags)) return undefined;
  const stringTags = tags.filter(isNonEmptyString);
  if (stringTags.length !== tags.length) return undefined;
  const epoch = value.pinnedWriterEpoch === undefined ? DEFAULT_WRITER_EPOCH : value.pinnedWriterEpoch;
  if (!isNonNegativeInteger(epoch)) return undefined;
  return { tags: canonicalizeTargetTags(stringTags), pinnedWriterEpoch: epoch };
}
