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
