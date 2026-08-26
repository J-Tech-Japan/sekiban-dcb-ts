export interface G30DeploymentWitness {
  task: "SDT-G30";
  phase: "A" | "B" | "A-prime";
  sourceCommit: string;
  configDigest: string;
  placement: "off";
  serviceId: string;
  worker: string;
  deployedVersion: {
    id: string;
    number: number;
    createdOn: string;
    message: string;
  };
}

export function assertDeploymentWitness(
  witness: unknown,
  phase: "A" | "B" | "A-prime",
  sourceCommit: string,
  configDigest: string,
): G30DeploymentWitness;

export function commitEnvelope(consistencyHead: string): {
  version: 1;
  eventCandidates: Array<{ payload: string; eventPayloadName: "RoomCreated"; tags: string[] }>;
  consistencyTags: Array<{ tag: string; lastSortableUniqueId: string }>;
};

export const CONFORMANCE_RETRY_ATTEMPTS: 15;
export const CONFORMANCE_RETRY_DELAY_MS: 1000;
export const MAX_WINDOW_RESETS: 5;

export function establishB0Consistency(input: {
  baseUrl: string;
  token: string;
  conformanceRetryAttempts?: number;
  conformanceRetryDelayMs?: number;
}): Promise<{
  head: string;
  source: "existing-fixed-tag-head" | "one-time-fixed-tag-seed";
  seeded: boolean;
  seedEventId?: string | null;
}>;

export class G30HeadReadFailure extends Error {
  readonly record: {
    task: "SDT-G30";
    kind: "fixed-tag-head-read-failure";
    endpoint: "/conformance/v1/api/sekiban/serialized/tag-latest-sortable";
    capturedAt: string;
    response: {
      status: number;
      cfRay: string | null;
      receivedAtMs: number;
      receivedAt: string;
      body: unknown;
      rawBody: string;
    };
  };
}

export class G30PhaseMeasurementFailure extends Error {
  readonly record: {
    task: "SDT-G30";
    kind: "phase-window-reset-failure";
    phase: "A" | "B" | "A-prime";
    sourceCommit: string;
    configDigest: string;
    endpoint: string;
    reason: string;
    resetCount: number;
    resetLimit: 5;
    expectedConsistencyHead: string;
    rawAttempts: Array<Record<string, unknown>>;
    readback?: Record<string, unknown>;
    capturedAt: string;
  };
}

export function buildHeadReadFailureEvidence(
  context: { phase: "A" | "B" | "A-prime"; sourceCommit: string; configDigest: string },
  failure: G30HeadReadFailure,
): Record<string, unknown>;

export function writeHeadReadFailureEvidence(
  output: string,
  context: { phase: "A" | "B" | "A-prime"; sourceCommit: string; configDigest: string },
  failure: G30HeadReadFailure,
): Record<string, unknown>;

export function buildPhaseMeasurementFailureEvidence(
  context: { phase: "A" | "B" | "A-prime"; sourceCommit: string; configDigest: string },
  failure: G30PhaseMeasurementFailure,
): Record<string, unknown>;

export function writePhaseMeasurementFailureEvidence(
  output: string,
  context: { phase: "A" | "B" | "A-prime"; sourceCommit: string; configDigest: string },
  failure: G30PhaseMeasurementFailure,
): Record<string, unknown>;

export function measureB0Phase(input: {
  baseUrl: string;
  token: string;
  phase: "A" | "B" | "A-prime";
  sourceCommit: string;
  configDigest: string;
  deploymentWitness: unknown;
  consistencyHead: string;
  samples?: number;
  warmup?: number;
  sleepFor?: (milliseconds: number) => Promise<void>;
  conformanceRetryAttempts?: number;
  conformanceRetryDelayMs?: number;
}): Promise<Record<string, unknown>>;
