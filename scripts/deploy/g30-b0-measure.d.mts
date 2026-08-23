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

export function measureB0Phase(input: {
  baseUrl: string;
  token: string;
  phase: "A" | "B" | "A-prime";
  sourceCommit: string;
  configDigest: string;
  deploymentWitness: unknown;
  samples?: number;
  warmup?: number;
}): Promise<Record<string, unknown>>;
