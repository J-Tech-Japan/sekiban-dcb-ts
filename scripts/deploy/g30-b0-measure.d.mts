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

export function establishB0Consistency(input: {
  baseUrl: string;
  token: string;
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

export function buildHeadReadFailureEvidence(
  context: { phase: "A" | "B" | "A-prime"; sourceCommit: string; configDigest: string },
  failure: G30HeadReadFailure,
): Record<string, unknown>;

export function writeHeadReadFailureEvidence(
  output: string,
  context: { phase: "A" | "B" | "A-prime"; sourceCommit: string; configDigest: string },
  failure: G30HeadReadFailure,
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
}): Promise<Record<string, unknown>>;
